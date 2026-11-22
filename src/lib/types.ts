// Shared domain types for EdgePilot AI.

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

/** OHLCV candle. `time` = candle OPEN time in unix seconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Provenance attached to every piece of market data shown in the UI. */
export interface DataMeta {
  source: string; // e.g. "Binance (data-api.binance.vision)"
  fetchedAt: number; // ms epoch when the server fetched it
  dataTime?: number; // ms epoch of the newest datapoint
  delayed: boolean; // true if newest datapoint is older than expected
  note?: string;
  errors?: string[]; // providers that failed before the one that succeeded
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  meta?: DataMeta;
  error?: string;
}

export interface Ticker {
  symbol: string;
  price: number;
  change24hPct: number | null;
  volume24hQuote: number | null;
  high24h: number | null;
  low24h: number | null;
}

export interface DerivativesSnapshot {
  venue: string;
  markPrice: number | null;
  /** funding rate per funding interval, as a fraction (0.0001 = 0.01%) */
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  /** funding normalized to an 8h period (fraction) for comparison across venues */
  funding8h: number | null;
  nextFundingTime: number | null;
  openInterestBase: number | null; // in BTC
  openInterestUsd: number | null;
  openInterestChangePct24h: number | null;
  longShortRatio: number | null; // accounts long / short
  longShortSource: string | null;
  liquidations24h: { longUsd: number; shortUsd: number; source: string } | null;
  fundingHistory: { time: number; rate8h: number }[];
}

// ---------- Scoring / signals ----------

export type Direction = "LONG" | "SHORT" | "BUY" | "SELL" | "WAIT" | "NO_TRADE";

export interface FactorScore {
  key: string;
  label: string;
  weight: number; // effective weight after renormalization, 0..1
  score: number | null; // 0..100; null when data unavailable
  detail: string; // human readable measurable reason
  inputs: Record<string, number | string | null>;
}

export interface HardRule {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  severity: "reject" | "warn";
}

export interface HistoricalEdge {
  strategyId: string;
  strategyName: string;
  trades: number;
  winRate: number | null; // 0..1
  winRateLow: number | null; // Wilson 95% lower bound
  winRateHigh: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  bars: number;
  note: string;
}

export interface PositionPlan {
  accountEquity: number;
  riskPct: number;
  riskUsd: number;
  quantity: number; // units of base asset
  notionalUsd: number;
  leverage: number;
  marginUsd: number;
  liquidationPrice: number | null;
  liquidationDistancePct: number | null;
  stopDistancePct: number;
  feesUsd: number; // round trip estimate
  fundingUsdEstimate: number | null;
  warnings: string[];
  capped: string | null; // reason the size was capped
  suggestedLeverage?: { leverage: number; reason: string };
}

export interface TradeSignal {
  id: string;
  asset: string;
  market: "BTC-PERP" | "BTC-SPOT" | "SOL-MEME";
  direction: Direction;
  setupType: string;
  timeframe: string;
  entry: { low: number; high: number } | null;
  trigger: string | null; // the condition that must happen before entering
  stopLoss: number | null;
  takeProfits: { price: number; r: number; closePct: number }[];
  riskReward: number | null; // to final target
  riskRewardTp1: number | null;
  qualityScore: number; // 0..100 transparent factor score ("AI confidence")
  factors: FactorScore[];
  rules: HardRule[];
  historicalEdge: HistoricalEdge | null; // statistical (measured) evidence
  position: PositionPlan | null;
  reasons: string[];
  risks: string[];
  invalidation: string[];
  summary: string; // plain-English one-liner, e.g. "WAIT — volume is increasing but..."
  explanation: string; // longer beginner explanation for "Why this trade?"
  createdAt: number;
  expiresAt: number;
  price: number;
  dataSources: string[];
}
