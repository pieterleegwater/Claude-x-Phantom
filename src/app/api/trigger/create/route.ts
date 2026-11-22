import { z } from "zod";
import { NextResponse } from "next/server";
import { isMint, USDC_MINT } from "@/lib/providers/solana";
import { createTriggerOrder } from "@/lib/providers/trigger";
import { fail, limited } from "@/lib/server/respond";

// Builds an UNSIGNED take-profit (limit sell) order: sell `amountRaw` tokens for at least
// tokens × targetPriceUsd USDC. Output is USDC so the target is a dollar price.
const Body = z.object({
  mint: z.string().refine(isMint),
  amountRaw: z.string().regex(/^[1-9][0-9]{0,30}$/),
  decimals: z.number().int().min(0).max(18),
  targetPriceUsd: z.number().positive(),
  maker: z.string().refine(isMint),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

export async function POST(req: Request) {
  if (process.env.ENABLE_LIVE_EXECUTION !== "true") return fail("Live execution is disabled on this deployment.", 403);
  const rl = limited(req, "trigger", 10);
  if (rl) return rl;
  let body;
  try {
    body = Body.safeParse(await req.json());
  } catch {
    return fail("Invalid JSON", 400);
  }
  if (!body.success) return fail("Invalid parameters", 400);
  const b = body.data;
  const tokens = Number(b.amountRaw) / 10 ** b.decimals;
  const usdcOut = tokens * b.targetPriceUsd;
  if (usdcOut < 5) return fail(`Order value at target is $${usdcOut.toFixed(2)} — Jupiter requires about $5 minimum per trigger order.`, 400);
  const takingAmount = String(Math.floor(usdcOut * 1e6));
  try {
    const r = await createTriggerOrder({ inputMint: b.mint, outputMint: USDC_MINT, maker: b.maker, makingAmount: b.amountRaw, takingAmount, expiredAt: b.expiresInDays ? Math.floor(Date.now() / 1000) + b.expiresInDays * 86400 : undefined });
    if (!r.transaction || !r.order) return fail("Jupiter returned no order transaction.", 502);
    return NextResponse.json({ ok: true, order: r.order, transaction: r.transaction, usdcOut }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Could not create take-profit order");
  }
}
