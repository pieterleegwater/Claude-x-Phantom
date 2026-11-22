// Event-driven bar-by-bar backtester with walk-forward validation.
//
// Bias controls:
//  * Signals are computed at the close of bar i using data <= i only.
//  * Entries fill at the OPEN of bar i+1 (plus slippage) — never at the signal close.
//  * If stop and target are both touched inside one bar, the STOP is assumed first.
//  * Gaps through a stop fill at the (worse) open price.
//  * Fees (taker, both sides), slippage (both sides) and funding (perps) are charged.
//  * Walk-forward: parameters are chosen on an in-sample window and evaluated on the
//    following unseen out-of-sample window; only OOS results are stitched together.
import type { Candle } from "./types";
import { Indicators, type Strategy, type StrategyContext, type OpenPos } from "./strategies";
import { ema, adx, atr, percentileRank, wilson } from "./indicators";

export interface BacktestConfig {
  initialEquity: number;
  riskPct: number; // % equity risked per trade
  feeBps: number; // taker fee per side
  slippageBps: number; // per side
  maxLeverage: number; // caps notional at equity * maxLeverage
  /** constant funding per 8h (fraction) used when no series is provided; positive = longs pay */
  fundingPer8h: number;
  funding?: (number | null)[]; // optional aligned funding series (8h fraction)
  startIndex?: number;
  endIndex?: number; // exclusive
}

export const DEFAULT_BT: BacktestConfig = {
  initialEquity: 10_000,
  riskPct: 1,
  feeBps: 5,
  slippageBps: 3,
  maxLeverage: 3,
  fundingPer8h: 0.0001,
};

export type Regime = "Uptrend" | "Downtrend" | "Range" | "High volatility";

export interface Trade {
  side: "long" | "short";
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  stop: number;
  target: number | null;
  qty: number;
  pnl: number; // net USD after fees, slippage and funding
  r: number; // net R multiple
  fees: number;
  slippage: number;
  funding: number;
  bars: number;
  exitReason: "stop" | "target" | "signal" | "end";
  regime: Regime;
  reason: string;
}

export interface Metrics {
  trades: number;
  wins: number;
  winRate: number | null;
  winRateCI: [number, number] | null;
  profitFactor: number | null;
  totalReturnPct: number;
  maxDrawdownPct: number;
  avgWin: number | null;
  avgLoss: number | null;
  avgWinR: number | null;
  avgLossR: number | null;
  expectancyR: number | null;
  sharpe: number | null; // annualised from per-bar equity returns; null when sample too small
  fees: number;
  slippage: number;
  funding: number;
  exposurePct: number;
  buyHoldReturnPct: number;
}

export interface BacktestResult {
  trades: Trade[];
  equity: { time: number; equity: number }[];
  metrics: Metrics;
  byRegime: Record<Regime, { trades: number; winRate: number | null; pnl: number; expectancyR: number | null }>;
}

export function regimeSeries(c: Candle[]): Regime[] {
  const close = c.map((k) => k.close);
  const e200 = ema(close, 200);
  const e50 = ema(close, 50);
  const x = adx(c, 14);
  const a = atr(c, 14);
  const atrPct = a.map((v, i) => v / close[i]);
  return c.map((_, i) => {
    const window = atrPct.slice(Math.max(0, i - 300), i + 1);
    if (percentileRank(window, atrPct[i]) > 90 && window.length > 50) return "High volatility";
    const trendRef = Number.isFinite(e200[i]) ? e200[i] : e50[i];
    if (!Number.isFinite(x[i]) || !Number.isFinite(trendRef)) return "Range";
    if (x[i] > 22 && close[i] > trendRef) return "Uptrend";
    if (x[i] > 22 && close[i] < trendRef) return "Downtrend";
    return "Range";
  });
}

export function runBacktest(c: Candle[], strategy: Strategy, params: Record<string, number>, cfg: BacktestConfig = DEFAULT_BT, cache?: { ind?: Indicators; regimes?: Regime[] }): BacktestResult {
  const ind = cache?.ind ?? new Indicators(c);
  const regimes = cache?.regimes ?? regimeSeries(c);
  const ctx: StrategyContext = { c, ind, p: params, funding: cfg.funding };
  const start = Math.max(cfg.startIndex ?? 0, strategy.warmup(params), 2);
  const end = Math.min(cfg.endIndex ?? c.length, c.length);
  const barSec = c.length > 1 ? c[1].time - c[0].time : 3600;
  const fee = cfg.feeBps / 10_000;
  const slip = cfg.slippageBps / 10_000;

  let equity = cfg.initialEquity;
  const trades: Trade[] = [];
  const curve: { time: number; equity: number }[] = [];
  let pos: (OpenPos & { qty: number; target: number | null; fees: number; slippage: number; funding: number; reason: string; regime: Regime; riskUsd: number }) | null = null;
  let exitNextOpen = false;
  let barsInMarket = 0;

  const close = (i: number, rawPrice: number, reason: Trade["exitReason"], time: number) => {
    if (!pos) return;
    const px = pos.side === "long" ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const slipCost = Math.abs(px - rawPrice) * pos.qty;
    const exitFee = px * pos.qty * fee;
    const gross = (pos.side === "long" ? px - pos.entry : pos.entry - px) * pos.qty;
    const pnl = gross - exitFee - pos.fees - pos.funding; // entry fee was stored in pos.fees
    equity += gross - exitFee - pos.funding; // entry fee already deducted at entry
    trades.push({
      side: pos.side,
      entryTime: c[pos.entryIndex].time,
      exitTime: time,
      entry: pos.entry,
      exit: px,
      stop: pos.stop,
      target: pos.target,
      qty: pos.qty,
      pnl,
      r: pos.riskUsd > 0 ? pnl / pos.riskUsd : 0,
      fees: pos.fees + exitFee,
      slippage: pos.slippage + slipCost,
      funding: pos.funding,
      bars: i - pos.entryIndex + 1,
      exitReason: reason,
      regime: pos.regime,
      reason: pos.reason,
    });
    pos = null;
  };

  for (let i = start; i < end; i++) {
    const k = c[i];
    // 1) pending discretionary exit fills at this bar's open
    if (pos && exitNextOpen) {
      close(i, k.open, "signal", k.time);
      exitNextOpen = false;
    }
    // 2) manage open position inside bar i
    if (pos) {
      barsInMarket++;
      const f = cfg.funding?.[i] ?? cfg.fundingPer8h;
      pos.funding += pos.qty * k.close * (f ?? 0) * (barSec / 28_800) * (pos.side === "long" ? 1 : -1);
      if (pos.side === "long") {
        if (k.low <= pos.stop) close(i, Math.min(pos.stop, k.open), "stop", k.time);
        else if (pos.target != null && k.high >= pos.target) close(i, Math.max(pos.target, k.open), "target", k.time);
      } else {
        if (k.high >= pos.stop) close(i, Math.max(pos.stop, k.open), "stop", k.time);
        else if (pos.target != null && k.low <= pos.target) close(i, Math.min(pos.target, k.open), "target", k.time);
      }
      if (pos && strategy.exit?.(i, ctx, pos)) exitNextOpen = true;
    }
    // 3) mark-to-market
    const unreal = pos ? (pos.side === "long" ? k.close - pos.entry : pos.entry - k.close) * pos.qty - pos.funding : 0;
    curve.push({ time: k.time, equity: equity + unreal });

    // 4) new entry at close of i -> fill at open of i+1
    if (!pos && i + 1 < end) {
      const sig = strategy.entry(i, ctx);
      if (sig) {
        const nxt = c[i + 1];
        const fill = sig.side === "long" ? nxt.open * (1 + slip) : nxt.open * (1 - slip);
        const validStop = sig.side === "long" ? sig.stop < fill : sig.stop > fill;
        if (validStop) {
          const riskUsd = (equity * cfg.riskPct) / 100;
          const perUnit = Math.abs(fill - sig.stop) + fill * fee * 2 + fill * slip;
          let qty = riskUsd / perUnit;
          const maxQty = (equity * cfg.maxLeverage) / fill;
          if (qty > maxQty) qty = maxQty;
          const entryFee = fill * qty * fee;
          equity -= entryFee;
          const riskDist = Math.abs(fill - sig.stop);
          pos = {
            side: sig.side,
            entry: fill,
            stop: sig.stop,
            entryIndex: i + 1,
            qty,
            target: sig.targetR ? (sig.side === "long" ? fill + sig.targetR * riskDist : fill - sig.targetR * riskDist) : null,
            fees: entryFee,
            slippage: Math.abs(fill - nxt.open) * qty,
            funding: 0,
            reason: sig.reason,
            regime: regimes[i],
            riskUsd: qty * perUnit,
          };
        }
      }
    }
  }
  if (pos) {
    const lastBar = c[end - 1];
    close(end - 1, lastBar.close, "end", lastBar.time);
    if (curve.length) curve[curve.length - 1].equity = equity;
  }

  const bh = end - 1 > start ? (c[end - 1].close / c[start].open - 1) * 100 : 0;
  const metrics = computeMetrics(trades, curve, cfg.initialEquity, barSec, barsInMarket / Math.max(1, end - start), bh);
  return { trades, equity: curve, metrics, byRegime: byRegime(trades) };
}

export function computeMetrics(trades: Trade[], curve: { time: number; equity: number }[], initial: number, barSec: number, exposure: number, buyHold: number): Metrics {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  let peak = initial;
  let maxDD = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    maxDD = Math.max(maxDD, (peak - p.equity) / peak);
  }
  const finalEq = curve.length ? curve[curve.length - 1].equity : initial;
  let sharpe: number | null = null;
  if (trades.length >= 30 && curve.length > 50) {
    const rets: number[] = [];
    for (let i = 1; i < curve.length; i++) rets.push(curve[i].equity / curve[i - 1].equity - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
    const periodsPerYear = (365 * 86400) / barSec;
    sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : null;
  }
  const n = trades.length;
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? wins.length / n : null,
    winRateCI: n ? wilson(wins.length, n) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : n ? (grossWin > 0 ? Infinity : null) : null,
    totalReturnPct: (finalEq / initial - 1) * 100,
    maxDrawdownPct: maxDD * 100,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    avgWinR: wins.length ? wins.reduce((s, t) => s + t.r, 0) / wins.length : null,
    avgLossR: losses.length ? losses.reduce((s, t) => s + t.r, 0) / losses.length : null,
    expectancyR: n ? trades.reduce((s, t) => s + t.r, 0) / n : null,
    sharpe,
    fees: trades.reduce((s, t) => s + t.fees, 0),
    slippage: trades.reduce((s, t) => s + t.slippage, 0),
    funding: trades.reduce((s, t) => s + t.funding, 0),
    exposurePct: exposure * 100,
    buyHoldReturnPct: buyHold,
  };
}

function byRegime(trades: Trade[]) {
  const regs: Regime[] = ["Uptrend", "Downtrend", "Range", "High volatility"];
  return Object.fromEntries(
    regs.map((r) => {
      const t = trades.filter((x) => x.regime === r);
      const w = t.filter((x) => x.pnl > 0).length;
      return [r, { trades: t.length, winRate: t.length ? w / t.length : null, pnl: t.reduce((s, x) => s + x.pnl, 0), expectancyR: t.length ? t.reduce((s, x) => s + x.r, 0) / t.length : null }];
    }),
  ) as BacktestResult["byRegime"];
}

// ---------------- Walk-forward ----------------

export function paramGrid(strategy: Strategy, base: Record<string, number>, maxCombos = 36): Record<string, number>[] {
  let combos: Record<string, number>[] = [{ ...base }];
  for (const def of strategy.params) {
    if (!def.grid?.length) continue;
    const next: Record<string, number>[] = [];
    for (const c of combos) for (const v of def.grid) next.push({ ...c, [def.key]: v });
    if (next.length > maxCombos) break;
    combos = next;
  }
  return combos;
}

export interface WalkForwardFold {
  isStart: number;
  isEnd: number;
  oosStart: number;
  oosEnd: number;
  chosen: Record<string, number>;
  isExpectancyR: number | null;
  isTrades: number;
  oosExpectancyR: number | null;
  oosTrades: number;
  oosReturnPct: number;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  oos: BacktestResult; // stitched out-of-sample result
  isAvgExpectancyR: number | null;
  oosAvgExpectancyR: number | null;
  robustness: number; // % of grid combos with positive in-sample expectancy (parameter stability)
  combosTested: number;
}

function objective(m: Metrics) {
  if (m.trades < 5 || m.expectancyR == null) return -Infinity;
  return m.expectancyR * Math.sqrt(m.trades);
}

export function walkForward(c: Candle[], strategy: Strategy, base: Record<string, number>, cfg: BacktestConfig = DEFAULT_BT, folds = 4): WalkForwardResult {
  const ind = new Indicators(c);
  const regimes = regimeSeries(c);
  const grid = paramGrid(strategy, base);
  const n = c.length;
  const seg = Math.floor(n / (folds + 2));
  const out: WalkForwardFold[] = [];
  const oosTrades: Trade[] = [];
  const oosCurve: { time: number; equity: number }[] = [];
  let equity = cfg.initialEquity;
  let positiveCombos = 0;
  let combosEvaluated = 0;

  for (let f = 0; f < folds; f++) {
    const isStart = f * seg;
    const isEnd = isStart + 2 * seg;
    const oosStart = isEnd;
    const oosEnd = f === folds - 1 ? n : oosStart + seg;
    let best = grid[0];
    let bestScore = -Infinity;
    let bestM: Metrics | null = null;
    for (const g of grid) {
      const r = runBacktest(c, strategy, g, { ...cfg, startIndex: isStart, endIndex: isEnd }, { ind, regimes });
      combosEvaluated++;
      if ((r.metrics.expectancyR ?? -1) > 0) positiveCombos++;
      const s = objective(r.metrics);
      if (s > bestScore) {
        bestScore = s;
        best = g;
        bestM = r.metrics;
      }
    }
    // fresh Indicators not needed: indicators are causal and identical regardless of param window.
    const oos = runBacktest(c, strategy, best, { ...cfg, initialEquity: equity, startIndex: oosStart, endIndex: oosEnd }, { ind, regimes });
    oosTrades.push(...oos.trades);
    oosCurve.push(...oos.equity);
    equity = oos.equity.length ? oos.equity[oos.equity.length - 1].equity : equity;
    out.push({
      isStart,
      isEnd,
      oosStart,
      oosEnd,
      chosen: best,
      isExpectancyR: bestM?.expectancyR ?? null,
      isTrades: bestM?.trades ?? 0,
      oosExpectancyR: oos.metrics.expectancyR,
      oosTrades: oos.metrics.trades,
      oosReturnPct: oos.metrics.totalReturnPct,
    });
  }
  const barSec = n > 1 ? c[1].time - c[0].time : 3600;
  const firstOos = out[0]?.oosStart ?? 0;
  const bh = n > firstOos + 1 ? (c[n - 1].close / c[firstOos].open - 1) * 100 : 0;
  const metrics = computeMetrics(oosTrades, oosCurve, cfg.initialEquity, barSec, NaN, bh);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return {
    folds: out,
    oos: { trades: oosTrades, equity: oosCurve, metrics, byRegime: byRegime(oosTrades) },
    isAvgExpectancyR: avg(out.map((f) => f.isExpectancyR)),
    oosAvgExpectancyR: avg(out.map((f) => f.oosExpectancyR)),
    robustness: combosEvaluated ? (positiveCombos / combosEvaluated) * 100 : 0,
    combosTested: grid.length,
  };
}

/** Align a sparse funding history to candles (step function, last known value). */
export function alignFunding(c: Candle[], history: { time: number; rate8h: number }[]): (number | null)[] {
  const h = [...history].sort((a, b) => a.time - b.time);
  let j = 0;
  let cur: number | null = null;
  return c.map((k) => {
    const t = k.time * 1000;
    while (j < h.length && h[j].time <= t) cur = h[j++].rate8h;
    return cur;
  });
}
