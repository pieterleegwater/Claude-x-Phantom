import "server-only";

export class UpstreamError extends Error {
  constructor(public provider: string, message: string, public status?: number) {
    super(`${provider}: ${message}`);
  }
}

/** fetch JSON with a timeout and sane error messages. Never forwards client headers upstream. */
export async function fetchJson<T>(provider: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 8000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "EdgePilot/1.0", ...(init.headers ?? {}) },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new UpstreamError(provider, `HTTP ${res.status}${body ? ` — ${body.slice(0, 160)}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    const msg = e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e);
    throw new UpstreamError(provider, msg);
  } finally {
    clearTimeout(timer);
  }
}

/** Try providers in order; return the first success plus the list of failures. */
export async function firstOk<T>(attempts: { name: string; run: () => Promise<T> }[]): Promise<{ value: T; source: string; errors: string[] }> {
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return { value: await a.run(), source: a.name, errors };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new UpstreamError("all providers", errors.join(" | ") || "no providers configured");
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
