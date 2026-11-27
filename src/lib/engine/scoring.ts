// Opportunity scoring (0–100) with critical flags that override any score.
// Bands: 90–100 exceptional · 80–89 high · 70–79 watch / paper only · <70 no trade.
import type { Candle, DerivativesSnapshot, FactorScore } from "../types";
import { Indicators } from "../strategies";
import { factorScores } from "../analysis/btcEngine";
import { readStructure } from "../analysis/structure";
import { emaRibbon, structureEvents } from "./features";
import { readRegime, type MarketRegime, type RegimeRead } from "./regime";
import type { EngineConfig, ExitProfile, ValidationResult, VenueAsset } from "./types";
import { clamp, scale } from "../indicators";

export interface ScoreInput {
  c: Candle[]; // closed candles of the execution timeframe
  htf: Candle[]; // closed candles of the higher timeframe
  side: "long" | "short";
  entry: number;
  stop: number;
  exit: ExitProfile;
  regime: RegimeRead;
  strategyRegimes: MarketRegime[];
  family: string;
  validation: ValidationResult | null;
  asset: VenueAsset;
  book: { imbalance: number; depthUsd: number; spreadPct: number } | null;
  notional: number;
  dataAgeSec: number;
  tfSec: number;
  config: EngineConfig;
}

export interface ScoreResult {
  score: number;
  band: "exceptional" | "high" | "watch" | "none";
  factors: FactorScore[];
  flags: string[]; // critical — any flag blocks the trade
}

const W = { trend: 0.13, momentum: 0.09, volume: 0.09, structure: 0.11, htf: 0.12, entry: 0.1, rr: 0.09, volatility: 0.05, liquidity: 0.08, edge: 0.08, conditions: 0.06 };

export function band(score: number): ScoreResult["band"] {
  return score >= 90 ? "exceptional" : score >= 80 ? "high" : score >= 70 ? "watch" : "none";
}

export function scoreOpportunity(x: ScoreInput): ScoreResult {
  const s: 1 | -1 = x.side === "long" ? 1 : -1;
  const ind = new Indicators(x.c);
  const i = x.c.length - 1;
  const risk = Math.abs(x.entry - x.stop);
  const blendedR = x.exit.tps.length ? x.exit.tps.reduce((t, tp) => t + (tp.r * tp.pct) / 100, 0) : 2;
  const funding8h = x.asset.funding * 8;
  const deriv: DerivativesSnapshot = { venue: "Hyperliquid", markPrice: x.asset.markPx, fundingRate: x.asset.funding, fundingIntervalHours: 1, funding8h, nextFundingTime: null, openInterestBase: x.asset.openInterest, openInterestUsd: x.asset.openInterest * x.asset.markPx, openInterestChangePct24h: null, longShortRatio: null, longShortSource: null, liquidations24h: null, fundingHistory: [] };
  const base = factorScores(x.c, x.htf, ind, x.side, deriv, blendedR, readStructure(x.c), readStructure(x.htf));
  const get = (k: string) => base.find((f) => f.key === k)?.score ?? 50;

  // structure: add BOS/CHOCH alignment on the execution timeframe
  const st = structureEvents(x.c);
  const structScore = clamp(get("structure") * 0.6 + (st.trend[i] === s ? 40 : st.trend[i] === 0 ? 15 : 0), 0, 100);
  // higher timeframe: ribbon stack + HTF regime
  const hr = emaRibbon(x.htf), hi = x.htf.length - 1;
  const htfRegime = x.htf.length > 220 ? readRegime(x.htf).regime : "range";
  const htfScore = (hr.stack[hi] === s ? 60 : hr.stack[hi] === 0 ? 30 : 0) + ((s === 1 && htfRegime === "bull_trend") || (s === -1 && htfRegime === "bear_trend") ? 40 : htfRegime === "range" || htfRegime === "low_vol" ? 20 : 0);
  // entry quality: not chasing — distance from EMA21 in ATR
  const r = emaRibbon(x.c), a = ind.atr(14)[i];
  const stretch = Number.isFinite(a) && a > 0 ? Math.abs(x.entry - r.e21[i]) / a : 2;
  const entryScore = stretch <= 0.8 ? 100 : stretch <= 1.6 ? 100 - ((stretch - 0.8) / 0.8) * 40 : stretch <= 3 ? 60 - ((stretch - 1.6) / 1.4) * 50 : 5;
  // liquidity: depth vs order size, spread, aligned imbalance
  let liq = 50;
  if (x.book) liq = clamp(scale(Math.log10(Math.max(1, x.book.depthUsd / Math.max(x.notional, 1))), 1, 3) * 0.6 + (x.book.spreadPct < 0.02 ? 30 : x.book.spreadPct < 0.05 ? 15 : 0) + (s * x.book.imbalance > 0.1 ? 10 : 0), 0, 100);
  // validated edge
  const edge = x.validation?.validated ? scale(x.validation.oosExpectancyR ?? 0, 0.05, 0.4) : 0;
  // market conditions: regime fit + funding not crowded against us
  const fit = x.strategyRegimes.includes(x.regime.regime) ? 70 : 0;
  const fundAgainst = s * funding8h * 10_000; // bps per 8h paid by our side
  const conditions = clamp(fit + (fundAgainst > 5 ? -40 : fundAgainst > 2 ? -15 : 30), 0, 100);

  const raw: [keyof typeof W, string, number, string][] = [
    ["trend", "Trend strength", get("trend"), base.find((f) => f.key === "trend")?.detail ?? ""],
    ["momentum", "Momentum", get("momentum"), base.find((f) => f.key === "momentum")?.detail ?? ""],
    ["volume", "Volume confirmation", get("volume"), base.find((f) => f.key === "volume")?.detail ?? ""],
    ["structure", "Market structure (BOS/CHOCH)", structScore, `Execution-TF structure trend ${st.trend[i] === 1 ? "up" : st.trend[i] === -1 ? "down" : "undefined"}.`],
    ["htf", "Higher-timeframe confirmation", htfScore, `HTF ribbon ${hr.stack[hi] === 1 ? "bullish" : hr.stack[hi] === -1 ? "bearish" : "mixed"}, HTF regime ${htfRegime}.`],
    ["entry", "Entry quality (not chasing)", entryScore, `Entry is ${stretch.toFixed(2)} ATR from EMA21.`],
    ["rr", "Risk / reward", scale(blendedR, 1, 3), `Blended target ${blendedR.toFixed(2)}R (${x.exit.id}).`],
    ["volatility", "Volatility", get("volatility"), base.find((f) => f.key === "volatility")?.detail ?? ""],
    ["liquidity", "Liquidity / order book", liq, x.book ? `Depth ±0.5% $${Math.round(x.book.depthUsd).toLocaleString()} vs order $${x.notional.toFixed(0)}, spread ${x.book.spreadPct.toFixed(3)}%, imbalance ${x.book.imbalance.toFixed(2)}.` : "Order book unavailable."],
    ["edge", "Validated edge (out-of-sample)", edge, x.validation ? x.validation.why : "Strategy not validated on this market."],
    ["conditions", "Market conditions", conditions, `Regime ${x.regime.regime}${fit ? " (fits strategy)" : " (does NOT fit strategy)"}; funding ${(funding8h * 100).toFixed(4)}%/8h.`],
  ];
  const factors: FactorScore[] = raw.map(([key, label, sc, detail]) => ({ key, label, score: Math.round(clamp(sc, 0, 100)), weight: W[key], detail, inputs: {} }));
  const score = Math.round(factors.reduce((t, f) => t + (f.score ?? 0) * f.weight, 0));

  const flags: string[] = [];
  if (x.dataAgeSec > x.tfSec * 2) flags.push(`Stale data (${Math.round(x.dataAgeSec / 60)} min old).`);
  if (!x.validation?.validated) flags.push("Strategy has no validated out-of-sample edge on this market/timeframe.");
  if (!x.strategyRegimes.includes(x.regime.regime)) flags.push(`Regime ${x.regime.regime} does not match the strategy (${x.strategyRegimes.join(", ")}).`);
  if (x.book && x.book.spreadPct > 0.1) flags.push(`Spread too wide (${x.book.spreadPct.toFixed(3)}%).`);
  if (x.book && x.book.depthUsd < x.notional * 20) flags.push("Order book too thin for this order size.");
  if (fundAgainst > 8) flags.push(`Funding strongly against this side (${fundAgainst.toFixed(1)} bps/8h).`);
  if (x.regime.atrPctile > 97) flags.push("Extreme volatility (ATR above 97th percentile).");
  if ((x.family === "trend" || x.family === "breakout") && hr.stack[hi] === -s) flags.push("Higher timeframe trend opposes a trend-following entry.");
  if (!(risk > 0)) flags.push("Invalid stop.");
  return { score, band: band(score), factors, flags };
}
