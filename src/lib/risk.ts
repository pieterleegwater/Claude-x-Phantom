// Risk management: position sizing, leverage, liquidation estimates, fees, funding.
// All sizing is RISK-FIRST: we decide how many dollars we can lose, then derive size.
// Leverage only changes how much margin is locked — it never increases the planned risk
// as long as the stop-loss is honoured and sits well before liquidation.
import type { PositionPlan } from "./types";

export interface RiskInputs {
  equity: number; // account equity in USD
  riskPct: number; // % of equity risked if the stop is hit (e.g. 1 = 1%)
  entry: number;
  stop: number;
  side: "long" | "short";
  leverage: number; // user-selected leverage (1 = spot / no leverage)
  takerFeeBps: number; // per side, e.g. 5 = 0.05%
  slippageBps: number; // expected slippage per side
  maintenanceMarginRate?: number; // e.g. 0.004 (0.4%) for BTC tier 1 on major venues
  maxNotionalPctOfEquity?: number; // hard cap on position notional as % of equity * leverage
  funding8h?: number | null; // fraction, positive = longs pay
  expectedHoldHours?: number;
  maxPositionUsd?: number; // optional external cap (e.g. liquidity constraint)
}

/**
 * Isolated-margin liquidation estimate for a linear (USDT/USDC-margined) perpetual.
 * long:  P_liq = entry * (1 - 1/L + mmr)
 * short: P_liq = entry * (1 + 1/L - mmr)
 * This ignores fees already paid, tiered MMR and venue-specific insurance logic, so it is an
 * ESTIMATE. Always check the exchange's own liquidation price before trading.
 */
export function liquidationPrice(entry: number, leverage: number, side: "long" | "short", mmr = 0.004): number | null {
  if (leverage <= 1) return null; // fully collateralised: no liquidation in the isolated model
  return side === "long" ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr);
}

export function planPosition(i: RiskInputs): PositionPlan {
  const warnings: string[] = [];
  const mmr = i.maintenanceMarginRate ?? 0.004;
  const leverage = Math.max(1, i.leverage);
  const stopDist = Math.abs(i.entry - i.stop);
  const stopDistancePct = (stopDist / i.entry) * 100;
  const riskUsd = (i.equity * i.riskPct) / 100;

  // Cost per unit if the stop is hit: price distance + round-trip fees + slippage on both sides.
  const costRate = ((i.takerFeeBps + i.slippageBps) * 2) / 10_000;
  const lossPerUnit = stopDist + i.entry * costRate;
  let quantity = lossPerUnit > 0 ? riskUsd / lossPerUnit : 0;
  let capped: string | null = null;

  const maxNotional = (i.equity * leverage * (i.maxNotionalPctOfEquity ?? 100)) / 100;
  if (quantity * i.entry > maxNotional) {
    quantity = maxNotional / i.entry;
    capped = `Size capped: the stop is tight, so full risk would need more than ${leverage}x of your equity. Using the maximum your leverage allows.`;
  }
  if (i.maxPositionUsd && quantity * i.entry > i.maxPositionUsd) {
    quantity = i.maxPositionUsd / i.entry;
    capped = `Size capped at $${i.maxPositionUsd.toFixed(0)} (liquidity / max position rule).`;
  }

  const notionalUsd = quantity * i.entry;
  const marginUsd = notionalUsd / leverage;
  const liq = liquidationPrice(i.entry, leverage, i.side, mmr);
  const liquidationDistancePct = liq ? (Math.abs(i.entry - liq) / i.entry) * 100 : null;
  const feesUsd = notionalUsd * ((i.takerFeeBps * 2) / 10_000);
  const actualRisk = quantity * lossPerUnit;

  let fundingUsdEstimate: number | null = null;
  if (i.funding8h != null && i.expectedHoldHours && leverage > 1) {
    const periods = i.expectedHoldHours / 8;
    // Positive funding: longs pay shorts.
    fundingUsdEstimate = notionalUsd * i.funding8h * periods * (i.side === "long" ? 1 : -1);
  }

  if (leverage >= 50) warnings.push(`EXTREME LEVERAGE (${leverage}x): a ${(100 / leverage).toFixed(1)}% move against you wipes the margin. Most professionals never use this.`);
  else if (leverage >= 20) warnings.push(`Very high leverage (${leverage}x). Liquidation is only ~${(100 / leverage).toFixed(1)}% away. Small wicks can liquidate you.`);
  else if (leverage > 10) warnings.push(`High leverage (${leverage}x). Make sure you understand liquidation before using it.`);

  if (liq && liquidationDistancePct != null) {
    const stopBeyondLiq = i.side === "long" ? i.stop <= liq : i.stop >= liq;
    if (stopBeyondLiq) {
      warnings.push(`DANGER: liquidation (~${fmt(liq)}) would happen BEFORE your stop-loss (${fmt(i.stop)}). This plan is invalid at ${leverage}x — lower the leverage.`);
    } else if (liquidationDistancePct < stopDistancePct * 2) {
      warnings.push(`Liquidation is dangerously close to the stop (liq ${liquidationDistancePct.toFixed(2)}% away vs stop ${stopDistancePct.toFixed(2)}%). A wick or slippage past the stop could liquidate you. Lower leverage so liquidation is at least 2x farther than the stop.`);
    }
  }
  if (Math.abs(actualRisk - riskUsd) / Math.max(riskUsd, 1e-9) > 0.02 && capped) {
    warnings.push(`Actual risk is $${actualRisk.toFixed(2)} (below your $${riskUsd.toFixed(2)} budget) because of the size cap.`);
  }
  if (marginUsd > i.equity) warnings.push("Margin required exceeds account equity.");
  if (stopDistancePct < 0.15) warnings.push("Stop is extremely tight (<0.15%) — normal noise and fees may stop you out.");

  return {
    accountEquity: i.equity,
    riskPct: i.riskPct,
    riskUsd: actualRisk,
    quantity,
    notionalUsd,
    leverage,
    marginUsd,
    liquidationPrice: liq,
    liquidationDistancePct,
    stopDistancePct,
    feesUsd,
    fundingUsdEstimate,
    warnings,
    capped,
  };
}

/**
 * The lowest leverage that keeps margin <= `marginBudgetPct` of equity, while ensuring
 * liquidation is at least `liqBuffer` times farther away than the stop. Returns 1 if no
 * leverage is needed. Never derived from confidence.
 */
export function suggestLeverage(opts: {
  equity: number;
  notionalUsd: number;
  stopDistancePct: number;
  maxLeverage: number;
  marginBudgetPct?: number;
  liqBuffer?: number;
  mmr?: number;
}): { leverage: number; reason: string } {
  const budget = (opts.equity * (opts.marginBudgetPct ?? 30)) / 100;
  const needed = Math.max(1, Math.ceil(opts.notionalUsd / Math.max(budget, 1e-9)));
  const mmr = opts.mmr ?? 0.004;
  // liquidation distance ≈ (1/L - mmr) * 100 %. Require >= liqBuffer * stopDistance.
  const liqBuffer = opts.liqBuffer ?? 2.5;
  const maxSafe = Math.max(1, Math.floor(1 / ((opts.stopDistancePct * liqBuffer) / 100 + mmr)));
  const lev = Math.min(needed, maxSafe, opts.maxLeverage);
  let reason = `Lowest leverage that keeps margin under ${opts.marginBudgetPct ?? 30}% of your account.`;
  if (needed > maxSafe) reason = `Capped at ${lev}x so liquidation stays ≥${liqBuffer}x farther than the stop-loss.`;
  if (needed > opts.maxLeverage) reason = `Capped at your max leverage setting (${opts.maxLeverage}x).`;
  if (lev === 1) reason = "No leverage needed for this position size.";
  return { leverage: lev, reason };
}

export function rMultiple(entry: number, stop: number, target: number) {
  const risk = Math.abs(entry - stop);
  return risk === 0 ? 0 : Math.abs(target - entry) / risk;
}

export function fmt(n: number | null | undefined, digits?: number): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const d = digits ?? (Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : Math.abs(n) >= 0.01 ? 4 : 8);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
