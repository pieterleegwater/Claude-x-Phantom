import { describe, it, expect } from "vitest";
import { emptyLive, recordBuy, recordSell, reconcile, liveStats, triggeredLevels, setLevels } from "@/lib/live";

const M = "DessaMint1111111111111111111111111111111111";

describe("live position tracking", () => {
  it("averages entries and realises PnL on partial and full sells", () => {
    let s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 500, usd: 2, sig: "a" });
    s = recordBuy(s, { mint: M, symbol: "DESSA", decimals: 6, tokens: 500, usd: 3, sig: "b" });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0].entryPrice).toBeCloseTo(0.005, 9);
    s = recordSell(s, { mint: M, tokens: 500, usd: 4, sig: "c" }); // cost 2.5 -> +1.5
    expect(s.trades[0].pnlUsd).toBeCloseTo(1.5, 9);
    expect(s.positions[0].investedUsd).toBeCloseTo(2.5, 9);
    s = recordSell(s, { mint: M, tokens: 500, usd: 2, sig: "d" }); // cost 2.5 -> -0.5
    expect(s.positions[0].closedAt).toBeDefined();
    const st = liveStats(s, {});
    expect(st.realized).toBeCloseTo(1, 9);
    expect(st.closedCount).toBe(1);
    expect(st.winRate).toBe(1);
  });
  it("unrealised PnL uses live price and wallet balance", () => {
    const s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 532.93, usd: 2, sig: "a" });
    const st = liveStats(s, { [M]: 0.00366 }, { [M]: 532.93 });
    expect(st.valueOpen).toBeCloseTo(1.95, 2);
    expect(st.unrealized).toBeCloseTo(-0.05, 2);
  });
  it("unknown price shows the position at cost, not as a loss", () => {
    const s = recordBuy(emptyLive(), { mint: M, symbol: "X", decimals: 6, tokens: 10, usd: 5, sig: null });
    expect(liveStats(s, {}).unrealized).toBe(0);
  });
  it("reconcile records sells done outside EdgePilot, and never guesses without a balance", () => {
    let s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 1000, usd: 4, sig: "a" });
    expect(reconcile(s, {}, { [M]: 0.01 }).changed).toHaveLength(0);
    const r = reconcile(s, { [M]: 0 }, { [M]: 0.006 });
    s = r.state;
    expect(r.changed).toEqual(["DESSA"]);
    expect(s.positions[0].closedAt).toBeDefined();
    expect(s.trades[0].pnlUsd).toBeCloseTo(2, 9);
    expect(s.trades[0].note).toMatch(/estimated/);
  });
  it("reconcile attributes a filled Jupiter TP order to its target price", () => {
    let s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 1000, usd: 4, sig: "a" });
    s = setLevels(s, M, { tps: [{ price: 0.008, pct: 50, status: "order", order: "o1" }] });
    s = reconcile(s, { [M]: 500 }, { [M]: 0.0082 }).state;
    expect(s.trades[0].usd).toBeCloseTo(4, 9);
    expect(s.positions[0].tps[0].status).toBe("done");
  });
  it("detects stop and planned TP breaches", () => {
    let s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 1000, usd: 4, sig: "a" });
    s = setLevels(s, M, { stop: 0.003, tps: [{ price: 0.006, pct: 50, status: "planned" }] });
    const p = s.positions[0];
    expect(triggeredLevels(p, 0.0029)?.kind).toBe("stop");
    expect(triggeredLevels(p, 0.0061)?.kind).toBe("tp");
    expect(triggeredLevels(p, 0.004)).toBeNull();
  });
});

describe("live reconcile safety", () => {
  it("ignores positions owned by a different wallet", () => {
    const s = recordBuy(emptyLive(), { mint: M, symbol: "DESSA", decimals: 6, tokens: 1000, usd: 4, sig: "a", owner: "WalletA" });
    expect(reconcile(s, { [M]: 0 }, { [M]: 0.01 }, Date.now(), "WalletB").changed).toHaveLength(0);
    expect(reconcile(s, { [M]: 0 }, { [M]: 0.01 }, Date.now(), "WalletA").changed).toEqual(["DESSA"]);
  });
});
