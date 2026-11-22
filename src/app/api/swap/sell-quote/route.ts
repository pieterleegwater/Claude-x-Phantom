import { z } from "zod";
import { jupQuote, solPriceUsd, isMint, SOL_MINT } from "@/lib/providers/solana";
import { ok, fail, limited, meta } from "@/lib/server/respond";

// Read-only SELL preview: token -> SOL. Never builds or signs a transaction.
const Q = z.object({
  inputMint: z.string().refine(isMint),
  amountRaw: z.string().regex(/^[1-9][0-9]{0,30}$/),
  slippageBps: z.coerce.number().int().min(10).max(3000).default(100),
});

export async function GET(req: Request) {
  const rl = limited(req, "sellquote", 40);
  if (rl) return rl;
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return fail("Invalid parameters", 400);
  try {
    const [sol, q] = await Promise.all([solPriceUsd(), jupQuote(p.data.inputMint, SOL_MINT, p.data.amountRaw, p.data.slippageBps)]);
    const outSol = Number(q.outAmount) / 1e9;
    return ok(
      {
        outSol,
        outUsd: outSol * sol.price,
        minOutSol: Number(q.otherAmountThreshold) / 1e9,
        priceImpactPct: Number(q.priceImpactPct) * 100,
        slippageBps: q.slippageBps,
        route: q.routePlan.map((r) => ({ label: r.swapInfo.label ?? "AMM", percent: r.percent })),
        solPriceUsd: sol.price,
      },
      meta(`Jupiter quote API + ${sol.source}`, Date.now(), 30_000, { note: "Quote only — prices move; quotes expire within seconds." }),
      0,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "No sell route found");
  }
}
