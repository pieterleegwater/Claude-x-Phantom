import "server-only";

// Sliding-window rate limiter keyed by client IP + bucket. Best-effort on serverless
// (state is per warm instance) — sufficient to stop accidental hammering of upstream APIs
// and the paid AI endpoint. For hard guarantees, back this with Redis/Upstash.
const hits = new Map<string, number[]>();

export function clientIp(req: Request): string {
  const h = req.headers;
  return (h.get("x-nf-client-connection-ip") || h.get("x-forwarded-for")?.split(",")[0] || h.get("x-real-ip") || "unknown").trim();
}

export function rateLimit(req: Request, bucket: string, limit: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return { ok: false, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => t > now - windowMs)) hits.delete(k);
  return { ok: true, retryAfter: 0 };
}
