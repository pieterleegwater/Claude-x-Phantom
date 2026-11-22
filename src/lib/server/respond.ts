import "server-only";
import { NextResponse } from "next/server";
import type { DataMeta } from "../types";
import { rateLimit } from "./rateLimit";

export function ok<T>(data: T, meta: DataMeta, cacheSeconds = 10) {
  return NextResponse.json(
    { ok: true, data, meta },
    { headers: { "Cache-Control": `public, max-age=0, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 3}` } },
  );
}

/** Generic error response — never leaks stack traces or secrets. */
export function fail(message: string, status = 502) {
  const safe = message.replace(/(api[_-]?key|token|secret)=[^&\s]+/gi, "$1=***").slice(0, 600);
  return NextResponse.json({ ok: false, error: safe }, { status, headers: { "Cache-Control": "no-store" } });
}

export function limited(req: Request, bucket: string, limit: number, windowMs = 60_000) {
  const r = rateLimit(req, bucket, limit, windowMs);
  if (r.ok) return null;
  return NextResponse.json({ ok: false, error: `Rate limit exceeded. Try again in ${r.retryAfter}s.` }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
}

export function meta(source: string, dataTimeMs: number | undefined, expectedMaxAgeMs: number, extra: Partial<DataMeta> = {}): DataMeta {
  const now = Date.now();
  return { source, fetchedAt: now, dataTime: dataTimeMs, delayed: dataTimeMs != null ? now - dataTimeMs > expectedMaxAgeMs : false, ...extra };
}
