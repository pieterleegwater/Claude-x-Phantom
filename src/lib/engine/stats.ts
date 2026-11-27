// Performance analytics for the engine dashboard (pure).
import type { ClosedTrade, EngineMode, EngineState } from "./types";

export interface PerfStats {
  trades: number;
  wins: number;
  winRate: number | null;
  netUsd: number;
  avgR: number | null;
  profitFactor: number | null;
  maxDrawdownUsd: number;
  feesUsd: number;
  fundingUsd: number;
  best: ClosedTrade | null;
  worst: ClosedTrade | null;
}

export function perf(trades: ClosedTrade[]): PerfStats {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const gw = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = -trades.filter((t) => t.pnlUsd < 0).reduce((a, t) => a + t.pnlUsd, 0);
  // drawdown on the cumulative realized curve (chronological)
  let eq = 0, peak = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.closedAt - b.closedAt)) { eq += t.pnlUsd; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const sorted = [...trades].sort((a, b) => b.pnlUsd - a.pnlUsd);
  return {
    trades: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length : null,
    netUsd: trades.reduce((a, t) => a + t.pnlUsd, 0), avgR: trades.length ? trades.reduce((a, t) => a + t.r, 0) / trades.length : null,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null, maxDrawdownUsd: dd, feesUsd: trades.reduce((a, t) => a + t.feesUsd, 0),
    fundingUsd: trades.reduce((a, t) => a + t.fundingUsd, 0), best: sorted[0] ?? null, worst: sorted[sorted.length - 1] ?? null,
  };
}

export function byStrategy(trades: ClosedTrade[]) {
  const m: Record<string, ClosedTrade[]> = {};
  for (const t of trades) (m[t.strategyId] ??= []).push(t);
  return Object.entries(m).map(([id, ts]) => ({ id, ...perf(ts) })).sort((a, b) => b.netUsd - a.netUsd);
}

export function periodPnl(s: EngineState, mode: EngineMode, now = Date.now()) {
  const ts = s.trades.filter((t) => t.mode === mode);
  const day = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const week = Date.parse(s.week.key || "1970-01-01");
  return {
    today: ts.filter((t) => t.closedAt >= day).reduce((a, t) => a + t.pnlUsd, 0),
    week: ts.filter((t) => t.closedAt >= week).reduce((a, t) => a + t.pnlUsd, 0),
  };
}

/** Unrealized PnL of an open position at price px (before exit costs). */
export const unrealized = (p: { side: "long" | "short"; entry: number; qty: number }, px: number) => (p.side === "long" ? 1 : -1) * (px - p.entry) * p.qty;
