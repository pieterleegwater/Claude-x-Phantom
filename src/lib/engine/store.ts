// Engine state persistence. Netlify Blobs in production (strongly consistent, ETag-conditional
// writes); a local JSON file in development. No secrets are ever stored here.
import { getStore } from "@netlify/blobs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE_CONFIG, newEngineState, type EngineState } from "./types";

const KEY = "engine-state-v1";
const LOCK = "engine-lock";
const LOCAL = path.join(process.cwd(), ".data", "engine.json");

function blobs() {
  try {
    return getStore({ name: "edgepilot-engine", consistency: "strong" });
  } catch {
    return null; // not running on Netlify (local dev / tests)
  }
}

export interface Loaded { state: EngineState; etag: string | null }

function hydrate(raw: unknown): EngineState {
  const base = newEngineState();
  if (!raw || typeof raw !== "object") return base;
  const s = raw as EngineState;
  // forward-compatible: new config keys get their defaults
  return { ...base, ...s, config: { ...DEFAULT_ENGINE_CONFIG, ...(s.config ?? {}) } };
}

export async function loadState(): Promise<Loaded> {
  const b = blobs();
  if (b) {
    try {
      const r = await b.getWithMetadata(KEY, { type: "json" });
      return { state: hydrate(r?.data), etag: r?.etag ?? null };
    } catch (e) {
      if (!process.env.NETLIFY) return loadLocal();
      throw e;
    }
  }
  return loadLocal();
}

async function loadLocal(): Promise<Loaded> {
  try {
    const txt = await fs.readFile(LOCAL, "utf8");
    return { state: hydrate(JSON.parse(txt)), etag: String(txt.length) + ":" + txt.slice(-32) };
  } catch {
    return { state: newEngineState(), etag: null };
  }
}

/** Conditional save. Returns false when somebody else wrote in between (caller must merge). */
export async function saveState(s: EngineState, etag: string | null): Promise<boolean> {
  const b = blobs();
  if (b && process.env.NETLIFY) {
    const r = etag ? await b.setJSON(KEY, s, { onlyIfMatch: etag }) : await b.setJSON(KEY, s, { onlyIfNew: true });
    return r.modified;
  }
  const cur = await loadLocal();
  if (cur.etag !== etag) return false;
  await fs.mkdir(path.dirname(LOCAL), { recursive: true });
  await fs.writeFile(LOCAL, JSON.stringify(s));
  return true;
}

/** Fields owned by the user (dashboard) that must survive a concurrent engine tick. */
export function mergeControl(tickResult: EngineState, fresh: EngineState): EngineState {
  return { ...tickResult, config: fresh.config, killSwitch: fresh.killSwitch, liveArmed: fresh.liveArmed, halted: fresh.halted === null ? null : tickResult.halted ?? fresh.halted, day: fresh.day.key === "" ? fresh.day : tickResult.day, week: fresh.week.key === "" ? fresh.week : tickResult.week };
}

/** Atomic read-modify-write with retries (used by the control API). */
export async function updateState(fn: (s: EngineState) => EngineState | Promise<EngineState>): Promise<EngineState> {
  for (let i = 0; i < 5; i++) {
    const { state, etag } = await loadState();
    const next = await fn(state);
    if (await saveState(next, etag)) return next;
  }
  throw new Error("State is busy — please retry.");
}

// ---- tick lock (prevents overlapping engine cycles)
const memLock = { at: 0 };
export async function acquireLock(ttlMs = 55_000): Promise<boolean> {
  const b = blobs();
  const now = Date.now();
  if (!(b && process.env.NETLIFY)) {
    if (now - memLock.at < ttlMs) return false;
    memLock.at = now;
    return true;
  }
  const created = await b.setJSON(LOCK, { at: now }, { onlyIfNew: true });
  if (created.modified) return true;
  const cur = await b.getWithMetadata(LOCK, { type: "json" });
  if (cur && now - Number(cur.data?.at ?? 0) > ttlMs && cur.etag) {
    return (await b.setJSON(LOCK, { at: now }, { onlyIfMatch: cur.etag })).modified;
  }
  return false;
}
export async function releaseLock() {
  const b = blobs();
  if (b && process.env.NETLIFY) await b.delete(LOCK).catch(() => {});
  else memLock.at = 0;
}
