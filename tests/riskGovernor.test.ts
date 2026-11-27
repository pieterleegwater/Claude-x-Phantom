import { describe, it, expect } from "vitest";
import { sizePosition, evaluateLimits, liquidationPrice, roundPrice, roundSizeDown, rollPeriods } from "@/lib/engine/riskGovernor";
import { DEFAULT_ENGINE_CONFIG, newEngineState, type EngineConfig } from "@/lib/engine/types";

const BTC = { szDecimals: 5, maxLeverage: 40 };
const base = (over: Partial<Parameters<typeof sizePosition>[0]> = {}) =>
  sizePosition({ equity: 10, config: DEFAULT_ENGINE_CONFIG, mode: "live", lossStreak: 0, asset: BTC, side: "long", entry: 60_000, stop: 59_820, openRiskUsd: 0, ...over });

describe("risk governor — $10 account", () => {
  it("sizes a tight-stop trade within 0.5% risk incl. fees and slippage", () => {
    const r = base(); // 0.3% stop: the widest a $10 / 0.5% account can afford after costs
    expect(r.ok).toBe(true);
    expect(r.riskUsd).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(r.notional).toBeGreaterThanOrEqual(10);
    expect(r.leverage).toBeLessThanOrEqual(DEFAULT_ENGINE_CONFIG.maxLeverageLive);
  });
  it("skips (does not oversize) when the $10 minimum order would exceed the risk budget", () => {
    const r = base({ stop: 59_760 }); // 0.4% stop + 0.15% costs -> $0.055 at $10 notional > $0.05 budget
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/Cannot size within risk/);
  });
  it("never lets liquidation sit before the stop (40x simulation)", () => {
    const cfg: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, simLeverage: 40 };
    const r = sizePosition({ equity: 1000, config: cfg, mode: "paper", lossStreak: 0, asset: BTC, side: "long", entry: 60_000, stop: 58_800, openRiskUsd: 0 }); // 2% stop
    expect(r.ok).toBe(true);
    const liqDist = (60_000 - r.liqPrice!) / 60_000;
    expect(liqDist).toBeGreaterThanOrEqual(0.02 * 1.5 - 1e-9);
    expect(r.leverage).toBeLessThan(40);
  });
  it("40x is used in simulation when the stop allows it", () => {
    const cfg: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, simLeverage: 40 };
    const r = sizePosition({ equity: 1000, config: cfg, mode: "paper", lossStreak: 0, asset: BTC, side: "short", entry: 60_000, stop: 60_240, openRiskUsd: 0 });
    expect(r.ok).toBe(true);
    expect(r.leverage).toBe(40);
    expect(r.liqPrice!).toBeGreaterThan(60_240);
  });
  it("halves risk after a losing streak and never increases it", () => {
    const normal = sizePosition({ equity: 1000, config: DEFAULT_ENGINE_CONFIG, mode: "live", lossStreak: 0, asset: BTC, side: "long", entry: 60_000, stop: 59_400, openRiskUsd: 0 });
    const streak = sizePosition({ equity: 1000, config: DEFAULT_ENGINE_CONFIG, mode: "live", lossStreak: 4, asset: BTC, side: "long", entry: 60_000, stop: 59_400, openRiskUsd: 0 });
    expect(streak.riskUsd).toBeLessThan(normal.riskUsd * 0.6);
  });
  it("rejects a stop on the wrong side", () => expect(base({ stop: 60_100 }).ok).toBe(false));
});

describe("account limits", () => {
  it("halts at the 1.5% daily loss until the next UTC day", () => {
    const now = Date.UTC(2026, 10, 27, 15);
    const s = { ...newEngineState(), day: { key: "2026-11-27", startEquity: 10 } };
    const r = evaluateLimits(s, 9.84, now);
    expect(r.canOpen).toBe(false);
    expect(r.halt?.until).toBe(Date.UTC(2026, 10, 28));
  });
  it("halts at the 5% weekly drawdown and requires manual review", () => {
    const s = { ...newEngineState(), week: { key: "x", startEquity: 10, peak: 10.5 }, day: { key: "x", startEquity: 10 } };
    const r = evaluateLimits(s, 9.97, Date.now());
    expect(r.halt?.until).toBeNull();
  });
  it("cool-down after a loss blocks new entries (no revenge trading)", () => {
    const now = Date.now();
    const s = { ...newEngineState(), lastLossAt: now - 5 * 60_000 };
    expect(evaluateLimits(s, 10, now).reasons.join(" ")).toMatch(/Cooling down/);
  });
  it("emergency stop blocks everything", () => {
    expect(evaluateLimits({ ...newEngineState(), killSwitch: true }, 10).canOpen).toBe(false);
  });
  it("rolls periods and clears expired halts", () => {
    const s = { ...newEngineState(), day: { key: "2000-01-01", startEquity: 5 }, halted: { reason: "x", at: 0, until: 1 } };
    const r = rollPeriods(s, 10);
    expect(r.day.startEquity).toBe(10);
    expect(r.halted).toBeNull();
  });
});

describe("venue rounding & liquidation", () => {
  it("rounds sizes down and prices to 5 significant figures", () => {
    expect(roundSizeDown(0.000209, 5)).toBe(0.0002);
    expect(roundPrice(60123.456, 5)).toBe(60123);
    expect(roundPrice(1.234567, 2)).toBe(1.2346);
  });
  it("liquidation formula", () => {
    expect(liquidationPrice(100, "long", 10, 40)).toBeCloseTo((100 * 0.9) / (1 - 1 / 80), 9);
    expect(liquidationPrice(100, "short", 10, 40)).toBeCloseTo((100 * 1.1) / (1 + 1 / 80), 9);
  });
});
