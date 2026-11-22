import { z } from "zod";
import { getTicker } from "@/lib/providers/market";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

const Q = z.object({ symbol: z.enum(["BTC", "ETH", "SOL"]).default("BTC") });

export async function GET(req: Request) {
  const rl = limited(req, "ticker", 240);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("Invalid symbol", 400);
  try {
    const r = await cached(`t:${parsed.data.symbol}`, 4_000, () => getTicker(parsed.data.symbol));
    return ok(r.value, meta(r.source, Date.now(), 60_000, { errors: r.errors }), 3);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Ticker request failed");
  }
}
