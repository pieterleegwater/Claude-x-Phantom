// Market data from Hyperliquid (the venue that is actually traded), via the official-API SDK.
// Public info endpoints only — no keys needed.
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import type { Candle } from "../types";
import type { BookLevel } from "./features";
import type { VenueAsset } from "./types";

export type FeedTf = "1m" | "5m" | "15m" | "1h" | "4h";
export const TF_MS: Record<FeedTf, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };

export interface AssetInfo extends VenueAsset { assetIndex: number }

export interface MarketFeed {
  assets(coins: string[]): Promise<Record<string, AssetInfo>>;
  candles(coin: string, tf: FeedTf, bars: number, endMs?: number): Promise<Candle[]>;
  book(coin: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] } | null>;
}

export class HyperliquidFeed implements MarketFeed {
  private info: InfoClient;
  constructor(isTestnet = false, info?: InfoClient) {
    this.info = info ?? new InfoClient({ transport: new HttpTransport({ isTestnet, timeout: 10_000 }) });
  }
  async assets(coins: string[]) {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs();
    const out: Record<string, AssetInfo> = {};
    meta.universe.forEach((u, idx) => {
      if (!coins.includes(u.name)) return;
      const c = ctxs[idx];
      out[u.name] = {
        coin: u.name,
        assetIndex: idx,
        szDecimals: u.szDecimals,
        maxLeverage: u.maxLeverage,
        markPx: Number(c.markPx),
        midPx: Number(c.midPx ?? c.markPx),
        funding: Number(c.funding),
        openInterest: Number(c.openInterest),
        dayNtlVlm: Number(c.dayNtlVlm),
        prevDayPx: Number(c.prevDayPx),
      };
    });
    return out;
  }
  async candles(coin: string, tf: FeedTf, bars: number, endMs = Date.now()) {
    const startTime = endMs - bars * TF_MS[tf];
    const rows = await this.info.candleSnapshot({ coin, interval: tf, startTime, endTime: endMs });
    return rows
      .map((r) => ({ time: Math.floor(r.t / 1000), open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v) }))
      .sort((a, b) => a.time - b.time);
  }
  async book(coin: string) {
    const b = await this.info.l2Book({ coin });
    if (!b) return null;
    const map = (l: { px: string; sz: string }[]) => l.map((x) => ({ px: Number(x.px), sz: Number(x.sz) }));
    return { bids: map(b.levels[0]), asks: map(b.levels[1]) };
  }
}

/** Only fully closed candles (the forming candle is dropped). */
export function closedCandles(c: Candle[], tf: FeedTf, now = Date.now()) {
  if (!c.length) return c;
  return c[c.length - 1].time * 1000 + TF_MS[tf] > now ? c.slice(0, -1) : c;
}
