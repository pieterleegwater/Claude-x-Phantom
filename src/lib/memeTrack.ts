// Forward test of the memecoin scanner: every BUY signal that was shown is checked afterwards
// against the token's real pool candles. This measures what the scanner actually achieved —
// instead of trusting its quality score.
import type { Candle, HistoricalEdge, TradeSignal } from "./types";
import { wilson } from "./indicators";

export interface MemeOutcome {
  signalId: string;
  mint: string;
  symbol: string;
  time: number; // signal time (ms)
  entry: number;
  stop: number;
  tp1: number;
  score: number;
  status: "tp1" | "stop" | "open" | "expired";
  exitPct: number | null; // result if traded mechanically (TP1 / stop / 24h close)
  maxGainPct: number;
  maxDrawdownPct: number;
  gapCrash: boolean; // price fell far through the stop within one candle
  evaluatedAt: number;
}

export const HORIZON_MS = 24 * 3_600_000;

export function memeMint(sig: TradeSignal) {
  return sig.id.split("-")[1] ?? "";
}

/** One BUY per token per 12h window (repeat logs of the same setup must not inflate the sample). */
export function trackableSignals(log: TradeSignal[]): TradeSignal[] {
  const out: TradeSignal[] = [];
  const lastByMint = new Map<string, number>();
  for (const s of [...log].filter((x) => x.market === "SOL-MEME" && x.direction === "BUY" && x.stopLoss && x.takeProfits[0]).sort((a, b) => a.createdAt - b.createdAt)) {
    const m = memeMint(s);
    const prev = lastByMint.get(m);
    if (prev != null && s.createdAt - prev < 12 * 3_600_000) continue;
    lastByMint.set(m, s.createdAt);
    out.push(s);
  }
  return out;
}

/**
 * Walk candles after the signal: stop is checked before TP1 inside a candle (conservative).
 * Entry = signal price. In a crash candle that falls >15% through the stop, the exit is the
 * candle close (a stop/alert cannot fill at the stop price in a one-candle dump).
 */
export function evaluateSignal(sig: { id: string; mint: string; symbol: string; time: number; entry: number; stop: number; tp1: number; score: number }, candles: Candle[], now = Date.now()): MemeOutcome {
  const after = candles.filter((k) => k.time * 1000 >= sig.time && k.time * 1000 <= sig.time + HORIZON_MS).sort((a, b) => a.time - b.time);
  let maxGain = 0;
  let maxDd = 0;
  let status: MemeOutcome["status"] = "open";
  let exitPct: number | null = null;
  let gapCrash = false;
  for (const k of after) {
    maxGain = Math.max(maxGain, (k.high / sig.entry - 1) * 100);
    maxDd = Math.min(maxDd, (k.low / sig.entry - 1) * 100);
    if (k.low <= sig.stop) {
      status = "stop";
      gapCrash = k.low < sig.stop * 0.85;
      const fill = gapCrash ? Math.min(k.close, sig.stop) : Math.min(k.open, sig.stop);
      exitPct = (fill / sig.entry - 1) * 100;
      break;
    }
    if (k.high >= sig.tp1) {
      status = "tp1";
      exitPct = (sig.tp1 / sig.entry - 1) * 100;
      break;
    }
  }
  if (status === "open" && now - sig.time >= HORIZON_MS && after.length) {
    status = "expired";
    exitPct = (after[after.length - 1].close / sig.entry - 1) * 100;
  }
  return { signalId: sig.id, mint: sig.mint, symbol: sig.symbol, time: sig.time, entry: sig.entry, stop: sig.stop, tp1: sig.tp1, score: sig.score, status, exitPct, maxGainPct: maxGain, maxDrawdownPct: maxDd, gapCrash, evaluatedAt: now };
}

export interface TrackStats {
  total: number;
  resolved: number;
  tp1: number;
  stops: number;
  expired: number;
  open: number;
  hitRate: number | null; // TP1 before stop, among resolved
  hitRateCI: [number, number] | null;
  avgExitPct: number | null;
  gapCrashes: number;
  worstExitPct: number | null;
}

export function trackStats(outcomes: MemeOutcome[]): TrackStats {
  const resolved = outcomes.filter((o) => o.status !== "open");
  const tp1 = resolved.filter((o) => o.status === "tp1").length;
  const exits = resolved.map((o) => o.exitPct).filter((x): x is number => x != null);
  return {
    total: outcomes.length,
    resolved: resolved.length,
    tp1,
    stops: resolved.filter((o) => o.status === "stop").length,
    expired: resolved.filter((o) => o.status === "expired").length,
    open: outcomes.length - resolved.length,
    hitRate: resolved.length ? tp1 / resolved.length : null,
    hitRateCI: resolved.length ? wilson(tp1, resolved.length) : null,
    avgExitPct: exits.length ? exits.reduce((s, x) => s + x, 0) / exits.length : null,
    gapCrashes: resolved.filter((o) => o.gapCrash).length,
    worstExitPct: exits.length ? Math.min(...exits) : null,
  };
}

/** Shown on memecoin signals as their "measured history". */
export function scannerEdge(st: TrackStats): HistoricalEdge | null {
  if (!st.total) return null;
  return {
    strategyId: "meme-scanner",
    strategyName: "Scanner BUY signals (forward test)",
    trades: st.resolved,
    winRate: st.hitRate,
    winRateLow: st.hitRateCI?.[0] ?? null,
    winRateHigh: st.hitRateCI?.[1] ?? null,
    profitFactor: null,
    expectancyR: null,
    bars: 0,
    note:
      st.resolved < 20
        ? `Only ${st.resolved} finished BUY signals checked so far (TP1 hit before stop in ${st.tp1}). Far too few to trust — keep paper trading memecoins until there are at least 30.`
        : `Of ${st.resolved} past BUY signals, ${st.tp1} reached TP1 before the stop. Average mechanical result ${st.avgExitPct?.toFixed(1)}% per signal; ${st.gapCrashes} crashed through the stop in one candle. Measured on real pool candles after each signal.`,
  };
}
