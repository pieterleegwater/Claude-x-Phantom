import { describe, it, expect } from "vitest";
import { newPaperState, openPosition, updatePrices, closeQty, equity, stats } from "@/lib/paper";

const cost = { takerFeeBps: 5, slippageBps: 0, mmr: 0.004 };

describe("paper trading", () => {
  it("opens, takes partial profit, moves stop to break-even, then stops out at BE", () => {
    let s = newPaperState(10_000);
    const o = openPosition(s, { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "long", qty: 0.1, stop: 49_000, takeProfits: [{ price: 51_000, closePct: 50 }, { price: 53_000, closePct: 50 }], leverage: 5, setup: "test" }, 50_000, cost);
    expect(o.error).toBeUndefined();
    s = o.state;
    expect(s.balance).toBeCloseTo(10_000 - 5000 * 0.0005, 6);
    let r = updatePrices(s, { BTC: { price: 51_100 } }, cost);
    s = r.state;
    expect(r.events[0].type).toBe("tp");
    expect(s.positions[0].qty).toBeCloseTo(0.05, 9);
    expect(s.positions[0].stop).toBe(s.positions[0].entry);
    r = updatePrices(s, { BTC: { price: 49_990 } }, cost);
    s = r.state;
    expect(s.positions).toHaveLength(0);
    expect(s.closedPositions).toHaveLength(1);
    expect(s.closedPositions[0].pnl).toBeGreaterThan(0); // TP1 profit exceeds fees
    expect(equity(s)).toBeCloseTo(s.balance, 9);
  });
  it("stop is checked before take-profit within one update (conservative)", () => {
    let s = openPosition(newPaperState(10_000), { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "long", qty: 0.1, stop: 49_000, takeProfits: [{ price: 51_000, closePct: 100 }], leverage: 2, setup: "t" }, 50_000, cost).state;
    s = updatePrices(s, { BTC: { price: 50_000, high: 51_500, low: 48_500 } }, cost).state;
    expect(s.fills[0].reason).toBe("stop");
  });
  it("rejects positions where liquidation precedes the stop", () => {
    const r = openPosition(newPaperState(10_000), { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "long", qty: 0.1, stop: 45_000, takeProfits: [], leverage: 20, setup: "t" }, 50_000, cost);
    expect(r.error).toMatch(/liquidation/i);
  });
  it("spot cannot be shorted", () => {
    const r = openPosition(newPaperState(10_000), { market: "BTC-SPOT", asset: "BTC", priceKey: "BTC", side: "short", qty: 0.01, stop: 51_000, takeProfits: [], leverage: 1, setup: "t" }, 50_000, cost);
    expect(r.error).toBeTruthy();
  });
  it("short PnL sign and funding accrual", () => {
    const t0 = 1_000_000;
    let s = openPosition(newPaperState(10_000), { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "short", qty: 0.1, stop: 52_000, takeProfits: [], leverage: 3, setup: "t" }, 50_000, cost, t0).state;
    s = updatePrices(s, { BTC: { price: 49_000, funding8h: 0.0001 } }, cost, t0 + 8 * 3600_000).state;
    // positive funding: shorts RECEIVE
    expect(s.positions[0].fundingPaid).toBeLessThan(0);
    const c = closeQty(s, s.positions[0].id, 0.1, 49_000, "manual", cost, t0 + 9 * 3600_000);
    expect(c.fill!.pnl).toBeGreaterThan(90);
    expect(stats(c.state).closed).toBe(1);
  });
});

describe("paper trading — regression (review findings)", () => {
  const open = (over: Partial<Parameters<typeof openPosition>[1]> = {}, price = 100_000, now = 1_000_000_000) =>
    openPosition(newPaperState(10_000), { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "long", qty: 0.1, stop: 99_500, takeProfits: [{ price: 102_000, closePct: 100 }], leverage: 2, setup: "t", ...over }, price, cost, now).state;

  it("candles from before the position opened do not trigger the stop", () => {
    const t0 = 1_000_000_000;
    const s = open({}, 100_000, t0);
    const oldDip = { time: Math.floor((t0 - 20 * 60_000) / 1000), high: 100_100, low: 99_000 };
    const r = updatePrices(s, { BTC: { price: 100_000, candles: [oldDip] } }, cost, t0 + 10_000);
    expect(r.state.positions).toHaveLength(1);
    const newDip = { time: Math.floor((t0 + 60_000) / 1000), high: 100_100, low: 99_000 };
    const r2 = updatePrices(s, { BTC: { price: 100_000, candles: [newDip] } }, cost, t0 + 130_000);
    expect(r2.state.fills[0].reason).toBe("stop");
  });
  it("a wick through stop AND liquidation stops out, not liquidates", () => {
    const s = openPosition(newPaperState(10_000), { market: "BTC-PERP", asset: "BTC", priceKey: "BTC", side: "long", qty: 0.1, stop: 95_000, takeProfits: [], leverage: 10, setup: "t" }, 100_000, cost).state;
    const r = updatePrices(s, { BTC: { price: 96_000, low: 89_000 } }, cost);
    expect(r.state.fills[0].reason).toBe("stop");
  });
  it("gap beyond the stop fills at the worse current price", () => {
    const s = open();
    const r = updatePrices(s, { BTC: { price: 99_000 } }, cost);
    expect(r.state.fills[0].exit).toBeLessThan(99_500);
  });
  it("funding is not double counted after a partial close", () => {
    const t0 = 1_000_000_000;
    let s = open({ takeProfits: [] }, 100_000, t0);
    s = updatePrices(s, { BTC: { price: 100_000, funding8h: 0.001 } }, cost, t0 + 3600_000).state;
    const paid = s.positions[0].fundingPaid;
    s = closeQty(s, s.positions[0].id, 0.05, 100_000, "manual", cost, t0 + 3600_001).state;
    expect(stats(s).fundingPaid).toBeCloseTo(paid, 9);
  });
  it("funding gaps are capped at 1 hour per update", () => {
    const t0 = 1_000_000_000;
    const s = open({ takeProfits: [] }, 100_000, t0);
    const r = updatePrices(s, { BTC: { price: 100_000, funding8h: 0.001 } }, cost, t0 + 72 * 3600_000);
    expect(r.state.positions[0].fundingPaid).toBeCloseTo(0.1 * 100_000 * 0.001 / 8, 6);
  });
  it("exits use the cost model fixed at open (memecoins)", () => {
    const memeCost = { takerFeeBps: 30, slippageBps: 50, mmr: 0.004 };
    let s = openPosition(newPaperState(10_000), { market: "SOL-MEME", asset: "X", priceKey: "m", side: "long", qty: 1000, stop: 0.08, takeProfits: [], leverage: 1, setup: "t" }, 0.1, memeCost).state;
    s = closeQty(s, s.positions[0].id, 1000, 0.1, "manual", cost).state; // global cost passed, position cost must win
    expect(s.fills[0].exit).toBeCloseTo(0.1 * (1 - 0.005), 9);
  });
  it("a single 50% target closes only 50%", () => {
    let s = open({ takeProfits: [{ price: 101_000, closePct: 50 }] });
    s = updatePrices(s, { BTC: { price: 101_100 } }, cost).state;
    expect(s.positions[0].qty).toBeCloseTo(0.05, 9);
  });
  it("today's PnL starts from equity at midnight, not from position entry", () => {
    const midnight = new Date(2026, 10, 22).getTime();
    let s = open({ takeProfits: [] }, 100_000, midnight - 6 * 3600_000);
    // yesterday the position fell to 95k (−$500); snapshot taken before midnight
    s = updatePrices(s, { BTC: { price: 99_600 } }, cost, midnight - 60_000).state;
    s = { ...s, equityHistory: [...s.equityHistory, { t: midnight - 60_000, equity: 10_000 - 500 }] };
    s = { ...s, positions: s.positions.map((p) => ({ ...p, lastPrice: 99_700 })) };
    const st = stats(s, midnight + 3600_000);
    expect(st.todayPnl).toBeGreaterThan(0); // price rose today even though the trade is still red overall
  });
});
