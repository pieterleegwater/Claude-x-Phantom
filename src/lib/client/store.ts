"use client";
// Tiny persisted client store (no external dependency). Everything lives in this browser's
// localStorage — no secrets, no private keys. Export/import is available in Settings.
import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type Settings } from "../settings";
import { newPaperState, migratePaper, type PaperState } from "../paper";
import type { TradeSignal } from "../types";

export interface AppNotification {
  id: string;
  key: string; // dedupe key
  time: number;
  type: "setup" | "breakout" | "breakdown" | "meme" | "stop" | "tp" | "risk" | "info";
  title: string;
  body: string;
  href?: string;
  read: boolean;
}

export interface LeaderboardEntry {
  strategyId: string;
  symbol: string;
  tf: string;
  oosExpectancyR: number | null;
  oosTrades: number;
  oosProfitFactor: number | null;
  oosReturnPct: number;
  oosMaxDD: number;
  robustness: number;
  testedAt: number;
}

export interface TicketDraft {
  market: "BTC-PERP" | "BTC-SPOT" | "SOL-MEME";
  asset: string;
  priceKey: string;
  side: "long" | "short";
  stop: number | null;
  takeProfits: { price: number; closePct: number }[];
  leverage: number;
  qty: number | null;
  setup: string;
  signalId?: string;
}

export interface AppState {
  hydrated: boolean;
  settings: Settings;
  paper: PaperState;
  notifications: AppNotification[];
  watchlist: string[]; // memecoin mints
  memeLiquidity: Record<string, { liq: number; t: number }>;
  leaderboard: Record<string, LeaderboardEntry>; // key = strategy:symbol:tf
  signalLog: TradeSignal[];
  ticket: TicketDraft | null;
  aiAccessCode: string;
}

const KEY = "edgepilot:v1";
const initial = (): AppState => ({
  hydrated: false,
  settings: DEFAULT_SETTINGS,
  paper: newPaperState(DEFAULT_SETTINGS.accountEquity),
  notifications: [],
  watchlist: [],
  memeLiquidity: {},
  leaderboard: {},
  signalLog: [],
  ticket: null,
  aiAccessCode: "",
});

let state: AppState = initial();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist() {
  if (typeof window === "undefined" || !state.hydrated) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const { hydrated: _h, ...rest } = state;
      void _h;
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage full or blocked — app keeps working in memory */
    }
  }, 250);
}

export function getState() {
  return state;
}

export function setState(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const patch = typeof update === "function" ? update(state) : update;
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
  persist();
}

export function hydrate() {
  if (state.hydrated) return;
  let loaded: Partial<AppState> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) loaded = JSON.parse(raw);
  } catch {
    /* ignore corrupted storage */
  }
  const base = initial();
  state = {
    ...base,
    ...loaded,
    settings: { ...base.settings, ...(loaded.settings ?? {}), notifications: { ...base.settings.notifications, ...(loaded.settings?.notifications ?? {}) } },
    paper: migratePaper(loaded.paper, base.settings.accountEquity),
    hydrated: true,
  };
  listeners.forEach((l) => l());
  // keep multiple tabs in sync: another tab saved → reload our copy
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const other = JSON.parse(e.newValue) as Partial<AppState>;
      state = mergeLoaded(other);
      listeners.forEach((l) => l());
    } catch {
      /* ignore */
    }
  });
}

function mergeLoaded(loaded: Partial<AppState>): AppState {
  const base = initial();
  return {
    ...base,
    ...loaded,
    settings: { ...base.settings, ...(loaded.settings ?? {}), notifications: { ...base.settings.notifications, ...(loaded.settings?.notifications ?? {}) } },
    paper: migratePaper(loaded.paper, base.settings.accountEquity),
    hydrated: true,
  };
}

const TAB_ID = Math.random().toString(36).slice(2);
const LEADER_KEY = "edgepilot:leader";
/** Simple leader election so only one tab runs the paper-fill simulation. */
export function isLeaderTab(): boolean {
  try {
    const now = Date.now();
    const cur = JSON.parse(localStorage.getItem(LEADER_KEY) || "null") as { id: string; t: number } | null;
    if (!cur || cur.id === TAB_ID || now - cur.t > 25_000) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, t: now }));
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function exportData() {
  const { hydrated: _h, ...rest } = state;
  void _h;
  return JSON.stringify(rest, null, 2);
}

export function importData(json: string) {
  const parsed = JSON.parse(json) as Partial<AppState>;
  if (typeof parsed !== "object" || !parsed) throw new Error("Invalid file");
  state = mergeLoaded(parsed);
  listeners.forEach((l) => l());
  persist();
}

export function resetAll() {
  state = { ...initial(), hydrated: true };
  listeners.forEach((l) => l());
  persist();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const serverState = initial();
export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(serverState),
  );
}

export function notify(n: Omit<AppNotification, "id" | "time" | "read">) {
  const s = getState();
  if (s.notifications.some((x) => x.key === n.key)) return false;
  const item: AppNotification = { ...n, id: Math.random().toString(36).slice(2), time: Date.now(), read: false };
  setState({ notifications: [item, ...s.notifications].slice(0, 200) });
  if (s.settings.notifications.browser && typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(`EdgePilot: ${n.title}`, { body: n.body });
    } catch {
      /* some browsers require a service worker */
    }
  }
  return true;
}

export function logSignal(sig: TradeSignal) {
  const s = getState();
  if (s.signalLog.some((x) => x.id === sig.id)) return;
  setState({ signalLog: [sig, ...s.signalLog].slice(0, 300) });
}
