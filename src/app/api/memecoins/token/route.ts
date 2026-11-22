import { z } from "zod";
import { tokensByMint, rugcheck, poolCandles, isMint } from "@/lib/providers/solana";
import { cached } from "@/lib/server/cache";
import { ok, fail, limited, meta } from "@/lib/server/respond";

const Q = z.object({ mint: z.string().refine(isMint, "invalid mint"), tf: z.enum(["1m", "5m", "15m", "1h", "4h"]).default("5m") });

export async function GET(req: Request) {
  const rl = limited(req, "token", 40);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("Invalid token address", 400);
  const { mint, tf } = parsed.data;
  try {
    const [t] = await cached(`tok:${mint}`, 15_000, () => tokensByMint([mint]));
    if (!t) return fail("Token not found on DexScreener (Solana)", 404);
    const [risk, candles] = await Promise.all([rugcheck(mint), cached(`gt:${t.pairAddress}:${tf}`, 30_000, () => poolCandles(t.pairAddress, tf)).catch(() => [])]);
    t.risk = risk;
    return ok({ token: t, candles, decimals: risk.decimals ?? null }, meta("DexScreener + RugCheck + GeckoTerminal", Date.now(), 120_000, { note: candles.length ? undefined : "Pool candles unavailable from GeckoTerminal." }), 15);
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Token lookup failed");
  }
}
