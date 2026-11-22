// Live (real-money) position tracking. Pure functions — no signing, no network.
// Positions are built from trades executed through EdgePilot, plus manual "track" entries for
// tokens bought elsewhere. The connected wallet's balance is the source of truth: if it drops
// below the tracked amount (sold in Phantom, or a Jupiter take-profit order filled) the
// difference is recorded as a sell at an estimated price.

export interface LiveTP {
  price: number; // USD
  pct: number; // % of the position's tokens to sell
  status: "planned" | "order" | "done";
  order?: string; // Jupiter trigger order account when placed on-chain
}

export interface LivePosition {
  mint: string;
  symbol: string;
  decimals: number | null;
  tokens: number; // tracked amount still held
  investedUsd: number; // cost basis of the tokens still held
  entryPrice: number; // average USD per token
  realizedUsd: number; // realised PnL so far
  openedAt: number;
  closedAt?: number;
  stop: number | null; // USD price
  tps: LiveTP[];
  source: "edgepilot" | "manual";
  owner?: string; // wallet address that holds the position
}

export interface LiveTrade {
  id: string;
  sig: string | null;
  mint: string;
  symbol: string;
  side: "buy" | "sell";
  tokens: number;
  usd: number;
  price: number;
  time: number;
  pnlUsd: number | null; // realised PnL for sells
  note?: string; // e.g. "estimated — sold outside EdgePilot"
  status: "confirmed" | "unconfirmed";
}

export interface LiveState {
  positions: LivePosition[];
  trades: LiveTrade[];
}

export const emptyLive = (): LiveState => ({ positions: [], trades: [] });
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const DUST = 1e-9;

export function openPositions(s: LiveState) {
  return s.positions.filter((p) => !p.closedAt);
}

export function recordBuy(s: LiveState, b: { mint: string; symbol: string; decimals: number | null; tokens: number; usd: number; sig: string | null; time?: number; status?: LiveTrade["status"]; source?: LivePosition["source"]; note?: string; owner?: string }): LiveState {
  if (!(b.tokens > 0) || !(b.usd >= 0)) return s;
  const time = b.time ?? Date.now();
  const price = b.usd / b.tokens;
  const trade: LiveTrade = { id: uid(), sig: b.sig, mint: b.mint, symbol: b.symbol, side: "buy", tokens: b.tokens, usd: b.usd, price, time, pnlUsd: null, status: b.status ?? "confirmed", note: b.note };
  const cur = s.positions.find((p) => p.mint === b.mint && !p.closedAt);
  let positions: LivePosition[];
  if (cur) {
    const tokens = cur.tokens + b.tokens;
    const invested = cur.investedUsd + b.usd;
    positions = s.positions.map((p) => (p === cur ? { ...p, tokens, investedUsd: invested, entryPrice: invested / tokens, decimals: p.decimals ?? b.decimals } : p));
  } else {
    positions = [...s.positions, { mint: b.mint, symbol: b.symbol, decimals: b.decimals, tokens: b.tokens, investedUsd: b.usd, entryPrice: price, realizedUsd: 0, openedAt: time, stop: null, tps: [], source: b.source ?? "edgepilot", owner: b.owner }];
  }
  return { positions, trades: [trade, ...s.trades].slice(0, 1000) };
}

export function recordSell(s: LiveState, x: { mint: string; tokens: number; usd: number; sig: string | null; time?: number; status?: LiveTrade["status"]; note?: string }): LiveState {
  const cur = s.positions.find((p) => p.mint === x.mint && !p.closedAt);
  if (!cur || !(x.tokens > 0)) return s;
  const time = x.time ?? Date.now();
  const qty = Math.min(x.tokens, cur.tokens);
  const usd = x.tokens > 0 ? (x.usd * qty) / x.tokens : 0;
  const cost = cur.entryPrice * qty;
  const pnl = usd - cost;
  const remaining = cur.tokens - qty;
  const closed = remaining <= cur.tokens * 1e-6 || remaining < DUST;
  const updated: LivePosition = {
    ...cur,
    tokens: closed ? 0 : remaining,
    investedUsd: closed ? 0 : cur.investedUsd - cost,
    realizedUsd: cur.realizedUsd + pnl,
    closedAt: closed ? time : undefined,
  };
  const trade: LiveTrade = { id: uid(), sig: x.sig, mint: x.mint, symbol: cur.symbol, side: "sell", tokens: qty, usd, price: qty > 0 ? usd / qty : 0, time, pnlUsd: pnl, status: x.status ?? "confirmed", note: x.note };
  return { positions: s.positions.map((p) => (p === cur ? updated : p)), trades: [trade, ...s.trades].slice(0, 1000) };
}

/**
 * Compare tracked amounts with the wallet. If the wallet holds less than tracked, record the
 * difference as a sell — at the take-profit price if an on-chain TP order was placed and the
 * price is at/above it, otherwise at the current price (marked as estimated).
 */
export function reconcile(s: LiveState, balances: Record<string, number>, prices: Record<string, number>, time = Date.now(), owner?: string): { state: LiveState; changed: string[] } {
  let state = s;
  const changed: string[] = [];
  for (const p of openPositions(s)) {
    if (owner && p.owner && p.owner !== owner) continue; // different wallet connected — never treat as sold
    const bal = balances[p.mint];
    if (bal == null) continue; // unknown balance (e.g. wallet not loaded) — never guess
    if (bal >= p.tokens * 0.995) continue;
    const diff = p.tokens - bal;
    const price = prices[p.mint];
    const tpOrder = p.tps.find((t) => t.status === "order" && price != null && price >= t.price * 0.97);
    const px = tpOrder ? tpOrder.price : price;
    if (px == null || !Number.isFinite(px)) continue;
    state = recordSell(state, { mint: p.mint, tokens: diff, usd: diff * px, sig: null, time, note: tpOrder ? "Jupiter take-profit order (price estimated at target)" : "Sold outside EdgePilot (price estimated)" });
    if (tpOrder) state = { ...state, positions: state.positions.map((q) => (q.mint === p.mint ? { ...q, tps: q.tps.map((t) => (t === tpOrder ? { ...t, status: "done" as const } : t)) } : q)) };
    changed.push(p.symbol);
  }
  return { state, changed };
}

export function setLevels(s: LiveState, mint: string, levels: { stop?: number | null; tps?: LiveTP[] }): LiveState {
  return { ...s, positions: s.positions.map((p) => (p.mint === mint && !p.closedAt ? { ...p, ...("stop" in levels ? { stop: levels.stop ?? null } : {}), ...(levels.tps ? { tps: levels.tps } : {}) } : p)) };
}

export function removePosition(s: LiveState, mint: string): LiveState {
  return { ...s, positions: s.positions.filter((p) => !(p.mint === mint && !p.closedAt)) };
}

export interface LiveStats {
  openCount: number;
  investedOpen: number;
  valueOpen: number;
  unrealized: number;
  realized: number;
  totalPnl: number;
  closedCount: number;
  wins: number;
  winRate: number | null;
  best: { symbol: string; pnl: number } | null;
  worst: { symbol: string; pnl: number } | null;
}

export function liveStats(s: LiveState, prices: Record<string, number>, balances: Record<string, number> = {}): LiveStats {
  const open = openPositions(s);
  const closed = s.positions.filter((p) => p.closedAt);
  let value = 0;
  let invested = 0;
  for (const p of open) {
    const qty = balances[p.mint] != null ? Math.min(balances[p.mint], p.tokens) : p.tokens;
    const px = prices[p.mint];
    invested += p.investedUsd;
    value += px != null ? qty * px : p.investedUsd; // unknown price → show at cost, not as profit/loss
  }
  const realized = s.positions.reduce((t, p) => t + p.realizedUsd, 0);
  const wins = closed.filter((p) => p.realizedUsd > 0).length;
  const sorted = [...closed].sort((a, b) => b.realizedUsd - a.realizedUsd);
  return {
    openCount: open.length,
    investedOpen: invested,
    valueOpen: value,
    unrealized: value - invested,
    realized,
    totalPnl: value - invested + realized,
    closedCount: closed.length,
    wins,
    winRate: closed.length ? wins / closed.length : null,
    best: sorted[0] ? { symbol: sorted[0].symbol, pnl: sorted[0].realizedUsd } : null,
    worst: sorted.length ? { symbol: sorted[sorted.length - 1].symbol, pnl: sorted[sorted.length - 1].realizedUsd } : null,
  };
}

/** Which levels does the current price breach? Only planned (not on-chain) TPs are alerted. */
export function triggeredLevels(p: LivePosition, price: number): { kind: "stop" | "tp"; price: number; pct: number; index?: number } | null {
  if (p.stop != null && price <= p.stop) return { kind: "stop", price: p.stop, pct: 100 };
  const i = p.tps.findIndex((t) => t.status === "planned" && price >= t.price);
  if (i >= 0) return { kind: "tp", price: p.tps[i].price, pct: p.tps[i].pct, index: i };
  return null;
}
