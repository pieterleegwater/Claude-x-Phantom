"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DataMeta } from "../types";

export interface ApiState<T> {
  data: T | undefined;
  meta: DataMeta | undefined;
  error: string | undefined;
  loading: boolean;
  refresh: () => void;
}

export async function apiGet<T>(url: string, init?: RequestInit): Promise<{ data: T; meta: DataMeta }> {
  const res = await fetch(url, init);
  let j: { ok: boolean; data?: T; meta?: DataMeta; error?: string };
  try {
    j = await res.json();
  } catch {
    throw new Error(`Request failed (HTTP ${res.status})`);
  }
  if (!res.ok || !j.ok) throw new Error(j.error || `Request failed (HTTP ${res.status})`);
  return { data: j.data as T, meta: j.meta as DataMeta };
}

/** Minimal fetch hook with polling and stale-while-revalidate behaviour. */
export function useApi<T>(url: string | null, refreshMs = 0): ApiState<T> {
  const [data, setData] = useState<T>();
  const [meta, setMeta] = useState<DataMeta>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    setLoading(true);
    try {
      const r = await apiGet<T>(u);
      if (urlRef.current !== u) return;
      setData(r.data);
      setMeta(r.meta);
      setError(undefined);
    } catch (e) {
      if (urlRef.current === u) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (urlRef.current === u) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    setMeta(undefined);
    setError(undefined);
    if (!url) return;
    load();
    if (!refreshMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, refreshMs);
    return () => clearInterval(id);
  }, [url, refreshMs, load]);

  return { data, meta, error, loading, refresh: load };
}
