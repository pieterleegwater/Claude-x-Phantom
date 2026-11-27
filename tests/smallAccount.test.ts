// $10 account compatibility across the traded coins (Hyperliquid parameters as configured:
// $10 minimum order value, size decimals BTC 5 / ETH 4 / SOL 2, max leverage 40 / 25 / 20,
// taker 4.5 bps + 3 bps slippage per side).
import { describe, it, expect } from "vitest";
import { sizePosition, HL_MIN_NOTIONAL } from "@/lib/engine/riskGovernor";
import { DEFAULT_ENGINE_CONFIG } from "@/lib/engine/types";

const COINS = [
  { coin: "BTC", px: 60_000, szDecimals: 5, maxLeverage: 40 },
  { coin: "ETH", px: 3_000, szDecimals: 4, maxLeverage: 25 },
  { coin: "SOL", px: 150, szDecimals: 2, maxLeverage: 20 },
];

describe("$10 account — never increases risk to satisfy the exchange minimum", () => {
  for (const c of COINS) {
    it(`${c.coin}: finds the widest tradable stop and never exceeds $0.05 risk`, () => {
      let widest = 0;
      for (let bp = 5; bp <= 200; bp += 1) {
        const stop = c.px * (1 - bp / 10_000);
        const r = sizePosition({ equity: 10, config: DEFAULT_ENGINE_CONFIG, mode: "live", lossStreak: 0, asset: c, side: "long", entry: c.px, stop, openRiskUsd: 0 });
        if (r.ok) {
          widest = bp;
          expect(r.riskUsd).toBeLessThanOrEqual(0.05 + 1e-9);
          expect(r.notional).toBeGreaterThanOrEqual(HL_MIN_NOTIONAL);
          expect(r.leverage).toBeLessThanOrEqual(DEFAULT_ENGINE_CONFIG.maxLeverageLive);
          expect(r.margin).toBeLessThanOrEqual(10);
        }
      }
      console.log(`${c.coin}: widest affordable stop ≈ ${(widest / 100).toFixed(2)}%`);
      expect(widest).toBeGreaterThan(0);
      expect(widest).toBeLessThan(40); // ≈0.35%: anything wider is skipped
    });
  }
});
