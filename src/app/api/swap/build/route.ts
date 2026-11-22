import { z } from "zod";
import { NextResponse } from "next/server";
import { jupQuote, solPriceUsd, isMint, SOL_MINT } from "@/lib/providers/solana";
import { fetchJson } from "@/lib/server/http";
import { fail, limited } from "@/lib/server/respond";

// Builds an UNSIGNED swap transaction for the user's wallet to review and sign.
// Disabled unless ENABLE_LIVE_EXECUTION=true on the server (and the matching public flag in
// the browser). The server never holds keys and never signs or sends anything.
//   BUY : SOL -> token, sized in USD          { side: "buy",  outputMint, amountUsd }
//   SELL: token -> SOL, sized in token units  { side: "sell", inputMint, amountRaw }
const Base = { slippageBps: z.number().int().min(10).max(3000), userPublicKey: z.string().refine(isMint) };
const Body = z.discriminatedUnion("side", [
  z.object({ side: z.literal("buy"), outputMint: z.string().refine(isMint), amountUsd: z.number().positive().max(10_000), ...Base }),
  z.object({ side: z.literal("sell"), inputMint: z.string().refine(isMint), amountRaw: z.string().regex(/^[1-9][0-9]{0,30}$/), ...Base }),
]);

export async function POST(req: Request) {
  if (process.env.ENABLE_LIVE_EXECUTION !== "true") return fail("Live execution is disabled on this deployment (ENABLE_LIVE_EXECUTION is not 'true').", 403);
  const rl = limited(req, "build", 15);
  if (rl) return rl;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("Invalid JSON", 400);
  }
  // backwards compatible: old clients sent a buy without "side"
  if (raw && typeof raw === "object" && !("side" in raw)) (raw as Record<string, unknown>).side = "buy";
  const body = Body.safeParse(raw);
  if (!body.success) return fail("Invalid parameters", 400);
  const b = body.data;
  try {
    const sol = await solPriceUsd();
    let quote;
    if (b.side === "buy") {
      const lamports = Math.round((b.amountUsd / sol.price) * 1e9);
      quote = await jupQuote(SOL_MINT, b.outputMint, String(lamports), b.slippageBps);
    } else {
      quote = await jupQuote(b.inputMint, SOL_MINT, b.amountRaw, b.slippageBps);
    }
    const base = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
    const swap = await fetchJson<{ swapTransaction: string; lastValidBlockHeight: number }>("Jupiter", `${base}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {}) },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: b.userPublicKey, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto", wrapAndUnwrapSol: true }),
    });
    return NextResponse.json(
      {
        ok: true,
        side: b.side,
        swapTransaction: swap.swapTransaction,
        lastValidBlockHeight: swap.lastValidBlockHeight,
        solPriceUsd: sol.price,
        quote: { inAmount: quote.inAmount, outAmount: quote.outAmount, minOut: quote.otherAmountThreshold, priceImpactPct: Number(quote.priceImpactPct) * 100 },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Build failed");
  }
}
