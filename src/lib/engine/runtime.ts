// Wires state + market feed + broker together. Live trading requires ALL of:
//   1. LIVE_TRADING_ENABLED=true (server env var, set by you in Netlify)
//   2. HL_ACCOUNT_ADDRESS + HL_AGENT_PRIVATE_KEY (withdraw-disabled API wallet; server env only)
//   3. live mode armed in the dashboard with a typed confirmation (state.liveArmed)
import { PaperBroker, type Broker } from "./broker";
import { HyperliquidBroker } from "./hlBroker";
import { HyperliquidFeed } from "./market";
import { recordEquity, runCycle } from "./engine";
import { acquireLock, loadState, mergeControl, releaseLock, saveState } from "./store";
import type { EngineState } from "./types";

export function liveEnv() {
  const enabled = process.env.LIVE_TRADING_ENABLED === "true";
  const user = process.env.HL_ACCOUNT_ADDRESS ?? "";
  const key = process.env.HL_AGENT_PRIVATE_KEY ?? "";
  const okUser = /^0x[0-9a-fA-F]{40}$/.test(user);
  const okKey = /^0x[0-9a-fA-F]{64}$/.test(key);
  return { enabled, configured: okUser && okKey, testnet: process.env.HL_TESTNET === "true", user: okUser ? (user as `0x${string}`) : null, key: okKey ? (key as `0x${string}`) : null };
}

export function brokerFor(s: EngineState): { broker: Broker | null; why?: string } {
  const c = s.config;
  if (c.mode === "paper") return { broker: new PaperBroker(c.takerFeeBps, c.slippageBps) };
  const env = liveEnv();
  if (!env.enabled) return { broker: null, why: "Live mode selected but LIVE_TRADING_ENABLED is not 'true' on the server." };
  if (!env.configured) return { broker: null, why: "Live mode selected but HL_ACCOUNT_ADDRESS / HL_AGENT_PRIVATE_KEY are missing or malformed." };
  if (!s.liveArmed && !(s.killSwitch && s.positions.some((p) => p.mode === "live"))) return { broker: null, why: "Live mode not armed in the dashboard." };
  return { broker: new HyperliquidBroker(env.user!, env.key!, env.testnet) };
}

export const feedFor = () => new HyperliquidFeed(liveEnv().testnet);

/** One full engine tick with locking and conflict-safe persistence. */
export async function tick(opts: { budgetMs?: number } = {}): Promise<{ ran: boolean; state?: EngineState; why?: string }> {
  if (!(await acquireLock())) return { ran: false, why: "Another engine cycle is running." };
  try {
    const { state, etag } = await loadState();
    const { broker, why } = brokerFor(state);
    let next: EngineState;
    const feed = feedFor();
    if (!broker) {
      next = { ...state, lastTick: { at: Date.now(), ms: 0, ok: false, error: why, notes: [why!] } };
    } else {
      next = await runCycle(state, { feed, broker, validationBudgetMs: opts.budgetMs ?? 9000 });
      try {
        const assets = await feed.assets(next.config.coins);
        next = recordEquity(next, await broker.equity(next, assets), Date.now());
      } catch { /* equity snapshot is best-effort */ }
    }
    if (!(await saveState(next, etag))) {
      // the dashboard changed settings during the tick — keep its control fields
      const fresh = await loadState();
      next = mergeControl(next, fresh.state);
      if (!(await saveState(next, fresh.etag))) return { ran: true, why: "State conflict — tick result discarded; next tick will retry." };
    }
    return { ran: true, state: next };
  } finally {
    await releaseLock();
  }
}

/** Manual close of one position (dashboard), under the engine lock. */
export async function closePosition(id: string): Promise<{ ok: boolean; note: string; state?: EngineState }> {
  if (!(await acquireLock())) return { ok: false, note: "An engine cycle is running — try again in a few seconds." };
  try {
    const { state, etag } = await loadState();
    const pos = state.positions.find((p) => p.id === id);
    if (!pos) return { ok: false, note: "Position not found." };
    const { broker, why } = brokerFor({ ...state, config: { ...state.config, mode: pos.mode }, killSwitch: true });
    if (!broker) return { ok: false, note: why ?? "No broker." };
    const feed = feedFor();
    const assets = await feed.assets([pos.coin]);
    const r = await broker.close(state, id, "manual close", assets, Date.now());
    const alerts = [{ id: Math.random().toString(36).slice(2, 9), at: Date.now(), level: r.ok ? ("info" as const) : ("critical" as const), msg: `Manual close ${pos.coin}: ${r.note}` }, ...r.s.alerts];
    const next = { ...r.s, alerts };
    if (!(await saveState(next, etag))) {
      const fresh = await loadState();
      await saveState(mergeControl(next, fresh.state), fresh.etag);
    }
    return { ok: r.ok, note: r.note, state: next };
  } finally {
    await releaseLock();
  }
}
