import { describe, it, expect } from "vitest";
import { sma, ema, rsi, atr, priorHigh, aggregate, wilson, swingPoints } from "@/lib/indicators";
import { series } from "./helpers";

describe("indicators", () => {
  it("sma computes rolling mean with NaN warmup", () => {
    const v = sma([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBeCloseTo(2);
    expect(v[4]).toBeCloseTo(4);
  });
  it("ema seeds with sma and converges", () => {
    const v = ema(new Array(50).fill(10), 10);
    expect(v[9]).toBe(10);
    expect(v[49]).toBe(10);
  });
  it("rsi is 100 for strictly rising prices and ~0 for falling", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const dn = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(rsi(up, 14)[39]).toBe(100);
    expect(rsi(dn, 14)[39]).toBeLessThan(1);
  });
  it("priorHigh excludes the current bar (no look-ahead)", () => {
    const c = series(30);
    const ph = priorHigh(c, 5);
    expect(ph[10]).toBe(Math.max(...c.slice(5, 10).map((k) => k.high)));
  });
  it("atr is positive", () => {
    const a = atr(series(100), 14);
    expect(a[99]).toBeGreaterThan(0);
  });
  it("aggregate merges 4 hourly candles into one 4h candle", () => {
    const c = series(8, { tf: 3600, endMs: Date.UTC(2026, 0, 1, 8) + 3600_000 });
    const g = aggregate(c, 14400);
    expect(g.length).toBeGreaterThanOrEqual(2);
    const first = c.filter((k) => Math.floor(k.time / 14400) * 14400 === g[0].time);
    expect(g[0].high).toBe(Math.max(...first.map((k) => k.high)));
    expect(g[0].volume).toBeCloseTo(first.reduce((s, k) => s + k.volume, 0));
  });
  it("wilson interval contains the point estimate", () => {
    const [lo, hi] = wilson(30, 60);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
  });
  it("swing points require bars on both sides", () => {
    const c = series(50);
    const s = swingPoints(c, 3, 3);
    expect(s.every((p) => p.index >= 3 && p.index <= 46)).toBe(true);
  });
});
