"use client";
// Background monitor (runs while the app is open in a browser tab):
//  • paper positions: checks stops / take-profits / liquidation against live prices
//  • BTC: new high-quality setups, breakouts and breakdowns
//  • memecoins: momentum acceleration, high-risk flags on watchlist / held tokens
// There is no server-side push in this version — alerts only fire while a tab is open.
import { useEffect, useRef } from "react";
import { apiGet } from "@/lib/client/useApi";
import { getState, setState, notify, logSignal, useStore, isLeaderTab } from "@/lib/client/store";
import { updatePrices, type PriceUpdate } from "@/lib/paper";
import { analyzeBtc } from "@/lib/analysis/btcEngine";
import { analyzeMeme, type MemeToken } from "@/lib/analysis/memeEngine";
import { priorHigh, priorLow } from "@/lib/indicators";
import type { Candle, DerivativesSnapshot, Ticker } from "@/lib/types";
import { HIGHER_TF } from "@/lib/client/hooks";

export function Watcher() {
  const hydrated = useStore((s) => s.hydrated);
  const funding = useRef<{ v: number | null; t: number }>({ v: null, t: 0 });
  const busy = useRef({ paper: false, market: false });

  // ---- Paper position monitor (every 10s while positions are open)
  useEffect(() => {
    if (!hydrated) return;
    const tick = async () => {
      const s = getState();
      // only one browser tab simulates fills, otherwise tabs would double-process positions
      if (!s.paper.positions.length || busy.current.paper || !isLeaderTab()) return;
      busy.current.paper = true;
      try {
        const prices: Record<string, PriceUpdate> = {};
        if (s.paper.positions.some((p) => p.priceKey === "BTC")) {
          const [t, c] = await Promise.all([apiGet<Ticker>("/api/market/ticker?symbol=BTC"), apiGet<Candle[]>("/api/market/candles?symbol=BTC&tf=1m&limit=50")]);
          if (Date.now() - funding.current.t > 5 * 60_000) {
            try {
              const d = await apiGet<DerivativesSnapshot>("/api/btc/derivatives");
              funding.current = { v: d.data.funding8h, t: Date.now() };
            } catch {
              funding.current = { v: funding.current.v, t: Date.now() };
            }
          }
          // candles are filtered per position (only those starting after the position opened / levels changed)
          prices.BTC = { price: t.data.price, candles: c.data.slice(-30), funding8h: funding.current.v };
        }
        const mints = [...new Set(s.paper.positions.filter((p) => p.market === "SOL-MEME").map((p) => p.priceKey))];
        if (mints.length) {
          const r = await apiGet<Record<string, { priceUsd: number }>>(`/api/memecoins/prices?mints=${mints.join(",")}`);
          for (const m of mints) if (r.data[m]) prices[m] = { price: r.data[m].priceUsd };
        }
        const st = getState();
        const cost = { takerFeeBps: st.settings.takerFeeBps, slippageBps: st.settings.slippageBps, mmr: st.settings.maintenanceMarginRate };
        const res = updatePrices(st.paper, prices, cost);
        setState({ paper: res.state });
        if (st.settings.notifications.paperFills)
          for (const e of res.events) notify({ key: `${e.title}-${Date.now()}`, type: e.type === "tp" ? "tp" : "stop", title: e.title, body: e.body, href: "/paper" });
      } catch {
        /* transient network errors: try again next tick */
      } finally {
        busy.current.paper = false;
      }
    };
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  }, [hydrated]);

  // ---- Market alerts
  const pollSeconds = useStore((s) => s.settings.notifications.pollSeconds);
  useEffect(() => {
    if (!hydrated) return;
    let n = 0;
    const run = async () => {
      if (busy.current.market || document.visibilityState !== "visible") return;
      busy.current.market = true;
      const s = getState();
      const ns = s.settings.notifications;
      try {
        // BTC every 5 cycles (or first run)
        if (n % 5 === 0) {
          const tf = s.settings.primaryTimeframe;
          const [p, h, d] = await Promise.all([
            apiGet<Candle[]>(`/api/market/candles?symbol=BTC&tf=${tf}&limit=1000`),
            apiGet<Candle[]>(`/api/market/candles?symbol=BTC&tf=${HIGHER_TF[tf]}&limit=500`),
            apiGet<DerivativesSnapshot>("/api/btc/derivatives").catch(() => null),
          ]);
          const a = analyzeBtc({ primary: p.data, primaryTf: tf, higher: h.data, higherTf: HIGHER_TF[tf], derivatives: d?.data ?? null, settings: s.settings, market: "BTC-PERP", leverage: s.settings.defaultLeverage, sources: [p.meta.source] });
          const sig = a.signal;
          if (sig.direction === "LONG" || sig.direction === "SHORT") {
            logSignal(sig);
            if (sig.qualityScore >= ns.newSetupMinScore) notify({ key: `setup-${sig.id}`, type: "setup", title: `New ${sig.direction} setup: BTC (${sig.qualityScore}/100)`, body: sig.summary, href: "/signals" });
          }
          if (ns.btcBreakouts) {
            const c = a.closedCandles;
            const i = c.length - 1;
            const hi = priorHigh(c, 20)[i], lo = priorLow(c, 20)[i];
            if (c[i].close > hi) notify({ key: `bo-${c[i].time}`, type: "breakout", title: `BTC breakout (${tf})`, body: `Closed at ${c[i].close.toFixed(0)}, above the 20-candle high ${hi.toFixed(0)}. Check the signal for confirmation before acting.`, href: "/bitcoin" });
            if (c[i].close < lo) notify({ key: `bd-${c[i].time}`, type: "breakdown", title: `BTC breakdown (${tf})`, body: `Closed at ${c[i].close.toFixed(0)}, below the 20-candle low ${lo.toFixed(0)}.`, href: "/bitcoin" });
          }
        }
        // Memecoins every 5 cycles, offset
        if (n % 5 === 2) {
          const r = await apiGet<{ tokens: MemeToken[] }>("/api/memecoins/scan");
          const held = new Set([...s.watchlist, ...s.paper.positions.filter((p) => p.market === "SOL-MEME").map((p) => p.priceKey)]);
          const hour = Math.floor(Date.now() / 3_600_000);
          for (const t of r.data.tokens) {
            const m = analyzeMeme(t, s.settings, { prevLiquidity: s.memeLiquidity[t.mint]?.liq });
            const accel = t.volume.h6 > 0 ? t.volume.h1 / (t.volume.h6 / 6) : 0;
            if (accel >= ns.memeVolumeAccel && (m.category === "EARLY MOMENTUM" || m.category === "BREAKOUT" || m.category === "TRENDING"))
              notify({ key: `meme-${t.mint}-${hour}`, type: "meme", title: `${t.symbol}: volume ${accel.toFixed(1)}× and accelerating`, body: `${m.category}, quality ${m.score}/100. ${m.warnings.length} warnings.`, href: `/scanner/${t.mint}` });
            if (m.signal.direction === "BUY") logSignal(m.signal);
            if (ns.highRiskTokens && held.has(t.mint) && (m.category === "POSSIBLE RUG" || m.critical.length))
              notify({ key: `risk-${t.mint}-${Math.floor(hour / 6)}`, type: "risk", title: `High-risk alert: ${t.symbol}`, body: m.critical[0] ?? "Flagged POSSIBLE RUG.", href: `/scanner/${t.mint}` });
          }
        }
      } catch {
        /* ignore — errors are visible on the respective pages */
      } finally {
        n++;
        busy.current.market = false;
      }
    };
    const t0 = setTimeout(run, 4000);
    const id = setInterval(run, Math.max(60, pollSeconds) * 1000);
    return () => {
      clearTimeout(t0);
      clearInterval(id);
    };
  }, [hydrated, pollSeconds]);

  return null;
}
