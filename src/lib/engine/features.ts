// Advanced market-structure features. Every series is CAUSAL: the value at bar i only uses data
// available at the close of bar i. Swing points are only used once confirmed (index + right <= i).
import type { Candle } from "../types";
import { ema, rsi, atr } from "../indicators";

export interface SwingC {
  index: number; // bar of the swing extreme
  confirmedAt: number; // first bar where the swing is known
  price: number;
  type: "high" | "low";
}

/** Fractal swings with their confirmation bar (no look-ahead when filtered by confirmedAt). */
export function confirmedSwings(c: Candle[], left = 3, right = 3): SwingC[] {
  const out: SwingC[] = [];
  for (let i = left; i < c.length - right; i++) {
    let hi = true, lo = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) hi = false;
      if (c[j].low <= c[i].low) lo = false;
    }
    if (hi) out.push({ index: i, confirmedAt: i + right, price: c[i].high, type: "high" });
    if (lo) out.push({ index: i, confirmedAt: i + right, price: c[i].low, type: "low" });
  }
  return out;
}

/** EMA 9/21/50/200 stack: +1 fully bullish, -1 fully bearish, 0 mixed. */
export function emaRibbon(c: Candle[]) {
  const cl = c.map((k) => k.close);
  const e9 = ema(cl, 9), e21 = ema(cl, 21), e50 = ema(cl, 50), e200 = ema(cl, 200);
  const stack = cl.map((_, i) => {
    if (![e9[i], e21[i], e50[i], e200[i]].every(Number.isFinite)) return 0;
    if (e9[i] > e21[i] && e21[i] > e50[i] && e50[i] > e200[i]) return 1;
    if (e9[i] < e21[i] && e21[i] < e50[i] && e50[i] < e200[i]) return -1;
    return 0;
  });
  return { e9, e21, e50, e200, stack };
}

export type StructEvent = "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN" | null;

/**
 * Break of Structure / Change of Character, causal.
 * A close above the last confirmed swing high is a BOS_UP when the prevailing structure was up,
 * or a CHOCH_UP when it was down (first sign of reversal). Mirror for downside.
 */
export function structureEvents(c: Candle[], left = 3, right = 3) {
  const swings = confirmedSwings(c, left, right).sort((a, b) => a.confirmedAt - b.confirmedAt);
  const events: StructEvent[] = new Array(c.length).fill(null);
  const trend: (1 | -1 | 0)[] = new Array(c.length).fill(0);
  const lastHigh: (number | null)[] = new Array(c.length).fill(null);
  const lastLow: (number | null)[] = new Array(c.length).fill(null);
  let k = 0, hi: number | null = null, lo: number | null = null, tr: 1 | -1 | 0 = 0;
  let hiBroken = false, loBroken = false;
  for (let i = 0; i < c.length; i++) {
    while (k < swings.length && swings[k].confirmedAt <= i) {
      const s = swings[k++];
      if (s.type === "high") { hi = s.price; hiBroken = false; } else { lo = s.price; loBroken = false; }
    }
    if (hi != null && !hiBroken && c[i].close > hi) { events[i] = tr === -1 ? "CHOCH_UP" : "BOS_UP"; tr = 1; hiBroken = true; }
    else if (lo != null && !loBroken && c[i].close < lo) { events[i] = tr === 1 ? "CHOCH_DOWN" : "BOS_DOWN"; tr = -1; loBroken = true; }
    trend[i] = tr; lastHigh[i] = hi; lastLow[i] = lo;
  }
  return { events, trend, lastHigh, lastLow };
}

export interface FVG {
  index: number; // middle-candle bar index + 1 (the bar that completes the gap)
  type: "bull" | "bear";
  top: number;
  bottom: number;
  filledAt: number | null;
}

/** Fair Value Gaps: bull if low[i] > high[i-2], bear if high[i] < low[i-2]. Fill tracked causally. */
export function fairValueGaps(c: Candle[], minAtrFrac = 0.15): FVG[] {
  const a = atr(c, 14);
  const gaps: FVG[] = [];
  for (let i = 2; i < c.length; i++) {
    const min = Number.isFinite(a[i]) ? a[i] * minAtrFrac : 0;
    if (c[i].low - c[i - 2].high > min) gaps.push({ index: i, type: "bull", top: c[i].low, bottom: c[i - 2].high, filledAt: null });
    if (c[i - 2].low - c[i].high > min) gaps.push({ index: i, type: "bear", top: c[i - 2].low, bottom: c[i].high, filledAt: null });
  }
  for (const g of gaps) {
    for (let j = g.index + 1; j < c.length; j++) {
      if ((g.type === "bull" && c[j].low <= g.bottom) || (g.type === "bear" && c[j].high >= g.top)) { g.filledAt = j; break; }
    }
  }
  return gaps;
}

/** Unfilled gaps of a type that exist at bar i (created before i, not filled by i). */
export function openGapsAt(gaps: FVG[], i: number, type: "bull" | "bear") {
  return gaps.filter((g) => g.type === type && g.index < i && (g.filledAt == null || g.filledAt > i));
}

/**
 * Regular RSI divergence, causal: bullish when price makes a lower confirmed swing low but RSI
 * makes a higher low (mirror for bearish). Signal fires on the bar the second swing is confirmed.
 */
export function rsiDivergence(c: Candle[], period = 14, maxGapBars = 40) {
  const r = rsi(c.map((k) => k.close), period);
  const swings = confirmedSwings(c, 3, 3);
  const bull: boolean[] = new Array(c.length).fill(false);
  const bear: boolean[] = new Array(c.length).fill(false);
  const lows = swings.filter((s) => s.type === "low");
  const highs = swings.filter((s) => s.type === "high");
  for (let k = 1; k < lows.length; k++) {
    const a = lows[k - 1], b = lows[k];
    if (b.index - a.index > maxGapBars || b.confirmedAt >= c.length) continue;
    if (b.price < a.price && r[b.index] > r[a.index] && r[b.index] < 45) bull[b.confirmedAt] = true;
  }
  for (let k = 1; k < highs.length; k++) {
    const a = highs[k - 1], b = highs[k];
    if (b.index - a.index > maxGapBars || b.confirmedAt >= c.length) continue;
    if (b.price > a.price && r[b.index] < r[a.index] && r[b.index] > 55) bear[b.confirmedAt] = true;
  }
  return { bull, bear, rsi: r };
}

/** Volume profile over a window: point of control and 70% value area. */
export function volumeProfile(c: Candle[], bins = 40) {
  if (!c.length) return null;
  const lo = Math.min(...c.map((k) => k.low)), hi = Math.max(...c.map((k) => k.high));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  for (const k of c) {
    // spread each candle's volume uniformly across the bins it covers
    const b0 = Math.max(0, Math.floor((k.low - lo) / w)), b1 = Math.min(bins - 1, Math.floor((k.high - lo) / w));
    const share = k.volume / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vol[b] += share;
  }
  const poc = vol.indexOf(Math.max(...vol));
  const total = vol.reduce((s, v) => s + v, 0);
  let inArea = vol[poc], a = poc, b = poc;
  while (inArea < total * 0.7 && (a > 0 || b < bins - 1)) {
    const left = a > 0 ? vol[a - 1] : -1, right = b < bins - 1 ? vol[b + 1] : -1;
    if (right >= left) inArea += vol[++b]; else inArea += vol[--a];
  }
  return { poc: lo + (poc + 0.5) * w, val: lo + a * w, vah: lo + (b + 1) * w, low: lo, high: hi };
}

export interface BookLevel { px: number; sz: number }

/** Order-book imbalance within `bandPct` of mid: +1 = all bids, -1 = all asks. Also depth in USD. */
export function bookImbalance(bids: BookLevel[], asks: BookLevel[], bandPct = 0.5) {
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0].px + asks[0].px) / 2;
  const lo = mid * (1 - bandPct / 100), hi = mid * (1 + bandPct / 100);
  const bidUsd = bids.filter((l) => l.px >= lo).reduce((s, l) => s + l.px * l.sz, 0);
  const askUsd = asks.filter((l) => l.px <= hi).reduce((s, l) => s + l.px * l.sz, 0);
  const spreadPct = ((asks[0].px - bids[0].px) / mid) * 100;
  return { mid, imbalance: bidUsd + askUsd > 0 ? (bidUsd - askUsd) / (bidUsd + askUsd) : 0, bidUsd, askUsd, depthUsd: bidUsd + askUsd, spreadPct };
}
