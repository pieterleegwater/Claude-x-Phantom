import "server-only";
import { timingSafeEqual } from "node:crypto";

/** Admin token for the engine control API (server env ENGINE_ADMIN_TOKEN, ≥ 16 chars). */
export function engineAuth(req: Request): { configured: boolean; ok: boolean } {
  const want = process.env.ENGINE_ADMIN_TOKEN ?? "";
  if (want.length < 16) return { configured: false, ok: false };
  const got = req.headers.get("x-engine-token") ?? "";
  const a = Buffer.from(got), b = Buffer.from(want);
  return { configured: true, ok: a.length === b.length && timingSafeEqual(a, b) };
}
