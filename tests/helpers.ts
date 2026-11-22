import type { Candle } from "@/lib/types";

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Geometric random walk with optional drift, hourly candles ending "now". */
export function series(n: number, opts: { seed?: number; drift?: number; vol?: number; start?: number; tf?: number; endMs?: number } = {}): Candle[] {
  const r = rng(opts.seed ?? 1);
  const tf = opts.tf ?? 3600;
  const end = Math.floor((opts.endMs ?? Date.now()) / 1000 / tf) * tf - tf; // last fully closed
  let p = opts.start ?? 50_000;
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const g = (r() + r() + r() + r() - 2) * 0.866; // ~N(0,1)
    const ret = (opts.drift ?? 0) + (opts.vol ?? 0.006) * g;
    const open = p;
    const close = p * (1 + ret);
    const high = Math.max(open, close) * (1 + r() * (opts.vol ?? 0.006) * 0.6);
    const low = Math.min(open, close) * (1 - r() * (opts.vol ?? 0.006) * 0.6);
    out.push({ time: end - (n - 1 - i) * tf, open, high, low, close, volume: 100 + r() * 100 });
    p = close;
  }
  return out;
}
