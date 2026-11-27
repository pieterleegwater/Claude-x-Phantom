// 24/7 engine heartbeat: Netlify Scheduled Function, every minute (30s execution limit).
import { tick } from "../../src/lib/engine/runtime";

export default async () => {
  const started = Date.now();
  try {
    const r = await tick({ budgetMs: 9000 });
    console.log(`[engine] ran=${r.ran} ${r.why ?? ""} ${Date.now() - started}ms ${r.state?.lastTick?.notes?.slice(0, 3).join(" | ") ?? ""}`);
  } catch (e) {
    console.error("[engine] tick failed", e);
  }
  return new Response("ok");
};

export const config = { schedule: "* * * * *" };
