// Paper trading simulation engine (pure functions). Uses REAL market prices with VIRTUAL money.
// Every fill here is SIMULATED: market orders fill at the observed price ± configured slippage,
// fees are charged per side, and perpetual positions accrue funding. Real exchange fills differ.
import { liquidationPrice } from "./risk";

export type PaperMarket = "BTC-PERP" | "BTC-SPOT" | "SOL-MEME";

export interface PaperTP {
  price: number;
  closePct: number; // % of INITIAL quantity to close
  hit: boolean;
}

export interface PaperPosition {
  id: string;
  market: PaperMarket;
  asset: string; // "BTC" or token symbol
  priceKey: string; // "BTC" or mint address
  side: "long" | "short";
  initialQty: number;
  qty: number;
  entry: number;
  stop: number;
  initialStop: number;
  takeProfits: PaperTP[];
  leverage: number;
  margin: number; // margin locked for remaining qty
  liqPrice: number | null;
  openedAt: number;
  entryFee: number;
  feesPaid: number;
  fundingPaid: number;
  fundingReported: number; // funding already attributed to fills
  realizedPnl: number;
  setup: string;
  signalId?: string;
  breakevenAfterTp1: boolean;
  lastFundingAt: number;
  lastPrice: number;
  /** ms epoch since which candle highs/lows may trigger stop/TP (open, TP hit or stop change) */
  levelsSince: number;
  /** fees/slippage model fixed at open, so exits are charged consistently */
  cost?: CostModel;
}

export interface PaperFill {
  id: string;
  positionId: string;
  asset: string;
  market: PaperMarket;
  side: "long" | "short";
  qty: number;
  entry: number;
  exit: number;
  pnl: number; // net of exit fee & allocated entry fee & funding
  fees: number;
  funding: number;
  reason: "stop" | "tp1" | "tp2" | "tp3" | "manual" | "liquidation";
  openedAt: number;
  closedAt: number;
  setup: string;
  simulated: true;
}

export interface PaperState {
  startingBalance: number;
  balance: number; // cash incl. realized PnL (margin is not deducted; see available())
  positions: PaperPosition[];
  fills: PaperFill[];
  closedPositions: { id: string; asset: string; market: PaperMarket; side: "long" | "short"; setup: string; pnl: number; openedAt: number; closedAt: number; r: number }[];
  equityHistory: { t: number; equity: number }[];
}

export const newPaperState = (balance = 10_000): PaperState => ({ startingBalance: balance, balance, positions: [], fills: [], closedPositions: [], equityHistory: [{ t: Date.now(), equity: balance }] });

export interface CostModel {
  takerFeeBps: number;
  slippageBps: number;
  mmr: number;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function unrealized(p: PaperPosition, price = p.lastPrice) {
  return (p.side === "long" ? price - p.entry : p.entry - price) * p.qty;
}

export function equity(s: PaperState) {
  return s.balance + s.positions.reduce((t, p) => t + unrealized(p), 0);
}

export function available(s: PaperState) {
  return equity(s) - s.positions.reduce((t, p) => t + p.margin, 0);
}

export interface OpenParams {
  market: PaperMarket;
  asset: string;
  priceKey: string;
  side: "long" | "short";
  qty: number;
  stop: number;
  takeProfits: { price: number; closePct: number }[];
  leverage: number;
  setup: string;
  signalId?: string;
  breakevenAfterTp1?: boolean;
}

export function openPosition(s: PaperState, o: OpenParams, marketPrice: number, cost: CostModel, now = Date.now()): { state: PaperState; error?: string; position?: PaperPosition } {
  if (!(o.qty > 0) || !(marketPrice > 0)) return { state: s, error: "Invalid size or price." };
  if (o.market !== "BTC-PERP" && o.side === "short") return { state: s, error: "Spot and memecoin positions cannot be shorted." };
  const lev = o.market === "BTC-PERP" ? Math.max(1, o.leverage) : 1;
  const slip = cost.slippageBps / 10_000;
  const fill = o.side === "long" ? marketPrice * (1 + slip) : marketPrice * (1 - slip);
  if (o.side === "long" ? o.stop >= fill : o.stop <= fill) return { state: s, error: "Stop-loss must be below entry for longs and above entry for shorts." };
  const notional = fill * o.qty;
  const margin = notional / lev;
  const fee = notional * (cost.takerFeeBps / 10_000);
  if (margin + fee > available(s)) return { state: s, error: `Not enough available balance: need $${(margin + fee).toFixed(2)}, have $${available(s).toFixed(2)}.` };
  const liq = lev > 1 ? liquidationPrice(fill, lev, o.side, cost.mmr) : null;
  if (liq != null && (o.side === "long" ? liq >= o.stop : liq <= o.stop)) return { state: s, error: `At ${lev}x, liquidation (${liq.toFixed(2)}) comes before your stop. Lower the leverage.` };
  const pos: PaperPosition = {
    id: uid(),
    market: o.market,
    asset: o.asset,
    priceKey: o.priceKey,
    side: o.side,
    initialQty: o.qty,
    qty: o.qty,
    entry: fill,
    stop: o.stop,
    initialStop: o.stop,
    takeProfits: o.takeProfits.map((t) => ({ ...t, hit: false })),
    leverage: lev,
    margin,
    liqPrice: liq,
    openedAt: now,
    entryFee: fee,
    feesPaid: fee,
    fundingPaid: 0,
    fundingReported: 0,
    realizedPnl: -fee,
    setup: o.setup,
    signalId: o.signalId,
    breakevenAfterTp1: o.breakevenAfterTp1 ?? true,
    lastFundingAt: now,
    lastPrice: marketPrice,
    levelsSince: now,
    cost,
  };
  return { state: { ...s, balance: s.balance - fee, positions: [...s.positions, pos] }, position: pos };
}

/** Close `qty` of a position at `rawPrice` (slippage applied). Returns new state + fill. */
export function closeQty(s: PaperState, posId: string, qty: number, rawPrice: number, reason: PaperFill["reason"], cost: CostModel, now = Date.now()): { state: PaperState; fill?: PaperFill } {
  const p = s.positions.find((x) => x.id === posId);
  if (!p) return { state: s };
  const q = Math.min(qty, p.qty);
  if (q <= 0) return { state: s };
  cost = p.cost ?? cost;
  const slip = reason === "liquidation" ? 0 : cost.slippageBps / 10_000;
  const px = p.side === "long" ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
  const fee = px * q * (cost.takerFeeBps / 10_000);
  let gross = (p.side === "long" ? px - p.entry : p.entry - px) * q;
  const frac = q / p.qty;
  if (reason === "liquidation") gross = -p.margin * frac; // isolated margin lost
  const pnl = gross - fee; // cash effect (entry fee & funding were already charged)
  const entryFeeAlloc = (p.entryFee * q) / p.initialQty;
  const fundingAlloc = ((p.fundingPaid - p.fundingReported) * q) / p.qty;
  const fill: PaperFill = {
    id: uid(),
    positionId: p.id,
    asset: p.asset,
    market: p.market,
    side: p.side,
    qty: q,
    entry: p.entry,
    exit: px,
    pnl: pnl - entryFeeAlloc - fundingAlloc, // reported net result of this slice
    fees: fee + entryFeeAlloc,
    funding: fundingAlloc,
    reason,
    openedAt: p.openedAt,
    closedAt: now,
    setup: p.setup,
    simulated: true,
  };
  const remaining = p.qty - q;
  const updated: PaperPosition = { ...p, fundingReported: p.fundingReported + fundingAlloc, qty: remaining, margin: p.margin * (1 - frac), feesPaid: p.feesPaid + fee, realizedPnl: p.realizedPnl + pnl, lastPrice: rawPrice };
  let positions = s.positions.map((x) => (x.id === p.id ? updated : x));
  let closedPositions = s.closedPositions;
  if (remaining <= p.initialQty * 1e-9) {
    positions = positions.filter((x) => x.id !== p.id);
    const riskUsd = Math.abs(p.entry - p.initialStop) * p.initialQty;
    closedPositions = [...closedPositions, { id: p.id, asset: p.asset, market: p.market, side: p.side, setup: p.setup, pnl: updated.realizedPnl - updated.fundingPaid, openedAt: p.openedAt, closedAt: now, r: riskUsd > 0 ? (updated.realizedPnl - updated.fundingPaid) / riskUsd : 0 }];
  }
  const balance = s.balance + pnl;
  const next: PaperState = { ...s, balance, positions, fills: [...s.fills, fill], closedPositions };
  return { state: snapshot(next, now, true), fill };
}

export function snapshot(s: PaperState, now = Date.now(), force = false): PaperState {
  const last = s.equityHistory[s.equityHistory.length - 1];
  if (!force && last && now - last.t < 5 * 60_000) return s;
  const hist = [...s.equityHistory, { t: now, equity: equity(s) }];
  return { ...s, equityHistory: hist.length > 3000 ? hist.slice(-3000) : hist };
}

export interface PriceUpdate {
  price: number;
  high?: number; // highest price observed since last update (applied to every position)
  low?: number;
  /** recent candles (time = open, unix s); only candles that START after a position's levelsSince are used */
  candles?: { time: number; high: number; low: number }[];
  funding8h?: number | null;
}

export interface PaperEvent {
  type: "stop" | "tp" | "liquidation";
  title: string;
  body: string;
}

/** Apply new prices: accrue funding, check liquidation, stop-loss and take-profits (stop first if ambiguous). */
export function updatePrices(s: PaperState, prices: Record<string, PriceUpdate>, cost: CostModel, now = Date.now()): { state: PaperState; events: PaperEvent[] } {
  let state = s;
  const events: PaperEvent[] = [];
  for (const p0 of s.positions) {
    const u = prices[p0.priceKey];
    if (!u || !(u.price > 0)) continue;
    let p = state.positions.find((x) => x.id === p0.id);
    if (!p) continue;
    // funding (perps only), charged pro-rata. Gaps (app closed / feed down) are capped at 1h so a
    // reopened app does not charge days of funding at today's rate in one go.
    if (p.market === "BTC-PERP") {
      const hours = Math.min(1, Math.max(0, (now - p.lastFundingAt) / 3_600_000));
      if (u.funding8h != null && hours > 0) {
        const f = p.qty * u.price * u.funding8h * (hours / 8) * (p.side === "long" ? 1 : -1);
        p = { ...p, fundingPaid: p.fundingPaid + f };
        state = { ...state, balance: state.balance - f };
      }
      p = { ...p, lastFundingAt: now };
    }
    p = { ...p, lastPrice: u.price };
    state = { ...state, positions: state.positions.map((x) => (x.id === p!.id ? p! : x)) };

    const since = p.levelsSince ?? p.openedAt;
    const valid = (u.candles ?? []).filter((k) => k.time * 1000 >= since);
    const hi = Math.max(u.high ?? u.price, u.price, ...valid.map((k) => k.high));
    const lo = Math.min(u.low ?? u.price, u.price, ...valid.map((k) => k.low));
    const adverse = p.side === "long" ? lo : hi;
    const favorable = p.side === "long" ? hi : lo;
    // Stop first: a valid stop sits between entry and liquidation, so price must cross it before
    // liquidation. If price has already gapped beyond the stop, fill at the (worse) current price.
    if (p.side === "long" ? adverse <= p.stop : adverse >= p.stop) {
      const fillAt = p.side === "long" ? Math.min(p.stop, u.price) : Math.max(p.stop, u.price);
      const stopIsSafe = p.liqPrice == null || (p.side === "long" ? p.stop > p.liqPrice : p.stop < p.liqPrice);
      if (stopIsSafe) {
        const r = closeQty(state, p.id, p.qty, fillAt, "stop", cost, now);
        state = r.state;
        events.push({ type: "stop", title: `Stop-loss hit: ${p.asset} (paper)`, body: `Closed ${p.side} at ~${fillAt.toPrecision(6)}. PnL ${r.fill ? r.fill.pnl.toFixed(2) : "?"} USD.` });
        continue;
      }
    }
    if (p.liqPrice != null && (p.side === "long" ? adverse <= p.liqPrice : adverse >= p.liqPrice)) {
      state = closeQty(state, p.id, p.qty, p.liqPrice, "liquidation", cost, now).state;
      events.push({ type: "liquidation", title: `${p.asset} position LIQUIDATED (paper)`, body: `Price reached the estimated liquidation level ${p.liqPrice.toFixed(2)}. Margin lost.` });
      continue;
    }
    for (let k = 0; k < p.takeProfits.length; k++) {
      const cur = state.positions.find((x) => x.id === p!.id);
      if (!cur) break;
      const tp = cur.takeProfits[k];
      if (tp.hit) continue;
      const reached = cur.side === "long" ? favorable >= tp.price : favorable <= tp.price;
      if (!reached) break;
      const isLast = cur.takeProfits.slice(k + 1).every((t) => t.hit) || k === cur.takeProfits.length - 1;
      const coversAll = cur.takeProfits.reduce((t, x) => t + x.closePct, 0) >= 99;
      const qty = isLast && coversAll ? cur.qty : Math.min(cur.qty, (cur.initialQty * tp.closePct) / 100);
      const r = closeQty(state, cur.id, qty, tp.price, (["tp1", "tp2", "tp3"][k] ?? "tp3") as PaperFill["reason"], cost, now);
      state = r.state;
      events.push({ type: "tp", title: `Take-profit ${k + 1} hit: ${cur.asset} (paper)`, body: `Closed ${qty.toPrecision(4)} at ~${tp.price.toPrecision(6)}. PnL ${r.fill ? r.fill.pnl.toFixed(2) : "?"} USD.` });
      state = {
        ...state,
        positions: state.positions.map((x) =>
          x.id === cur.id ? { ...x, takeProfits: x.takeProfits.map((t, j) => (j === k ? { ...t, hit: true } : t)), stop: k === 0 && x.breakevenAfterTp1 ? x.entry : x.stop, levelsSince: now } : x,
        ),
      };
    }
  }
  return { state: snapshot(state, now), events };
}

export interface PaperStats {
  equity: number;
  totalPnl: number;
  totalPnlPct: number;
  todayPnl: number;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  closed: number;
  avgR: number | null;
  bySetup: Record<string, { trades: number; pnl: number; wins: number }>;
  feesPaid: number;
  fundingPaid: number;
}

export function stats(s: PaperState, now = Date.now()): PaperStats {
  const eq = equity(s);
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  // equity at the last snapshot before local midnight (or the starting balance for a new account)
  const before = s.equityHistory.filter((h) => h.t < dayStart.getTime());
  const dayStartEquity = before.length ? before[before.length - 1].equity : (s.equityHistory[0]?.equity ?? s.startingBalance);
  const cp = s.closedPositions;
  const wins = cp.filter((c) => c.pnl > 0);
  const gw = wins.reduce((t, c) => t + c.pnl, 0);
  const gl = -cp.filter((c) => c.pnl <= 0).reduce((t, c) => t + c.pnl, 0);
  let peak = s.startingBalance;
  let dd = 0;
  for (const h of [...s.equityHistory, { t: now, equity: eq }]) {
    peak = Math.max(peak, h.equity);
    dd = Math.max(dd, (peak - h.equity) / peak);
  }
  const bySetup: PaperStats["bySetup"] = {};
  for (const c of cp) {
    const b = (bySetup[c.setup] ??= { trades: 0, pnl: 0, wins: 0 });
    b.trades++;
    b.pnl += c.pnl;
    if (c.pnl > 0) b.wins++;
  }
  return {
    equity: eq,
    totalPnl: eq - s.startingBalance,
    totalPnlPct: ((eq - s.startingBalance) / s.startingBalance) * 100,
    todayPnl: eq - dayStartEquity,
    winRate: cp.length ? wins.length / cp.length : null,
    profitFactor: gl > 0 ? gw / gl : cp.length ? (gw > 0 ? Infinity : null) : null,
    maxDrawdownPct: dd * 100,
    closed: cp.length,
    avgR: cp.length ? cp.reduce((t, c) => t + c.r, 0) / cp.length : null,
    bySetup,
    feesPaid: s.fills.reduce((t, f) => t + f.fees, 0),
    fundingPaid: s.fills.reduce((t, f) => t + f.funding, 0) + s.positions.reduce((t, p) => t + (p.fundingPaid - (p.fundingReported ?? 0)), 0),
  };
}

/** Fill fields added in later versions so older saved data never produces NaN. */
export function migratePaper(raw: unknown, fallbackBalance: number): PaperState {
  const base = newPaperState(fallbackBalance);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<PaperState>;
  const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);
  return {
    startingBalance: num(r.startingBalance, base.startingBalance),
    balance: num(r.balance, base.balance),
    fills: Array.isArray(r.fills) ? r.fills : [],
    closedPositions: Array.isArray(r.closedPositions) ? r.closedPositions : [],
    equityHistory: Array.isArray(r.equityHistory) && r.equityHistory.length ? r.equityHistory : base.equityHistory,
    positions: (Array.isArray(r.positions) ? r.positions : []).map((p) => ({
      ...p,
      entryFee: num(p.entryFee, 0),
      feesPaid: num(p.feesPaid, 0),
      fundingPaid: num(p.fundingPaid, 0),
      fundingReported: num(p.fundingReported, 0),
      realizedPnl: num(p.realizedPnl, 0),
      breakevenAfterTp1: p.breakevenAfterTp1 ?? true,
      lastFundingAt: num(p.lastFundingAt, Date.now()),
      lastPrice: num(p.lastPrice, p.entry),
      levelsSince: num(p.levelsSince, Date.now()),
      takeProfits: Array.isArray(p.takeProfits) ? p.takeProfits : [],
    })),
  };
}

/** Manually move the stop to entry. Only allowed while the trade is in profit. */
export function moveStopToBreakeven(s: PaperState, id: string, now = Date.now()): PaperState {
  return { ...s, positions: s.positions.map((p) => (p.id === id && unrealized(p) > 0 ? { ...p, stop: p.entry, levelsSince: now } : p)) };
}
