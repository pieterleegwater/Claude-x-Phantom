// Risk governor: every new order must pass these checks. Pure functions, fully unit-tested.
// Principles: size from the stop distance, never from confidence; never increase size after a loss;
// halt automatically at the daily / weekly loss limits; reject any trade that cannot be sized
// within the risk budget under the venue's minimum order size.
import type { EngineConfig, EngineState, VenueAsset } from "./types";
import { dayKey, weekKey } from "./types";

export const HL_MIN_NOTIONAL = 10; // Hyperliquid minimum order value (USD)

/** Round a size DOWN to the asset's size decimals (never up — rounding up would exceed risk). */
export function roundSizeDown(qty: number, szDecimals: number) {
  const f = 10 ** szDecimals;
  return Math.floor(qty * f + 1e-9) / f;
}

/** Hyperliquid perp price rules: ≤ 5 significant figures and ≤ (6 − szDecimals) decimals. */
export function roundPrice(px: number, szDecimals: number, mode: "nearest" | "down" | "up" = "nearest") {
  if (!(px > 0)) return px;
  const maxDec = Math.max(0, 6 - szDecimals);
  const sigDec = Math.max(0, 5 - Math.floor(Math.log10(px)) - 1);
  const dec = Math.min(maxDec, sigDec);
  const f = 10 ** dec;
  const fn = mode === "down" ? Math.floor : mode === "up" ? Math.ceil : Math.round;
  return fn(px * f) / f;
}

/**
 * Isolated-margin liquidation price with maintenance margin rate mmr = 1 / (2 × maxLeverage)
 * (Hyperliquid sets maintenance margin at half the initial margin at max leverage).
 * long:  p = e(1 − 1/L) / (1 − mmr)      short: p = e(1 + 1/L) / (1 + mmr)
 */
export function liquidationPrice(entry: number, side: "long" | "short", leverage: number, maxLeverage: number) {
  const mmr = 1 / (2 * maxLeverage);
  return side === "long" ? (entry * (1 - 1 / leverage)) / (1 - mmr) : (entry * (1 + 1 / leverage)) / (1 + mmr);
}

/** Roll the daily / weekly bookkeeping (UTC). Call once per tick with the current equity. */
export function rollPeriods(s: EngineState, equity: number, now = Date.now()): EngineState {
  let next = s;
  const dk = dayKey(now), wk = weekKey(now);
  if (s.day.key !== dk) next = { ...next, day: { key: dk, startEquity: equity }, tradesToday: 0 };
  if (s.week.key !== wk) next = { ...next, week: { key: wk, startEquity: equity, peak: equity } };
  else if (equity > next.week.peak) next = { ...next, week: { ...next.week, peak: equity } };
  if (next.halted?.until != null && now >= next.halted.until) next = { ...next, halted: null };
  return next;
}

export interface LimitCheck {
  canOpen: boolean;
  reasons: string[];
  halt: { reason: string; until: number | null } | null;
  dailyPnlPct: number;
  weeklyDdPct: number;
}

/** Account-level gates. A halt is returned when a loss limit is breached (engine persists it). */
export function evaluateLimits(s: EngineState, equity: number, now = Date.now()): LimitCheck {
  const c = s.config;
  const reasons: string[] = [];
  const dailyPnlPct = s.day.startEquity > 0 ? ((equity - s.day.startEquity) / s.day.startEquity) * 100 : 0;
  const weeklyDdPct = s.week.peak > 0 ? ((equity - s.week.peak) / s.week.peak) * 100 : 0;
  let halt: LimitCheck["halt"] = null;
  if (s.killSwitch) reasons.push("Emergency STOP is active.");
  if (s.halted && (s.halted.until == null || now < s.halted.until)) reasons.push(`Trading halted: ${s.halted.reason}`);
  if (dailyPnlPct <= -c.maxDailyLossPct) {
    const tomorrow = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    halt = { reason: `Daily loss limit reached (${dailyPnlPct.toFixed(2)}% ≤ −${c.maxDailyLossPct}%). Resumes next UTC day.`, until: tomorrow };
    reasons.push(halt.reason);
  }
  if (weeklyDdPct <= -c.maxWeeklyDrawdownPct) {
    halt = { reason: `Weekly drawdown limit reached (${weeklyDdPct.toFixed(2)}% ≤ −${c.maxWeeklyDrawdownPct}%). Manual review required.`, until: null };
    reasons.push(halt.reason);
  }
  if (s.tradesToday >= c.maxTradesPerDay) reasons.push(`Max trades per day reached (${c.maxTradesPerDay}).`);
  if (s.lastLossAt && now - s.lastLossAt < c.cooldownMinAfterLoss * 60_000) reasons.push(`Cooling down after a loss (${Math.ceil((c.cooldownMinAfterLoss * 60_000 - (now - s.lastLossAt)) / 60_000)} min left) — no revenge trading.`);
  if (s.positions.filter((p) => p.mode === c.mode).length >= c.maxOpenPositions) reasons.push(`Max simultaneous positions reached (${c.maxOpenPositions}).`);
  return { canOpen: reasons.length === 0, reasons, halt, dailyPnlPct, weeklyDdPct };
}

export interface SizingInput {
  equity: number;
  config: EngineConfig;
  mode: "paper" | "live";
  lossStreak: number;
  asset: Pick<VenueAsset, "szDecimals" | "maxLeverage">;
  side: "long" | "short";
  entry: number;
  stop: number;
  openRiskUsd: number; // risk already at stake in open positions
}

export interface SizingResult {
  ok: boolean;
  reasons: string[];
  qty: number;
  notional: number;
  margin: number;
  leverage: number;
  riskUsd: number; // loss if stopped, incl. round-trip fees and slippage
  riskPct: number;
  liqPrice: number | null;
  feesUsd: number;
}

export function sizePosition(i: SizingInput): SizingResult {
  const c = i.config;
  const reasons: string[] = [];
  const fail = (r: string): SizingResult => ({ ok: false, reasons: [...reasons, r], qty: 0, notional: 0, margin: 0, leverage: 0, riskUsd: 0, riskPct: 0, liqPrice: null, feesUsd: 0 });
  const dist = Math.abs(i.entry - i.stop);
  if (!(dist > 0) || !(i.entry > 0)) return fail("Invalid entry/stop.");
  if (i.side === "long" ? i.stop >= i.entry : i.stop <= i.entry) return fail("Stop is on the wrong side of entry.");
  // never increase risk after losses; dampen after a losing streak
  let riskPct = c.riskPerTradePct;
  if (i.lossStreak >= 3) { riskPct /= 2; reasons.push(`Risk halved after ${i.lossStreak} consecutive losses.`); }
  const budget = (i.equity * riskPct) / 100;
  const costRate = ((c.takerFeeBps + c.slippageBps) * 2) / 10_000;
  const perUnit = dist + i.entry * costRate;
  const qty = roundSizeDown(budget / perUnit, i.asset.szDecimals);
  const notional = qty * i.entry;
  if (notional < HL_MIN_NOTIONAL) {
    const neededRisk = (HL_MIN_NOTIONAL / i.entry) * perUnit;
    return fail(`Cannot size within risk: the $${HL_MIN_NOTIONAL} minimum order would risk $${neededRisk.toFixed(3)} (${((neededRisk / i.equity) * 100).toFixed(2)}% of equity) vs budget $${budget.toFixed(3)} (${riskPct}%). Stop is ${((dist / i.entry) * 100).toFixed(2)}% away — skipped instead of oversizing.`);
  }
  const cap = Math.min(i.mode === "live" ? c.maxLeverageLive : Math.min(c.simLeverage, c.maxLeverageSim), i.asset.maxLeverage);
  // lowest leverage whose margin fits in 60% of equity
  let leverage = Math.max(1, Math.ceil(notional / (i.equity * 0.6)));
  if (leverage > cap) return fail(`Needs ${leverage}x to fit the margin, above the ${cap}x cap.`);
  if (i.mode === "paper") leverage = Math.max(leverage, Math.min(cap, c.simLeverage)); // simulation uses the chosen leverage
  // walk leverage down until liquidation sits beyond the stop with a 1.5× buffer
  const safe = (L: number) => {
    const lq = liquidationPrice(i.entry, i.side, L, i.asset.maxLeverage);
    const beyond = i.side === "long" ? lq < i.stop : lq > i.stop;
    return beyond && Math.abs(i.entry - lq) >= dist * 1.5 && notional / L <= i.equity * 0.95;
  };
  let chosen = 0;
  for (let L = leverage; L >= 1; L--) if (safe(L)) { chosen = L; break; }
  if (!chosen) return fail(`Liquidation would be within 1.5× the stop distance (or margin too large) at every leverage ≤ ${leverage}x.`);
  if (chosen < leverage) reasons.push(`Leverage reduced ${leverage}x → ${chosen}x so liquidation stays well beyond the stop.`);
  leverage = chosen;
  const riskUsd = qty * perUnit;
  if (i.openRiskUsd + riskUsd > (i.equity * c.maxDailyLossPct) / 100) return fail(`Total open risk would exceed the daily loss limit (${c.maxDailyLossPct}%).`);
  const finalLiq = liquidationPrice(i.entry, i.side, leverage, i.asset.maxLeverage);
  return {
    ok: true,
    reasons,
    qty,
    notional,
    margin: notional / leverage,
    leverage,
    riskUsd,
    riskPct: (riskUsd / i.equity) * 100,
    liqPrice: finalLiq,
    feesUsd: notional * (c.takerFeeBps * 2) / 10_000,
  };
}
