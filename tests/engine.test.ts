import { describe, it, expect } from "vitest";
import type { Candle } from "@/lib/types";
import type { Strategy } from "@/lib/strategies";
import { getStrategy } from "@/lib/strategies";
import { runBacktestV2, type Bt2Config } from "@/lib/engine/backtest2";
import { PaperBroker } from "@/lib/engine/broker";
import { manageExit } from "@/lib/engine/exits";
import { runCycle } from "@/lib/engine/engine";
import { validateStrategy } from "@/lib/engine/validation";
import { closedCandles, type AssetInfo, type FeedTf, type MarketFeed, TF_MS } from "@/lib/engine/market";
import { DEFAULT_ENGINE_CONFIG, EXIT_PROFILES, newEngineState, type EnginePosition, type EngineState } from "@/lib/engine/types";
import { series } from "./helpers";

const flat = (n: number, px = 100, t0 = 1_700_000_000, tf = 3600): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: t0 + i * tf, open: px, high: px * 1.001, low: px * 0.999, close: px, volume: 100 }));

/** Scripted strategy: one long at bar `at`, stop 1% below. */
const scripted = (at: number, side: "long" | "short" = "long"): Strategy => ({
  id: "scripted", name: "s", family: "trend", summary: "", rules: [], evidence: { level: "mixed", notes: "", sources: [] }, goodIn: "", badIn: "", params: [],
  warmup: () => 30,
  entry: (i, { c }) => (i === at ? { side, stop: side === "long" ? c[i].close * 0.99 : c[i].close * 1.01, reason: "test" } : null),
});

const cfg: Bt2Config = { initialEquity: 1000, riskPct: 0.5, takerFeeBps: 0, slippageBps: 0, leverage: 5, maxLeverage: 40, fundingPer8h: 0 };

describe("backtest v2 exits", () => {
  it("enters on the next bar open (no look-ahead) and scales out at 1R/2R/3R", () => {
    const c = flat(120);
    // after the signal at bar 50, price climbs 0.5% per bar
    for (let i = 51; i < 120; i++) { const p = 100 * (1 + 0.005 * (i - 50)); c[i] = { ...c[i], open: p - 0.25, close: p, high: p + 0.1, low: p - 0.3 }; }
    const r = runBacktestV2(c, scripted(50), {}, cfg, EXIT_PROFILES[0]);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entry).toBeCloseTo(c[51].open, 6); // next-bar open
    expect(t.r).toBeGreaterThan(1.5); // 40%@1R + 35%@2R + 25%@3R ≈ 1.75R
    expect(t.r).toBeLessThan(2.1);
  });
  it("hits the stop before targets when a bar spans both", () => {
    const c = flat(120);
    c[52] = { ...c[52], high: 110, low: 90 }; // huge bar: both stop and TP inside
    const r = runBacktestV2(c, scripted(50), {}, cfg, EXIT_PROFILES[2]);
    expect(r.trades[0].r).toBeLessThan(-0.9);
  });
  it("charges fees and slippage", () => {
    const c = flat(120);
    c[52] = { ...c[52], high: 110, low: 99.95 };
    const free = runBacktestV2(c, scripted(50), {}, cfg, EXIT_PROFILES[2]).trades[0];
    const costly = runBacktestV2(c, scripted(50), {}, { ...cfg, takerFeeBps: 4.5, slippageBps: 3 }, EXIT_PROFILES[2]).trades[0];
    expect(costly.pnl).toBeLessThan(free.pnl);
    expect(costly.fees).toBeGreaterThan(0);
  });
});

describe("exit manager", () => {
  const pos = (over: Partial<EnginePosition> = {}): EnginePosition => ({
    id: "p", mode: "paper", coin: "BTC", side: "long", qty: 1, initialQty: 1, entry: 100, stop: 99, initialStop: 99, risk: 1,
    tps: [{ price: 101, pct: 40, filled: false }, { price: 102, pct: 35, filled: false }, { price: 103, pct: 25, filled: false }],
    leverage: 5, liqPrice: 81, openedAt: 0, barsHeld: 3, tf: "1h", strategyId: "ema_trend", exitProfile: "scale_3", score: 85, thesis: "",
    beMoved: false, trailingActive: false, feesUsd: 0, fundingUsd: 0, realizedUsd: 0, lastPrice: 100, maxFavorableR: 0, lastFundingAt: 0, ...over,
  });
  it("moves the stop to break-even (+fees) after 1R", () => {
    const c = flat(100);
    const a = manageExit(pos({ maxFavorableR: 1.2 }), c, EXIT_PROFILES[0], null, {}, 4.5);
    const m = a.find((x) => x.type === "move_stop");
    expect(m && m.type === "move_stop" && m.stop).toBeGreaterThan(100);
  });
  it("time-stops a trade that never developed", () => {
    const a = manageExit(pos({ barsHeld: 45 }), flat(100), EXIT_PROFILES[0], null, {}, 4.5);
    expect(a.some((x) => x.type === "close" && /Time stop/.test(x.why))).toBe(true);
  });
  it("closes a long when the regime flips to a bear trend", () => {
    const a = manageExit(pos(), flat(100), EXIT_PROFILES[0], "bear_trend", {}, 4.5);
    expect(a.some((x) => x.type === "close" && /regime/.test(x.why))).toBe(true);
  });
});

// ---------------------------------------------------------------- stub feed (tests only)
class StubFeed implements MarketFeed {
  constructor(public px: number, public minute: Candle[] = [], private hist: Partial<Record<FeedTf, Candle[]>> = {}) {}
  async assets(): Promise<Record<string, AssetInfo>> {
    return { BTC: { coin: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40, markPx: this.px, midPx: this.px, funding: 0, openInterest: 1e4, dayNtlVlm: 1e9, prevDayPx: this.px } };
  }
  async candles(_c: string, tf: FeedTf) { return tf === "1m" ? this.minute : this.hist[tf] ?? []; }
  async book() { return { bids: [{ px: this.px - 1, sz: 100 }], asks: [{ px: this.px + 1, sz: 100 }] }; }
}

describe("paper broker", () => {
  const now = 1_800_000_000_000;
  const open = async (stop = 59_400) => {
    const b = new PaperBroker(4.5, 3);
    const s0 = { ...newEngineState(), paperCash: 1000 };
    const feed = new StubFeed(60_000);
    const assets = await feed.assets();
    const r = await b.open(s0, { coin: "BTC", asset: assets.BTC, side: "long", qty: 0.01, refPrice: 60_000, stop, tps: [{ price: 60_600, pct: 50 }, { price: 61_200, pct: 50 }], leverage: 5, liqPrice: 48_500, tf: "1h", strategyId: "ema_trend", exitProfile: "runner", score: 85, thesis: "t", regime: "bull_trend" }, now);
    return { b, s: r.s, ok: r.ok, assets };
  };
  it("opens with slippage and fees booked", async () => {
    const { s, ok } = await open();
    expect(ok).toBe(true);
    expect(s.positions[0].entry).toBeGreaterThan(60_000);
    expect(s.paperCash).toBeLessThan(1000);
  });
  it("fills partial TPs then the stop from 1m candles and books the trade", async () => {
    const { b, s, assets } = await open();
    const m = (t: number, o: number, h: number, l: number, c: number): Candle => ({ time: (now + t * 60_000) / 1000, open: o, high: h, low: l, close: c, volume: 1 });
    const feed = new StubFeed(60_000, [m(0, 60_000, 60_700, 59_950, 60_650), m(1, 60_650, 60_660, 59_300, 59_350)]);
    const r = await b.sync(s, feed, assets, now + 3 * 60_000);
    expect(r.s.positions).toHaveLength(0);
    expect(r.s.trades).toHaveLength(1);
    const t = r.s.trades[0];
    expect(t.pnlUsd).toBeLessThan(0.5); // +50% at 1R, -50% at the stop, minus costs
    expect(t.pnlUsd).toBeGreaterThan(-3.5);
  });
  it("refuses entry when price is already through the stop", async () => {
    const { ok } = await open(60_100);
    expect(ok).toBe(false);
  });
});

describe("engine cycle (paper, stub feed)", () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const mk = (tf: FeedTf, n: number) => closedCandles(series(n, { seed: 3, tf: TF_MS[tf] / 1000, endMs: now, start: 60_000 }), tf, now);
  const feed = new StubFeed(60_000, [], { "15m": mk("15m", 400), "1h": mk("1h", 400), "4h": mk("4h", 400) });
  const base = (): EngineState => ({ ...newEngineState({ ...DEFAULT_ENGINE_CONFIG, coins: ["BTC"], timeframes: ["1h"], autoTrading: true }), paperCash: 10 });

  it("WAITs when no strategy has a validated edge (never trades without evidence)", async () => {
    const s = await runCycle(base(), { feed, broker: new PaperBroker(4.5, 3), now, validationBudgetMs: 0 });
    expect(s.positions).toHaveLength(0);
    expect(s.opportunities.every((o) => o.decision !== "TRADE")).toBe(true);
    expect(s.opportunities.some((o) => o.decision === "WAIT")).toBe(true);
    expect(s.lastTick?.ok).toBe(true);
  });
  it("emergency stop flattens open positions", async () => {
    let s = base();
    s = { ...s, paperCash: 1000, killSwitch: true, positions: [{ id: "x", mode: "paper", coin: "BTC", side: "long", qty: 0.01, initialQty: 0.01, entry: 59_000, stop: 58_000, initialStop: 58_000, risk: 1000, tps: [], leverage: 5, liqPrice: 48_000, openedAt: now - 3_600_000, barsHeld: 1, tf: "1h", strategyId: "ema_trend", exitProfile: "scale_3", score: 85, thesis: "", beMoved: false, trailingActive: false, feesUsd: 0, fundingUsd: 0, realizedUsd: 0, lastPrice: 60_000, maxFavorableR: 0, lastFundingAt: now }] };
    const out = await runCycle(s, { feed, broker: new PaperBroker(4.5, 3), now });
    expect(out.positions).toHaveLength(0);
    expect(out.trades[0].reason).toBe("EMERGENCY STOP");
  });
  it("halts after the daily loss limit", async () => {
    const s = { ...base(), day: { key: new Date(now).toISOString().slice(0, 10), startEquity: 10.5 } };
    const out = await runCycle(s, { feed, broker: new PaperBroker(4.5, 3), now, validationBudgetMs: 0 });
    expect(out.halted?.reason).toMatch(/Daily loss/);
  });
});

describe("walk-forward validation", () => {
  it("rejects strategies on random-walk data (no fake edge)", () => {
    const c = series(1500, { seed: 11, vol: 0.006 });
    const v = validateStrategy(c, getStrategy("ema_trend")!, "BTC", "1h", DEFAULT_ENGINE_CONFIG, 40);
    expect(v.validated).toBe(false);
    expect(v.why.length).toBeGreaterThan(5);
  }, 60_000);
});
