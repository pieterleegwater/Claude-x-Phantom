import { describe, it, expect } from "vitest";
import { liquidationPrice, planPosition, suggestLeverage } from "@/lib/risk";

describe("risk", () => {
  it("liquidation price formula (isolated, linear)", () => {
    expect(liquidationPrice(100, 10, "long", 0.004)).toBeCloseTo(90.4);
    expect(liquidationPrice(100, 10, "short", 0.004)).toBeCloseTo(109.6);
    expect(liquidationPrice(100, 1, "long")).toBeNull();
  });
  it("sizes by risk: loss at stop incl. costs equals risk budget", () => {
    const p = planPosition({ equity: 10_000, riskPct: 1, entry: 50_000, stop: 49_000, side: "long", leverage: 5, takerFeeBps: 5, slippageBps: 3 });
    expect(p.riskUsd).toBeCloseTo(100, 1);
    const lossPerUnit = 1000 + 50_000 * ((5 + 3) * 2) / 10_000;
    expect(p.quantity).toBeCloseTo(100 / lossPerUnit, 6);
    expect(p.marginUsd).toBeCloseTo(p.notionalUsd / 5, 6);
  });
  it("leverage does not change dollar risk", () => {
    const a = planPosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 98, side: "long", leverage: 2, takerFeeBps: 5, slippageBps: 0 });
    const b = planPosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 98, side: "long", leverage: 8, takerFeeBps: 5, slippageBps: 0 });
    expect(a.riskUsd).toBeCloseTo(b.riskUsd, 6);
    expect(b.marginUsd).toBeLessThan(a.marginUsd);
  });
  it("warns when liquidation comes before the stop", () => {
    const p = planPosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 90, side: "long", leverage: 20, takerFeeBps: 5, slippageBps: 0 });
    expect(p.warnings.some((w) => w.startsWith("DANGER"))).toBe(true);
  });
  it("warns on extreme leverage", () => {
    const p = planPosition({ equity: 10_000, riskPct: 1, entry: 100, stop: 99.5, side: "short", leverage: 100, takerFeeBps: 5, slippageBps: 0 });
    expect(p.warnings.some((w) => w.includes("EXTREME"))).toBe(true);
  });
  it("suggested leverage keeps liquidation >= 2.5x stop distance and respects max", () => {
    const s = suggestLeverage({ equity: 1000, notionalUsd: 50_000, stopDistancePct: 2, maxLeverage: 50 });
    const liqDist = (1 / s.leverage - 0.004) * 100;
    expect(liqDist).toBeGreaterThanOrEqual(2 * 2.5);
    expect(suggestLeverage({ equity: 1000, notionalUsd: 50_000, stopDistancePct: 0.1, maxLeverage: 5 }).leverage).toBeLessThanOrEqual(5);
  });
});
