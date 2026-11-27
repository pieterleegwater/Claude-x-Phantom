// Autonomous engine — shared types. Pure data, safe to use on server and client.
import type { MarketRegime, RegimeRead } from "./regime";

export const LIVE_CONFIRM_PHRASE = "I ACCEPT LIVE TRADING RISK";

export type EngineMode = "paper" | "live";
export type ExecTf = "5m" | "15m" | "1h";

export interface ExitProfile {
  id: string;
  tps: { r: number; pct: number }[]; // partial take-profits in R, % of initial size
  beAfterR: number | null; // move stop to break-even (+fees) once price reaches this R
  trailAtr: number | null; // ATR multiple for the trailing stop (activates after TP1)
  timeStopBars: number | null; // exit if 0.5R not reached within N bars
}

export const EXIT_PROFILES: ExitProfile[] = [
  { id: "scale_3", tps: [{ r: 1, pct: 40 }, { r: 2, pct: 35 }, { r: 3, pct: 25 }], beAfterR: 1, trailAtr: 2, timeStopBars: 40 },
  { id: "runner", tps: [{ r: 1.5, pct: 50 }, { r: 4, pct: 50 }], beAfterR: 1, trailAtr: 3, timeStopBars: 60 },
  { id: "fixed_2r", tps: [{ r: 2, pct: 100 }], beAfterR: null, trailAtr: null, timeStopBars: null },
];

export interface EngineConfig {
  mode: EngineMode;
  autoTrading: boolean;
  coins: string[];
  timeframes: ExecTf[];
  riskPerTradePct: number; // % of equity lost if the stop is hit (incl. costs)
  maxDailyLossPct: number;
  maxWeeklyDrawdownPct: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  cooldownMinAfterLoss: number;
  maxLeverageLive: number;
  maxLeverageSim: number;
  simLeverage: number; // leverage used by the paper engine (up to maxLeverageSim)
  liveMinScore: number;
  paperMinScore: number;
  paperStartingEquity: number;
  takerFeeBps: number;
  makerFeeBps: number;
  slippageBps: number;
  minOosTrades: number;
  minOosExpectancyR: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  mode: "paper",
  autoTrading: false,
  coins: ["BTC", "ETH", "SOL"],
  timeframes: ["15m", "1h"],
  riskPerTradePct: 0.5,
  maxDailyLossPct: 1.5,
  maxWeeklyDrawdownPct: 5,
  maxOpenPositions: 2,
  maxTradesPerDay: 6,
  cooldownMinAfterLoss: 45,
  maxLeverageLive: 5,
  maxLeverageSim: 40,
  simLeverage: 10,
  liveMinScore: 80,
  paperMinScore: 70,
  paperStartingEquity: 10,
  takerFeeBps: 4.5, // Hyperliquid base tier taker
  makerFeeBps: 1.5,
  slippageBps: 3,
  minOosTrades: 30,
  minOosExpectancyR: 0.05,
};

export interface VenueAsset {
  coin: string;
  szDecimals: number;
  maxLeverage: number;
  markPx: number;
  midPx: number;
  funding: number; // hourly funding rate (fraction)
  openInterest: number; // in coins
  dayNtlVlm: number;
  prevDayPx: number;
}

export interface EnginePosition {
  id: string;
  mode: EngineMode;
  coin: string;
  side: "long" | "short";
  qty: number;
  initialQty: number;
  entry: number;
  stop: number;
  initialStop: number;
  risk: number; // |entry - initialStop|
  tps: { price: number; pct: number; filled: boolean; oid?: number | null }[];
  leverage: number;
  liqPrice: number | null;
  openedAt: number;
  barsHeld: number;
  tf: ExecTf;
  strategyId: string;
  exitProfile: string;
  score: number;
  thesis: string;
  beMoved: boolean;
  trailingActive: boolean;
  feesUsd: number;
  fundingUsd: number;
  realizedUsd: number;
  lastPrice: number;
  maxFavorableR: number;
  slOid?: number | null;
  lastFundingAt: number;
  exitNotional?: number; // cumulative, for the average exit price
  exitQty?: number;
  unprotected?: boolean; // live: no verified stop on the exchange (protection retried every cycle)
}

export interface ClosedTrade {
  id: string;
  mode: EngineMode;
  coin: string;
  side: "long" | "short";
  strategyId: string;
  tf: ExecTf;
  regime: MarketRegime | null;
  score: number;
  entry: number;
  exitAvg: number;
  qty: number;
  pnlUsd: number; // net of fees and funding
  r: number;
  feesUsd: number;
  fundingUsd: number;
  openedAt: number;
  closedAt: number;
  reason: string;
}

export interface Opportunity {
  at: number;
  coin: string;
  tf: ExecTf;
  regime: MarketRegime;
  strategyId: string | null;
  side: "long" | "short" | null;
  score: number;
  band: "exceptional" | "high" | "watch" | "none";
  decision: "TRADE" | "PAPER_ONLY" | "WAIT" | "NO_TRADE";
  reasons: string[];
  flags: string[];
  entry?: number;
  stop?: number;
  tps?: number[];
  qty?: number;
  notional?: number;
  leverage?: number;
  liqPrice?: number | null;
  riskUsd?: number;
}

export interface ValidationResult {
  key: string; // coin:tf:strategy
  strategyId: string;
  coin: string;
  tf: ExecTf;
  testedAt: number;
  bars: number;
  oosTrades: number;
  oosExpectancyR: number | null;
  oosProfitFactor: number | null;
  oosWinRate: number | null;
  oosMaxDD: number;
  oosNetPct: number;
  benchmarkExpectancyR: number | null;
  robustness: number;
  exitProfile: string;
  params: Record<string, number>;
  validated: boolean;
  why: string;
}

export interface EngineAlert {
  id: string;
  at: number;
  level: "info" | "warn" | "critical";
  msg: string;
}

export interface EngineState {
  version: 1;
  config: EngineConfig;
  killSwitch: boolean; // STOP ALL — blocks everything until manually cleared
  halted: { reason: string; at: number; until: number | null } | null;
  liveArmed: boolean; // explicit live activation (typed confirmation)
  paperCash: number;
  positions: EnginePosition[];
  trades: ClosedTrade[];
  equityHistory: { t: number; equity: number; mode: EngineMode }[];
  day: { key: string; startEquity: number };
  week: { key: string; startEquity: number; peak: number };
  lossStreak: number;
  lastLossAt: number | null;
  tradesToday: number;
  opportunities: Opportunity[];
  regimes: Record<string, Record<string, RegimeRead>>;
  validation: Record<string, ValidationResult>;
  alerts: EngineAlert[];
  lastTick: { at: number; ms: number; ok: boolean; error?: string; notes: string[] } | null;
  lastCandleCheck: Record<string, number>; // coin -> last 1m candle time processed (paper fills)
  /** live: an entry order whose outcome was not confirmed yet (adopted by the next sync if it filled) */
  flattenConfirmedAt?: number | null; // STOP ALL: when the venue confirmed 0 positions / 0 orders
  pendingEntry?: { coin: string; side: "long" | "short"; at: number; stop: number; tps: { price: number; pct: number }[]; tf: ExecTf; strategyId: string; exitProfile: string; score: number; thesis: string; leverage: number } | null;
}

export function newEngineState(cfg: EngineConfig = DEFAULT_ENGINE_CONFIG): EngineState {
  const now = Date.now();
  return {
    version: 1,
    config: cfg,
    killSwitch: false,
    halted: null,
    liveArmed: false,
    paperCash: cfg.paperStartingEquity,
    positions: [],
    trades: [],
    equityHistory: [{ t: now, equity: cfg.paperStartingEquity, mode: "paper" }],
    day: { key: dayKey(now), startEquity: cfg.paperStartingEquity },
    week: { key: weekKey(now), startEquity: cfg.paperStartingEquity, peak: cfg.paperStartingEquity },
    lossStreak: 0,
    lastLossAt: null,
    tradesToday: 0,
    opportunities: [],
    regimes: {},
    validation: {},
    alerts: [],
    lastTick: null,
    lastCandleCheck: {},
  };
}

export const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export function weekKey(t: number) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}
