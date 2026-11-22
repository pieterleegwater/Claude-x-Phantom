import { z } from "zod";
import { getCandles } from "@/lib/providers/market";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";
import { TF_SECONDS } from "@/lib/types";

const Q = z.object({ symbol: z.enum(["BTC", "ETH", "SOL"]).default("BTC"), tf: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).default("1h"), limit: z.coerce.number().int().min(50).max(1000).default(500) });

export async function GET(req: Request) {
  const rl = limited(req, "candles", 120);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("Invalid query parameters", 400);
  const { symbol, tf, limit } = parsed.data;
  try {
    const r = await cached(`c:${symbol}:${tf}:${limit}`, Math.min(TF_SECONDS[tf] * 250, 30_000), () => getCandles(symbol, tf, limit));
    const lastT = r.candles[r.candles.length - 1]?.time;
    // the newest candle is still forming; data is "delayed" if it is older than 2 intervals
    return ok(r.candles, meta(r.source, lastT ? lastT * 1000 : undefined, TF_SECONDS[tf] * 2000, { errors: r.errors, note: "Last candle may still be forming. Analysis uses closed candles only." }), 10);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Candle request failed");
  }
}
