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
