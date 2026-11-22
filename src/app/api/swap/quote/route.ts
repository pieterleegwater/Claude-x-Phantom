import { z } from "zod";
import { jupQuote, solPriceUsd, isMint, SOL_MINT, rugcheck } from "@/lib/providers/solana";
import { ok, fail, limited, meta } from "@/lib/server/respond";

// Read-only swap PREVIEW. This endpoint never builds, signs or sends a transaction.
const Q = z.object({
  outputMint: z.string().refine(isMint),
  amountUsd: z.coerce.number().positive().max(100_000),
  slippageBps: z.coerce.number().int().min(10).max(5000).default(100),
});

export async function GET(req: Request) {
  const rl = limited(req, "quote", 30);
  if (rl) return rl;
  const parsed = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return fail("Invalid quote parameters", 400);
  const { outputMint, amountUsd, slippageBps } = parsed.data;
  try {
    const sol = await solPriceUsd();
    const lamports = Math.round((amountUsd / sol.price) * 1e9);
    const [buy, risk] = await Promise.all([jupQuote(SOL_MINT, outputMint, String(lamports), slippageBps), rugcheck(outputMint)]);
    // Sellability check: can the received amount be routed back to SOL right now?
    let sell: { ok: boolean; priceImpactPct: number | null; outSol: number | null; error?: string } = { ok: false, priceImpactPct: null, outSol: null };
    try {
      const back = await jupQuote(outputMint, SOL_MINT, buy.outAmount, slippageBps);
      sell = { ok: true, priceImpactPct: Number(back.priceImpactPct) * 100, outSol: Number(back.outAmount) / 1e9 };
    } catch (e) {
      sell = { ok: false, priceImpactPct: null, outSol: null, error: e instanceof Error ? e.message : String(e) };
    }
    const decimals = risk.decimals ?? null;
    return ok(
      {
        inputMint: SOL_MINT,
        outputMint,
        inSol: lamports / 1e9,
        inUsd: amountUsd,
        solPriceUsd: sol.price,
        outAmountRaw: buy.outAmount,
        minOutRaw: buy.otherAmountThreshold,
        decimals,
        priceImpactPct: Number(buy.priceImpactPct) * 100,
        slippageBps: buy.slippageBps,
        route: buy.routePlan.map((r) => ({ label: r.swapInfo.label ?? "AMM", percent: r.percent })),
        // Base fee is 5,000 lamports per signature; priority fees vary with congestion (estimate).
        networkFeeSolEstimate: 0.000005 + 0.0001,
        roundTrip: sell,
        roundTripLossPct: sell.outSol != null ? (1 - sell.outSol / (lamports / 1e9)) * 100 : null,
      },
      meta(`Jupiter quote API + ${sol.source}`, Date.now(), 30_000, { note: "Quote only — no transaction is created. Prices move; quotes expire within seconds." }),
      0,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Quote failed");
  }
}
