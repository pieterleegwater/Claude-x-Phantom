// Walk-forward validation of each strategy per market & timeframe, against a plain benchmark.
// Parameters AND the exit profile are chosen on in-sample data only; the verdict uses the stitched
// out-of-sample results. A strategy is "validated" only if it shows a positive expectancy after
// fees, slippage and funding, on enough trades, AND beats the benchmark.
import type { Candle } from "../types";
import { Indicators, STRATEGIES, defaultParams, getStrategy, type Strategy } from "../strategies";
import { paramGrid } from "../backtest";
import { computeMetrics } from "../backtest";
import { runBacktestV2, NO_TP_PROFILE, type Bt2Config, type Bt2Trade } from "./backtest2";
import { regimeSeriesV2, type MarketRegime } from "./regime";
import { EXIT_PROFILES, type EngineConfig, type ExecTf, type ValidationResult } from "./types";

export function btConfig(cfg: EngineConfig, maxLeverage: number, funding?: (number | null)[]): Bt2Config {
  return { initialEquity: 1000, riskPct: cfg.riskPerTradePct, takerFeeBps: cfg.takerFeeBps, slippageBps: cfg.slippageBps, leverage: Math.min(cfg.maxLeverageLive, maxLeverage), maxLeverage, fundingPer8h: 0.0001, funding };
}

const objective = (expR: number | null, n: number) => (n < 6 || expR == null ? -Infinity : expR * Math.sqrt(n));

export function validateStrategy(c: Candle[], st: Strategy, coin: string, tf: ExecTf, cfg: EngineConfig, maxLeverage: number, opts: { funding?: (number | null)[]; folds?: number; cache?: { ind: Indicators; regimes: MarketRegime[] } } = {}): ValidationResult {
  const ind = opts.cache?.ind ?? new Indicators(c);
  const regimes = opts.cache?.regimes ?? regimeSeriesV2(c);
  const bc = btConfig(cfg, maxLeverage, opts.funding);
  const folds = opts.folds ?? 4;
  const seg = Math.floor(c.length / (folds + 2));
  const grid = paramGrid(st, defaultParams(st), 12);
  const exits = EXIT_PROFILES;
  const oos: Bt2Trade[] = [];
  const curve: { time: number; equity: number }[] = [];
  const bench: Bt2Trade[] = [];
  const benchSt = getStrategy("benchmark_ema_cross")!;
  let eq = bc.initialEquity, positive = 0, evaluated = 0;
  let chosen = { params: defaultParams(st), exit: exits[0].id };
  for (let f = 0; f < folds; f++) {
    const isS = f * seg, isE = isS + 2 * seg, oS = isE, oE = f === folds - 1 ? c.length : oS + seg;
    let best = { score: -Infinity, params: grid[0], exit: exits[0] };
    for (const g of grid) for (const ex of exits) {
      const r = runBacktestV2(c, st, g, { ...bc, startIndex: isS, endIndex: isE }, ex, { ind, regimes });
      evaluated++;
      if ((r.metrics.expectancyR ?? -1) > 0) positive++;
      const sc = objective(r.metrics.expectancyR, r.metrics.trades);
      if (sc > best.score) best = { score: sc, params: g, exit: ex };
    }
    const o = runBacktestV2(c, st, best.params, { ...bc, initialEquity: eq, startIndex: oS, endIndex: oE }, best.exit, { ind, regimes });
    oos.push(...o.trades); curve.push(...o.equity);
    eq = o.equity.length ? o.equity[o.equity.length - 1].equity : eq;
    const b = runBacktestV2(c, benchSt, defaultParams(benchSt), { ...bc, startIndex: oS, endIndex: oE }, NO_TP_PROFILE, { ind, regimes });
    bench.push(...b.trades);
    if (f === folds - 1) chosen = { params: best.params, exit: best.exit.id };
  }
  const barSec = c.length > 1 ? c[1].time - c[0].time : 3600;
  const m = computeMetrics(oos as never, curve, bc.initialEquity, barSec, NaN, 0);
  const bm = computeMetrics(bench as never, [], bc.initialEquity, barSec, NaN, 0);
  const robustness = evaluated ? (positive / evaluated) * 100 : 0;
  const checks: [boolean, string][] = [
    [m.trades >= cfg.minOosTrades, `${m.trades} out-of-sample trades (need ≥ ${cfg.minOosTrades})`],
    [(m.expectancyR ?? -1) >= cfg.minOosExpectancyR, `OOS expectancy ${m.expectancyR?.toFixed(3) ?? "—"}R after costs (need ≥ ${cfg.minOosExpectancyR}R)`],
    [(m.profitFactor ?? 0) >= 1.1, `OOS profit factor ${m.profitFactor == null ? "—" : Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"} (need ≥ 1.1)`],
    [(m.expectancyR ?? -1) > (bm.expectancyR ?? 0), `beats benchmark (${bm.expectancyR?.toFixed(3) ?? "—"}R)`],
    [robustness >= 35, `parameter robustness ${robustness.toFixed(0)}% (need ≥ 35%)`],
  ];
  const validated = checks.every(([okk]) => okk);
  return {
    key: `${coin}:${tf}:${st.id}`,
    strategyId: st.id,
    coin,
    tf,
    testedAt: Date.now(),
    bars: c.length,
    oosTrades: m.trades,
    oosExpectancyR: m.expectancyR,
    oosProfitFactor: m.profitFactor != null && Number.isFinite(m.profitFactor) ? m.profitFactor : m.profitFactor == null ? null : 99,
    oosWinRate: m.winRate,
    oosMaxDD: m.maxDrawdownPct,
    oosNetPct: m.totalReturnPct,
    benchmarkExpectancyR: bm.expectancyR,
    robustness,
    exitProfile: chosen.exit,
    params: chosen.params,
    validated,
    why: (validated ? "Validated: " : "Not validated: ") + checks.map(([okk, t]) => `${okk ? "✓" : "✗"} ${t}`).join("; "),
  };
}

/** Strategies eligible to trade in a regime: designed for it AND validated on this market/timeframe. */
export function selectStrategies(regime: MarketRegime, coin: string, tf: ExecTf, validation: Record<string, ValidationResult>) {
  return STRATEGIES.filter((s) => !s.benchmark && s.regimes?.includes(regime))
    .map((s) => validation[`${coin}:${tf}:${s.id}`])
    .filter((v): v is ValidationResult => !!v && v.validated)
    .sort((a, b) => (b.oosExpectancyR ?? 0) - (a.oosExpectancyR ?? 0));
}

export const TRADABLE_STRATEGIES = () => STRATEGIES.filter((s) => !s.benchmark && !s.requiresFunding);
