// Backtester v2: realistic exit management for the autonomous engine.
//  • entry at the NEXT bar open + slippage (signal at close of bar i)
//  • partial take-profits, break-even, ATR trailing, time stop, strategy exit
//  • stop checked before targets inside a bar; gaps fill at the worse open
//  • taker fees on every fill, slippage both sides, funding per bar, isolated-margin liquidation
import type { Candle } from "../types";
import { Indicators, type Strategy, type StrategyContext } from "../strategies";
import { computeMetrics, type Metrics } from "../backtest";
import { regimeSeriesV2, type MarketRegime } from "./regime";
import type { ExitProfile } from "./types";
import { liquidationPrice } from "./riskGovernor";

export interface Bt2Config {
  initialEquity: number;
  riskPct: number;
  takerFeeBps: number;
  slippageBps: number;
  leverage: number; // used for margin & liquidation
  maxLeverage: number; // venue max (sets maintenance margin)
  fundingPer8h: number; // fallback when no series
  funding?: (number | null)[];
  startIndex?: number;
  endIndex?: number;
}

export interface Bt2Trade {
  side: "long" | "short";
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number; // volume-weighted average exit
  pnl: number;
  r: number;
  fees: number;
  slippage: number;
  funding: number;
  bars: number;
  exitReason: string;
  regime: MarketRegime;
  liquidated: boolean;
}

export interface Bt2Result {
  trades: Bt2Trade[];
  equity: { time: number; equity: number }[];
  metrics: Metrics;
  liquidations: number;
  byRegime: Record<string, { trades: number; expectancyR: number | null; pnl: number }>;
}

export const NO_TP_PROFILE: ExitProfile = { id: "strategy_exit", tps: [], beAfterR: null, trailAtr: null, timeStopBars: null };

export function runBacktestV2(c: Candle[], st: Strategy, params: Record<string, number>, cfg: Bt2Config, exit: ExitProfile, cache?: { ind?: Indicators; regimes?: MarketRegime[] }): Bt2Result {
  const ind = cache?.ind ?? new Indicators(c);
  const regimes = cache?.regimes ?? regimeSeriesV2(c);
  const ctx: StrategyContext = { c, ind, p: params, funding: cfg.funding };
  const a = ind.atr(14);
  const start = Math.max(cfg.startIndex ?? 0, st.warmup(params), 2);
  const end = Math.min(cfg.endIndex ?? c.length, c.length);
  const barSec = c.length > 1 ? c[1].time - c[0].time : 3600;
  const fee = cfg.takerFeeBps / 10_000, slip = cfg.slippageBps / 10_000;
  let equity = cfg.initialEquity;
  const trades: Bt2Trade[] = [];
  const curve: { time: number; equity: number }[] = [];
  let liquidations = 0;

  type Pos = { side: "long" | "short"; s: 1 | -1; entry: number; stop: number; risk: number; qty0: number; qty: number; i0: number; tps: { px: number; pct: number; done: boolean }[]; trailing: boolean; maxFav: number; fees: number; slipCost: number; funding: number; realized: number; exitNotional: number; exitQty: number; liq: number | null; margin: number; riskUsd: number; regime: MarketRegime; exitNext: string | null };
  let p: Pos | null = null;

  const close = (i: number, reason: string, liq: boolean) => {
    if (!p) return;
    const pnl = p.realized - p.funding;
    trades.push({ side: p.side, entryTime: c[p.i0].time, exitTime: c[i].time, entry: p.entry, exit: p.exitQty ? p.exitNotional / p.exitQty : p.entry, pnl, r: p.riskUsd > 0 ? pnl / p.riskUsd : 0, fees: p.fees, slippage: p.slipCost, funding: p.funding, bars: i - p.i0 + 1, exitReason: reason, regime: p.regime, liquidated: liq });
    if (liq) liquidations++;
    p = null;
  };
  const fill = (raw: number, qty: number, reason: string, i: number) => {
    if (!p) return;
    const px = p.s === 1 ? raw * (1 - slip) : raw * (1 + slip);
    const f = px * qty * fee;
    const gross = p.s * (px - p.entry) * qty;
    p.realized += gross - f; p.fees += f; p.slipCost += Math.abs(px - raw) * qty;
    p.exitNotional += px * qty; p.exitQty += qty; p.qty -= qty;
    equity += gross - f;
    if (p.qty <= p.qty0 * 1e-9) close(i, reason, false);
  };
  /** Isolated liquidation: the margin backing the remaining size is lost. */
  const liquidate = (i: number) => {
    if (!p) return;
    const lost = p.margin * (p.qty / p.qty0);
    p.realized -= lost; equity -= lost; p.exitNotional += (p.liq ?? p.entry) * p.qty; p.exitQty += p.qty; p.qty = 0;
    close(i, "liquidated", true);
  };

  for (let i = start; i < end; i++) {
    const k = c[i];
    if (p && p.exitNext) fill(k.open, p.qty, p.exitNext, i);
    if (p) {
      // funding: longs pay positive funding
      const fr = cfg.funding?.[i] ?? cfg.fundingPer8h;
      const fpay = p.qty * k.close * (fr ?? 0) * (barSec / 28_800) * p.s;
      p.funding += fpay; equity -= fpay;
      const adverse = p.s === 1 ? k.low : k.high;
      const favorable = p.s === 1 ? k.high : k.low;
      // liquidation only if price gaps through both stop and liquidation
      if (p.liq != null && (p.s === 1 ? k.open <= p.liq : k.open >= p.liq)) liquidate(i);
      else if (p.s === 1 ? adverse <= p.stop : adverse >= p.stop) fill(p.s === 1 ? Math.min(p.stop, k.open) : Math.max(p.stop, k.open), p.qty, p.trailing ? "trailing stop" : p.stop === p.entry ? "break-even" : "stop", i);
      else {
        for (const tp of p.tps) {
          if (!p || tp.done) continue;
          if (p.s === 1 ? favorable >= tp.px : favorable <= tp.px) {
            tp.done = true;
            const last = p.tps.every((x) => x.done);
            const q = last ? p.qty : Math.min(p.qty, (p.qty0 * tp.pct) / 100);
            fill(p.s === 1 ? Math.max(tp.px, k.open) : Math.min(tp.px, k.open), q, "take-profit", i);
            if (p && exit.trailAtr) p.trailing = true;
          } else break;
        }
      }
      if (p) {
        p.maxFav = Math.max(p.maxFav, (p.s * (favorable - p.entry)) / p.risk);
        if (exit.beAfterR != null && p.maxFav >= exit.beAfterR && p.s * (p.stop - p.entry) < 0) p.stop = p.entry * (1 + p.s * fee * 2);
        if (p.trailing && exit.trailAtr && Number.isFinite(a[i])) {
          const t = k.close - p.s * exit.trailAtr * a[i];
          if (p.s * (t - p.stop) > 0) p.stop = t;
        }
        if (exit.timeStopBars && i - p.i0 >= exit.timeStopBars && p.maxFav < 0.5) p.exitNext = "time stop";
        else if (st.exit?.(i, ctx, { side: p.side, entry: p.entry, stop: p.stop, entryIndex: p.i0 })) p.exitNext = "thesis invalidated";
      }
    }
    const unreal = p ? p.s * (k.close - p.entry) * p.qty - p.funding : 0;
    curve.push({ time: k.time, equity: equity + unreal });

    if (!p && i + 1 < end && equity > 0) {
      const sig = st.entry(i, ctx);
      if (sig) {
        const nxt = c[i + 1];
        const s: 1 | -1 = sig.side === "long" ? 1 : -1;
        const entry = nxt.open * (1 + s * slip);
        const risk = Math.abs(entry - sig.stop);
        if (s * (entry - sig.stop) > 0 && risk > 0) {
          const riskUsd = (equity * cfg.riskPct) / 100;
          const perUnit = risk + entry * (fee * 2 + slip);
          let qty = riskUsd / perUnit;
          qty = Math.min(qty, (equity * cfg.leverage * 0.95) / entry);
          const f = entry * qty * fee;
          equity -= f;
          const profile = exit.tps.length ? exit.tps : sig.targetR ? [{ r: sig.targetR, pct: 100 }] : [];
          p = {
            side: sig.side, s, entry, stop: sig.stop, risk, qty0: qty, qty, i0: i + 1,
            tps: profile.map((t) => ({ px: entry + s * t.r * risk, pct: t.pct, done: false })),
            trailing: false, maxFav: 0, fees: f, slipCost: Math.abs(entry - nxt.open) * qty, funding: 0, realized: -f, exitNotional: 0, exitQty: 0,
            liq: cfg.leverage > 1 ? liquidationPrice(entry, sig.side, cfg.leverage, cfg.maxLeverage) : null,
            margin: (entry * qty) / cfg.leverage, riskUsd: qty * perUnit, regime: regimes[i], exitNext: null,
          };
        }
      }
    }
  }
  if (p) fill(c[end - 1].close, (p as Pos).qty, "end of data", end - 1);
  const metrics = computeMetrics(trades as never, curve, cfg.initialEquity, barSec, NaN, end - 1 > start ? (c[end - 1].close / c[start].open - 1) * 100 : 0);
  const byRegime: Bt2Result["byRegime"] = {};
  for (const t of trades) { const b = (byRegime[t.regime] ??= { trades: 0, expectancyR: 0, pnl: 0 }); b.trades++; b.pnl += t.pnl; b.expectancyR = (b.expectancyR ?? 0) + t.r; }
  for (const b of Object.values(byRegime)) b.expectancyR = b.trades ? (b.expectancyR ?? 0) / b.trades : null;
  return { trades, equity: curve, metrics, liquidations, byRegime };
}
