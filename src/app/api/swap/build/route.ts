import { z } from "zod";
import { NextResponse } from "next/server";
import { jupQuote, solPriceUsd, isMint, SOL_MINT } from "@/lib/providers/solana";
import { fetchJson } from "@/lib/server/http";
import { fail, limited } from "@/lib/server/respond";

// Builds an UNSIGNED swap transaction for the user's wallet to review and sign.
// Disabled unless ENABLE_LIVE_EXECUTION=true on the server (and the matching public flag in
// the browser). The server never holds keys and never signs or sends anything.
const Body = z.object({
  outputMint: z.string().refine(isMint),
  amountUsd: z.number().positive().max(10_000),
  slippageBps: z.number().int().min(10).max(3000),
  userPublicKey: z.string().refine(isMint),
});

export async function POST(req: Request) {
  if (process.env.ENABLE_LIVE_EXECUTION !== "true") return fail("Live execution is disabled on this deployment (ENABLE_LIVE_EXECUTION is not 'true').", 403);
  const rl = limited(req, "build", 10);
  if (rl) return rl;
  let body;
  try {
    body = Body.safeParse(await req.json());
  } catch {
    return fail("Invalid JSON", 400);
  }
  if (!body.success) return fail("Invalid parameters", 400);
  const { outputMint, amountUsd, slippageBps, userPublicKey } = body.data;
  try {
    const sol = await solPriceUsd();
    const lamports = Math.round((amountUsd / sol.price) * 1e9);
    const quote = await jupQuote(SOL_MINT, outputMint, String(lamports), slippageBps);
    const base = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
    const swap = await fetchJson<{ swapTransaction: string; lastValidBlockHeight: number }>("Jupiter", `${base}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}) },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto", wrapAndUnwrapSol: true }),
    });
    return NextResponse.json({ ok: true, swapTransaction: swap.swapTransaction, lastValidBlockHeight: swap.lastValidBlockHeight, quote: { inAmount: quote.inAmount, outAmount: quote.outAmount, minOut: quote.otherAmountThreshold, priceImpactPct: Number(quote.priceImpactPct) * 100 } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Build failed");
  }
}
