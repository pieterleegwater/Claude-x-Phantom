import { z } from "zod";
import { tokensByMint, isMint } from "@/lib/providers/solana";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

const Q = z.object({ mints: z.string().transform((s) => s.split(",").filter(Boolean)).pipe(z.array(z.string().refine(isMint)).min(1).max(30)) });

export async function GET(req: Request) {
  const rl = limited(req, "prices", 120);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("Invalid mints", 400);
  try {
    const key = [...parsed.data.mints].sort().join(",");
    const toks = await cached(`px:${key}`, 8_000, () => tokensByMint(parsed.data.mints));
    const prices = Object.fromEntries(toks.map((t) => [t.mint, { priceUsd: t.priceUsd, symbol: t.symbol, liquidityUsd: t.liquidityUsd, name: t.name, imageUrl: t.imageUrl ?? null }]));
    return ok(prices, meta("DexScreener", Date.now(), 60_000), 8);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Price lookup failed");
  }
}
