import { NextResponse } from "next/server";
import { loadState } from "@/lib/engine/store";
import { liveEnv } from "@/lib/engine/runtime";
import { engineAuth } from "@/lib/server/engineAuth";
import { limited } from "@/lib/server/respond";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rl = limited(req, "engine-state", 60);
  if (rl) return rl;
  const auth = engineAuth(req);
  if (!auth.configured && liveEnv().enabled) return NextResponse.json({ ok: false, error: "LIVE_TRADING_ENABLED is set but ENGINE_ADMIN_TOKEN is missing — the engine refuses to expose or run live without it." }, { status: 403 });
  if (auth.configured && !auth.ok) return NextResponse.json({ ok: false, error: "Engine token required.", needsToken: true }, { status: 401 });
  try {
    const { state } = await loadState();
    const env = liveEnv();
    return NextResponse.json(
      {
        ok: true,
        state,
        env: {
          adminConfigured: auth.configured,
          liveEnabled: env.enabled,
          liveConfigured: env.configured,
          testnet: env.testnet,
          account: env.user ? `${env.user.slice(0, 6)}…${env.user.slice(-4)}` : null,
        },
        serverTime: Date.now(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: `State unavailable: ${e instanceof Error ? e.message : e}` }, { status: 500 });
  }
}
