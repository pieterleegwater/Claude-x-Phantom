// The autonomous engine cycle. Deterministic given (state, market data, broker responses).
// Runs every minute from a scheduled function; also callable manually from the dashboard.
//
// Order of operations (every tick):
//   1. sync positions with the broker (fills of stops/targets, funding, liquidation, venue truth)
//   2. emergency stop → flatten everything
//   3. roll daily/weekly bookkeeping, evaluate account limits (may halt)
//   4. manage open positions (break-even, trailing, thesis exits)
//   5. (re)validate strategies within a time budget (walk-forward, out-of-sample, vs benchmark)
//   6. scan markets → regime → validated strategies → signal → size → score → flags → decision
//   7. execute at most one new trade per tick, only if every gate passes
import type { Candle } from "../types";
import { getStrategy, Indicators } from "../strategies";
import { closedCandles, TF_MS, type AssetInfo, type FeedTf, type MarketFeed } from "./market";
import { bookImbalance } from "./features";
import { readRegime, type MarketRegime } from "./regime";
import { evaluateLimits, rollPeriods, roundPrice, sizePosition } from "./riskGovernor";
import { scoreOpportunity } from "./scoring";
import { manageExit } from "./exits";
import { selectStrategies, TRADABLE_STRATEGIES, validateStrategy } from "./validation";
import type { Broker } from "./broker";
import { EXIT_PROFILES, type EngineAlert, type EngineState, type ExecTf, type Opportunity } from "./types";

export const HTF: Record<ExecTf, FeedTf> = { "5m": "1h", "15m": "1h", "1h": "4h" };
const VALIDATION_MAX_AGE = 12 * 3_600_000;

export interface CycleDeps {
  feed: MarketFeed;
  broker: Broker;
  now?: number;
  validationBudgetMs?: number;
  validationBars?: number;
}

const uid = () => Math.random().toString(36).slice(2, 9);
function alert(s: EngineState, level: EngineAlert["level"], msg: string, now: number): EngineState {
  if (s.alerts[0]?.msg === msg) return s; // de-duplicate consecutive identical alerts
  return { ...s, alerts: [{ id: uid(), at: now, level, msg }, ...s.alerts].slice(0, 300) };
}

export async function runCycle(state: EngineState, deps: CycleDeps): Promise<EngineState> {
  const now = deps.now ?? Date.now();
  const t0 = Date.now();
  const notes: string[] = [];
  let s = state;
  const cfg = s.config;
  const broker = deps.broker;
  try {
    const assets = await deps.feed.assets(cfg.coins);
    for (const coin of cfg.coins) if (!assets[coin]) notes.push(`${coin} not listed on the venue — skipped.`);

    // 1. sync
    const sync = await broker.sync(s, deps.feed, assets, now);
    s = sync.s;
    for (const n of sync.notes) { notes.push(n); if (/stop|TP|take-profit|closed|LIQUIDATED|EMERGENCY/i.test(n)) s = alert(s, /LIQUIDATED|EMERGENCY/.test(n) ? "critical" : "info", n, now); }

    // 2. emergency stop: flatten
    if (s.killSwitch) {
      for (const p of s.positions.filter((x) => x.mode === broker.mode)) {
        const r = await broker.close(s, p.id, "EMERGENCY STOP", assets, now);
        s = alert(r.s, "critical", r.ok ? `Emergency stop: ${p.coin} position closed.` : `Emergency stop: FAILED to close ${p.coin}: ${r.note}`, now);
      }
      return finish(s, now, t0, true, [...notes, "Emergency stop active — all trading blocked."]);
    }

    // 3. account limits
    const equity = await broker.equity(s, assets);
    s = rollPeriods(s, equity, now);
    const limits = evaluateLimits(s, equity, now);
    if (limits.halt && !s.halted) {
      s = { ...s, halted: { ...limits.halt, at: now } };
      s = alert(s, "critical", `Automatic shutdown: ${limits.halt.reason}`, now);
    }

    // candles per coin/tf (closed only)
    const cache: Record<string, Candle[]> = {};
    const get = async (coin: string, tf: FeedTf, bars = 400) => {
      const k = `${coin}:${tf}:${bars}`;
      if (!cache[k]) cache[k] = closedCandles(await deps.feed.candles(coin, tf, bars, now), tf, now);
      return cache[k];
    };

    // 4. manage open positions
    for (const p of s.positions.filter((x) => x.mode === broker.mode)) {
      try {
        const c = await get(p.coin, p.tf);
        const reg = c.length > 220 ? readRegime(c).regime : null;
        const prof = EXIT_PROFILES.find((e) => e.id === p.exitProfile) ?? EXIT_PROFILES[0];
        const params = s.validation[`${p.coin}:${p.tf}:${p.strategyId}`]?.params ?? {};
        const bars = Math.floor((now - p.openedAt) / TF_MS[p.tf]);
        s = { ...s, positions: s.positions.map((x) => (x.id === p.id ? { ...x, barsHeld: bars } : x)) };
        const pos = s.positions.find((x) => x.id === p.id)!;
        const actions = manageExit(pos, c, prof, reg, params, cfg.takerFeeBps);
        const close = actions.find((a) => a.type === "close");
        if (close) {
          const r = await broker.close(s, p.id, close.why, assets, now);
          s = alert(r.s, r.ok ? "info" : "critical", `${p.coin} ${p.side}: ${r.ok ? "closed" : "CLOSE FAILED"} — ${close.why}${r.ok ? "" : ` (${r.note})`}`, now);
          continue;
        }
        const moves = actions.filter((a): a is Extract<typeof a, { type: "move_stop" }> => a.type === "move_stop");
        if (moves.length) {
          const best = moves.reduce((b, m) => ((p.side === "long" ? m.stop > b.stop : m.stop < b.stop) ? m : b));
          const px = roundPrice(best.stop, assets[p.coin]?.szDecimals ?? 4, p.side === "long" ? "down" : "up");
          if (p.side === "long" ? px > pos.stop : px < pos.stop) {
            const r = await broker.moveStop(s, p.id, px, assets);
            s = r.s;
            s = { ...s, positions: s.positions.map((x) => (x.id === p.id ? { ...x, trailingActive: x.trailingActive || /trailing/i.test(best.why), beMoved: x.beMoved || /break-even/i.test(best.why) } : x)) };
            s = alert(s, r.ok ? "info" : "critical", `${p.coin}: ${r.ok ? best.why : `STOP MOVE FAILED (${r.note})`}`, now);
          }
        }
      } catch (e) {
        notes.push(`Managing ${p.coin} failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 5. validation (time-budgeted, oldest first)
    const budget = deps.validationBudgetMs ?? 8000;
    const vStart = Date.now();
    const jobs: { coin: string; tf: ExecTf; id: string; age: number }[] = [];
    for (const coin of cfg.coins) for (const tf of cfg.timeframes) for (const st of TRADABLE_STRATEGIES()) {
      const v = s.validation[`${coin}:${tf}:${st.id}`];
      const age = v ? now - v.testedAt : Infinity;
      if (age > VALIDATION_MAX_AGE) jobs.push({ coin, tf, id: st.id, age });
    }
    jobs.sort((a, b) => b.age - a.age);
    const validation = { ...s.validation };
    let validated = 0;
    for (const j of jobs) {
      if (Date.now() - vStart >= budget || !assets[j.coin]) break;
      const hist = await get(j.coin, j.tf, deps.validationBars ?? 3000);
      if (hist.length < 800) { notes.push(`${j.coin} ${j.tf}: only ${hist.length} candles — validation postponed.`); continue; }
      const v = validateStrategy(hist, getStrategy(j.id)!, j.coin, j.tf, cfg, assets[j.coin].maxLeverage);
      validation[v.key] = v;
      validated++;
    }
    s = { ...s, validation };
    if (validated) notes.push(`Validated ${validated} strategy/market combinations (${jobs.length - validated} pending).`);

    // 6. scan
    const regimes: EngineState["regimes"] = { ...s.regimes };
    const opps: Opportunity[] = [];
    for (const coin of cfg.coins) {
      const asset = assets[coin];
      if (!asset) continue;
      let book: ReturnType<typeof bookImbalance> = null;
      try { const b = await deps.feed.book(coin); book = b ? bookImbalance(b.bids, b.asks) : null; } catch { /* optional */ }
      for (const tf of cfg.timeframes) {
        const c = await get(coin, tf);
        const htf = await get(coin, HTF[tf]);
        if (c.length < 220) { opps.push(waitOpp(now, coin, tf, "range", [`Not enough ${tf} history (${c.length}).`])); continue; }
        const rr = readRegime(c);
        regimes[coin] = { ...(regimes[coin] ?? {}), [tf]: rr };
        const eligible = selectStrategies(rr.regime, coin, tf, s.validation);
        if (!eligible.length) { opps.push(waitOpp(now, coin, tf, rr.regime, [`WAIT — no strategy with a validated positive edge after costs for the ${rr.regime} regime on ${coin} ${tf}.`])); continue; }
        const i = c.length - 1;
        const dataAgeSec = (now - (c[i].time * 1000 + TF_MS[tf])) / 1000;
        let found = false;
        for (const v of eligible) {
          const st = getStrategy(v.strategyId)!;
          const sig = st.entry(i, { c, ind: new Indicators(c), p: v.params });
          if (!sig) continue;
          found = true;
          const prof = EXIT_PROFILES.find((e) => e.id === v.exitProfile) ?? EXIT_PROFILES[0];
          const entry = asset.midPx;
          const sgn = sig.side === "long" ? 1 : -1;
          const stop = roundPrice(sig.stop, asset.szDecimals, sig.side === "long" ? "down" : "up");
          const risk = Math.abs(entry - stop);
          const tps = prof.tps.map((t) => ({ price: roundPrice(entry + sgn * t.r * risk, asset.szDecimals), pct: t.pct }));
          const openRisk = s.positions.filter((p) => p.mode === broker.mode).reduce((t, p) => t + Math.abs(p.entry - p.stop) * p.qty, 0);
          const size = sizePosition({ equity, config: cfg, mode: broker.mode, lossStreak: s.lossStreak, asset, side: sig.side, entry, stop, openRiskUsd: openRisk });
          const sc = scoreOpportunity({ c, htf, side: sig.side, entry, stop, exit: prof, regime: rr, strategyRegimes: st.regimes ?? [], family: st.family, validation: v, asset, book, notional: size.notional || 10, dataAgeSec, tfSec: TF_MS[tf] / 1000, config: cfg });
          const flags = [...sc.flags, ...(size.ok ? [] : size.reasons)];
          if (s.positions.some((p) => p.coin === coin && p.mode === broker.mode)) flags.push(`Already in a ${coin} position — no duplicate or overlapping entries.`);
          const minScore = broker.mode === "live" ? cfg.liveMinScore : cfg.paperMinScore;
          const decision: Opportunity["decision"] = flags.length ? "NO_TRADE" : sc.score >= minScore ? "TRADE" : sc.score >= 70 ? "PAPER_ONLY" : "NO_TRADE";
          opps.push({
            at: now, coin, tf, regime: rr.regime, strategyId: st.id, side: sig.side, score: sc.score, band: sc.band, decision,
            reasons: [sig.reason, `OOS edge ${v.oosExpectancyR?.toFixed(3)}R over ${v.oosTrades} trades (benchmark ${v.benchmarkExpectancyR?.toFixed(3) ?? "—"}R).`, ...sc.factors.filter((f) => (f.score ?? 0) >= 70).map((f) => `${f.label}: ${f.score}`), ...size.reasons],
            flags, entry, stop, tps: tps.map((t) => t.price), qty: size.qty, notional: size.notional, leverage: size.leverage, liqPrice: size.liqPrice, riskUsd: size.riskUsd,
          });
        }
        if (!found) opps.push(waitOpp(now, coin, tf, rr.regime, [`WAIT — validated strategies for ${rr.regime} (${eligible.map((e) => e.strategyId).join(", ")}) have no entry signal on the latest closed ${tf} candle.`]));
      }
    }
    s = { ...s, regimes, opportunities: opps.sort((a, b) => b.score - a.score) };

    // 7. execute (at most one new trade per tick)
    if (!cfg.autoTrading) notes.push("Automatic trading is OFF — scanning only.");
    else if (!limits.canOpen || s.halted) notes.push(`No new trades: ${[...limits.reasons, s.halted?.reason].filter(Boolean).join(" ")}`);
    else {
      const best = s.opportunities.find((o) => o.decision === "TRADE");
      if (best && best.side && best.strategyId && best.qty && best.entry && best.stop) {
        const asset = assets[best.coin];
        const v = s.validation[`${best.coin}:${best.tf}:${best.strategyId}`];
        const prof = EXIT_PROFILES.find((e) => e.id === v?.exitProfile) ?? EXIT_PROFILES[0];
        const r = await broker.open(s, {
          coin: best.coin, asset, side: best.side, qty: best.qty, refPrice: asset.midPx, stop: best.stop,
          tps: (best.tps ?? []).map((px, k) => ({ price: px, pct: prof.tps[k]?.pct ?? 100 })), leverage: best.leverage ?? 1, liqPrice: best.liqPrice ?? null,
          tf: best.tf, strategyId: best.strategyId, exitProfile: prof.id, score: best.score, thesis: best.reasons[0] ?? "", regime: best.regime,
        }, now);
        s = r.ok ? { ...r.s, tradesToday: r.s.tradesToday + 1 } : r.s;
        s = alert(s, r.ok ? "info" : r.critical ? "critical" : "warn", `${r.ok ? "ENTRY" : "Entry rejected"}: ${best.coin} ${best.side} (${best.strategyId}, score ${best.score}) — ${r.note}`, now);
      } else notes.push("No opportunity passed every gate this tick — NO TRADE.");
    }
    return finish(s, now, t0, true, notes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    s = alert(s, "warn", `Engine tick failed: ${msg}`, now);
    return finish(s, now, t0, false, [...notes, msg]);
  }
}

function waitOpp(now: number, coin: string, tf: ExecTf, regime: MarketRegime, reasons: string[]): Opportunity {
  return { at: now, coin, tf, regime, strategyId: null, side: null, score: 0, band: "none", decision: "WAIT", reasons, flags: [] };
}

function finish(s: EngineState, now: number, t0: number, ok: boolean, notes: string[]): EngineState {
  return { ...s, lastTick: { at: now, ms: Date.now() - t0, ok, notes: notes.slice(0, 30), ...(ok ? {} : { error: notes[notes.length - 1] }) } };
}

/** Append an equity point at most every 15 minutes (called by the runtime with the broker equity). */
export function recordEquity(s: EngineState, equity: number, now: number): EngineState {
  const last = s.equityHistory[s.equityHistory.length - 1];
  if (last && now - last.t < 15 * 60_000 && last.mode === s.config.mode) return s;
  return { ...s, equityHistory: [...s.equityHistory, { t: now, equity, mode: s.config.mode }].slice(-5000) };
}
