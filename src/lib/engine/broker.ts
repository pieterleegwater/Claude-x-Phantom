// Broker abstraction + the paper (simulation) broker. The live Hyperliquid broker lives in
// hlBroker.ts. Both expose the same verified operations to the engine.
import type { ClosedTrade, EngineMode, EnginePosition, EngineState, ExecTf } from "./types";
import type { MarketRegime } from "./regime";
import type { AssetInfo, MarketFeed } from "./market";

export interface EntryIntent {
  coin: string;
  asset: AssetInfo;
  side: "long" | "short";
  qty: number;
  refPrice: number;
  stop: number;
  tps: { price: number; pct: number }[];
  leverage: number;
  liqPrice: number | null;
  tf: ExecTf;
  strategyId: string;
  exitProfile: string;
  score: number;
  thesis: string;
  regime: MarketRegime;
}

export interface BrokerResult { s: EngineState; ok: boolean; note: string; critical?: boolean }
export interface FlattenResult extends BrokerResult { confirmed: boolean; report: string[] }

export interface Broker {
  mode: EngineMode;
  equity(s: EngineState, assets: Record<string, AssetInfo>): Promise<number>;
  /** Reconcile/advance positions (fills of stops/targets, funding, liquidation). */
  sync(s: EngineState, feed: MarketFeed, assets: Record<string, AssetInfo>, now: number): Promise<{ s: EngineState; notes: string[] }>;
  open(s: EngineState, intent: EntryIntent, now: number): Promise<BrokerResult>;
  moveStop(s: EngineState, posId: string, stop: number, assets: Record<string, AssetInfo>): Promise<BrokerResult>;
  close(s: EngineState, posId: string, reason: string, assets: Record<string, AssetInfo>, now: number): Promise<BrokerResult>;
  /** STOP ALL: close everything and cancel all orders; confirmed only when the venue shows nothing open. */
  flattenAll(s: EngineState, assets: Record<string, AssetInfo>, now: number): Promise<FlattenResult>;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Book a fully closed position as a trade and update loss-streak bookkeeping. */
export function finalizeTrade(s: EngineState, p: EnginePosition, exitNotional: number, exitQty: number, reason: string, now: number, regime: MarketRegime | null = null): EngineState {
  if (p.exitQty) { exitNotional = p.exitNotional ?? exitNotional; exitQty = p.exitQty; }
  const pnl = p.realizedUsd - p.fundingUsd;
  const riskUsd = p.risk * p.initialQty;
  const t: ClosedTrade = {
    id: p.id, mode: p.mode, coin: p.coin, side: p.side, strategyId: p.strategyId, tf: p.tf, regime, score: p.score,
    entry: p.entry, exitAvg: exitQty > 0 ? exitNotional / exitQty : p.entry, qty: p.initialQty, pnlUsd: pnl,
    r: riskUsd > 0 ? pnl / riskUsd : 0, feesUsd: p.feesUsd, fundingUsd: p.fundingUsd, openedAt: p.openedAt, closedAt: now, reason,
  };
  const loss = pnl < 0;
  return {
    ...s,
    positions: s.positions.filter((x) => x.id !== p.id),
    trades: [t, ...s.trades].slice(0, 2000),
    lossStreak: loss ? s.lossStreak + 1 : 0,
    lastLossAt: loss ? now : s.lastLossAt,
  };
}

// ---------------------------------------------------------------- paper broker
export class PaperBroker implements Broker {
  mode: EngineMode = "paper";
  constructor(private feeBps: number, private slipBps: number) {}

  async equity(s: EngineState) {
    return s.paperCash + s.positions.filter((p) => p.mode === "paper").reduce((t, p) => t + (p.side === "long" ? 1 : -1) * (p.lastPrice - p.entry) * p.qty, 0); // fees & funding are already booked in paperCash
  }

  private realize(s: EngineState, p: EnginePosition, qty: number, rawPx: number, liq = false) {
    const sgn = p.side === "long" ? 1 : -1;
    const px = liq ? rawPx : rawPx * (1 - sgn * this.slipBps / 10_000);
    const fee = liq ? 0 : px * qty * (this.feeBps / 10_000);
    const gross = liq ? -(qty / p.initialQty) * ((p.entry * p.initialQty) / p.leverage) : sgn * (px - p.entry) * qty;
    p.realizedUsd += gross - fee;
    p.feesUsd += fee;
    p.qty -= qty;
    p.exitNotional = (p.exitNotional ?? 0) + px * qty;
    p.exitQty = (p.exitQty ?? 0) + qty;
    s.paperCash += gross - fee;
    return { px, qty };
  }

  async sync(s0: EngineState, feed: MarketFeed, assets: Record<string, AssetInfo>, now: number) {
    let s: EngineState = { ...s0, positions: s0.positions.map((p) => ({ ...p, tps: p.tps.map((t) => ({ ...t })) })), lastCandleCheck: { ...s0.lastCandleCheck } };
    const notes: string[] = [];
    for (const p of s.positions.filter((x) => x.mode === "paper")) {
      const since = Math.max(s.lastCandleCheck[p.id] ?? p.openedAt, now - 6 * 3_600_000);
      let mins = [] as Awaited<ReturnType<MarketFeed["candles"]>>;
      try { mins = (await feed.candles(p.coin, "1m", Math.min(360, Math.ceil((now - since) / 60_000) + 2), now)).filter((k) => k.time * 1000 >= since - 60_000 && k.time * 1000 + 60_000 <= now); } catch { notes.push(`${p.coin}: 1m candles unavailable — paper fills checked on mark price only.`); }
      const mark = assets[p.coin]?.markPx;
      const bars = mins.length ? mins : mark ? [{ time: Math.floor(now / 1000) - 60, open: mark, high: mark, low: mark, close: mark, volume: 0 }] : [];
      const sgn = p.side === "long" ? 1 : -1;
      let exitNotional = 0, exitQty = 0, reason = "";
      // hourly funding (positive funding: longs pay)
      const hrs = (now - p.lastFundingAt) / 3_600_000;
      if (hrs > 0 && assets[p.coin]) {
        const f = p.qty * assets[p.coin].markPx * assets[p.coin].funding * Math.min(hrs, 6) * sgn;
        p.fundingUsd += f; s.paperCash -= f; p.lastFundingAt = now;
      }
      for (const k of bars) {
        if (p.qty <= 0) break;
        const adverse = sgn === 1 ? k.low : k.high, favorable = sgn === 1 ? k.high : k.low;
        // liquidation only when price gaps through the stop AND the liquidation price (the stop sits before liq by design)
        if (p.liqPrice != null && (sgn === 1 ? k.open <= p.liqPrice : k.open >= p.liqPrice)) {
          const r = this.realize(s, p, p.qty, p.liqPrice, true); exitNotional += r.px * r.qty; exitQty += r.qty; reason = "LIQUIDATED (simulated)"; break;
        }
        if (sgn === 1 ? adverse <= p.stop : adverse >= p.stop) {
          const px = sgn === 1 ? Math.min(p.stop, k.open) : Math.max(p.stop, k.open);
          const r = this.realize(s, p, p.qty, px); exitNotional += r.px * r.qty; exitQty += r.qty;
          reason = p.trailingActive ? "trailing stop" : Math.abs(p.stop - p.entry) / p.entry < 0.002 ? "break-even stop" : "stop-loss";
          break;
        }
        for (const tp of p.tps) {
          if (tp.filled || p.qty <= 0) continue;
          if (sgn === 1 ? favorable >= tp.price : favorable <= tp.price) {
            tp.filled = true;
            const last = p.tps.every((x) => x.filled);
            const q = last ? p.qty : Math.min(p.qty, (p.initialQty * tp.pct) / 100);
            const r = this.realize(s, p, q, sgn === 1 ? Math.max(tp.price, k.open) : Math.min(tp.price, k.open)); exitNotional += r.px * r.qty; exitQty += r.qty;
            reason = "take-profit"; notes.push(`${p.coin} TP hit at ${tp.price.toPrecision(6)} (simulated).`);
          } else break;
        }
        p.maxFavorableR = Math.max(p.maxFavorableR, (sgn * (favorable - p.entry)) / p.risk);
        p.lastPrice = k.close;
      }
      s.lastCandleCheck[p.id] = now;
      if (p.qty <= p.initialQty * 1e-9) {
        s = finalizeTrade(s, p, exitNotional, exitQty || 1, reason || "closed", now);
        notes.push(`${p.coin} ${p.side} closed: ${reason} (simulated).`);
      }
    }
    return { s, notes };
  }

  async open(s0: EngineState, x: EntryIntent, now: number): Promise<BrokerResult> {
    const s = { ...s0, positions: [...s0.positions] };
    const sgn = x.side === "long" ? 1 : -1;
    const fill = x.refPrice * (1 + sgn * this.slipBps / 10_000);
    if (sgn * (fill - x.stop) <= 0) return { s: s0, ok: false, note: "Price moved through the stop before entry — skipped." };
    const margin = (fill * x.qty) / x.leverage;
    const used = s.positions.filter((p) => p.mode === "paper").reduce((t, p) => t + (p.entry * p.qty) / p.leverage, 0);
    if (margin > s.paperCash - used) return { s: s0, ok: false, note: "Insufficient simulated margin." };
    const fee = fill * x.qty * (this.feeBps / 10_000);
    s.paperCash -= fee;
    const risk = Math.abs(fill - x.stop);
    s.positions.push({
      id: uid(), mode: "paper", coin: x.coin, side: x.side, qty: x.qty, initialQty: x.qty, entry: fill, stop: x.stop, initialStop: x.stop, risk,
      tps: x.tps.map((t) => ({ price: t.price, pct: t.pct, filled: false })), leverage: x.leverage, liqPrice: x.liqPrice, openedAt: now, barsHeld: 0,
      tf: x.tf, strategyId: x.strategyId, exitProfile: x.exitProfile, score: x.score, thesis: x.thesis, beMoved: false, trailingActive: false,
      feesUsd: fee, fundingUsd: 0, realizedUsd: -fee, lastPrice: x.refPrice, maxFavorableR: 0, lastFundingAt: now,
    });
    return { s, ok: true, note: `SIMULATED ${x.side} ${x.qty} ${x.coin} @ ${fill.toPrecision(6)} (${x.leverage}x), stop ${x.stop.toPrecision(6)}.` };
  }

  async flattenAll(s0: EngineState, assets: Record<string, AssetInfo>, now: number): Promise<FlattenResult> {
    let s = s0;
    const report: string[] = [];
    for (const p of s0.positions.filter((x) => x.mode === "paper")) {
      const r = await this.close(s, p.id, "EMERGENCY STOP", assets, now);
      s = r.s;
      report.push(`${p.coin}: ${r.note}`);
    }
    const left = s.positions.filter((x) => x.mode === "paper").length;
    report.push(left ? `${left} simulated position(s) still open.` : "All simulated positions closed.");
    return { s, ok: left === 0, confirmed: left === 0, note: report.join(" "), report };
  }

  async moveStop(s: EngineState, posId: string, stop: number): Promise<BrokerResult> {
    return { s: { ...s, positions: s.positions.map((p) => (p.id === posId ? { ...p, stop, beMoved: p.beMoved || Math.abs(stop - p.entry) / p.entry < 0.002 } : p)) }, ok: true, note: "stop moved (simulated)" };
  }

  async close(s0: EngineState, posId: string, reason: string, assets: Record<string, AssetInfo>, now: number): Promise<BrokerResult> {
    const s = { ...s0, positions: s0.positions.map((p) => ({ ...p })) };
    const p = s.positions.find((x) => x.id === posId);
    if (!p) return { s: s0, ok: false, note: "position not found" };
    const px = assets[p.coin]?.midPx ?? p.lastPrice;
    const q = p.qty;
    const r = this.realize(s, p, q, px);
    return { s: finalizeTrade(s, p, r.px * r.qty, r.qty, reason, now), ok: true, note: `${p.coin} closed (simulated): ${reason}` };
  }
}
