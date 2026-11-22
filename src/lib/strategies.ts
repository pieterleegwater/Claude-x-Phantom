// Strategy framework. Each strategy is a pure, causal rule set evaluated at the CLOSE of bar i.
// The backtester fills entries at the OPEN of bar i+1, so no strategy can see the future.
// The live signal engine evaluates the same entry() on the latest closed candle, which lets
// every live signal carry its own measured historical performance.
import type { Candle } from "./types";
import * as I from "./indicators";

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Values tried during walk-forward optimisation (kept small to limit overfitting). */
  grid?: number[];
  help?: string;
}

export interface EntrySignal {
  side: "long" | "short";
  stop: number;
  targetR?: number; // take-profit as a multiple of initial risk
  reason: string;
}

export interface OpenPos {
  side: "long" | "short";
  entry: number;
  stop: number;
  entryIndex: number;
}

/** Lazily computed, memoised indicator cache over a candle array. */
export class Indicators {
  private memo = new Map<string, unknown>();
  readonly close: number[];
  constructor(readonly c: Candle[]) {
    this.close = c.map((k) => k.close);
  }
  private get<T>(key: string, fn: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, fn());
    return this.memo.get(key) as T;
  }
  ema = (p: number) => this.get(`ema${p}`, () => I.ema(this.close, p));
  sma = (p: number) => this.get(`sma${p}`, () => I.sma(this.close, p));
  rsi = (p: number) => this.get(`rsi${p}`, () => I.rsi(this.close, p));
  atr = (p = 14) => this.get(`atr${p}`, () => I.atr(this.c, p));
  adx = (p = 14) => this.get(`adx${p}`, () => I.adx(this.c, p));
  macd = (f = 12, s = 26, g = 9) => this.get(`macd${f}-${s}-${g}`, () => I.macd(this.close, f, s, g));
  bb = (p = 20, m = 2) => this.get(`bb${p}-${m}`, () => I.bollinger(this.close, p, m));
  vwap = () =>
    this.get("vwap", () => {
      const tf = this.c.length > 1 ? this.c[1].time - this.c[0].time : 3600;
      return tf >= 86400 ? I.rollingVwap(this.c, 20) : I.sessionVwap(this.c);
    });
  priorHigh = (p: number) => this.get(`ph${p}`, () => I.priorHigh(this.c, p));
  priorLow = (p: number) => this.get(`pl${p}`, () => I.priorLow(this.c, p));
  volSma = (p = 20) => this.get(`vs${p}`, () => I.sma(this.c.map((k) => k.volume), p));
}

export interface StrategyContext {
  c: Candle[];
  ind: Indicators;
  p: Record<string, number>;
  /** funding rate per 8h aligned to each bar (fraction), when available */
  funding?: (number | null)[];
}

export interface Strategy {
  id: string;
  name: string;
  family: "trend" | "momentum" | "breakout" | "mean-reversion" | "structure" | "derivatives";
  summary: string; // beginner-friendly one-liner
  rules: string[]; // exact rules in plain English
  evidence: {
    level: "academic" | "practitioner" | "mixed";
    notes: string;
    sources: { title: string; url?: string }[];
  };
  goodIn: string;
  badIn: string;
  params: ParamDef[];
  requiresFunding?: boolean;
  warmup: (p: Record<string, number>) => number;
  entry: (i: number, ctx: StrategyContext) => EntrySignal | null;
  /** Discretionary exit evaluated at close of bar i (filled next open). */
  exit?: (i: number, ctx: StrategyContext, pos: OpenPos) => boolean;
  /** "Setup forming" detector used by the live engine to produce WAIT signals. */
  forming?: (i: number, ctx: StrategyContext) => { side: "long" | "short"; trigger: string } | null;
}

const ok = (...v: number[]) => v.every((x) => Number.isFinite(x));
const allowShort = (p: Record<string, number>) => (p.allowShorts ?? 1) >= 1;
const SHORTS: ParamDef = { key: "allowShorts", label: "Allow shorts (1 = yes)", min: 0, max: 1, step: 1, default: 1 };

export const STRATEGIES: Strategy[] = [
  {
    id: "ema_trend",
    name: "EMA Trend System",
    family: "trend",
    summary: "Buy when the fast moving average crosses above the slow one while price is above the 200 EMA (and the mirror for shorts).",
    rules: [
      "Long: EMA(fast) crosses above EMA(slow) AND close > EMA(200).",
      "Short: EMA(fast) crosses below EMA(slow) AND close < EMA(200).",
      "Stop: entry ∓ ATR(14) × multiplier. Target: R multiple. Exit early on the opposite cross.",
    ],
    evidence: {
      level: "academic",
      notes:
        "Moving-average rules are among the most studied technical rules. Results are mixed and decay after publication and costs, but trend-following has long-run support across asset classes, including crypto time-series momentum.",
      sources: [
        { title: "Brock, Lakonishok & LeBaron (1992), Simple Technical Trading Rules and the Stochastic Properties of Stock Returns, Journal of Finance" },
        { title: "Park & Irwin (2007), What Do We Know About the Profitability of Technical Analysis?, Journal of Economic Surveys" },
        { title: "Hurst, Ooi & Pedersen (2017), A Century of Evidence on Trend-Following Investing, AQR" },
      ],
    },
    goodIn: "Persistent trends with expanding volatility.",
    badIn: "Choppy ranges — produces repeated whipsaw losses.",
    params: [
      { key: "fast", label: "Fast EMA", min: 5, max: 50, step: 1, default: 20, grid: [10, 20, 30] },
      { key: "slow", label: "Slow EMA", min: 20, max: 200, step: 5, default: 50, grid: [50, 100] },
      { key: "atrMult", label: "Stop ATR ×", min: 0.5, max: 5, step: 0.25, default: 2, grid: [1.5, 2.5] },
      { key: "targetR", label: "Target (R)", min: 1, max: 10, step: 0.5, default: 3 },
      SHORTS,
    ],
    warmup: () => 210,
    entry: (i, { ind, p, c }) => {
      const f = ind.ema(p.fast), s = ind.ema(p.slow), t = ind.ema(200), a = ind.atr(14);
      if (!ok(f[i], s[i], f[i - 1], s[i - 1], t[i], a[i])) return null;
      const close = c[i].close;
      if (f[i] > s[i] && f[i - 1] <= s[i - 1] && close > t[i])
        return { side: "long", stop: close - p.atrMult * a[i], targetR: p.targetR, reason: `EMA${p.fast} crossed above EMA${p.slow} with price above EMA200` };
      if (allowShort(p) && f[i] < s[i] && f[i - 1] >= s[i - 1] && close < t[i])
        return { side: "short", stop: close + p.atrMult * a[i], targetR: p.targetR, reason: `EMA${p.fast} crossed below EMA${p.slow} with price below EMA200` };
      return null;
    },
    exit: (i, { ind, p }, pos) => {
      const f = ind.ema(p.fast), s = ind.ema(p.slow);
      return pos.side === "long" ? f[i] < s[i] : f[i] > s[i];
    },
    forming: (i, { ind, p, c }) => {
      const f = ind.ema(p.fast), s = ind.ema(p.slow), t = ind.ema(200), a = ind.atr(14);
      if (!ok(f[i], s[i], t[i], a[i])) return null;
      const gap = f[i] - s[i];
      if (gap < 0 && gap > -0.3 * a[i] && f[i] > f[i - 3] && c[i].close > t[i])
        return { side: "long", trigger: `EMA${p.fast} is about to cross above EMA${p.slow}. Wait for the cross on a closed candle.` };
      if (gap > 0 && gap < 0.3 * a[i] && f[i] < f[i - 3] && c[i].close < t[i])
        return { side: "short", trigger: `EMA${p.fast} is about to cross below EMA${p.slow}. Wait for the cross on a closed candle.` };
      return null;
    },
  },
  {
    id: "donchian_breakout",
    name: "Donchian Channel Breakout",
    family: "breakout",
    summary: "Turtle-style: buy a close above the highest high of the last N bars; exit on a close below the lowest low of a shorter window.",
    rules: [
      "Long: close > highest high of previous N bars. Short: close < lowest low of previous N bars.",
      "Initial stop: 2 × ATR(14). Exit: close beyond the opposite M-bar channel (trailing).",
    ],
    evidence: {
      level: "mixed",
      notes:
        "Channel breakouts are the core of the documented Turtle Trading rules and of many CTA trend programs. Win rates are typically low (30–40%) with large winners; edge depends on catching rare big trends.",
      sources: [
        { title: "Faith, C. (2007), Way of the Turtle, McGraw-Hill" },
        { title: "Moskowitz, Ooi & Pedersen (2012), Time Series Momentum, Journal of Financial Economics" },
      ],
    },
    goodIn: "Strong trending markets after consolidation.",
    badIn: "Ranges with false breakouts.",
    params: [
      { key: "entryLen", label: "Entry channel (bars)", min: 10, max: 100, step: 1, default: 20, grid: [20, 55] },
      { key: "exitLen", label: "Exit channel (bars)", min: 5, max: 50, step: 1, default: 10, grid: [10, 20] },
      { key: "atrMult", label: "Stop ATR ×", min: 0.5, max: 5, step: 0.25, default: 2 },
      SHORTS,
    ],
    warmup: (p) => Math.max(p.entryLen, 20) + 2,
    entry: (i, { ind, p, c }) => {
      const hi = ind.priorHigh(p.entryLen), lo = ind.priorLow(p.entryLen), a = ind.atr(14);
      if (!ok(hi[i], lo[i], a[i])) return null;
      const close = c[i].close;
      if (close > hi[i]) return { side: "long", stop: close - p.atrMult * a[i], reason: `Closed above the ${p.entryLen}-bar high (${hi[i].toFixed(2)})` };
      if (allowShort(p) && close < lo[i]) return { side: "short", stop: close + p.atrMult * a[i], reason: `Closed below the ${p.entryLen}-bar low (${lo[i].toFixed(2)})` };
      return null;
    },
    exit: (i, { ind, p, c }, pos) => {
      const lo = ind.priorLow(p.exitLen), hi = ind.priorHigh(p.exitLen);
      return pos.side === "long" ? c[i].close < lo[i] : c[i].close > hi[i];
    },
    forming: (i, { ind, p, c }) => {
      const hi = ind.priorHigh(p.entryLen), lo = ind.priorLow(p.entryLen), a = ind.atr(14);
      if (!ok(hi[i], lo[i], a[i])) return null;
      if (hi[i] - c[i].close < 0.35 * a[i] && c[i].close <= hi[i])
        return { side: "long", trigger: `Price is just below the ${p.entryLen}-bar high (${hi[i].toFixed(2)}). Only valid if a candle CLOSES above it.` };
      if (allowShort(p) && c[i].close - lo[i] < 0.35 * a[i] && c[i].close >= lo[i])
        return { side: "short", trigger: `Price is just above the ${p.entryLen}-bar low (${lo[i].toFixed(2)}). Only valid if a candle CLOSES below it.` };
      return null;
    },
  },
  {
    id: "rsi_pullback",
    name: "RSI(2) Pullback in Trend",
    family: "mean-reversion",
    summary: "Inside a long-term uptrend, buy short, sharp dips (very low 2-period RSI) and sell when price recovers above a short average.",
    rules: [
      "Long: close > SMA(200) AND RSI(2) < entry level. Exit: close > SMA(5).",
      "Short (mirror): close < SMA(200) AND RSI(2) > 100 − level. Exit: close < SMA(5).",
      "Catastrophe stop: ATR(14) × multiplier.",
    ],
    evidence: {
      level: "practitioner",
      notes:
        "Popularised by Connors & Alvarez with long equity-index backtests. Evidence in crypto is weaker and sensitive to costs because trades are short. Treat results here as your own measurement, not a promise.",
      sources: [{ title: "Connors & Alvarez (2008), Short Term Trading Strategies That Work, TradingMarkets" }, { title: "Wilder, J. W. (1978), New Concepts in Technical Trading Systems (RSI, ATR)" }],
    },
    goodIn: "Steady trends with shallow pullbacks.",
    badIn: "Trend reversals and crashes (catching falling knives).",
    params: [
      { key: "level", label: "RSI(2) entry level", min: 2, max: 30, step: 1, default: 10, grid: [5, 10, 15] },
      { key: "exitSma", label: "Exit SMA", min: 3, max: 20, step: 1, default: 5 },
      { key: "atrMult", label: "Catastrophe stop ATR ×", min: 1, max: 6, step: 0.5, default: 2.5, grid: [2, 3] },
      SHORTS,
    ],
    warmup: () => 205,
    entry: (i, { ind, p, c }) => {
      const r = ind.rsi(2), t = ind.sma(200), a = ind.atr(14);
      if (!ok(r[i], t[i], a[i])) return null;
      const close = c[i].close;
      if (close > t[i] && r[i] < p.level) return { side: "long", stop: close - p.atrMult * a[i], reason: `RSI(2) at ${r[i].toFixed(1)} (oversold dip) in an uptrend` };
      if (allowShort(p) && close < t[i] && r[i] > 100 - p.level) return { side: "short", stop: close + p.atrMult * a[i], reason: `RSI(2) at ${r[i].toFixed(1)} (overbought bounce) in a downtrend` };
      return null;
    },
    exit: (i, { ind, p, c }, pos) => {
      const s = ind.sma(p.exitSma);
      return pos.side === "long" ? c[i].close > s[i] : c[i].close < s[i];
    },
    forming: (i, { ind, p, c }) => {
      const r = ind.rsi(2), t = ind.sma(200);
      if (!ok(r[i], t[i])) return null;
      if (c[i].close > t[i] && r[i] < p.level + 15) return { side: "long", trigger: `Pullback developing in an uptrend (RSI(2) ${r[i].toFixed(0)}). Entry only if RSI(2) closes below ${p.level}.` };
      return null;
    },
  },
  {
    id: "vwap_reclaim",
    name: "VWAP Reclaim",
    family: "momentum",
    summary: "Buy when price closes back above the volume-weighted average price with above-average volume while the trend is up.",
    rules: [
      "Long: previous close < VWAP and current close > VWAP, close > EMA(50), volume > 20-bar average.",
      "Short: mirror. Stop: beyond the 3-bar extreme ± 0.25 ATR. Target: R multiple.",
      "VWAP resets each UTC day on intraday timeframes; 20-bar rolling VWAP on daily.",
    ],
    evidence: {
      level: "practitioner",
      notes: "VWAP is an institutional execution benchmark; reclaim/reject setups are widely used by intraday traders. Little peer-reviewed evidence as a standalone signal — measure it.",
      sources: [{ title: "Berkowitz, Logue & Noser (1988), The Total Cost of Transactions on the NYSE, Journal of Finance (VWAP benchmark)" }],
    },
    goodIn: "Intraday trends with volume confirmation.",
    badIn: "Low-volume, sideways sessions.",
    params: [
      { key: "targetR", label: "Target (R)", min: 1, max: 6, step: 0.5, default: 2, grid: [1.5, 2, 3] },
      { key: "trendLen", label: "Trend EMA", min: 20, max: 200, step: 10, default: 50 },
      SHORTS,
    ],
    warmup: (p) => p.trendLen + 25,
    entry: (i, { ind, p, c }) => {
      const v = ind.vwap(), t = ind.ema(p.trendLen), a = ind.atr(14), vs = ind.volSma(20);
      if (!ok(v[i], v[i - 1], t[i], a[i], vs[i])) return null;
      const k = c[i];
      const lo3 = Math.min(c[i].low, c[i - 1].low, c[i - 2].low);
      const hi3 = Math.max(c[i].high, c[i - 1].high, c[i - 2].high);
      if (c[i - 1].close < v[i - 1] && k.close > v[i] && k.close > t[i] && k.volume > vs[i])
        return { side: "long", stop: lo3 - 0.25 * a[i], targetR: p.targetR, reason: "Reclaimed VWAP on above-average volume in an uptrend" };
      if (allowShort(p) && c[i - 1].close > v[i - 1] && k.close < v[i] && k.close < t[i] && k.volume > vs[i])
        return { side: "short", stop: hi3 + 0.25 * a[i], targetR: p.targetR, reason: "Lost VWAP on above-average volume in a downtrend" };
      return null;
    },
    forming: (i, { ind, p, c }) => {
      const v = ind.vwap(), t = ind.ema(p.trendLen), a = ind.atr(14);
      if (!ok(v[i], t[i], a[i])) return null;
      if (c[i].close < v[i] && v[i] - c[i].close < 0.3 * a[i] && c[i].close > t[i])
        return { side: "long", trigger: `Price is testing VWAP (${v[i].toFixed(2)}) from below in an uptrend. Valid only on a close above VWAP with above-average volume.` };
      return null;
    },
  },
  {
    id: "macd_momentum",
    name: "MACD Momentum",
    family: "momentum",
    summary: "Buy when MACD crosses above its signal line while price is above the 200 EMA.",
    rules: ["Long: MACD line crosses above signal AND close > EMA(200).", "Short: mirror.", "Stop: ATR × multiplier. Exit: opposite MACD cross."],
    evidence: {
      level: "mixed",
      notes: "Created by Gerald Appel. Academic tests show weak standalone predictive power after costs; it works best as a momentum confirmation inside a trend filter.",
      sources: [{ title: "Appel, G. (2005), Technical Analysis: Power Tools for Active Investors" }, { title: "Park & Irwin (2007), Journal of Economic Surveys" }],
    },
    goodIn: "Trend continuation after consolidation.",
    badIn: "Sideways markets (frequent crosses).",
    params: [
      { key: "atrMult", label: "Stop ATR ×", min: 0.5, max: 5, step: 0.25, default: 2, grid: [1.5, 2, 3] },
      { key: "targetR", label: "Target (R, 0 = none)", min: 0, max: 10, step: 0.5, default: 0 },
      SHORTS,
    ],
    warmup: () => 210,
    entry: (i, { ind, p, c }) => {
      const m = ind.macd(), t = ind.ema(200), a = ind.atr(14);
      if (!ok(m.line[i], m.signal[i], m.line[i - 1], m.signal[i - 1], t[i], a[i])) return null;
      const close = c[i].close;
      const tr = p.targetR > 0 ? p.targetR : undefined;
      if (m.line[i] > m.signal[i] && m.line[i - 1] <= m.signal[i - 1] && close > t[i])
        return { side: "long", stop: close - p.atrMult * a[i], targetR: tr, reason: "MACD bullish cross above the 200 EMA" };
      if (allowShort(p) && m.line[i] < m.signal[i] && m.line[i - 1] >= m.signal[i - 1] && close < t[i])
        return { side: "short", stop: close + p.atrMult * a[i], targetR: tr, reason: "MACD bearish cross below the 200 EMA" };
      return null;
    },
    exit: (i, { ind }, pos) => {
      const m = ind.macd();
      return pos.side === "long" ? m.line[i] < m.signal[i] : m.line[i] > m.signal[i];
    },
  },
  {
    id: "volume_breakout",
    name: "Volume Expansion Breakout",
    family: "breakout",
    summary: "Buy a breakout above recent highs only when volume is much larger than normal (shows real participation).",
    rules: ["Long: close > highest high of previous N bars AND volume > multiplier × 20-bar average volume.", "Short: mirror on lows.", "Stop: ATR × multiplier. Target: R multiple."],
    evidence: {
      level: "mixed",
      notes: "Volume confirmation of price moves is documented in the literature on volume and momentum; it filters some false breakouts but adds lag.",
      sources: [{ title: "Lee & Swaminathan (2000), Price Momentum and Trading Volume, Journal of Finance" }, { title: "Blume, Easley & O'Hara (1994), Market Statistics and Technical Analysis: The Role of Volume, Journal of Finance" }],
    },
    goodIn: "Range expansions with genuine demand.",
    badIn: "News spikes that immediately fade.",
    params: [
      { key: "len", label: "Breakout lookback", min: 10, max: 100, step: 5, default: 20, grid: [20, 40] },
      { key: "volMult", label: "Volume multiple", min: 1, max: 5, step: 0.1, default: 1.8, grid: [1.5, 2, 2.5] },
      { key: "atrMult", label: "Stop ATR ×", min: 0.5, max: 5, step: 0.25, default: 1.5 },
      { key: "targetR", label: "Target (R)", min: 1, max: 8, step: 0.5, default: 2.5 },
      SHORTS,
    ],
    warmup: (p) => Math.max(p.len, 20) + 2,
    entry: (i, { ind, p, c }) => {
      const hi = ind.priorHigh(p.len), lo = ind.priorLow(p.len), vs = ind.volSma(20), a = ind.atr(14);
      if (!ok(hi[i], lo[i], vs[i], a[i])) return null;
      const k = c[i];
      const rel = k.volume / vs[i];
      if (k.close > hi[i] && rel > p.volMult) return { side: "long", stop: k.close - p.atrMult * a[i], targetR: p.targetR, reason: `Breakout above ${p.len}-bar high on ${rel.toFixed(1)}× volume` };
      if (allowShort(p) && k.close < lo[i] && rel > p.volMult) return { side: "short", stop: k.close + p.atrMult * a[i], targetR: p.targetR, reason: `Breakdown below ${p.len}-bar low on ${rel.toFixed(1)}× volume` };
      return null;
    },
    forming: (i, { ind, p, c }) => {
      const hi = ind.priorHigh(p.len), vs = ind.volSma(20), a = ind.atr(14);
      if (!ok(hi[i], vs[i], a[i])) return null;
      const rel = c[i].volume / vs[i];
      if (c[i].close <= hi[i] && hi[i] - c[i].close < 0.4 * a[i] && rel > 1.1)
        return { side: "long", trigger: `Volume is increasing (${rel.toFixed(1)}× average) but price has not closed above ${hi[i].toFixed(2)}. Entry now would have poor risk/reward.` };
      return null;
    },
  },
  {
    id: "bb_mean_reversion",
    name: "Bollinger Mean Reversion (range only)",
    family: "mean-reversion",
    summary: "In a sideways market (low ADX), buy closes below the lower Bollinger Band and take profit at the middle band.",
    rules: ["Only when ADX(14) < threshold (no strong trend).", "Long: close < lower band. Short: close > upper band.", "Exit: close crosses middle band. Stop: 1.5 × ATR."],
    evidence: {
      level: "mixed",
      notes: "Short-horizon reversal is documented in many markets, but crypto has strong momentum, so mean reversion is restricted to low-ADX regimes here.",
      sources: [{ title: "Bollinger, J. (2001), Bollinger on Bollinger Bands, McGraw-Hill" }, { title: "Lo & MacKinlay (1990), When Are Contrarian Profits Due to Stock Market Overreaction?, Review of Financial Studies" }],
    },
    goodIn: "Quiet, range-bound markets.",
    badIn: "Breakouts — bands 'walk' and losses accumulate.",
    params: [
      { key: "mult", label: "Band width (σ)", min: 1.5, max: 3.5, step: 0.25, default: 2, grid: [2, 2.5] },
      { key: "adxMax", label: "Max ADX", min: 10, max: 35, step: 1, default: 20, grid: [18, 22, 26] },
      { key: "atrMult", label: "Stop ATR ×", min: 0.5, max: 4, step: 0.25, default: 1.5 },
      SHORTS,
    ],
    warmup: () => 40,
    entry: (i, { ind, p, c }) => {
      const b = ind.bb(20, p.mult), x = ind.adx(14), a = ind.atr(14);
      if (!ok(b.lower[i], b.upper[i], x[i], a[i])) return null;
      if (x[i] >= p.adxMax) return null;
      const close = c[i].close;
      if (close < b.lower[i]) return { side: "long", stop: close - p.atrMult * a[i], reason: `Closed below lower band in a range (ADX ${x[i].toFixed(0)})` };
      if (allowShort(p) && close > b.upper[i]) return { side: "short", stop: close + p.atrMult * a[i], reason: `Closed above upper band in a range (ADX ${x[i].toFixed(0)})` };
      return null;
    },
    exit: (i, { ind, p, c }, pos) => {
      const b = ind.bb(20, p.mult);
      return pos.side === "long" ? c[i].close >= b.mid[i] : c[i].close <= b.mid[i];
    },
  },
  {
    id: "liquidity_sweep",
    name: "Liquidity Sweep Reversal",
    family: "structure",
    summary: "Price briefly breaks below a recent low (triggering stop-losses) and then closes back above it — a sign sellers were absorbed.",
    rules: [
      "Long: low < lowest low of previous N bars, but close > that level and close > open (rejection candle), close > EMA(200) if trend filter on.",
      "Short: mirror at highs.",
      "Stop: beyond the sweep wick ± 0.25 ATR. Target: R multiple.",
    ],
    evidence: {
      level: "practitioner",
      notes:
        "A market-structure concept popular with discretionary traders (stop-hunt / liquidity grab). There is little peer-reviewed evidence; stop-loss clustering near round numbers and recent extremes is documented, which is the plausible mechanism. Rely on the measured results only.",
      sources: [{ title: "Osler, C. (2003), Currency Orders and Exchange Rate Dynamics: An Explanation for the Predictive Success of Technical Analysis, Journal of Finance" }],
    },
    goodIn: "Ranges and pullbacks within trends.",
    badIn: "Genuine breakdowns where price keeps falling.",
    params: [
      { key: "lookback", label: "Swing lookback", min: 5, max: 60, step: 1, default: 20, grid: [10, 20, 30] },
      { key: "targetR", label: "Target (R)", min: 1, max: 6, step: 0.5, default: 2, grid: [2, 3] },
      { key: "trendFilter", label: "EMA200 filter (1 = on)", min: 0, max: 1, step: 1, default: 1 },
      SHORTS,
    ],
    warmup: (p) => Math.max(205, p.lookback + 2),
    entry: (i, { ind, p, c }) => {
      const lo = ind.priorLow(p.lookback), hi = ind.priorHigh(p.lookback), a = ind.atr(14), t = ind.ema(200);
      if (!ok(lo[i], hi[i], a[i], t[i])) return null;
      const k = c[i];
      const tf = p.trendFilter >= 1;
      if (k.low < lo[i] && k.close > lo[i] && k.close > k.open && (!tf || k.close > t[i]))
        return { side: "long", stop: k.low - 0.25 * a[i], targetR: p.targetR, reason: `Swept the ${p.lookback}-bar low (${lo[i].toFixed(2)}) and closed back above it` };
      if (allowShort(p) && k.high > hi[i] && k.close < hi[i] && k.close < k.open && (!tf || k.close < t[i]))
        return { side: "short", stop: k.high + 0.25 * a[i], targetR: p.targetR, reason: `Swept the ${p.lookback}-bar high (${hi[i].toFixed(2)}) and closed back below it` };
      return null;
    },
  },
  {
    id: "tsmom",
    name: "Time-Series Momentum",
    family: "trend",
    summary: "Go with the sign of the past N-bar return: long when it turns positive, short when it turns negative.",
    rules: ["Momentum = close / close N bars ago − 1.", "Enter long when momentum turns positive (short when negative). Exit when it flips.", "Stop: ATR × multiplier; position size scales inversely with volatility (risk-based sizing)."],
    evidence: {
      level: "academic",
      notes: "One of the best-documented anomalies across asset classes. Liu & Tsyvinski find strong time-series momentum in crypto returns. Edge is concentrated in large trends and suffers in reversals.",
      sources: [
        { title: "Moskowitz, Ooi & Pedersen (2012), Time Series Momentum, Journal of Financial Economics" },
        { title: "Liu & Tsyvinski (2021), Risks and Returns of Cryptocurrency, Review of Financial Studies" },
      ],
    },
    goodIn: "Sustained directional markets.",
    badIn: "Sharp V-shaped reversals.",
    params: [
      { key: "lookback", label: "Lookback (bars)", min: 10, max: 300, step: 2, default: 48, grid: [24, 48, 96] },
      { key: "atrMult", label: "Stop ATR ×", min: 1, max: 6, step: 0.5, default: 3 },
      SHORTS,
    ],
    warmup: (p) => p.lookback + 20,
    entry: (i, { ind, p, c }) => {
      const L = p.lookback, a = ind.atr(14);
      if (i - L - 1 < 0 || !ok(a[i])) return null;
      const m = c[i].close / c[i - L].close - 1;
      const mPrev = c[i - 1].close / c[i - 1 - L].close - 1;
      if (m > 0 && mPrev <= 0) return { side: "long", stop: c[i].close - p.atrMult * a[i], reason: `${L}-bar return turned positive (${(m * 100).toFixed(2)}%)` };
      if (allowShort(p) && m < 0 && mPrev >= 0) return { side: "short", stop: c[i].close + p.atrMult * a[i], reason: `${L}-bar return turned negative (${(m * 100).toFixed(2)}%)` };
      return null;
    },
    exit: (i, { p, c }, pos) => {
      const m = c[i].close / c[i - p.lookback].close - 1;
      return pos.side === "long" ? m < 0 : m > 0;
    },
  },
  {
    id: "funding_contrarian",
    name: "Funding-Rate Contrarian",
    family: "derivatives",
    summary: "When perpetual futures funding is extreme (crowded positioning), fade the crowd once momentum confirms.",
    rules: [
      "Short: funding (8h-equivalent) > high threshold AND RSI(14) crosses below 50.",
      "Long: funding < −low threshold AND RSI(14) crosses above 50.",
      "Stop: 2 × ATR. Target: R multiple. Requires funding history (Hyperliquid / Binance / OKX).",
    ],
    evidence: {
      level: "mixed",
      notes:
        "Persistently high funding reflects leveraged long demand; research on crypto carry links extreme funding to subsequent crash risk. Signals are rare, so samples are small — interpret cautiously.",
      sources: [{ title: "Schmeling, Schrimpf & Todorov (2023), Crypto Carry, BIS Working Paper No. 1087" }],
    },
    goodIn: "Overheated leveraged markets.",
    badIn: "Strong trends where funding stays elevated for weeks.",
    requiresFunding: true,
    params: [
      { key: "highBps", label: "High funding (bps / 8h)", min: 1, max: 20, step: 0.5, default: 3, grid: [2, 3, 5] },
      { key: "lowBps", label: "Negative funding (bps / 8h)", min: 0, max: 10, step: 0.5, default: 1 },
      { key: "targetR", label: "Target (R)", min: 1, max: 6, step: 0.5, default: 2 },
      SHORTS,
    ],
    warmup: () => 30,
    entry: (i, { ind, p, c, funding }) => {
      const f = funding?.[i];
      const r = ind.rsi(14), a = ind.atr(14);
      if (f == null || !ok(r[i], r[i - 1], a[i])) return null;
      const bps = f * 10_000;
      if (allowShort(p) && bps > p.highBps && r[i] < 50 && r[i - 1] >= 50)
        return { side: "short", stop: c[i].close + 2 * a[i], targetR: p.targetR, reason: `Funding ${bps.toFixed(2)} bps/8h (crowded longs) and momentum rolled over` };
      if (bps < -p.lowBps && r[i] > 50 && r[i - 1] <= 50)
        return { side: "long", stop: c[i].close - 2 * a[i], targetR: p.targetR, reason: `Funding ${bps.toFixed(2)} bps/8h (crowded shorts) and momentum turned up` };
      return null;
    },
  },
];

export function getStrategy(id: string) {
  return STRATEGIES.find((s) => s.id === id);
}

export function defaultParams(s: Strategy): Record<string, number> {
  return Object.fromEntries(s.params.map((p) => [p.key, p.default]));
}
