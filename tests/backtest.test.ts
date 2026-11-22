import { describe, it, expect } from "vitest";
import { runBacktest, walkForward, DEFAULT_BT } from "@/lib/backtest";
import { STRATEGIES, defaultParams, type Strategy } from "@/lib/strategies";
import type { Candle } from "@/lib/types";
import { series } from "./helpers";

const flat = (n: number): Candle[] => Array.from({ length: n }, (_, i) => ({ time: i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 10 }));

describe("backtest engine", () => {
  it("fills at the NEXT bar open with slippage (no look-ahead)", () => {
    const c = flat(20);
    c[11] = { ...c[11], open: 105, high: 106, low: 104, close: 105 };
    const s: Strategy = { ...STRATEGIES[0], id: "t", warmup: () => 2, entry: (i) => (i === 10 ? { side: "long", stop: 90, reason: "test" } : null), exit: undefined };
    const r = runBacktest(c, s, {}, { ...DEFAULT_BT, slippageBps: 10, feeBps: 0, fundingPer8h: 0 });
    expect(r.trades.length).toBe(1);
    expect(r.trades[0].entry).toBeCloseTo(105 * 1.001, 6);
    expect(r.trades[0].entryTime).toBe(c[11].time);
  });
  it("assumes stop before target when both hit in one bar", () => {
    const c = flat(20);
    c[12] = { ...c[12], high: 130, low: 80 };
    const s: Strategy = { ...STRATEGIES[0], id: "t", warmup: () => 2, entry: (i) => (i === 10 ? { side: "long", stop: 95, targetR: 2, reason: "t" } : null), exit: undefined };
    const r = runBacktest(c, s, {}, { ...DEFAULT_BT, slippageBps: 0, feeBps: 0, fundingPer8h: 0 });
    expect(r.trades[0].exitReason).toBe("stop");
    expect(r.trades[0].r).toBeCloseTo(-1, 2);
  });
  it("gap through stop fills at the worse open", () => {
    const c = flat(20);
    c[12] = { ...c[12], open: 90, high: 91, low: 89, close: 90 };
    const s: Strategy = { ...STRATEGIES[0], id: "t", warmup: () => 2, entry: (i) => (i === 10 ? { side: "long", stop: 97, reason: "t" } : null), exit: undefined };
    const r = runBacktest(c, s, {}, { ...DEFAULT_BT, slippageBps: 0, feeBps: 0, fundingPer8h: 0 });
    expect(r.trades[0].exit).toBe(90);
  });
  it("fees reduce pnl", () => {
    const c = series(1500, { seed: 3 });
    const st = STRATEGIES.find((s) => s.id === "ema_trend")!;
    const a = runBacktest(c, st, defaultParams(st), { ...DEFAULT_BT, feeBps: 0, slippageBps: 0, fundingPer8h: 0 });
    const b = runBacktest(c, st, defaultParams(st), { ...DEFAULT_BT, feeBps: 10, slippageBps: 0, fundingPer8h: 0 });
    expect(a.trades.length).toBeGreaterThan(0);
    expect(b.metrics.fees).toBeGreaterThan(0);
    expect(b.metrics.totalReturnPct).toBeLessThan(a.metrics.totalReturnPct);
  });
  it("every strategy runs on 3000 bars without NaN equity", () => {
    const c = series(3000, { seed: 7, drift: 0.0002 });
    const funding = c.map((_, i) => (i % 300 < 20 ? 0.0006 : i % 300 > 280 ? -0.0002 : 0.0001));
    for (const s of STRATEGIES) {
      const r = runBacktest(c, s, defaultParams(s), { ...DEFAULT_BT, funding });
      expect(r.equity.every((e) => Number.isFinite(e.equity)), s.id).toBe(true);
      for (const t of r.trades) expect(t.entryTime).toBeGreaterThan(c[0].time);
    }
  });
  it("walk-forward only reports out-of-sample trades", () => {
    const c = series(3000, { seed: 11, drift: 0.0001 });
    const st = STRATEGIES.find((s) => s.id === "donchian_breakout")!;
    const wf = walkForward(c, st, defaultParams(st), DEFAULT_BT, 4);
    expect(wf.folds.length).toBe(4);
    const firstOos = c[wf.folds[0].oosStart].time;
    expect(wf.oos.trades.every((t) => t.entryTime >= firstOos)).toBe(true);
    for (const f of wf.folds) expect(f.oosStart).toBe(f.isEnd);
  });
});
