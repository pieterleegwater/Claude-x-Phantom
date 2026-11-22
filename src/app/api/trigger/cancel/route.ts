import { z } from "zod";
import { NextResponse } from "next/server";
import { isMint } from "@/lib/providers/solana";
import { cancelTriggerOrder } from "@/lib/providers/trigger";
import { fail, limited } from "@/lib/server/respond";

const Body = z.object({ maker: z.string().refine(isMint), order: z.string().refine(isMint) });

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
  try {
    const r = await cancelTriggerOrder(body.data.maker, body.data.order);
    return NextResponse.json({ ok: true, transaction: r.transaction }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Could not cancel order");
  }
}
