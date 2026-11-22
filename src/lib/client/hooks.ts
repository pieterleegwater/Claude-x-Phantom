"use client";
import { useEffect, useMemo } from "react";
import { useApi } from "./useApi";
import { useStore, setState, getState } from "./store";
import type { Candle, DerivativesSnapshot, Ticker, Timeframe } from "../types";
import { analyzeBtc, type BtcAnalysis } from "../analysis/btcEngine";
import { analyzeMeme, type MemeAnalysis, type MemeToken } from "../analysis/memeEngine";

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
  const analyses = useMemo<MemeAnalysis[]>(() => {
    if (!api.data) return [];
    return api.data.tokens.map((t) => analyzeMeme(t, settings, { prevLiquidity: liq[t.mint]?.liq })).sort((a, b) => b.score - a.score);
    // liq intentionally read at analysis time; it is updated after each scan by the watcher
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.data, settings]);
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
