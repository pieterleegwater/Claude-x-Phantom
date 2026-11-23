import { describe, it, expect } from "vitest";
import { analyzeBtc } from "@/lib/analysis/btcEngine";
import { analyzeMeme, type MemeToken } from "@/lib/analysis/memeEngine";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { aggregate } from "@/lib/indicators";
import { series } from "./helpers";

describe("BTC engine", () => {
  const now = Date.now();
  it("produces a complete, valid signal on realistic data", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const h1 = series(1000, { seed, drift: seed % 2 ? 0.0004 : -0.0004, endMs: now });
      const h4 = aggregate(series(2000, { seed: seed + 100, endMs: now }), 14400);
      const a = analyzeBtc({ primary: h1, primaryTf: "1h", higher: h4, higherTf: "4h", derivatives: null, settings: DEFAULT_SETTINGS, market: "BTC-PERP", leverage: 3, now });
      const s = a.signal;
      expect(["LONG", "SHORT", "WAIT", "NO_TRADE"]).toContain(s.direction);
      expect(s.qualityScore).toBeGreaterThanOrEqual(0);
      expect(s.qualityScore).toBeLessThanOrEqual(100);
      const w = s.factors.reduce((t, f) => t + f.weight, 0);
      expect(w).toBeCloseTo(1, 6);
      expect(s.summary.length).toBeGreaterThan(10);
      if (s.direction === "LONG" || s.direction === "SHORT") {
        // an actionable signal must have passed every reject rule
        expect(s.rules.filter((r) => r.severity === "reject").every((r) => r.passed)).toBe(true);
        expect(s.stopLoss).not.toBeNull();
        expect(s.position).not.toBeNull();
        expect(s.riskReward!).toBeGreaterThanOrEqual(DEFAULT_SETTINGS.minRiskReward);
      }
    }
  });
  it("spot never produces SHORT", () => {
    for (const seed of [21, 22, 23]) {
      const h1 = series(1000, { seed, drift: -0.0008, endMs: now });
      const h4 = aggregate(series(2000, { seed, drift: -0.0008, endMs: now }), 14400);
      const a = analyzeBtc({ primary: h1, primaryTf: "1h", higher: h4, higherTf: "4h", derivatives: null, settings: DEFAULT_SETTINGS, market: "BTC-SPOT", leverage: 1, now });
      expect(a.signal.direction).not.toBe("SHORT");
      expect(a.signal.direction).not.toBe("LONG");
    }
  });
  it("stale data fails the freshness rule and cannot produce a trade", () => {
    const old = now - 10 * 3600_000;
    const h1 = series(1000, { seed: 5, endMs: old });
    const h4 = aggregate(series(2000, { seed: 6, endMs: old }), 14400);
    const a = analyzeBtc({ primary: h1, primaryTf: "1h", higher: h4, higherTf: "4h", derivatives: null, settings: DEFAULT_SETTINGS, market: "BTC-PERP", leverage: 3, now });
    expect(a.signal.rules.find((r) => r.id === "fresh")?.passed).toBe(false);
    expect(["LONG", "SHORT"]).not.toContain(a.signal.direction);
  });
  it("drops the forming candle", () => {
    const h1 = series(1001, { seed: 9, endMs: now + 3600_000 }); // last candle is still open
    const h4 = aggregate(series(2000, { seed: 10, endMs: now }), 14400);
    const a = analyzeBtc({ primary: h1, primaryTf: "1h", higher: h4, higherTf: "4h", derivatives: null, settings: DEFAULT_SETTINGS, market: "BTC-PERP", leverage: 3, now });
    expect(a.closedCandles.length).toBe(1000);
  });
});

const baseToken = (): MemeToken => ({
  mint: "So11111111111111111111111111111111111111112",
  symbol: "TEST",
  name: "Test",
  pairAddress: "x",
  dexId: "raydium",
  url: "",
  priceUsd: 0.01,
  priceChange: { m5: 1.5, h1: 12, h6: 30, h24: 60 },
  volume: { m5: 20_000, h1: 150_000, h6: 300_000, h24: 900_000 },
  txns: { m5: { buys: 60, sells: 40 }, h1: { buys: 700, sells: 450 }, h6: { buys: 3000, sells: 2200 }, h24: { buys: 9000, sells: 7000 } },
  liquidityUsd: 400_000,
  fdv: 3_000_000,
  marketCap: 3_000_000,
  pairCreatedAt: Date.now() - 3 * 86_400_000,
  socials: [{ type: "twitter", url: "x" }],
  websites: ["https://example.com"],
  boosts: 0,
  risk: { source: "RugCheck", fetched: true, risks: [], mintAuthority: null, freezeAuthority: null, lpLockedPct: 100, topHolders: [{ address: "a", pct: 4 }], top10Pct: 14, totalHolders: 5000, insidersDetected: 0, mutableMetadata: false },
});

describe("memecoin engine", () => {
  it("a clean, liquid, accelerating token can qualify as BUY", () => {
    const a = analyzeMeme(baseToken(), DEFAULT_SETTINGS);
    expect(["BREAKOUT", "EARLY MOMENTUM", "TRENDING"]).toContain(a.category);
    expect(a.critical).toHaveLength(0);
    expect(a.signal.direction).toBe("BUY");
    expect(a.signal.position!.notionalUsd).toBeLessThanOrEqual((DEFAULT_SETTINGS.accountEquity * DEFAULT_SETTINGS.memeMaxPositionPct) / 100 + 1e-6);
  });
  it("freeze authority => POSSIBLE RUG and NO_TRADE regardless of momentum", () => {
    const t = baseToken();
    t.risk!.freezeAuthority = "SomeAuthority111111111111111111111111111";
    const a = analyzeMeme(t, DEFAULT_SETTINGS);
    expect(a.category).toBe("POSSIBLE RUG");
    expect(a.signal.direction).toBe("NO_TRADE");
  });
  it("honeypot pattern (no sells) is flagged", () => {
    const t = baseToken();
    t.txns.h1 = { buys: 500, sells: 5 };
    expect(analyzeMeme(t, DEFAULT_SETTINGS).category).toBe("POSSIBLE RUG");
  });
  it("liquidity pull since last scan is flagged", () => {
    const a = analyzeMeme(baseToken(), DEFAULT_SETTINGS, { prevLiquidity: 1_000_000 });
    expect(a.critical.some((c) => c.includes("Liquidity fell"))).toBe(true);
  });
  it("unverified tokens are never actionable", () => {
    const t = baseToken();
    t.risk = { source: "RugCheck", fetched: false, risks: [], topHolders: [] };
    const a = analyzeMeme(t, DEFAULT_SETTINGS);
    expect(a.score).toBeLessThanOrEqual(60);
    expect(a.signal.direction).not.toBe("BUY");
  });
  it("dump risk: a holder that can crash the price >65% blocks BUY", () => {
    const t = baseToken();
    t.risk!.topHolders = [{ address: "whale", pct: 12 }]; // 12% of $3M = $360k into a $200k quote side
    const a = analyzeMeme(t, DEFAULT_SETTINGS);
    expect(a.dumpRiskTop1!).toBeGreaterThan(65);
    expect(a.signal.direction).not.toBe("BUY");
    expect(a.signal.rules.find((r) => r.id === "dump")?.passed).toBe(false);
  });
  it("gap-aware sizing: a full dump costs at most the risk budget", () => {
    const a = analyzeMeme(baseToken(), DEFAULT_SETTINGS);
    const budget = (DEFAULT_SETTINGS.accountEquity * DEFAULT_SETTINGS.riskPerTradePct) / 100;
    const worst = Math.max(0.5, a.dumpRiskTop1! / 100);
    expect(a.signal.position!.notionalUsd * worst).toBeLessThanOrEqual(budget + 1e-6);
  });
  it("unknown holders => no BUY", () => {
    const t = baseToken();
    t.risk!.topHolders = [];
    t.risk!.top10Pct = null;
    expect(analyzeMeme(t, DEFAULT_SETTINGS).signal.direction).not.toBe("BUY");
  });
  it("tiny liquidity => AVOID", () => {
    const t = baseToken();
    t.liquidityUsd = 5_000;
    expect(analyzeMeme(t, DEFAULT_SETTINGS).category).toBe("AVOID");
  });
});
