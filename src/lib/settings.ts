// User settings (persisted in the browser). No secrets are ever stored here.
export interface Settings {
  beginnerMode: boolean;
  accountEquity: number; // used for risk calculations (paper or your real account size)
  riskPerTradePct: number; // % equity risked per trade
  maxOpenRiskPct: number; // max combined risk at stops across open positions
  dailyLossLimitPct: number; // stop trading for the day beyond this loss
  maxLeverage: number; // hard cap — the engine will never suggest more
  defaultLeverage: number; // leverage pre-selected in the BTC terminal
  minRiskReward: number; // reject setups with lower R:R to final target
  minQualityScore: number; // below this a setup is WAIT / NO TRADE
  takerFeeBps: number;
  slippageBps: number;
  maintenanceMarginRate: number; // fraction e.g. 0.004
  memeMaxPositionPct: number; // max % of equity per memecoin position
  liveMaxTradeUsd: number; // hard cap per REAL-money buy
  memeTradeSizeUsd: number; // size used for slippage estimates
  memeMinLiquidityUsd: number;
  primaryTimeframe: "15m" | "1h" | "4h";
  notifications: {
    browser: boolean;
    newSetupMinScore: number;
    btcBreakouts: boolean;
    memeVolumeAccel: number; // volume acceleration multiple that triggers an alert
    paperFills: boolean;
    highRiskTokens: boolean;
    pollSeconds: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  beginnerMode: true,
  accountEquity: 10_000,
  riskPerTradePct: 1,
  maxOpenRiskPct: 5,
  dailyLossLimitPct: 3,
  maxLeverage: 10,
  defaultLeverage: 3,
  minRiskReward: 2,
  minQualityScore: 65,
  takerFeeBps: 5,
  slippageBps: 3,
  maintenanceMarginRate: 0.004,
  memeMaxPositionPct: 2,
  liveMaxTradeUsd: 50,
  memeTradeSizeUsd: 200,
  memeMinLiquidityUsd: 25_000,
  primaryTimeframe: "1h",
  notifications: {
    browser: false,
    newSetupMinScore: 70,
    btcBreakouts: true,
    memeVolumeAccel: 3,
    paperFills: true,
    highRiskTokens: true,
    pollSeconds: 60,
  },
};
