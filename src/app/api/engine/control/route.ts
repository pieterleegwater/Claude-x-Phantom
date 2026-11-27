import { NextResponse } from "next/server";
import { z } from "zod";
import { updateState } from "@/lib/engine/store";
import { closePosition, liveEnv, tick } from "@/lib/engine/runtime";
import { LIVE_CONFIRM_PHRASE, newEngineState, type EngineConfig } from "@/lib/engine/types";
import { engineAuth } from "@/lib/server/engineAuth";
import { limited } from "@/lib/server/respond";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

const COINS = ["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "AVAX", "LINK", "SUI", "BNB"];

const ConfigPatch = z
  .object({
    coins: z.array(z.enum(COINS as [string, ...string[]])).min(1).max(6),
    timeframes: z.array(z.enum(["5m", "15m", "1h"])).min(1).max(3),
    riskPerTradePct: z.number().min(0.1).max(1),
    maxDailyLossPct: z.number().min(0.5).max(3),
    maxWeeklyDrawdownPct: z.number().min(1).max(10),
    maxOpenPositions: z.number().int().min(1).max(4),
    maxTradesPerDay: z.number().int().min(1).max(20),
    cooldownMinAfterLoss: z.number().int().min(0).max(1440),
    maxLeverageLive: z.number().int().min(1).max(10),
    simLeverage: z.number().int().min(1).max(40),
    liveMinScore: z.number().int().min(80).max(100),
    paperMinScore: z.number().int().min(70).max(100),
    paperStartingEquity: z.number().min(10).max(1_000_000),
  })
  .partial()
  .strict();

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_auto"), on: z.boolean() }),
  z.object({ action: z.literal("set_config"), patch: ConfigPatch }),
  z.object({ action: z.literal("set_mode"), mode: z.enum(["paper", "live"]) }),
  z.object({ action: z.literal("arm_live"), confirm: z.string() }),
  z.object({ action: z.literal("disarm_live") }),
  z.object({ action: z.literal("stop_all") }),
  z.object({ action: z.literal("clear_stop") }),
  z.object({ action: z.literal("clear_halt") }),
  z.object({ action: z.literal("reset_paper") }),
  z.object({ action: z.literal("revalidate") }),
  z.object({ action: z.literal("tick") }),
  z.object({ action: z.literal("close_position"), id: z.string().min(1).max(64) }),
]);

const err = (error: string, status = 400) => NextResponse.json({ ok: false, error }, { status });

export async function POST(req: Request) {
  const rl = limited(req, "engine-control", 20);
  if (rl) return rl;
  const auth = engineAuth(req);
  if (!auth.configured) return err("Engine controls are disabled until ENGINE_ADMIN_TOKEN (≥16 characters) is set in the server environment.", 403);
  if (!auth.ok) return err("Invalid engine token.", 401);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return err(`Invalid request: ${e instanceof Error ? e.message.slice(0, 300) : "bad body"}`);
  }
  const now = Date.now();
  const note = (msg: string, level: "info" | "warn" | "critical" = "info") => ({ id: Math.random().toString(36).slice(2, 9), at: now, level, msg });
  try {
    switch (body.action) {
      case "tick": {
        const r = await tick({ budgetMs: 4000 });
        return NextResponse.json({ ok: true, ran: r.ran, why: r.why, state: r.state });
      }
      case "close_position": {
        const r = await closePosition(body.id);
        return r.ok ? NextResponse.json({ ok: true, state: r.state, note: r.note }) : err(r.note, 409);
      }
      case "stop_all": {
        await updateState((s) => ({ ...s, killSwitch: true, config: { ...s.config, autoTrading: false }, alerts: [note("STOP ALL pressed — automatic trading disabled, flattening all positions.", "critical"), ...s.alerts] }));
        const r = await tick({ budgetMs: 0 }); // the cycle closes every position when the kill switch is set
        return NextResponse.json({ ok: true, ran: r.ran, why: r.why ?? (r.ran ? undefined : "A cycle is running; positions will be flattened within a minute."), state: r.state });
      }
    }
    const state = await updateState((s) => {
      switch (body.action) {
        case "set_auto":
          if (body.on && s.killSwitch) throw new Error("Clear the emergency stop first.");
          return { ...s, config: { ...s.config, autoTrading: body.on }, alerts: [note(`Automatic trading ${body.on ? "ON" : "OFF"}.`), ...s.alerts] };
        case "set_config": {
          const config: EngineConfig = { ...s.config, ...body.patch } as EngineConfig;
          const coinsChanged = body.patch.coins || body.patch.timeframes;
          return { ...s, config, alerts: [note(`Settings updated: ${Object.keys(body.patch).join(", ")}.`), ...s.alerts], ...(coinsChanged ? { opportunities: [] } : {}) };
        }
        case "set_mode": {
          if (s.positions.some((p) => p.mode === s.config.mode)) throw new Error("Close all open positions before switching mode.");
          if (body.mode === "live") {
            const env = liveEnv();
            if (!env.enabled) throw new Error("LIVE_TRADING_ENABLED is not 'true' on the server.");
            if (!env.configured) throw new Error("HL_ACCOUNT_ADDRESS / HL_AGENT_PRIVATE_KEY missing or malformed on the server.");
          }
          // fresh daily/weekly baselines for the new account (re-initialised on the next tick)
          return { ...s, config: { ...s.config, mode: body.mode, autoTrading: false }, liveArmed: body.mode === "live" ? s.liveArmed : false, day: { key: "", startEquity: 0 }, week: { key: "", startEquity: 0, peak: 0 }, lossStreak: 0, tradesToday: 0, halted: null, alerts: [note(`Mode switched to ${body.mode.toUpperCase()} (automatic trading OFF until re-enabled).`, body.mode === "live" ? "warn" : "info"), ...s.alerts] };
        }
        case "arm_live":
          if (body.confirm.trim() !== LIVE_CONFIRM_PHRASE) throw new Error(`Type exactly: ${LIVE_CONFIRM_PHRASE}`);
          if (!liveEnv().enabled || !liveEnv().configured) throw new Error("Live trading is not enabled/configured on the server.");
          return { ...s, liveArmed: true, alerts: [note("LIVE trading armed by explicit confirmation.", "warn"), ...s.alerts] };
        case "disarm_live":
          if (s.positions.some((p) => p.mode === "live")) throw new Error("Live positions are open — use STOP ALL (closes them) instead of disarming.");
          return { ...s, liveArmed: false, config: { ...s.config, autoTrading: s.config.mode === "live" ? false : s.config.autoTrading }, alerts: [note("Live trading disarmed."), ...s.alerts] };
        case "clear_stop":
          return { ...s, killSwitch: false, alerts: [note("Emergency stop cleared (automatic trading stays OFF until you turn it on)."), ...s.alerts] };
        case "clear_halt":
          return { ...s, halted: null, week: { ...s.week, peak: s.week.peak }, alerts: [note("Halt cleared manually after review."), ...s.alerts] };
        case "reset_paper": {
          if (s.positions.some((p) => p.mode === "paper")) throw new Error("Close paper positions first.");
          const fresh = newEngineState(s.config);
          return { ...s, paperCash: s.config.paperStartingEquity, trades: s.trades.filter((t) => t.mode !== "paper"), equityHistory: fresh.equityHistory, day: fresh.day, week: fresh.week, lossStreak: 0, lastLossAt: null, tradesToday: 0, halted: null, alerts: [note("Paper account reset."), ...s.alerts] };
        }
        case "revalidate":
          return { ...s, validation: {}, alerts: [note("Validation cleared — strategies will be re-tested over the next ticks."), ...s.alerts] };
      }
      return s;
    });
    return NextResponse.json({ ok: true, state });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e), 409);
  }
}
