"use client";
import { useEffect, useMemo } from "react";
import { useApi } from "./useApi";
import { useStore, setState, getState } from "./store";
import type { Candle, DerivativesSnapshot, Ticker, Timeframe } from "../types";
import { analyzeBtc, type BtcAnalysis } from "../analysis/btcEngine";
import { analyzeMeme, type MemeAnalysis, type MemeToken } from "../analysis/memeEngine";
import { evaluateSignal, memeMint, scannerEdge, trackableSignals, trackStats, HORIZON_MS } from "../memeTrack";
import { apiGet } from "./useApi";

export const HIGHER_TF: Record<string, Timeframe> = { "15m": "1h", "1h": "4h", "4h": "1d" };

export function useTicker(symbol = "BTC", refreshMs = 10_000) {
  return useApi<Ticker>(`/api/market/ticker?symbol=${symbol}`, refreshMs);
}

export function useDerivatives(refreshMs = 60_000) {
  return useApi<DerivativesSnapshot>("/api/btc/derivatives", refreshMs);
}

export function useBtcAnalysis(opts: { market: "BTC-PERP" | "BTC-SPOT"; tf?: "15m" | "1h" | "4h"; leverage?: number; symbol?: "BTC" | "ETH" | "SOL" }) {
  const settings = useStore((s) => s.settings);
  const tf = opts.tf ?? settings.primaryTimeframe;
  const htf = HIGHER_TF[tf];
  const sym = opts.symbol ?? "BTC";
  const refresh = tf === "15m" ? 60_000 : 120_000;
  const primary = useApi<Candle[]>(`/api/market/candles?symbol=${sym}&tf=${tf}&limit=1000`, refresh);
  const higher = useApi<Candle[]>(`/api/market/candles?symbol=${sym}&tf=${htf}&limit=500`, refresh * 2);
  const deriv = useDerivatives();
  const leverage = opts.leverage ?? settings.defaultLeverage;

  const result = useMemo((): { analysis?: BtcAnalysis; error?: string } => {
    if (!primary.data || !higher.data || !settings) return {};
    try {
      const sources = [primary.meta?.source, higher.meta?.source, sym === "BTC" && deriv.data ? deriv.meta?.source : undefined].filter(Boolean) as string[];
      return {
        analysis: analyzeBtc({
          primary: primary.data,
          primaryTf: tf,
          higher: higher.data,
          higherTf: htf,
          derivatives: sym === "BTC" ? (deriv.data ?? null) : null,
          settings,
          market: opts.market,
          leverage,
          sources: [...new Set(sources)],
          asset: sym,
        }),
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [primary.data, higher.data, deriv.data, settings, tf, htf, opts.market, leverage, primary.meta, higher.meta, deriv.meta, sym]);

  return {
    ...result,
    tf,
    htf,
    loading: primary.loading || higher.loading,
    error: result.error ?? primary.error ?? higher.error,
    derivError: deriv.error,
    primaryMeta: primary.meta,
    derivatives: deriv.data,
    derivMeta: deriv.meta,
    candles: primary.data,
    refresh: () => {
      primary.refresh();
      higher.refresh();
      deriv.refresh();
    },
  };
}

export function useMemeScan(refreshMs = 120_000) {
  const api = useApi<{ tokens: MemeToken[]; candidates: number }>("/api/memecoins/scan", refreshMs);
  const settings = useStore((s) => s.settings);
  const liq = useStore((s) => s.memeLiquidity);
  const outcomes = useStore((s) => s.memeOutcomes);
  const analyses = useMemo<MemeAnalysis[]>(() => {
    if (!api.data) return [];
    const edge = scannerEdge(trackStats(Object.values(outcomes)));
    return api.data.tokens
      .map((t) => {
        const a = analyzeMeme(t, settings, { prevLiquidity: liq[t.mint]?.liq });
        if (edge && (a.signal.direction === "BUY" || a.signal.direction === "WAIT")) a.signal.historicalEdge = edge;
        return a;
      })
      .sort((a, b) => b.score - a.score);
    // liq intentionally read at analysis time; it is updated after each scan by the watcher
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.data, settings, outcomes]);
  useEffect(() => {
    if (!api.data) return;
    const now = Date.now();
    const cur = getState().memeLiquidity;
    const next = { ...cur };
    let changed = false;
    for (const t of api.data.tokens) {
      const prev = cur[t.mint];
      if (!prev || now - prev.t > 15 * 60_000) {
        next[t.mint] = { liq: t.liquidityUsd, t: now };
        changed = true;
      }
    }
    // prune entries older than 3 days
    for (const [k, v] of Object.entries(next)) if (now - v.t > 3 * 86_400_000) (delete next[k], (changed = true));
    if (changed) setState({ memeLiquidity: next });
  }, [api.data]);
  return { ...api, analyses };
}

/**
 * Forward test: re-checks logged memecoin BUY signals against real pool candles (GeckoTerminal via
 * /api/memecoins/token). Runs a few at a time to respect rate limits.
 */
export function useMemeTrackRecord() {
  const log = useStore((s) => s.signalLog);
  const outcomes = useStore((s) => s.memeOutcomes);
  const hydrated = useStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const run = async () => {
      const now = Date.now();
      const cur = getState().memeOutcomes;
      const todo = trackableSignals(getState().signalLog)
        .filter((s) => now - s.createdAt > 15 * 60_000)
        .filter((s) => {
          const o = cur[s.id];
          return !o || (o.status === "open" && now - o.evaluatedAt > 10 * 60_000);
        })
        .slice(0, 4);
      for (const s of todo) {
        if (cancelled) return;
        const mint = memeMint(s);
        const age = now - s.createdAt;
        const tf = age < 22 * 3_600_000 ? "5m" : "1h";
        try {
          const r = await apiGet<{ candles: import("../types").Candle[] }>(`/api/memecoins/token?mint=${mint}&tf=${tf}`);
          if (!r.data.candles?.length) continue;
          const o = evaluateSignal({ id: s.id, mint, symbol: s.asset, time: s.createdAt, entry: s.price, stop: s.stopLoss!, tp1: s.takeProfits[0].price, score: s.qualityScore }, r.data.candles, now);
          setState((st) => ({ memeOutcomes: { ...st.memeOutcomes, [s.id]: o } }));
        } catch {
          /* token delisted or rate-limited — retry later */
        }
      }
    };
    run();
    const id = setInterval(run, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hydrated]);
  const tracked = trackableSignals(log);
  const list = tracked.map((s) => outcomes[s.id]).filter((o): o is NonNullable<typeof o> => !!o);
  return { stats: trackStats(list), outcomes: list.sort((a, b) => b.time - a.time), pending: tracked.length - list.length, horizonHours: HORIZON_MS / 3_600_000 };
}
