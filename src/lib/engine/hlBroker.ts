// LIVE broker: Hyperliquid perpetuals through the official API (SDK @nktkas/hyperliquid).
//
// Security model
//  - Uses an API ("agent") wallet approved by the user's master account. Agent wallets can place
//    and cancel orders but CANNOT withdraw funds. The master private key / seed phrase is never
//    requested or stored. The agent key lives only in a server environment variable.
//  - Never constructed unless LIVE_TRADING_ENABLED=true on the server AND the user armed live
//    mode in the dashboard (typed confirmation) — see runtime.ts.
//
// Execution guarantees (each verified against exchange responses, never assumed)
//  - Entries are IOC limits with a slippage cap. Whatever the order call returns (success, error,
//    timeout), the position is read back from clearinghouseState before anything else happens.
//  - A reduce-only stop-market trigger is placed immediately and verified in frontendOpenOrders.
//    If it cannot be placed/verified (one retry), the position is closed at market and the flat
//    state is verified. If even that fails, the position stays tracked as UNPROTECTED and every
//    cycle retries protection/close until the exchange confirms.
//  - Exchange (order) calls are never blindly retried — a retry could double an order. Read-only
//    info calls are retried once.
//  - Stop moves place the new stop first and only then cancel the old one.
//  - sync() reconciles with the venue every cycle: closes, partial fills, size mismatches, missing
//    stops, and positions the engine does not know about (adopted when they match a pending
//    entry; otherwise closed if unprotected).
//  - flattenAll() (STOP ALL) closes every position, cancels every order and only reports success
//    when the exchange shows zero positions and zero open orders.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { AssetInfo, MarketFeed } from "./market";
import type { Broker, BrokerResult, EntryIntent, FlattenResult } from "./broker";
import { finalizeTrade } from "./broker";
import { HL_MIN_NOTIONAL, roundPrice, roundSizeDown } from "./riskGovernor";
import type { EngineMode, EnginePosition, EngineState } from "./types";

const ENTRY_SLIPPAGE_CAP = 0.003; // IOC entry: max 0.3% worse than the reference price
const CLOSE_SLIPPAGE_CAP = 0.01; // market closes / triggered stops: 1% cap
const PENDING_TTL = 10 * 60_000;

export function fmtPx(px: number, szDecimals: number) {
  return roundPrice(px, szDecimals).toFixed(Math.max(0, 6 - szDecimals)).replace(/\.0+$|(\.\d*?)0+$/, "$1");
}
export const fmtSz = (q: number, szDecimals: number) => roundSizeDown(q, szDecimals).toFixed(szDecimals);

type Status = { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string } | string;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The subset of the SDK the broker uses — lets tests drive the broker against a scripted exchange. */
export interface HlInfo {
  clearinghouseState(p: { user: `0x${string}` }): Promise<{ assetPositions: { position: { coin: string; szi: string; entryPx: string; liquidationPx: string | null } }[]; marginSummary: { accountValue: string }; withdrawable: string }>;
  frontendOpenOrders(p: { user: `0x${string}` }): Promise<{ coin: string; oid: number; sz: string; isTrigger: boolean; reduceOnly: boolean; triggerPx: string; side: string; limitPx: string }[]>;
  allMids(): Promise<Record<string, string>>;
  userFillsByTime(p: { user: `0x${string}`; startTime: number; endTime?: number }): Promise<{ coin: string; px: string; sz: string; fee: string; closedPnl: string; dir: string; oid: number; time: number }[]>;
  userFunding(p: { user: `0x${string}`; startTime: number; endTime?: number }): Promise<{ delta: { coin: string; usdc: string } }[]>;
}
export interface HlExchange {
  order(p: { orders: unknown[]; grouping: "na" }): Promise<{ response: { data: { statuses: unknown[] } } }>;
  cancel(p: { cancels: { a: number; o: number }[] }): Promise<unknown>;
  updateLeverage(p: { asset: number; isCross: boolean; leverage: number }): Promise<unknown>;
}

export interface HlBrokerOptions { isTestnet?: boolean; clients?: { info: HlInfo; ex: HlExchange }; verifyDelayMs?: number }

type VenuePos = { szi: number; entryPx: number; liq: number | null };

export class HyperliquidBroker implements Broker {
  mode: EngineMode = "live";
  private info: HlInfo;
  private ex: HlExchange;
  private verifyDelayMs: number;
  constructor(private user: `0x${string}`, agentKey: `0x${string}` | null, opts: HlBrokerOptions = {}) {
    if (opts.clients) { this.info = opts.clients.info; this.ex = opts.clients.ex; }
    else {
      if (!agentKey) throw new Error("agent key required");
      const transport = new HttpTransport({ isTestnet: !!opts.isTestnet, timeout: 10_000 });
      this.info = new InfoClient({ transport }) as unknown as HlInfo;
      this.ex = new ExchangeClient({ transport, wallet: privateKeyToAccount(agentKey) }) as unknown as HlExchange;
    }
    this.verifyDelayMs = opts.verifyDelayMs ?? 400;
  }

  /** Read-only calls: one retry on failure (safe — no side effects). */
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch { await sleep(this.verifyDelayMs); return fn(); }
  }

  async venue() {
    const st = await this.read(() => this.info.clearinghouseState({ user: this.user }));
    const pos: Record<string, VenuePos> = {};
    for (const ap of st.assetPositions) {
      const p = ap.position;
      if (Number(p.szi) !== 0) pos[p.coin] = { szi: Number(p.szi), entryPx: Number(p.entryPx), liq: p.liquidationPx ? Number(p.liquidationPx) : null };
    }
    return { pos, equity: Number(st.marginSummary.accountValue), withdrawable: Number(st.withdrawable) };
  }
  private openOrders() { return this.read(() => this.info.frontendOpenOrders({ user: this.user })); }
  private async mid(coin: string, fallback: number) {
    try { const m = Number((await this.read(() => this.info.allMids()))[coin]); return m > 0 ? m : fallback; } catch { return fallback; }
  }

  async equity() { return (await this.venue()).equity; }

  private async place(o: { a: number; b: boolean; p: string; s: string; r: boolean; t: unknown }): Promise<Status> {
    const res = await this.ex.order({ orders: [o], grouping: "na" });
    return res.response.data.statuses[0] as Status;
  }

  /** Place a reduce-only stop-market and verify it rests on the book. Returns the oid or null. */
  async placeStop(asset: AssetInfo, side: "long" | "short", qty: number, stop: number): Promise<number | null> {
    const isBuy = side === "short";
    const trig = fmtPx(stop, asset.szDecimals);
    const lim = fmtPx(isBuy ? stop * (1 + CLOSE_SLIPPAGE_CAP) : stop * (1 - CLOSE_SLIPPAGE_CAP), asset.szDecimals);
    const st = await this.place({ a: asset.assetIndex, b: isBuy, p: lim, s: fmtSz(qty, asset.szDecimals), r: true, t: { trigger: { isMarket: true, triggerPx: trig, tpsl: "sl" } } });
    if (typeof st === "object" && st.error) throw new Error(st.error);
    const oid = typeof st === "object" ? st.resting?.oid ?? st.filled?.oid : undefined;
    for (let k = 0; k < 2; k++) {
      const oo = await this.openOrders();
      const found = oo.find((o) => o.coin === asset.coin && o.isTrigger && o.reduceOnly && (oid == null ? Math.abs(Number(o.triggerPx) - Number(trig)) < 1e-9 : o.oid === oid));
      if (found) return found.oid;
      await sleep(this.verifyDelayMs);
    }
    return null;
  }

  /** Reduce-only IOC market close, then VERIFY the remaining venue size. */
  async marketClose(asset: AssetInfo, side: "long" | "short", qty: number): Promise<{ ok: boolean; remaining: number; note: string }> {
    const isBuy = side === "short";
    const ref = await this.mid(asset.coin, asset.markPx);
    const px = isBuy ? ref * (1 + CLOSE_SLIPPAGE_CAP) : ref * (1 - CLOSE_SLIPPAGE_CAP);
    let note = "";
    try {
      const st = await this.place({ a: asset.assetIndex, b: isBuy, p: fmtPx(px, asset.szDecimals), s: fmtSz(qty, asset.szDecimals), r: true, t: { limit: { tif: "Ioc" } } });
      if (typeof st === "object" && st.error) note = st.error;
    } catch (e) { note = errMsg(e); }
    const v = (await this.venue()).pos[asset.coin];
    const remaining = v ? Math.abs(v.szi) : 0;
    return { ok: remaining === 0, remaining, note: remaining === 0 ? "flat (verified)" : `${remaining} still open${note ? ` — ${note}` : ""}` };
  }

  private async cancel(asset: AssetInfo, oid: number | null | undefined) {
    if (oid == null) return;
    try { await this.ex.cancel({ cancels: [{ a: asset.assetIndex, o: oid }] }); } catch { /* already gone (filled/cancelled) — verified by callers */ }
  }

  /** Protect a venue position: stop (verified) or, failing that, close at market (verified). */
  private async protect(a: AssetInfo, side: "long" | "short", qty: number, stop: number) {
    let err = "";
    for (let k = 0; k < 2; k++) {
      try { const oid = await this.placeStop(a, side, qty, stop); if (oid != null) return { oid, closed: false, note: "" }; err = "stop not found on the book after placement"; }
      catch (e) { err = errMsg(e); }
    }
    const c = await this.marketClose(a, side, qty);
    return { oid: null, closed: c.ok, remaining: c.remaining, note: `stop-loss could not be placed/verified (${err}); ${c.ok ? "position closed at market (verified flat)" : `EMERGENCY CLOSE FAILED: ${c.note} — CHECK HYPERLIQUID NOW`}` };
  }

  async open(s0: EngineState, x: EntryIntent, now: number): Promise<BrokerResult> {
    const a = x.asset;
    let s = s0;
    try {
      const before = await this.venue();
      if (before.pos[a.coin]) return { s: s0, ok: false, note: `Venue already has a ${a.coin} position — no duplicate entries.` };
      if (s0.pendingEntry && now - s0.pendingEntry.at < PENDING_TTL) return { s: s0, ok: false, note: `An earlier ${s0.pendingEntry.coin} entry is still unverified — no new entries until it is reconciled.` };
      const notional = x.qty * x.refPrice;
      if (notional < HL_MIN_NOTIONAL) return { s: s0, ok: false, note: `Order value $${notional.toFixed(2)} below Hyperliquid's $${HL_MIN_NOTIONAL} minimum — skipped (size is never increased to meet it).` };
      const margin = notional / Math.max(1, Math.floor(x.leverage));
      if (margin * 1.05 > before.withdrawable) return { s: s0, ok: false, note: `Insufficient free margin: need ≈$${margin.toFixed(2)}, available $${before.withdrawable.toFixed(2)}.` };

      await this.ex.updateLeverage({ asset: a.assetIndex, isCross: false, leverage: Math.max(1, Math.floor(x.leverage)) });
      // mark the entry as pending BEFORE sending: if we crash/time out, the next sync adopts the fill
      s = { ...s0, pendingEntry: { coin: a.coin, side: x.side, at: now, stop: x.stop, tps: x.tps, tf: x.tf, strategyId: x.strategyId, exitProfile: x.exitProfile, score: x.score, thesis: x.thesis, leverage: x.leverage } };
      const isBuy = x.side === "long";
      const lim = isBuy ? x.refPrice * (1 + ENTRY_SLIPPAGE_CAP) : x.refPrice * (1 - ENTRY_SLIPPAGE_CAP);
      let orderNote = "";
      try {
        const st = await this.place({ a: a.assetIndex, b: isBuy, p: fmtPx(lim, a.szDecimals), s: fmtSz(x.qty, a.szDecimals), r: false, t: { limit: { tif: "Ioc" } } });
        if (typeof st === "object" && st.error) orderNote = st.error;
        else if (typeof st === "object" && !st.filled) orderNote = "no fill";
      } catch (e) {
        orderNote = `order call failed (${errMsg(e)}) — checking the exchange`;
      }
      // VERIFY against the venue regardless of what the order call said
      let vp: VenuePos | undefined;
      try { vp = (await this.venue()).pos[a.coin]; }
      catch (e) { return { s, ok: false, critical: true, note: `Entry state UNKNOWN (${orderNote || "sent"}; venue read failed: ${errMsg(e)}). The next cycle reconciles and protects any fill.` }; }
      if (!vp) return { s: { ...s, pendingEntry: null }, ok: false, note: `Entry not filled — ${orderNote || `IOC found no liquidity within ${ENTRY_SLIPPAGE_CAP * 100}%`} (verified: no position).` };
      return this.adopt({ ...s, pendingEntry: null }, a, vp, x, now, orderNote);
    } catch (e) {
      return { s, ok: false, critical: !!s.pendingEntry, note: `Live entry error: ${errMsg(e)} — the next cycle reconciles with Hyperliquid.` };
    }
  }

  /** Take ownership of a verified venue position: protect it, place targets, track it. */
  private async adopt(s: EngineState, a: AssetInfo, vp: VenuePos, x: Pick<EntryIntent, "stop" | "tps" | "tf" | "strategyId" | "exitProfile" | "score" | "thesis" | "leverage">, now: number, orderNote = ""): Promise<BrokerResult> {
    const qty = Math.abs(vp.szi);
    const side: "long" | "short" = vp.szi > 0 ? "long" : "short";
    const sgn = side === "long" ? 1 : -1;
    const partial = orderNote && /partial/i.test(orderNote) ? " (partial fill)" : "";
    if (sgn * (vp.entryPx - x.stop) <= 0) {
      const c = await this.marketClose(a, side, qty);
      return c.ok
        ? { s, ok: false, critical: true, note: `Filled beyond the planned stop — closed at market (verified flat).` }
        : { s: { ...s, positions: [...s.positions, this.record(a, side, qty, vp, x, null, [], now, true)] }, ok: false, critical: true, note: `Filled beyond the stop and EMERGENCY CLOSE FAILED (${c.note}) — tracked as UNPROTECTED, retried every cycle.` };
    }
    const prot = await this.protect(a, side, qty, x.stop);
    if (prot.oid == null) {
      if (prot.closed) return { s, ok: false, critical: true, note: `EMERGENCY: ${prot.note}.` };
      return { s: { ...s, positions: [...s.positions, this.record(a, side, prot.remaining ?? qty, vp, x, null, [], now, true)] }, ok: false, critical: true, note: `EMERGENCY: ${prot.note}. Position tracked as UNPROTECTED; protection retried every cycle.` };
    }
    // targets: reduce-only GTC limits. A target below the $10 minimum is merged into the next one.
    const tps: EnginePosition["tps"] = [];
    let remaining = qty;
    let carry = 0;
    for (let k = 0; k < x.tps.length; k++) {
      const t = x.tps[k];
      const last = k === x.tps.length - 1;
      let q = last ? remaining : Math.min(remaining, roundSizeDown((qty * (t.pct + carry)) / 100, a.szDecimals));
      if (!last && q * t.price < HL_MIN_NOTIONAL) { carry += t.pct; tps.push({ price: t.price, pct: 0, filled: false, oid: null }); continue; }
      carry = 0;
      let oid: number | null = null;
      if (q > 0 && q * t.price >= HL_MIN_NOTIONAL) {
        try {
          const r = await this.place({ a: a.assetIndex, b: side === "short", p: fmtPx(t.price, a.szDecimals), s: fmtSz(q, a.szDecimals), r: true, t: { limit: { tif: "Gtc" } } });
          oid = typeof r === "object" ? r.resting?.oid ?? r.filled?.oid ?? null : null;
        } catch { oid = null; }
      } else q = 0;
      if (oid != null) remaining = Math.max(0, remaining - q);
      tps.push({ price: t.price, pct: oid != null ? (q / qty) * 100 : 0, filled: false, oid });
    }
    const pos = this.record(a, side, qty, vp, x, prot.oid, tps, now, false);
    const tpNote = tps.some((t) => t.oid == null) ? " Some targets were merged/skipped (Hyperliquid $10 minimum) — the stop and trailing logic manage the rest." : "";
    return { s: { ...s, positions: [...s.positions, pos] }, ok: true, note: `LIVE ${side} ${qty} ${a.coin} filled @ ${vp.entryPx} (verified on Hyperliquid)${partial}; stop ${x.stop} verified on the book (oid ${prot.oid}).${tpNote}` };
  }

  private record(a: AssetInfo, side: "long" | "short", qty: number, vp: VenuePos, x: Pick<EntryIntent, "stop" | "tf" | "strategyId" | "exitProfile" | "score" | "thesis" | "leverage">, slOid: number | null, tps: EnginePosition["tps"], now: number, unprotected: boolean): EnginePosition {
    return {
      id: uid(), mode: "live", coin: a.coin, side, qty, initialQty: qty, entry: vp.entryPx, stop: x.stop, initialStop: x.stop, risk: Math.max(Math.abs(vp.entryPx - x.stop), vp.entryPx * 1e-4), tps, leverage: x.leverage,
      liqPrice: vp.liq, openedAt: now, barsHeld: 0, tf: x.tf, strategyId: x.strategyId, exitProfile: x.exitProfile, score: x.score, thesis: x.thesis,
      beMoved: false, trailingActive: false, feesUsd: 0, fundingUsd: 0, realizedUsd: 0, lastPrice: vp.entryPx, maxFavorableR: 0, slOid, lastFundingAt: now, unprotected,
    };
  }

  async moveStop(s0: EngineState, posId: string, stop: number, assets: Record<string, AssetInfo>): Promise<BrokerResult> {
    const p = s0.positions.find((x) => x.id === posId);
    const a = p && assets[p.coin];
    if (!p || !a) return { s: s0, ok: false, note: "position/asset not found" };
    try {
      const oid = await this.placeStop(a, p.side, p.qty, stop); // new first…
      if (oid == null) return { s: s0, ok: false, note: "new stop not verified — old stop kept" };
      await this.cancel(a, p.slOid); // …then remove the old one
      return { s: { ...s0, positions: s0.positions.map((x) => (x.id === posId ? { ...x, stop, slOid: oid, unprotected: false } : x)) }, ok: true, note: `stop moved to ${stop} (verified)` };
    } catch (e) {
      return { s: s0, ok: false, note: `stop move failed: ${errMsg(e)} — old stop kept` };
    }
  }

  async close(s0: EngineState, posId: string, reason: string, assets: Record<string, AssetInfo>, now: number): Promise<BrokerResult> {
    const p = s0.positions.find((x) => x.id === posId);
    const a = p && assets[p.coin];
    if (!p || !a) return { s: s0, ok: false, note: "position/asset not found" };
    try {
      const v = (await this.venue()).pos[p.coin];
      if (v) {
        const c = await this.marketClose(a, p.side, Math.abs(v.szi));
        if (!c.ok) return { s: { ...s0, positions: s0.positions.map((x) => (x.id === p.id ? { ...x, qty: c.remaining } : x)) }, ok: false, critical: true, note: `close not completed: ${c.note}; the stop stays in place and the close is retried` };
      }
      const left = await this.cancelReduceOnly(a);
      const b = await this.bookFills(p, now);
      return { s: finalizeTrade(s0, b, 0, 0, reason, now), ok: true, note: `${p.coin} closed on Hyperliquid (verified flat${left ? `; ${left} order(s) could not be cancelled` : ""}): ${reason}` };
    } catch (e) {
      return { s: s0, ok: false, critical: true, note: `close error: ${errMsg(e)}` };
    }
  }

  /** Cancel resting reduce-only orders for a coin; returns how many are still open afterwards. */
  private async cancelReduceOnly(a: AssetInfo) {
    const oo = await this.openOrders();
    for (const o of oo.filter((o) => o.coin === a.coin && o.reduceOnly)) await this.cancel(a, o.oid);
    return (await this.openOrders()).filter((o) => o.coin === a.coin && o.reduceOnly).length;
  }

  /** Realized PnL, fees, funding and exit prices from actual venue fills. */
  private async bookFills(p0: EnginePosition, now: number) {
    const p = { ...p0 };
    try {
      const fills = await this.read(() => this.info.userFillsByTime({ user: this.user, startTime: p.openedAt - 5_000, endTime: now + 60_000 }));
      const mine = fills.filter((f) => f.coin === p.coin);
      const closing = mine.filter((f) => /^Close/.test(f.dir) || Number(f.closedPnl) !== 0);
      p.feesUsd = mine.reduce((t, f) => t + Number(f.fee), 0);
      p.realizedUsd = closing.reduce((t, f) => t + Number(f.closedPnl), 0) - p.feesUsd;
      p.exitQty = closing.reduce((t, f) => t + Number(f.sz), 0);
      p.exitNotional = closing.reduce((t, f) => t + Number(f.sz) * Number(f.px), 0);
      const fund = await this.read(() => this.info.userFunding({ user: this.user, startTime: p.openedAt, endTime: now }));
      p.fundingUsd = -fund.filter((f) => f.delta.coin === p.coin).reduce((t, f) => t + Number(f.delta.usdc), 0);
    } catch { /* fills unavailable: PnL recorded as 0 and flagged by the caller's alert */ }
    return p;
  }

  async sync(s0: EngineState, _feed: MarketFeed, assets: Record<string, AssetInfo>, now: number) {
    let s = s0;
    const notes: string[] = [];
    let { pos } = await this.venue();
    let oo = await this.openOrders();
    let touched = false;
    // 1) positions on the venue the engine does not track
    for (const [coin, v] of Object.entries(pos)) {
      if (s.positions.some((p) => p.mode === "live" && p.coin === coin)) continue;
      const a = assets[coin];
      const pe = s.pendingEntry;
      if (a && pe && pe.coin === coin && (v.szi > 0 ? "long" : "short") === pe.side && now - pe.at < PENDING_TTL) {
        const r = await this.adopt({ ...s, pendingEntry: null }, a, v, pe, now, "recovered after an unconfirmed order call");
        s = r.s;
        touched = true;
        notes.push(`EMERGENCY recovery ${coin}: entry was filled although the order call did not confirm — ${r.note}`);
        continue;
      }
      const hasStop = oo.some((o) => o.coin === coin && o.isTrigger && o.reduceOnly);
      if (a && !hasStop && s.config.coins.includes(coin)) {
        const c = await this.marketClose(a, v.szi > 0 ? "long" : "short", Math.abs(v.szi));
        touched = true;
        notes.push(`EMERGENCY ${coin}: untracked position WITHOUT a stop-loss found on Hyperliquid — ${c.ok ? "closed at market (verified flat)" : `close FAILED (${c.note})`}.`);
      } else notes.push(`EMERGENCY check: untracked ${coin} position on Hyperliquid${hasStop ? " (it has a stop)" : ""} — the engine will not trade ${coin} until it is closed.`);
    }
    if (s.pendingEntry && (now - s.pendingEntry.at >= PENDING_TTL || !pos[s.pendingEntry.coin])) s = { ...s, pendingEntry: null };
    if (touched) { oo = await this.openOrders(); pos = (await this.venue()).pos; } // fresh view after recovery actions
    // 2) tracked positions
    for (const p of s.positions.filter((x) => x.mode === "live")) {
      const v = pos[p.coin];
      const a = assets[p.coin];
      if (!v) {
        if (a) await this.cancelReduceOnly(a).catch(() => 0);
        const b = await this.bookFills(p, now);
        const slGone = p.slOid != null && !oo.some((o) => o.oid === p.slOid);
        const reason = slGone ? (p.trailingActive ? "trailing stop" : p.beMoved ? "break-even stop" : "stop-loss") : p.tps.some((t) => t.filled) ? "take-profit" : "closed on venue";
        s = finalizeTrade(s, b, 0, 0, reason, now);
        notes.push(`${p.coin} ${p.side} closed on Hyperliquid: ${reason} (verified from fills).`);
        continue;
      }
      const qty = Math.abs(v.szi);
      const sideNow: "long" | "short" = v.szi > 0 ? "long" : "short";
      if (sideNow !== p.side) notes.push(`EMERGENCY ${p.coin}: venue side ${sideNow} differs from tracked ${p.side} — re-protecting the real position.`);
      if (Math.abs(qty - p.qty) > 1e-12) notes.push(`${p.coin}: venue size ${qty} differs from tracked ${p.qty} — reconciled to the exchange.`);
      const tps = p.tps.map((t) => ({ ...t, filled: t.filled || (t.oid != null && !oo.some((o) => o.oid === t.oid)) }));
      for (const [k, t] of tps.entries()) if (t.filled && !p.tps[k].filled) notes.push(`${p.coin} take-profit filled at ${t.price} (verified).`);
      let slOid = p.slOid ?? null;
      let unprotected = !!p.unprotected;
      const sl = oo.find((o) => o.oid === slOid);
      const sizeOk = sl && Math.abs(Number(sl.sz) - qty) <= 10 ** -(a?.szDecimals ?? 8) / 2;
      if (a && (!sl || !sizeOk || sideNow !== p.side)) {
        const prot = await this.protect(a, sideNow, qty, p.stop);
        if (prot.oid != null) { if (sl) await this.cancel(a, sl.oid); slOid = prot.oid; unprotected = false; notes.push(`${p.coin}: stop re-synced to ${qty} @ ${p.stop} (verified).`); }
        else if (prot.closed) { const b = await this.bookFills(p, now); s = finalizeTrade(s, b, 0, 0, "emergency close (stop could not be restored)", now); notes.push(`EMERGENCY ${p.coin}: ${prot.note}.`); continue; }
        else { unprotected = true; notes.push(`EMERGENCY ${p.coin}: ${prot.note}.`); }
      }
      const px = a ? await this.mid(p.coin, a.markPx) : p.lastPrice;
      s = { ...s, positions: s.positions.map((x) => (x.id === p.id ? { ...x, side: sideNow, qty, tps, slOid, unprotected, liqPrice: v.liq, lastPrice: px, maxFavorableR: Math.max(x.maxFavorableR, ((sideNow === "long" ? 1 : -1) * (px - x.entry)) / x.risk) } : x)) };
    }
    return { s, notes };
  }

  /** STOP ALL: close every position, cancel every order, confirm the final state on the exchange. */
  async flattenAll(s0: EngineState, assets: Record<string, AssetInfo>, now: number): Promise<FlattenResult> {
    const report: string[] = [];
    let s = s0;
    const indexOf = (coin: string) => assets[coin];
    const before = await this.venue();
    const orders = await this.openOrders();
    // 1) cancel non-reduce-only (entry) orders first so nothing new can fill
    for (const o of orders.filter((o) => !o.reduceOnly)) { const a = indexOf(o.coin); if (a) await this.cancel(a, o.oid); else report.push(`Cannot cancel ${o.coin} order ${o.oid}: asset metadata missing.`); }
    // 2) close every position at market (verified)
    for (const [coin, v] of Object.entries(before.pos)) {
      const a = indexOf(coin);
      if (!a) { report.push(`Cannot close ${coin}: asset metadata missing.`); continue; }
      const c = await this.marketClose(a, v.szi > 0 ? "long" : "short", Math.abs(v.szi));
      report.push(`${coin}: ${c.ok ? "closed (verified flat)" : `NOT closed — ${c.note}`}`);
    }
    // 3) cancel remaining (protective) orders
    for (const o of await this.openOrders()) { const a = indexOf(o.coin); if (a) await this.cancel(a, o.oid); }
    // 4) confirm with the exchange
    const after = await this.venue();
    const left = await this.openOrders();
    const confirmed = Object.keys(after.pos).length === 0 && left.length === 0;
    report.push(confirmed ? "Hyperliquid confirms: 0 open positions, 0 open orders." : `Hyperliquid still shows ${Object.keys(after.pos).length} position(s) and ${left.length} order(s) — retried next cycle.`);
    for (const p of s.positions.filter((x) => x.mode === "live")) {
      if (after.pos[p.coin]) continue;
      s = finalizeTrade(s, await this.bookFills(p, now), 0, 0, "EMERGENCY STOP", now);
    }
    return { s: { ...s, pendingEntry: null }, ok: confirmed, confirmed, note: report.join(" "), report };
  }
}
