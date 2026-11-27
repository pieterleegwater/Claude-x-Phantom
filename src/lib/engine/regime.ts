// Market regime classification (causal). Used to route to strategies designed for the condition.
import type { Candle } from "../types";
import { adx, atr, bollinger, ema, percentileRank, priorHigh, priorLow, sma } from "../indicators";

export type MarketRegime = "bull_trend" | "bear_trend" | "range" | "high_vol" | "low_vol" | "breakout";
export const REGIME_LABEL: Record<MarketRegime, string> = {
  bull_trend: "Strong bullish trend",
  bear_trend: "Strong bearish trend",
  range: "Sideways / range",
  high_vol: "High volatility",
  low_vol: "Low volatility (compression)",
  breakout: "Breakout environment",
};

export interface RegimeRead {
  regime: MarketRegime;
  adx: number;
  atrPctile: number;
  bbWidthPctile: number;
  slope50: number; // % change of EMA50 over 10 bars
  aboveEma200: boolean;
  detail: string;
}

/** Regime for every bar (vector form, used by backtests and the live engine alike). */
export function regimeSeriesV2(c: Candle[]): MarketRegime[] {
  const close = c.map((k) => k.close);
  const e50 = ema(close, 50), e200 = ema(close, 200);
  const x = adx(c, 14), a = atr(c, 14);
  const bb = bollinger(close, 20, 2);
  const width = close.map((_, i) => (bb.upper[i] - bb.lower[i]) / bb.mid[i]);
  const atrPct = a.map((v, i) => v / close[i]);
  const hi = priorHigh(c, 20), lo = priorLow(c, 20);
  const vs = sma(c.map((k) => k.volume), 20);
  return c.map((_, i) => readAt(i, { close, e50, e200, x, width, atrPct, hi, lo, vs, c }).regime);
}

interface Pre {
  close: number[]; e50: number[]; e200: number[]; x: number[]; width: number[]; atrPct: number[]; hi: number[]; lo: number[]; vs: number[]; c: Candle[];
}

function readAt(i: number, p: Pre): RegimeRead {
  const win = (arr: number[]) => arr.slice(Math.max(0, i - 300), i + 1);
  const atrPctile = percentileRank(win(p.atrPct), p.atrPct[i]);
  const bbPctile = percentileRank(win(p.width), p.width[i]);
  const ref = Number.isFinite(p.e200[i]) ? p.e200[i] : p.e50[i];
  const slope50 = Number.isFinite(p.e50[i - 10]) ? ((p.e50[i] - p.e50[i - 10]) / p.e50[i - 10]) * 100 : 0;
  const aboveEma200 = p.close[i] > ref;
  const adxV = Number.isFinite(p.x[i]) ? p.x[i] : 0;
  // breakout: squeeze in the last 10 bars, now a close outside the 20-bar range on volume
  const recentSqueeze = win(p.width).slice(-10).some((w) => percentileRank(win(p.width), w) < 25);
  const outside = (p.close[i] > p.hi[i] || p.close[i] < p.lo[i]) && p.c[i].volume > 1.4 * p.vs[i];
  let regime: MarketRegime;
  if (outside && recentSqueeze) regime = "breakout";
  else if (atrPctile > 88) regime = "high_vol";
  else if (adxV > 25 && aboveEma200 && slope50 > 0) regime = "bull_trend";
  else if (adxV > 25 && !aboveEma200 && slope50 < 0) regime = "bear_trend";
  else if (atrPctile < 15 && bbPctile < 20) regime = "low_vol";
  else regime = "range";
  return {
    regime,
    adx: adxV,
    atrPctile,
    bbWidthPctile: bbPctile,
    slope50,
    aboveEma200,
    detail: `ADX ${adxV.toFixed(0)}, ATR pctile ${atrPctile.toFixed(0)}, BB width pctile ${bbPctile.toFixed(0)}, EMA50 slope ${slope50.toFixed(2)}%/10 bars, price ${aboveEma200 ? "above" : "below"} EMA200.`,
  };
}

export function readRegime(c: Candle[]): RegimeRead {
  const close = c.map((k) => k.close);
  const i = c.length - 1;
  const bb = bollinger(close, 20, 2);
  return readAt(i, {
    close,
    e50: ema(close, 50),
    e200: ema(close, 200),
    x: adx(c, 14),
    width: close.map((_, j) => (bb.upper[j] - bb.lower[j]) / bb.mid[j]),
    atrPct: atr(c, 14).map((v, j) => v / close[j]),
    hi: priorHigh(c, 20),
    lo: priorLow(c, 20),
    vs: sma(c.map((k) => k.volume), 20),
    c,
  });
}
