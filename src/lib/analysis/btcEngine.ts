// Bitcoin analysis engine.
//
// Pipeline (all deterministic and inspectable):
//  1. Use CLOSED candles only (the forming candle is dropped).
//  2. Evaluate every strategy's entry rule on the latest closed candle (same code as the backtester).
//  3. Measure each strategy's historical performance on the same data (fees + slippage included).
//  4. Score the market with a transparent weighted factor model for the candidate direction.
//  5. Apply hard rejection rules. A high score NEVER overrides a failed hard rule.
//  6. Output LONG / SHORT / BUY / SELL / WAIT / NO_TRADE with a full trade plan and explanation.
import type { Candle, DerivativesSnapshot, FactorScore, HardRule, HistoricalEdge, Timeframe, TradeSignal } from "../types";
import { TF_SECONDS } from "../types";
import { Indicators, STRATEGIES, defaultParams, type EntrySignal, type Strategy } from "../strategies";
import { runBacktest, alignFunding, DEFAULT_BT, regimeSeries, type Metrics } from "../backtest";
import { ema, median, percentileRank, scale, clamp, wilson, swingPoints } from "../indicators";
import { supportResistance, nearestLevels, readStructure, modelledLiquidationZones, type Level, type StructureRead } from "./structure";
import { planPosition, suggestLeverage, fmt } from "../risk";
import type { Settings } from "../settings";

export interface BtcEngineInput {
  primary: Candle[];
  primaryTf: Timeframe;
  higher: Candle[];
  higherTf: Timeframe;
  derivatives: DerivativesSnapshot | null;
  settings: Settings;
  market: "BTC-PERP" | "BTC-SPOT";
  leverage: number;
  now?: number;
  sources?: string[];
  asset?: string;
}

export interface StrategyStatus {
  strategy: Strategy;
  triggered: EntrySignal | null;
  forming: { side: "long" | "short"; trigger: string } | null;
  metrics: Metrics;
  available: boolean;
  unavailableReason?: string;
}

export interface BtcAnalysis {
  signal: TradeSignal;
  levels: Level[];
  structure: StructureRead;
  htfStructure: StructureRead;
  strategies: StrategyStatus[];
  liqZones: ReturnType<typeof modelledLiquidationZones>;
  snapshot: Record<string, number | string | null>;
  closedCandles: Candle[];
}

const WEIGHTS = { trend: 0.2, momentum: 0.15, volume: 0.15, structure: 0.15, volatility: 0.1, location: 0.15, positioning: 0.1 };

export function closedOnly(c: Candle[], tf: Timeframe, nowMs = Date.now()): Candle[] {
  if (!c.length) return c;
  const lastK = c[c.length - 1];
  return lastK.time + TF_SECONDS[tf] > nowMs / 1000 ? c.slice(0, -1) : c;
}

function rsiScore(r: number, s: 1 | -1) {
  const x = s === 1 ? r : 100 - r;
  if (!Number.isFinite(x)) return NaN;
  if (x <= 40) return 10;
  if (x <= 55) return 10 + ((x - 40) / 15) * 70;
  if (x <= 68) return 100;
  if (x <= 78) return 100 - ((x - 68) / 10) * 60;
  return 20;
}

export function factorScores(c: Candle[], htf: Candle[], ind: Indicators, side: "long" | "short", deriv: DerivativesSnapshot | null, rr: number | null, structure: StructureRead, htfStructure: StructureRead): FactorScore[] {
  const s: 1 | -1 = side === "long" ? 1 : -1;
  const i = c.length - 1;
  const close = c[i].close;
  const e20 = ind.ema(20)[i], e50 = ind.ema(50)[i], e200 = ind.ema(200)[i];
  const e50prev = ind.ema(50)[i - 10];
  const hClose = htf.map((k) => k.close);
  const he50 = ema(hClose, 50), he200 = ema(hClose, 200);
  const hi = htf.length - 1;
  const hRef = Number.isFinite(he200[hi]) ? he200[hi] : he50[hi];

  // --- Trend
  let pScore = 0;
  if (Number.isFinite(e200)) pScore += s * (close - e200) > 0 ? 30 : 0;
  if (Number.isFinite(e200)) pScore += s * (e50 - e200) > 0 ? 25 : 0;
  pScore += s * (e20 - e50) > 0 ? 20 : 0;
  pScore += s * (e50 - e50prev) > 0 ? 25 : 0;
  let hScore = 50;
  if (htf.length > 60 && Number.isFinite(hRef)) {
    hScore = (s * (htf[hi].close - hRef) > 0 ? 50 : 0) + (s * (he50[hi] - he50[Math.max(0, hi - 5)]) > 0 ? 30 : 0) + (htfStructure.bias === s ? 20 : 0);
  }
  const trend = 0.6 * pScore + 0.4 * hScore;

  // --- Momentum
  const r = ind.rsi(14)[i];
  const m = ind.macd();
  const histAligned = s * m.hist[i] > 0;
  const histRising = s * (m.hist[i] - m.hist[i - 1]) > 0;
  const mom = 0.6 * rsiScore(r, s) + 0.4 * ((histAligned ? 60 : 0) + (histRising ? 40 : 0));

  // --- Volume
  const vs = ind.volSma(20)[i];
  const relVol = (c[i].volume + c[i - 1].volume + c[i - 2].volume) / 3 / vs;
  let upV = 0, dnV = 0;
  for (let j = i - 19; j <= i; j++) (c[j].close >= c[j].open ? (upV += c[j].volume) : (dnV += c[j].volume));
  const balance = s === 1 ? upV / Math.max(dnV, 1e-9) : dnV / Math.max(upV, 1e-9);
  const vol = 0.6 * scale(relVol, 0.6, 1.8) + 0.4 * scale(balance, 0.7, 1.5);

  // --- Structure
  let st = structure.bias === s ? 85 : structure.bias === 0 ? 45 : 10;
  if ((s === 1 && structure.brokeAbove) || (s === -1 && structure.brokeBelow)) st = Math.min(100, st + 15);
  if ((s === 1 && structure.brokeBelow) || (s === -1 && structure.brokeAbove)) st = Math.max(0, st - 30);

  // --- Volatility regime
  const atrArr = ind.atr(14);
  const atrPct = atrArr.map((a, j) => a / c[j].close);
  const pr = percentileRank(atrPct.slice(-300), atrPct[i]);
  const volat = pr > 95 ? 10 : pr > 85 ? 40 : pr < 10 ? 55 : 100;

  // --- Location / reward
  const loc = rr == null ? NaN : scale(rr, 1, 3);

  // --- Positioning (derivatives)
  let pos: number | null = null;
  let posDetail = "Funding / open-interest data unavailable — factor excluded and weights renormalised.";
  const posInputs: Record<string, number | string | null> = { funding8hPct: null, oiChange24hPct: null };
  if (deriv && deriv.funding8h != null) {
    const fBps = deriv.funding8h * 10_000 * s; // positive = same side is paying (crowded)
    let fs = fBps > 5 ? 10 : fBps > 2 ? 40 : fBps > 0.5 ? 65 : fBps > -1 ? 80 : 90;
    posInputs.funding8hPct = deriv.funding8h * 100;
    let oiTxt = "";
    if (deriv.openInterestChangePct24h != null) {
      posInputs.oiChange24hPct = deriv.openInterestChangePct24h;
      const priceUp = c[i].close > c[Math.max(0, i - 24)].close;
      const oiUp = deriv.openInterestChangePct24h > 0;
      const confirms = (s === 1 && priceUp && oiUp) || (s === -1 && !priceUp && oiUp);
      fs = clamp(fs + (confirms ? 10 : -5), 0, 100);
      oiTxt = ` Open interest ${deriv.openInterestChangePct24h.toFixed(1)}% (24h) ${confirms ? "confirms" : "does not confirm"} the move.`;
    }
    pos = fs;
    posDetail = `Funding ${(deriv.funding8h * 100).toFixed(4)}% per 8h on ${deriv.venue}: ${fBps > 2 ? "this side is crowded and paying" : fBps < -0.5 ? "the other side is paying (contrarian tailwind)" : "neutral"}.${oiTxt}`;
  }

  const raw: Omit<FactorScore, "weight">[] = [
    { key: "trend", label: "Trend", score: trend, detail: `Price ${close > e200 ? "above" : "below"} EMA200, EMA20 ${e20 > e50 ? ">" : "<"} EMA50, EMA50 ${e50 > e50prev ? "rising" : "falling"}. Higher timeframe ${s * (htf[hi]?.close - hRef) > 0 ? "agrees" : "disagrees"}.`, inputs: { ema20: e20, ema50: e50, ema200: e200, htfRef: hRef } },
    { key: "momentum", label: "Momentum", score: mom, detail: `RSI(14) ${r.toFixed(1)}; MACD histogram ${histAligned ? "supports" : "opposes"} this direction and is ${histRising ? "strengthening" : "weakening"}.`, inputs: { rsi14: r, macdHist: m.hist[i] } },
    { key: "volume", label: "Volume", score: vol, detail: `Recent volume ${relVol.toFixed(2)}× its 20-bar average; ${side === "long" ? "buying" : "selling"}-candle volume ratio ${balance.toFixed(2)}.`, inputs: { relVolume: relVol, volumeBalance: balance } },
    { key: "structure", label: "Market structure", score: st, detail: `${structure.label}${structure.brokeAbove ? "; closed above last swing high" : ""}${structure.brokeBelow ? "; closed below last swing low" : ""}.`, inputs: { structure: structure.label } },
    { key: "volatility", label: "Volatility regime", score: volat, detail: `ATR is at the ${pr.toFixed(0)}th percentile of the last 300 bars (${(atrPct[i] * 100).toFixed(2)}% of price). ${pr > 85 ? "Elevated — wider stops and smaller size needed." : pr < 10 ? "Very compressed — breakouts often follow but direction is uncertain." : "Normal."}`, inputs: { atrPct: atrPct[i] * 100, atrPercentile: pr } },
    { key: "location", label: "Location & reward", score: Number.isFinite(loc) ? loc : null, detail: rr == null ? "No concrete entry/stop to measure reward yet." : `Blended reward-to-risk of ${rr.toFixed(2)} based on the planned stop and targets.`, inputs: { riskReward: rr } },
    { key: "positioning", label: "Derivatives positioning", score: pos, detail: posDetail, inputs: posInputs },
  ];
  const avail = raw.filter((f) => f.score != null && Number.isFinite(f.score));
  const totalW = avail.reduce((t, f) => t + WEIGHTS[f.key as keyof typeof WEIGHTS], 0);
  return raw.map((f) => ({
    ...f,
    score: f.score != null && Number.isFinite(f.score) ? Math.round(f.score) : null,
    weight: f.score != null && Number.isFinite(f.score) ? WEIGHTS[f.key as keyof typeof WEIGHTS] / totalW : 0,
  }));
}

export function composite(f: FactorScore[]) {
  return Math.round(f.reduce((t, x) => t + (x.score ?? 0) * x.weight, 0));
}

interface Plan {
  entry: { low: number; high: number };
  entryMid: number;
  stop: number;
  tps: { price: number; r: number; closePct: number }[];
  blendedR: number;
  r1: number;
}

function buildPlan(side: "long" | "short", close: number, atrNow: number, stop: number, targetR: number | undefined, levels: Level[], trendFollowing: boolean): Plan {
  const s = side === "long" ? 1 : -1;
  const entry = side === "long" ? { low: close - 0.25 * atrNow, high: close + 0.05 * atrNow } : { low: close - 0.05 * atrNow, high: close + 0.25 * atrNow };
  const entryMid = close;
  const risk = Math.abs(entryMid - stop);
  const { resistance, support } = nearestLevels(levels, close);
  const opp = side === "long" ? resistance : support;
  let r1 = 1.5;
  if (opp) {
    const lvlR = Math.abs(opp.price - entryMid) / risk;
    if (lvlR >= 1 && lvlR <= 2.5) r1 = lvlR * 0.98; // just before the level
  }
  const r2 = Math.max(targetR ?? 2.5, r1 + 0.75);
  const tps = [
    { price: entryMid + s * r1 * risk, r: r1, closePct: trendFollowing ? 40 : 50 },
    { price: entryMid + s * r2 * risk, r: r2, closePct: trendFollowing ? 35 : 50 },
  ];
  if (trendFollowing) tps.push({ price: entryMid + s * Math.max(4, r2 + 1) * risk, r: Math.max(4, r2 + 1), closePct: 25 });
  const blendedR = tps.reduce((t, x) => t + (x.r * x.closePct) / 100, 0);
  return { entry, entryMid, stop, tps, blendedR, r1 };
}

function edgeFrom(st: StrategyStatus, bars: number, tf: string): HistoricalEdge {
  const m = st.metrics;
  const ci = m.trades ? wilson(m.wins, m.trades) : null;
  return {
    strategyId: st.strategy.id,
    strategyName: st.strategy.name,
    trades: m.trades,
    winRate: m.winRate,
    winRateLow: ci ? ci[0] : null,
    winRateHigh: ci ? ci[1] : null,
    profitFactor: m.profitFactor,
    expectancyR: m.expectancyR,
    bars,
    note:
      m.trades < 20
        ? `Only ${m.trades} historical trades on the last ${bars} ${tf} candles — too small a sample to estimate probability reliably.`
        : `Measured on the last ${bars} closed ${tf} candles with default parameters, after fees and slippage. In-sample measurement — see Strategy Lab for walk-forward (out-of-sample) results.`,
  };
}

export function analyzeBtc(input: BtcEngineInput): BtcAnalysis {
  const now = input.now ?? Date.now();
  const { settings } = input;
  const tf = input.primaryTf;
  const c = closedOnly(input.primary, tf, now);
  const htf = closedOnly(input.higher, input.higherTf, now);
  if (c.length < 220) throw new Error(`Need at least 220 closed ${tf} candles for analysis (got ${c.length}).`);
  const ind = new Indicators(c);
  const i = c.length - 1;
  const close = c[i].close;
  const atrNow = ind.atr(14)[i];
  const levels = supportResistance(c, atrNow * 0.5);
  const structure = readStructure(c);
  const htfStructure = readStructure(htf);
  const regimes = regimeSeries(c);
  const funding = input.derivatives?.fundingHistory?.length ? alignFunding(c, input.derivatives.fundingHistory) : undefined;
  const isPerp = input.market === "BTC-PERP";
  const btCfg = { ...DEFAULT_BT, feeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, riskPct: settings.riskPerTradePct, fundingPer8h: isPerp ? (input.derivatives?.funding8h ?? 0.0001) : 0, funding: isPerp ? funding : undefined };

  // 2 + 3: evaluate strategies & measure them
  const statuses: StrategyStatus[] = STRATEGIES.map((st) => {
    const p = defaultParams(st);
    if (!isPerp) p.allowShorts = 0; // spot cannot be shorted
    if (st.requiresFunding && !funding) {
      return { strategy: st, triggered: null, forming: null, metrics: runBacktest(c.slice(0, 0), st, p).metrics, available: false, unavailableReason: "Needs funding-rate history (derivatives feed unavailable)." };
    }
    const ctx = { c, ind, p, funding };
    const metrics = runBacktest(c, st, p, btCfg, { ind, regimes }).metrics;
    return { strategy: st, triggered: st.entry(i, ctx), forming: st.forming?.(i, ctx) ?? null, metrics, available: true };
  });

  const edgeBonus = (m: Metrics) => (m.trades >= 10 && m.expectancyR != null ? clamp(m.expectancyR, -1, 1) * 20 : 0);

  type Cand = { st: StrategyStatus; side: "long" | "short"; kind: "triggered" | "forming"; plan: Plan | null; factors: FactorScore[]; score: number; rank: number };
  const cands: Cand[] = [];
  for (const st of statuses) {
    if (st.triggered) {
      const sig = st.triggered;
      const plan = buildPlan(sig.side, close, atrNow, sig.stop, sig.targetR, levels, st.strategy.family === "trend" || st.strategy.family === "breakout");
      const factors = factorScores(c, htf, ind, sig.side, input.derivatives, plan.blendedR, structure, htfStructure);
      const score = composite(factors);
      cands.push({ st, side: sig.side, kind: "triggered", plan, factors, score, rank: score + edgeBonus(st.metrics) });
    } else if (st.forming) {
      const factors = factorScores(c, htf, ind, st.forming.side, input.derivatives, null, structure, htfStructure);
      const score = composite(factors);
      cands.push({ st, side: st.forming.side, kind: "forming", plan: null, factors, score, rank: score + edgeBonus(st.metrics) - 5 });
    }
  }
  cands.sort((a, b) => (a.kind === b.kind ? b.rank - a.rank : a.kind === "triggered" ? -1 : 1));
  const best = cands[0] ?? null;

  // Bias for display when there is no candidate
  const longF = factorScores(c, htf, ind, "long", input.derivatives, null, structure, htfStructure);
  const shortF = factorScores(c, htf, ind, "short", input.derivatives, null, structure, htfStructure);
  const longS = composite(longF), shortS = composite(shortF);
  const biasSide: "long" | "short" = longS >= shortS ? "long" : "short";

  const side = best?.side ?? biasSide;
  const factors = best?.factors ?? (biasSide === "long" ? longF : shortF);
  const quality = best ? best.score : Math.max(longS, shortS);
  const plan = best?.plan ?? null;
  const tfSec = TF_SECONDS[tf];

  // 5: hard rules
  const rules: HardRule[] = [];
  const lastAgeSec = now / 1000 - (c[i].time + tfSec);
  rules.push({ id: "fresh", label: "Data is fresh", passed: lastAgeSec < tfSec * 2, detail: `Last closed candle ended ${Math.round(lastAgeSec / 60)} min ago.`, severity: "reject" });
  const atrPctArr = ind.atr(14).map((a, j) => a / c[j].close);
  const volPr = percentileRank(atrPctArr.slice(-300), atrPctArr[i]);
  rules.push({ id: "vol", label: "Volatility not extreme", passed: volPr < 97, detail: `ATR percentile ${volPr.toFixed(0)} (reject above 97).`, severity: "reject" });

  let positionPlan = null as TradeSignal["position"];
  if (best && plan) {
    rules.push({ id: "rr", label: `Reward-to-risk ≥ ${settings.minRiskReward}`, passed: plan.blendedR >= settings.minRiskReward, detail: `Blended R:R ${plan.blendedR.toFixed(2)} (TP1 ${plan.r1.toFixed(2)}R).`, severity: "reject" });
    const hRef = (() => {
      const hc = htf.map((k) => k.close);
      const e = ema(hc, 200), e5 = ema(hc, 50);
      const v = e[hc.length - 1];
      return Number.isFinite(v) ? v : e5[hc.length - 1];
    })();
    const htfOk = !Number.isFinite(hRef) || (side === "long" ? htf[htf.length - 1].close > hRef : htf[htf.length - 1].close < hRef);
    const isMR = best.st.strategy.family === "mean-reversion" || best.st.strategy.family === "structure";
    rules.push({
      id: "htf",
      label: `Higher timeframe (${input.higherTf}) agrees`,
      passed: htfOk,
      detail: htfOk ? `${input.higherTf} trend supports a ${side}.` : `${input.higherTf} trend opposes this ${side}.${isMR ? " (Counter-trend setup — treated as a warning.)" : ""}`,
      severity: isMR ? "warn" : "reject",
    });
    const m = best.st.metrics;
    const negEdge = m.trades >= 20 && (m.expectancyR ?? 0) < 0;
    rules.push({
      id: "edge",
      label: "Setup has non-negative measured edge",
      passed: !negEdge,
      detail: m.trades < 20 ? `Only ${m.trades} historical trades — insufficient evidence (warning).` : `Historical expectancy ${m.expectancyR?.toFixed(2)}R over ${m.trades} trades.`,
      severity: m.trades < 20 ? "warn" : "reject",
    });
    if (m.trades < 20) rules[rules.length - 1].passed = false;

    // position sizing
    const lev = isPerp ? Math.min(input.leverage, settings.maxLeverage) : 1;
    const holdH = (tfSec / 3600) * 12;
    positionPlan = planPosition({
      equity: settings.accountEquity,
      riskPct: settings.riskPerTradePct,
      entry: plan.entryMid,
      stop: plan.stop,
      side,
      leverage: lev,
      takerFeeBps: settings.takerFeeBps,
      slippageBps: settings.slippageBps,
      maintenanceMarginRate: settings.maintenanceMarginRate,
      funding8h: isPerp ? input.derivatives?.funding8h ?? null : null,
      expectedHoldHours: holdH,
    });
    if (isPerp) {
      positionPlan.suggestedLeverage = suggestLeverage({ equity: settings.accountEquity, notionalUsd: positionPlan.notionalUsd, stopDistancePct: positionPlan.stopDistancePct, maxLeverage: settings.maxLeverage, mmr: settings.maintenanceMarginRate });
      const liq = positionPlan.liquidationPrice;
      const liqOk = liq == null || (side === "long" ? liq < plan.stop && (plan.entryMid - liq) >= 2 * (plan.entryMid - plan.stop) : liq > plan.stop && (liq - plan.entryMid) >= 2 * (plan.stop - plan.entryMid));
      rules.push({ id: "liq", label: "Liquidation ≥ 2× farther than stop", passed: liqOk, detail: liq == null ? "No leverage → no liquidation." : `Est. liquidation ${fmt(liq)} vs stop ${fmt(plan.stop)} at ${lev}x.`, severity: "reject" });
    }
    if (input.derivatives?.funding8h != null) {
      const crowded = (side === "long" ? 1 : -1) * input.derivatives.funding8h > 0.0005;
      rules.push({ id: "crowd", label: "Positioning not extremely crowded", passed: !crowded, detail: `Funding ${(input.derivatives.funding8h * 100).toFixed(4)}%/8h (warn above 0.05% against you).`, severity: "warn" });
    }
  }
  rules.push({ id: "score", label: `Quality score ≥ ${settings.minQualityScore}`, passed: quality >= settings.minQualityScore, detail: `Score ${quality}/100.`, severity: "reject" });

  const rejected = rules.filter((r) => !r.passed && r.severity === "reject");
  const onlyScoreFail = rejected.length === 1 && rejected[0].id === "score";

  // 6: decision
  let direction: TradeSignal["direction"];
  if (!best) direction = "NO_TRADE";
  else if (best.kind === "forming") direction = "WAIT";
  else if (rejected.length === 0) direction = isPerp ? (side === "long" ? "LONG" : "SHORT") : side === "long" ? "BUY" : "SELL";
  else if (onlyScoreFail && quality >= 50) direction = "WAIT";
  else direction = "NO_TRADE";

  const strat = best?.st.strategy;
  const setupType = strat ? strat.name : "No qualifying setup";
  const reasons: string[] = [];
  const risks: string[] = [];
  const invalidation: string[] = [];
  if (best?.st.triggered) reasons.push(best.st.triggered.reason + ".");
  for (const f of [...factors].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    if (f.score == null) continue;
    if (f.score >= 65) reasons.push(`${f.label}: ${f.detail}`);
    else if (f.score <= 40) risks.push(`${f.label}: ${f.detail}`);
  }
  for (const r of rules) if (!r.passed) risks.push(`${r.severity === "reject" ? "Rule failed" : "Warning"} — ${r.label}: ${r.detail}`);
  if (strat) risks.push(`This setup historically struggles in: ${strat.badIn}`);
  if (plan) {
    invalidation.push(`A candle closes ${side === "long" ? "below" : "above"} the stop-loss at ${fmt(plan.stop)}.`);
    invalidation.push(`Price never reaches the entry zone (${fmt(plan.entry.low)} – ${fmt(plan.entry.high)}) before the signal expires.`);
    if (structure.lastLow && side === "long") invalidation.push(`Market structure breaks: close below the last swing low ${fmt(structure.lastLow.price)}.`);
    if (structure.lastHigh && side === "short") invalidation.push(`Market structure breaks: close above the last swing high ${fmt(structure.lastHigh.price)}.`);
  } else if (best?.st.forming) {
    invalidation.push("The trigger condition is not met within the next candle or two.");
  }

  const pTf = tf;
  const summary = buildSummary(direction, side, best?.kind, setupType, best?.st.forming?.trigger, plan, rejected, quality, pTf);
  const explanation = buildExplanation({ direction, side, tf: pTf, htfTf: input.higherTf, factors, plan, structure, trigger: best?.st.forming?.trigger ?? null, setup: strat, rejected, edge: best ? best.st.metrics : null, isPerp });
  const expires = direction === "WAIT" ? now + tfSec * 1000 : now + tfSec * 3 * 1000;

  const signal: TradeSignal = {
    id: `${input.market}-${tf}-${c[i].time}-${strat?.id ?? "none"}`,
    asset: input.asset ?? "BTC",
    market: input.market,
    direction,
    setupType,
    timeframe: pTf,
    entry: plan ? plan.entry : null,
    trigger: best?.kind === "forming" ? best.st.forming!.trigger : null,
    stopLoss: plan?.stop ?? null,
    takeProfits: plan?.tps ?? [],
    riskReward: plan?.blendedR ?? null,
    riskRewardTp1: plan?.r1 ?? null,
    qualityScore: quality,
    factors,
    rules,
    historicalEdge: best ? edgeFrom(best.st, c.length, pTf) : null,
    position: positionPlan,
    reasons,
    risks,
    invalidation,
    summary,
    explanation,
    createdAt: now,
    expiresAt: expires,
    price: close,
    dataSources: input.sources ?? [],
  };

  const vs = ind.volSma(20)[i];
  return {
    signal,
    levels,
    structure,
    htfStructure,
    strategies: statuses,
    liqZones: modelledLiquidationZones(c),
    closedCandles: c,
    snapshot: {
      close,
      ema20: ind.ema(20)[i],
      ema50: ind.ema(50)[i],
      ema200: ind.ema(200)[i],
      rsi14: ind.rsi(14)[i],
      atr14: atrNow,
      atrPct: (atrNow / close) * 100,
      vwap: ind.vwap()[i],
      relVolume: c[i].volume / vs,
      adx14: ind.adx(14)[i],
      regime: regimes[i],
      longScore: longS,
      shortScore: shortS,
      medianAtrPct: median(atrPctArr.slice(-300)) * 100,
      swings: swingPoints(c.slice(-100)).length,
    },
  };
}

function buildSummary(direction: TradeSignal["direction"], side: string, kind: string | undefined, setup: string, trigger: string | undefined, plan: Plan | null, rejected: HardRule[], score: number, tf: string): string {
  const d = direction.replace("_", " ");
  if (direction === "WAIT" && kind === "forming") return `WAIT — ${trigger ?? "a setup is forming but not confirmed."}`;
  if (direction === "WAIT") return `WAIT — a ${setup} ${side} triggered, but overall quality (${score}/100) is below your threshold. Let it prove itself first.`;
  if (direction === "NO_TRADE" && !kind) return `NO TRADE — none of the ${STRATEGIES.length} tested strategies has a valid setup on the ${tf} chart right now. Patience is a position.`;
  if (direction === "NO_TRADE") return `NO TRADE — a ${setup} ${side} appeared but failed: ${rejected.map((r) => r.label.toLowerCase()).join("; ")}.`;
  return `${d} — ${setup} on the ${tf} chart. Quality ${score}/100, blended reward-to-risk ${plan?.blendedR.toFixed(2)}.`;
}

function buildExplanation(x: {
  direction: TradeSignal["direction"];
  side: "long" | "short";
  tf: string;
  htfTf: string;
  factors: FactorScore[];
  plan: Plan | null;
  structure: StructureRead;
  trigger: string | null;
  setup?: Strategy;
  rejected: HardRule[];
  edge: Metrics | null;
  isPerp: boolean;
}): string {
  const f = Object.fromEntries(x.factors.map((k) => [k.key, k]));
  const dirWord = x.side === "long" ? "upward" : "downward";
  const parts: string[] = [];
  const trend = f.trend?.score ?? 0;
  parts.push(
    trend >= 65
      ? `Bitcoin is trending ${dirWord} on the ${x.tf} chart, and the ${x.htfTf} chart ${(f.trend?.detail ?? "").includes("agrees") ? "agrees" : "does not fully agree"}.`
      : trend <= 40
        ? `The ${x.tf} trend does NOT support a ${x.side} right now.`
        : `The ${x.tf} trend is mixed — no strong direction.`,
  );
  if (f.volume?.score != null) parts.push((f.volume.score >= 60 ? "Volume is above normal, which means real participation. " : "Volume is ordinary or weak, so moves are less trustworthy. ") + `(${f.volume.detail})`);
  parts.push(`Market structure: ${x.structure.label.toLowerCase()}.`);
  if (x.setup) parts.push(`The setup is "${x.setup.name}": ${x.setup.summary}`);
  if (x.direction === "WAIT" && x.trigger) parts.push(`Nothing to do yet. ${x.trigger} If that does not happen, the idea is cancelled.`);
  if (x.plan && (x.direction === "LONG" || x.direction === "SHORT" || x.direction === "BUY" || x.direction === "SELL")) {
    parts.push(
      `The plan: enter between ${fmt(x.plan.entry.low)} and ${fmt(x.plan.entry.high)}. If price ${x.side === "long" ? "falls" : "rises"} to ${fmt(x.plan.stop)} you are wrong and exit with a small, pre-planned loss. Profits are taken in parts at ${x.plan.tps.map((t) => fmt(t.price)).join(", ")}.`,
    );
    if (x.direction === "SELL") parts.push("On spot you cannot short, so SELL means: reduce or exit BTC you hold, or stay in cash.");
  }
  if (x.rejected.length) parts.push(`Why no trade: ${x.rejected.map((r) => `${r.label} — ${r.detail}`).join(" ")}`);
  if (x.edge && x.edge.trades > 0)
    parts.push(
      `Evidence: on recent data this exact rule produced ${x.edge.trades} trades with a ${((x.edge.winRate ?? 0) * 100).toFixed(0)}% win rate and ${x.edge.expectancyR?.toFixed(2)}R average result per trade (after fees). ${x.edge.trades < 20 ? "That sample is small, so treat it with caution." : ""}`,
    );
  if (x.isPerp) parts.push("Leverage does not make a trade better — it only changes how much margin you lock up and how close liquidation is.");
  return parts.join(" ");
}
