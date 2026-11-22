import { scanMemecoins } from "@/lib/providers/solana";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

export const maxDuration = 26;

export async function GET(req: Request) {
  const rl = limited(req, "scan", 12);
  if (rl) return rl;
  try {
    const r = await cached("scan", 90_000, () => scanMemecoins());
    return ok({ tokens: r.tokens, candidates: r.candidates }, meta(r.sources.join(", "), Date.now(), 5 * 60_000, { errors: r.errors, note: "DexScreener data is near real-time; RugCheck reports cached up to 5 min. Social momentum is not measured (no reliable free source)." }), 60);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Scan failed");
  }
}
