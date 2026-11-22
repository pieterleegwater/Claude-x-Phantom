import "server-only";

// Per-instance in-memory TTL cache. On serverless platforms each warm instance has its own
// cache; responses are additionally cached at the CDN edge via Cache-Control headers.
const store = new Map<string, { exp: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.value as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn()
    .then((v) => {
      store.set(key, { exp: Date.now() + ttlMs, value: v });
      if (store.size > 500) {
        const now = Date.now();
        for (const [k, e] of store) if (e.exp < now) store.delete(k);
      }
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
