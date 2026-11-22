import { z } from "zod";
import { getHistory } from "@/lib/providers/market";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

const Q = z.object({
  symbol: z.enum(["BTC", "ETH", "SOL"]).default("BTC"),
  tf: z.enum(["5m", "15m", "1h", "4h", "1d"]).default("1h"),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
});

export async function GET(req: Request) {
  const rl = limited(req, "history", 20);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success || parsed.data.from >= parsed.data.to) return fail("Invalid range", 400);
  const { symbol, tf, from, to } = parsed.data;
  const toC = Math.min(to, Date.now());
  try {
    const r = await cached(`h:${symbol}:${tf}:${Math.floor(from / 3.6e6)}:${Math.floor(toC / 3.6e6)}`, 10 * 60_000, () => getHistory(symbol, tf, from, toC, 10_000));
    const lastT = r.candles[r.candles.length - 1]?.time;
    return ok(r.candles, meta(r.source, lastT ? lastT * 1000 : undefined, Number.MAX_SAFE_INTEGER, { errors: r.errors, note: `Capped at 10,000 candles.` }), 600);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "History request failed");
  }
}
