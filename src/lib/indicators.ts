// Technical indicators. All functions are causal: value[i] only uses data <= i.
// Values before an indicator has enough history are NaN.
import type { Candle } from "./types";

export function sma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
export function rma(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  let start = 0;
  while (start < values.length && !Number.isFinite(values[start])) start++;
  if (values.length - start < period) return out;
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += values[i];
  let prev = seed / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const gains = [NaN];
  const losses = [NaN];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = rma(gains, period);
  const l = rma(losses, period);
  return closes.map((_, i) => {
    if (!Number.isFinite(g[i]) || !Number.isFinite(l[i])) return NaN;
    if (l[i] === 0) return 100;
    const rs = g[i] / l[i];
    return 100 - 100 / (1 + rs);
  });
}

export function trueRange(c: Candle[]): number[] {
  return c.map((k, i) =>
    i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)),
  );
}

export function atr(c: Candle[], period = 14): number[] {
  return rma(trueRange(c), period);
}

export function macd(closes: number[], fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const firstValid = line.findIndex((v) => Number.isFinite(v));
  const sig = new Array(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal);
    for (let i = 0; i < tail.length; i++) sig[firstValid + i] = tail[i];
  }
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

export function bollinger(closes: number[], period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(NaN);
  const lower = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Session VWAP anchored at each UTC day start (typical price weighted). */
export function sessionVwap(c: Candle[]): number[] {
  const out: number[] = [];
  let pv = 0;
  let vol = 0;
  let day = -1;
  for (const k of c) {
    const d = Math.floor(k.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    vol += k.volume;
    out.push(vol > 0 ? pv / vol : tp);
  }
  return out;
}

/** Rolling VWAP over N bars (useful on daily candles where a session VWAP is meaningless). */
export function rollingVwap(c: Candle[], period = 20): number[] {
  const out = new Array(c.length).fill(NaN);
  for (let i = period - 1; i < c.length; i++) {
    let pv = 0;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) {
      pv += ((c[j].high + c[j].low + c[j].close) / 3) * c[j].volume;
      v += c[j].volume;
    }
    out[i] = v > 0 ? pv / v : c[i].close;
  }
  return out;
}

export function adx(c: Candle[], period = 14): number[] {
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  const tr = rma(trueRange(c), period);
  const p = rma(plusDM, period);
  const m = rma(minusDM, period);
  const dx = c.map((_, i) => {
    if (!Number.isFinite(tr[i]) || tr[i] === 0) return NaN;
    const pdi = (100 * p[i]) / tr[i];
    const mdi = (100 * m[i]) / tr[i];
    return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  });
  return rma(dx, period);
}

/** Highest high of the previous `period` bars, EXCLUDING the current bar. */
export function priorHigh(c: Candle[], period: number): number[] {
  return c.map((_, i) => {
    if (i < period) return NaN;
    let h = -Infinity;
    for (let j = i - period; j < i; j++) h = Math.max(h, c[j].high);
    return h;
  });
}

/** Lowest low of the previous `period` bars, EXCLUDING the current bar. */
export function priorLow(c: Candle[], period: number): number[] {
  return c.map((_, i) => {
    if (i < period) return NaN;
    let l = Infinity;
    for (let j = i - period; j < i; j++) l = Math.min(l, c[j].low);
    return l;
  });
}

export interface SwingPoint {
  index: number;
  price: number;
  type: "high" | "low";
}

/**
 * Fractal swing points. A swing at index i is only CONFIRMED at i + right, so
 * callers evaluating bar t must only use swings with index + right <= t.
 */
export function swingPoints(c: Candle[], left = 3, right = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = left; i < c.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isHigh = false;
      if (c[j].low <= c[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: c[i].high, type: "high" });
    if (isLow) out.push({ index: i, price: c[i].low, type: "low" });
  }
  return out;
}

export function last<T>(a: T[]): T {
  return a[a.length - 1];
}

export function pctChange(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

export function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function percentileRank(values: number[], x: number): number {
  const v = values.filter(Number.isFinite);
  if (!v.length) return NaN;
  return (v.filter((y) => y <= x).length / v.length) * 100;
}

export function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

/** Linear map of x from [a,b] to [0,100], clamped. */
export function scale(x: number, a: number, b: number) {
  if (!Number.isFinite(x)) return NaN;
  return clamp(((x - a) / (b - a)) * 100, 0, 100);
}

/** Wilson score interval for a binomial proportion (95%). */
export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [NaN, NaN];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const adj = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - adj) / denom, (centre + adj) / denom];
}

/** Aggregate candles of a lower timeframe into a higher one (e.g. 1h -> 4h). */
export function aggregate(c: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const k of c) {
    const bucket = Math.floor(k.time / seconds) * seconds;
    const cur = out[out.length - 1];
    if (cur && cur.time === bucket) {
      cur.high = Math.max(cur.high, k.high);
      cur.low = Math.min(cur.low, k.low);
      cur.close = k.close;
      cur.volume += k.volume;
    } else {
      out.push({ ...k, time: bucket });
    }
  }
  return out;
}
