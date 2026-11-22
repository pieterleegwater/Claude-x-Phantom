import { getDerivatives } from "@/lib/providers/market";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

export async function GET(req: Request) {
  const rl = limited(req, "deriv", 60);
  if (rl) return rl;
  try {
    const r = await cached("deriv:BTC", 30_000, () => getDerivatives());
    return ok(r.snapshot, meta(r.sources.join(" + "), Date.now(), 120_000, { errors: r.errors, note: "Funding normalised to an 8-hour period. Liquidation totals require COINGLASS_API_KEY." }), 30);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Derivatives request failed");
  }
}
