import { NextResponse } from "next/server";

// Reports which OPTIONAL integrations are configured (booleans only — never the values).
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      integrations: {
        ai: !!process.env.ANTHROPIC_API_KEY,
        aiModel: process.env.AI_MODEL || "claude-opus-5-5",
        privateSolanaRpc: !!process.env.SOLANA_RPC_URL,
        birdeye: !!process.env.BIRDEYE_API_KEY,
        coinglass: !!process.env.COINGLASS_API_KEY,
        jupiterKey: !!process.env.JUPITER_API_KEY,
        // server flag (builds swap transactions) — the browser flag is baked into the client bundle at build time
        liveExecution: process.env.ENABLE_LIVE_EXECUTION === "true",
      },
      time: Date.now(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
