import "server-only";
// Market data providers for BTC / ETH / SOL (CEX spot candles) and BTC perpetual derivatives.
// Every provider is public & documented; fallbacks run in order and failures are reported.
//
//  Spot candles/ticker : Binance public market-data API (data-api.binance.vision)
//                        -> Coinbase Exchange -> Kraken -> Hyperliquid (perp candles, labelled)
//  Derivatives         : Binance USDⓈ-M Futures, OKX public API, Hyperliquid info API (merged)
//  Liquidations        : CoinGlass (requires COINGLASS_API_KEY)
import type { Candle, DerivativesSnapshot, Ticker, Timeframe } from "../types";
import { TF_SECONDS } from "../types";
import { aggregate } from "../indicators";
import { fetchJson, firstOk, UpstreamError } from "../server/http";

export type Symbol = "BTC" | "ETH" | "SOL";
export const SYMBOLS: Symbol[] = ["BTC", "ETH", "SOL"];

const BINANCE = process.env.BINANCE_BASE_URL || "https://data-api.binance.vision";
const BINANCE_FUT = process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
const COINBASE = "https://api.exchange.coinbase.com";
const KRAKEN = "https://api.kraken.com";
const OKX = "https://www.okx.com";
const HL = "https://api.hyperliquid.xyz/info";

const bnSym = (s: Symbol) => `${s}USDT`;
const cbSym = (s: Symbol) => `${s}-USD`;
const krSym = (s: Symbol) => (s === "BTC" ? "XBTUSD" : `${s}USD`);
const num = (x: unknown) => (x == null || x === "" ? NaN : Number(x));

function clean(c: Candle[]): Candle[] {
  const seen = new Set<number>();
  return c
    .filter((k) => Number.isFinite(k.open) && Number.isFinite(k.close) && k.high >= k.low && !seen.has(k.time) && seen.add(k.time))
    .sort((a, b) => a.time - b.time);
}

// ---------------- Binance ----------------
async function binanceKlines(s: Symbol, tf: Timeframe, limit: number, startMs?: number, endMs?: number): Promise<Candle[]> {
  const q = new URLSearchParams({ symbol: bnSym(s), interval: tf, limit: String(Math.min(limit, 1000)) });
  if (startMs) q.set("startTime", String(startMs));
  if (endMs) q.set("endTime", String(endMs));
  const rows = await fetchJson<unknown[][]>("Binance", `${BINANCE}/api/v3/klines?${q}`);
  return rows.map((r) => ({ time: Math.floor(Number(r[0]) / 1000), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[5]) }));
}

// ---------------- Coinbase ----------------
const CB_GRAN: Partial<Record<Timeframe, number>> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400 };
async function coinbaseRange(s: Symbol, tf: Timeframe, startMs: number, endMs: number, maxReq = 12): Promise<Candle[]> {
  const baseTf: Timeframe = tf === "4h" ? "1h" : tf;
  const gran = CB_GRAN[baseTf]!;
  const out: Candle[] = [];
  let end = endMs;
  for (let n = 0; n < maxReq && end > startMs; n++) {
    const start = Math.max(startMs, end - gran * 300 * 1000);
    const q = new URLSearchParams({ granularity: String(gran), start: new Date(start).toISOString(), end: new Date(end).toISOString() });
    const rows = await fetchJson<number[][]>("Coinbase", `${COINBASE}/products/${cbSym(s)}/candles?${q}`);
    for (const r of rows) out.push({ time: r[0], low: r[1], high: r[2], open: r[3], close: r[4], volume: r[5] });
    end = start;
  }
  const c = clean(out);
  return tf === "4h" ? aggregate(c, TF_SECONDS["4h"]) : c;
}

// ---------------- Kraken ----------------
const KR_INT: Record<Timeframe, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 };
async function krakenOhlc(s: Symbol, tf: Timeframe): Promise<Candle[]> {
  const j = await fetchJson<{ error: string[]; result: Record<string, unknown> }>("Kraken", `${KRAKEN}/0/public/OHLC?pair=${krSym(s)}&interval=${KR_INT[tf]}`);
  if (j.error?.length) throw new UpstreamError("Kraken", j.error.join(", "));
  const key = Object.keys(j.result).find((k) => k !== "last")!;
  const rows = j.result[key] as unknown[][];
  return rows.map((r) => ({ time: Number(r[0]), open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[6]) }));
}

// ---------------- Hyperliquid ----------------
async function hlCandles(s: Symbol, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
  const rows = await fetchJson<{ t: number; o: string; h: string; l: string; c: string; v: string }[]>("Hyperliquid", HL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: s, interval: tf, startTime: startMs, endTime: endMs } }),
  });
  return rows.map((r) => ({ time: Math.floor(r.t / 1000), open: num(r.o), high: num(r.h), low: num(r.l), close: num(r.c), volume: num(r.v) }));
}

/** Most recent `limit` candles (including the currently forming one). */
export async function getCandles(s: Symbol, tf: Timeframe, limit = 500) {
  const now = Date.now();
  const startMs = now - TF_SECONDS[tf] * 1000 * limit;
  const r = await firstOk<Candle[]>([
    { name: "Binance spot (data-api.binance.vision)", run: async () => clean(await binanceKlines(s, tf, limit)) },
    { name: "Coinbase Exchange", run: () => coinbaseRange(s, tf, startMs, now, Math.ceil(limit / 300) * (tf === "4h" ? 4 : 1) + 1) },
    { name: "Kraken", run: async () => clean(await krakenOhlc(s, tf)).slice(-limit) },
    { name: "Hyperliquid perp (mark: perpetual, not spot)", run: async () => clean(await hlCandles(s, tf, startMs, now)) },
  ]);
  if (r.value.length < 10) throw new UpstreamError(r.source, "returned too few candles");
  return { candles: r.value.slice(-limit), source: r.source, errors: r.errors };
}

/** Historical candles for a date range (for backtests). Caps at `maxBars`. */
export async function getHistory(s: Symbol, tf: Timeframe, fromMs: number, toMs: number, maxBars = 10_000) {
  const tfMs = TF_SECONDS[tf] * 1000;
  const want = Math.min(maxBars, Math.ceil((toMs - fromMs) / tfMs));
  const from = Math.max(fromMs, toMs - want * tfMs);
  const r = await firstOk<Candle[]>([
    {
      name: "Binance spot (data-api.binance.vision)",
      run: async () => {
        const out: Candle[] = [];
        let cursor = from;
        for (let n = 0; n < Math.ceil(want / 1000) + 1 && cursor < toMs; n++) {
          const batch = await binanceKlines(s, tf, 1000, cursor, toMs);
          if (!batch.length) break;
          out.push(...batch);
          cursor = (batch[batch.length - 1].time + TF_SECONDS[tf]) * 1000;
        }
        return clean(out);
      },
    },
    { name: "Coinbase Exchange", run: () => coinbaseRange(s, tf, from, toMs, Math.min(40, Math.ceil((want * (tf === "4h" ? 4 : 1)) / 300) + 1)) },
    { name: "Hyperliquid perp", run: async () => clean(await hlCandles(s, tf, from, toMs)) },
  ]);
  return { candles: r.value.filter((k) => k.time * 1000 >= from && k.time * 1000 <= toMs), source: r.source, errors: r.errors };
}

export async function getTicker(s: Symbol) {
  return firstOk<Ticker>([
    {
      name: "Binance spot (data-api.binance.vision)",
      run: async () => {
        const j = await fetchJson<Record<string, string>>("Binance", `${BINANCE}/api/v3/ticker/24hr?symbol=${bnSym(s)}`);
        return { symbol: s, price: num(j.lastPrice), change24hPct: num(j.priceChangePercent), volume24hQuote: num(j.quoteVolume), high24h: num(j.highPrice), low24h: num(j.lowPrice) };
      },
    },
    {
      name: "Coinbase Exchange",
      run: async () => {
        const j = await fetchJson<Record<string, string>>("Coinbase", `${COINBASE}/products/${cbSym(s)}/stats`);
        const last = num(j.last), open = num(j.open);
        return { symbol: s, price: last, change24hPct: ((last - open) / open) * 100, volume24hQuote: num(j.volume) * last, high24h: num(j.high), low24h: num(j.low) };
      },
    },
    {
      name: "Kraken",
      run: async () => {
        const j = await fetchJson<{ error: string[]; result: Record<string, { c: string[]; v: string[]; h: string[]; l: string[]; o: string }> }>("Kraken", `${KRAKEN}/0/public/Ticker?pair=${krSym(s)}`);
        if (j.error?.length) throw new UpstreamError("Kraken", j.error.join(", "));
        const t = Object.values(j.result)[0];
        const last = num(t.c[0]), open = num(t.o);
        return { symbol: s, price: last, change24hPct: ((last - open) / open) * 100, volume24hQuote: num(t.v[1]) * last, high24h: num(t.h[1]), low24h: num(t.l[1]) };
      },
    },
  ]);
}

// ---------------- Derivatives ----------------
type Partial_ = Partial<DerivativesSnapshot> & { venue: string };

async function binanceDeriv(): Promise<Partial_> {
  const sym = "BTCUSDT";
  const [prem, oi, oiHist, ls, fh] = await Promise.allSettled([
    fetchJson<Record<string, string | number>>("Binance Futures", `${BINANCE_FUT}/fapi/v1/premiumIndex?symbol=${sym}`),
    fetchJson<{ openInterest: string }>("Binance Futures", `${BINANCE_FUT}/fapi/v1/openInterest?symbol=${sym}`),
    fetchJson<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]>("Binance Futures", `${BINANCE_FUT}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=25`),
    fetchJson<{ longShortRatio: string }[]>("Binance Futures", `${BINANCE_FUT}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`),
    fetchJson<{ fundingTime: number; fundingRate: string }[]>("Binance Futures", `${BINANCE_FUT}/fapi/v1/fundingRate?symbol=${sym}&limit=500`),
  ]);
  if (prem.status === "rejected") throw prem.reason;
  const p = prem.value;
  const out: Partial_ = { venue: "Binance Futures", markPrice: num(p.markPrice), fundingRate: num(p.lastFundingRate), fundingIntervalHours: 8, funding8h: num(p.lastFundingRate), nextFundingTime: Number(p.nextFundingTime) || null };
  if (oi.status === "fulfilled") {
    out.openInterestBase = num(oi.value.openInterest);
    out.openInterestUsd = out.openInterestBase * (out.markPrice ?? NaN);
  }
  if (oiHist.status === "fulfilled" && oiHist.value.length > 1) {
    const h = oiHist.value;
    const a = num(h[0].sumOpenInterest), b = num(h[h.length - 1].sumOpenInterest);
    out.openInterestChangePct24h = ((b - a) / a) * 100;
  }
  if (ls.status === "fulfilled" && ls.value[0]) {
    out.longShortRatio = num(ls.value[0].longShortRatio);
    out.longShortSource = "Binance global long/short account ratio";
  }
  if (fh.status === "fulfilled") out.fundingHistory = fh.value.map((x) => ({ time: x.fundingTime, rate8h: num(x.fundingRate) }));
  return out;
}

async function okxDeriv(): Promise<Partial_> {
  const inst = "BTC-USDT-SWAP";
  type R<T> = { code: string; data: T };
  const [fr, oi, oiHist, ls, fh] = await Promise.allSettled([
    fetchJson<R<{ fundingRate: string; nextFundingTime: string; fundingTime: string }[]>>("OKX", `${OKX}/api/v5/public/funding-rate?instId=${inst}`),
    fetchJson<R<{ oiCcy: string; oiUsd?: string }[]>>("OKX", `${OKX}/api/v5/public/open-interest?instType=SWAP&instId=${inst}`),
    fetchJson<R<string[][]>>("OKX", `${OKX}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H`),
    fetchJson<R<string[][]>>("OKX", `${OKX}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H`),
    fetchJson<R<{ fundingRate: string; realizedRate: string; fundingTime: string }[]>>("OKX", `${OKX}/api/v5/public/funding-rate-history?instId=${inst}&limit=100`),
  ]);
  if (fr.status === "rejected") throw fr.reason;
  const f = fr.value.data?.[0];
  if (!f) throw new UpstreamError("OKX", "empty funding response");
  const ft = Number(f.fundingTime), nt = Number(f.nextFundingTime);
  const intervalH = nt && ft && nt > ft ? Math.round((nt - ft) / 3_600_000) || 8 : 8;
  const rate = num(f.fundingRate);
  const out: Partial_ = { venue: "OKX", fundingRate: rate, fundingIntervalHours: intervalH, funding8h: (rate * 8) / intervalH, nextFundingTime: ft || null };
  if (oi.status === "fulfilled" && oi.value.data?.[0]) {
    out.openInterestBase = num(oi.value.data[0].oiCcy);
    if (oi.value.data[0].oiUsd) out.openInterestUsd = num(oi.value.data[0].oiUsd);
  }
  if (oiHist.status === "fulfilled" && oiHist.value.data?.length > 24) {
    // rows: [ts, oi, vol], newest first
    const d = oiHist.value.data;
    const nowOi = num(d[0][1]), dayAgo = num(d[24][1]);
    out.openInterestChangePct24h = ((nowOi - dayAgo) / dayAgo) * 100;
  }
  if (ls.status === "fulfilled" && ls.value.data?.[0]) {
    out.longShortRatio = num(ls.value.data[0][1]);
    out.longShortSource = "OKX long/short account ratio";
  }
  if (fh.status === "fulfilled") out.fundingHistory = fh.value.data.map((x) => ({ time: Number(x.fundingTime), rate8h: (num(x.realizedRate || x.fundingRate) * 8) / intervalH }));
  return out;
}

async function hyperliquidDeriv(): Promise<Partial_> {
  const post = <T,>(body: unknown) => fetchJson<T>("Hyperliquid", HL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const [metaCtx, fh] = await Promise.allSettled([
    post<[{ universe: { name: string }[] }, { funding: string; openInterest: string; markPx: string }[]]>({ type: "metaAndAssetCtxs" }),
    post<{ time: number; fundingRate: string }[]>({ type: "fundingHistory", coin: "BTC", startTime: Date.now() - 30 * 86_400_000 }),
  ]);
  if (metaCtx.status === "rejected") throw metaCtx.reason;
  const [meta, ctxs] = metaCtx.value;
  const idx = meta.universe.findIndex((u) => u.name === "BTC");
  const ctx = ctxs[idx];
  if (!ctx) throw new UpstreamError("Hyperliquid", "BTC not found");
  const hourly = num(ctx.funding);
  const mark = num(ctx.markPx);
  const out: Partial_ = { venue: "Hyperliquid", markPrice: mark, fundingRate: hourly, fundingIntervalHours: 1, funding8h: hourly * 8, openInterestBase: num(ctx.openInterest), openInterestUsd: num(ctx.openInterest) * mark };
  if (fh.status === "fulfilled") out.fundingHistory = fh.value.map((x) => ({ time: x.time, rate8h: num(x.fundingRate) * 8 }));
  return out;
}

async function coinglassLiquidations(): Promise<DerivativesSnapshot["liquidations24h"]> {
  const key = process.env.COINGLASS_API_KEY;
  if (!key) return null;
  const j = await fetchJson<{ code: string; data: Record<string, number | string>[] }>(
    "CoinGlass",
    "https://open-api-v4.coinglass.com/api/futures/liquidation/aggregated-history?symbol=BTC&interval=1d&limit=1&exchange_list=Binance,OKX,Bybit",
    { headers: { "CG-API-KEY": key } },
  );
  const row = j.data?.[j.data.length - 1];
  if (!row) return null;
  const longK = Object.keys(row).find((k) => /long/i.test(k) && /liq/i.test(k));
  const shortK = Object.keys(row).find((k) => /short/i.test(k) && /liq/i.test(k));
  if (!longK || !shortK) return null;
  return { longUsd: num(row[longK]), shortUsd: num(row[shortK]), source: "CoinGlass (aggregated Binance/OKX/Bybit)" };
}

export async function getDerivatives(): Promise<{ snapshot: DerivativesSnapshot; sources: string[]; errors: string[] }> {
  const results = await Promise.allSettled([binanceDeriv(), okxDeriv(), hyperliquidDeriv()]);
  const parts: Partial_[] = [];
  const errors: string[] = [];
  for (const r of results) r.status === "fulfilled" ? parts.push(r.value) : errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
  if (!parts.length) throw new UpstreamError("derivatives", errors.join(" | "));
  let liq: DerivativesSnapshot["liquidations24h"] = null;
  try {
    liq = await coinglassLiquidations();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  const pick = <K extends keyof DerivativesSnapshot>(k: K): { v: DerivativesSnapshot[K] | null; from?: string } => {
    for (const p of parts) {
      const v = p[k];
      if (v != null && !(typeof v === "number" && !Number.isFinite(v)) && !(Array.isArray(v) && !v.length)) return { v: v as DerivativesSnapshot[K], from: p.venue };
    }
    return { v: null };
  };
  const fr = pick("funding8h");
  const sources = new Set<string>();
  const take = <K extends keyof DerivativesSnapshot>(k: K) => {
    const r = pick(k);
    if (r.from) sources.add(r.from);
    return r.v;
  };
  const primary = parts.find((p) => p.venue === fr.from) ?? parts[0];
  const snapshot: DerivativesSnapshot = {
    venue: primary.venue,
    markPrice: take("markPrice"),
    fundingRate: primary.fundingRate ?? null,
    fundingIntervalHours: primary.fundingIntervalHours ?? null,
    funding8h: take("funding8h"),
    nextFundingTime: take("nextFundingTime"),
    openInterestBase: take("openInterestBase"),
    openInterestUsd: take("openInterestUsd"),
    openInterestChangePct24h: take("openInterestChangePct24h"),
    longShortRatio: take("longShortRatio"),
    longShortSource: take("longShortSource"),
    liquidations24h: liq,
    fundingHistory: take("fundingHistory") ?? [],
  };
  if (liq) sources.add("CoinGlass");
  return { snapshot, sources: [...sources], errors };
}
