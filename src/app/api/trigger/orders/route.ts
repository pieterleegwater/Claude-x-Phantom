import { z } from "zod";
import { isMint } from "@/lib/providers/solana";
import { getTriggerOrders } from "@/lib/providers/trigger";
import { ok, fail, limited, meta } from "@/lib/server/respond";

const Q = z.object({ user: z.string().refine(isMint), status: z.enum(["active", "history"]).default("active") });

export async function GET(req: Request) {
  const rl = limited(req, "triggerlist", 30);
  if (rl) return rl;
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return fail("Invalid parameters", 400);
  try {
    const orders = await getTriggerOrders(p.data.user, p.data.status);
    return ok(
      orders.map((o) => ({ order: o.orderKey ?? o.order ?? "", inputMint: o.inputMint, outputMint: o.outputMint, makingAmount: o.rawMakingAmount ?? o.makingAmount ?? null, takingAmount: o.rawTakingAmount ?? o.takingAmount ?? null, status: o.status ?? p.data.status, createdAt: o.createdAt ?? null })),
      meta("Jupiter Trigger API", Date.now(), 120_000),
      0,
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Could not load orders");
  }
}
