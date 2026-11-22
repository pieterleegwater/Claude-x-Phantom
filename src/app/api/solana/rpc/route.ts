import { z } from "zod";
import { NextResponse } from "next/server";
import { fail, limited } from "@/lib/server/respond";

// Read-only JSON-RPC proxy. Keeps a private RPC URL (e.g. Helius with API key) server-side
// and only forwards an allowlist of read methods. Transaction sending is NOT proxied.
const ALLOWED = new Set([
  "getBalance",
  "getAccountInfo",
  "getParsedAccountInfo",
  "getTokenAccountsByOwner",
  "getParsedTokenAccountsByOwner",
  "getTokenAccountBalance",
  "getTokenSupply",
  "getLatestBlockhash",
  "getGenesisHash",
  "getSlot",
  "getBlockHeight",
  "getVersion",
  "getHealth",
  "getMultipleAccounts",
  "getRecentPrioritizationFees",
  "getSignaturesForAddress",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getEpochInfo",
  "getSignatureStatuses",
  "simulateTransaction",
]);

const Single = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), method: z.string(), params: z.array(z.unknown()).optional() });
const Body = z.union([Single, z.array(Single).max(20)]);

export async function POST(req: Request) {
  const rl = limited(req, "rpc", 180);
  if (rl) return rl;
  const raw = await req.text();
  if (raw.length > 64_000) return fail("Request too large", 413);
  let parsed;
  try {
    parsed = Body.safeParse(JSON.parse(raw));
  } catch {
    return fail("Invalid JSON", 400);
  }
  if (!parsed.success) return fail("Invalid JSON-RPC request", 400);
  const calls = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  const bad = calls.find((c) => !ALLOWED.has(c.method));
  if (bad) return fail(`RPC method not allowed: ${bad.method}`, 403);
  const upstream = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  try {
    const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: raw, cache: "no-store" });
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return fail("Solana RPC unreachable");
  }
}
