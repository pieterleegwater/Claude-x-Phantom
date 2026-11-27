// LIVE broker: Hyperliquid perpetuals through the official API (SDK @nktkas/hyperliquid).
//
// Security model
//  - Uses an API ("agent") wallet approved by the user's master account. Agent wallets can place
//    and cancel orders but CANNOT withdraw funds. The master private key / seed phrase is never
//    requested or stored. The agent key lives only in a server environment variable.
//  - Never constructed unless LIVE_TRADING_ENABLED=true on the server AND the user armed live
//    mode in the dashboard (typed confirmation) — see runtime.ts.
//
// Execution guarantees
//  - Every entry is an IOC limit order with a slippage cap; the position is then read back from
//    clearinghouseState — the engine never assumes a fill.
//  - A reduce-only stop-market trigger is placed immediately and verified in frontendOpenOrders.
//    If the stop cannot be placed/verified, the position is closed at market (emergency protection).
//  - Take-profits are reduce-only GTC limits (partials). Stop moves place the new stop first and
//    only then cancel the old one, so the position is never unprotected.
//  - sync() reconciles local state with the venue every tick (closed by stop/TP/liquidation,
//    partial fills, manual intervention) and books realized PnL from actual fills.
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type { AssetInfo, MarketFeed } from "./market";
import type { Broker, BrokerResult, EntryIntent } from "./broker";
import { finalizeTrade } from "./broker";
import { roundPrice, roundSizeDown } from "./riskGovernor";
import type { EngineMode, EnginePosition, EngineState } from "./types";

const ENTRY_SLIPPAGE_CAP = 0.003; // max 0.3% worse than reference for the IOC entry
const CLOSE_SLIPPAGE_CAP = 0.01; // market-close emergency cap (1%)

export function fmtPx(px: number, szDecimals: number) {
  return roundPrice(px, szDecimals).toFixed(Math.max(0, 6 - szDecimals)).replace(/\.?0+$/, "");
}
export const fmtSz = (q: number, szDecimals: number) => roundSizeDown(q, szDecimals).toFixed(szDecimals);

type Status = { resting?: { oid: number }; filled?: { totalSz: string; avgPx: string; oid: number }; error?: string } | string;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class HyperliquidBroker implements Broker {
  mode: EngineMode = "live";
  private info: InfoClient;
  private ex: ExchangeClient;
  constructor(private user: `0x${string}`, agentKey: `0x${string}`, isTestnet = false) {
    const transport = new HttpTransport({ isTestnet, timeout: 10_000 });
    this.info = new InfoClient({ transport });
    this.ex = new ExchangeClient({ transport, wallet: privateKeyToAccount(agentKey) });
  }

  private async venuePositions() {
    const st = await this.info.clearinghouseState({ user: this.user });
    const pos: Record<string, { szi: number; entryPx: number; liq: number | null }> = {};
    for (const ap of st.assetPositions) {
      const p = ap.position;
      if (Number(p.szi) !== 0) pos[p.coin] = { szi: Number(p.szi), entryPx: Number(p.entryPx), liq: p.liquidationPx ? Number(p.liquidationPx) : null };
    }
    return { pos, equity: Number(st.marginSummary.accountValue), withdrawable: Number(st.withdrawable) };
  }
  private async openOrders() {
    return this.info.frontendOpenOrders({ user: this.user });
  }

  async equity() {
    return (await this.venuePositions()).equity;
  }

  /** Place one order and return the first status. Exchange errors are thrown by the SDK. */
  private async place(o: { a: number; b: boolean; p: string; s: string; r: boolean; t: unknown }): Promise<Status> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await this.ex.order({ orders: [o as any], grouping: "na" });
    return res.response.data.statuses[0] as Status;
  }

  private async placeStop(asset: AssetInfo, side: "long" | "short", qty: number, stop: number) {
    const isBuy = side === "short";
    const trig = fmtPx(stop, asset.szDecimals);
    // limit px for the triggered market order: generous so it fills in fast markets
    const lim = fmtPx(isBuy ? stop * (1 + CLOSE_SLIPPAGE_CAP) : stop * (1 - CLOSE_SLIPPAGE_CAP), asset.szDecimals);
    const st = await this.place({ a: asset.assetIndex, b: isBuy, p: lim, s: fmtSz(qty, asset.szDecimals), r: true, t: { trigger: { isMarket: true, triggerPx: trig, tpsl: "sl" } } });
    const oid = typeof st === "object" ? st.resting?.oid ?? st.filled?.oid : undefined;
    // verify it actually rests on the book
    const oo = await this.openOrders();
    const found = oo.find((o) => o.coin === asset.coin && o.isTrigger && o.reduceOnly && (oid == null || o.oid === oid));
    return found ? found.oid : null;
  }

  private async marketClose(asset: AssetInfo, side: "long" | "short", qty: number) {
    const isBuy = side === "short";
    const px = isBuy ? asset.markPx * (1 + CLOSE_SLIPPAGE_CAP) : asset.markPx * (1 - CLOSE_SLIPPAGE_CAP);
    const st = await this.place({ a: asset.assetIndex, b: isBuy, p: fmtPx(px, asset.szDecimals), s: fmtSz(qty, asset.szDecimals), r: true, t: { limit: { tif: "Ioc" } } });
    if (typeof st === "object" && st.filled) return { ok: true, qty: Number(st.filled.totalSz), px: Number(st.filled.avgPx) };
    return { ok: false, qty: 0, px: 0, note: typeof st === "object" ? st.error ?? JSON.stringify(st) : st };
  }

  private async cancel(asset: AssetInfo, oid: number | null | undefined) {
    if (oid == null) return;
    try { await this.ex.cancel({ cancels: [{ a: asset.assetIndex, o: oid }] }); } catch { /* already gone (filled/cancelled) */ }
  }

  async open(s0: EngineState, x: EntryIntent, now: number): Promise<BrokerResult> {
    const a = x.asset;
    try {
      const before = await this.venuePositions();
      if (before.pos[a.coin]) return { s: s0, ok: false, note: `Venue already has a ${a.coin} position — no duplicate entries.` };
      // isolated margin at the planned leverage
      await this.ex.updateLeverage({ asset: a.assetIndex, isCross: false, leverage: Math.max(1, Math.floor(x.leverage)) });
      const isBuy = x.side === "long";
      const lim = isBuy ? x.refPrice * (1 + ENTRY_SLIPPAGE_CAP) : x.refPrice * (1 - ENTRY_SLIPPAGE_CAP);
      let st: Status;
      try {
        st = await this.place({ a: a.assetIndex, b: isBuy, p: fmtPx(lim, a.szDecimals), s: fmtSz(x.qty, a.szDecimals), r: false, t: { limit: { tif: "Ioc" } } });
      } catch (e) {
        return { s: s0, ok: false, note: `Entry order rejected by the exchange: ${errMsg(e)}` };
      }
      // verify against the venue — never assume a fill
      const after = await this.venuePositions();
      const vp = after.pos[a.coin];
      if (!vp) return { s: s0, ok: false, note: `Entry not filled (IOC within ${ENTRY_SLIPPAGE_CAP * 100}% cap): ${typeof st === "object" ? st.error ?? "no fill" : st}.` };
      const qty = Math.abs(vp.szi);
      const entry = vp.entryPx;
      const side: "long" | "short" = vp.szi > 0 ? "long" : "short";
      // stop must still be on the correct side of the real entry
      const sgn = side === "long" ? 1 : -1;
      let stopOid: number | null = null;
      let stopErr = "";
      if (sgn * (entry - x.stop) > 0) {
        try { stopOid = await this.placeStop(a, side, qty, x.stop); } catch (e) { stopErr = errMsg(e); }
        if (stopOid == null) { try { stopOid = await this.placeStop(a, side, qty, x.stop); } catch (e) { stopErr = errMsg(e); } } // one retry
      } else stopErr = "fill price beyond planned stop";
      if (stopOid == null) {
        const c = await this.marketClose({ ...a, markPx: entry }, side, qty);
        return { s: s0, ok: false, critical: true, note: `EMERGENCY: stop-loss could not be placed/verified (${stopErr || "not found on book"}); position ${c.ok ? "closed at market" : `CLOSE FAILED (${c.note}) — CHECK HYPERLIQUID NOW`}.` };
      }
      // take-profits (reduce-only limits). Failures are not critical: the stop protects the position.
      const tps: EnginePosition["tps"] = [];
      let remaining = qty;
      for (let k = 0; k < x.tps.length; k++) {
        const t = x.tps[k];
        const last = k === x.tps.length - 1;
        const q = last ? remaining : roundSizeDown((qty * t.pct) / 100, a.szDecimals);
        let oid: number | null = null;
        if (q > 0 && q * t.price >= 10) {
          try {
            const r = await this.place({ a: a.assetIndex, b: side === "short", p: fmtPx(t.price, a.szDecimals), s: fmtSz(q, a.szDecimals), r: true, t: { limit: { tif: "Gtc" } } });
            oid = typeof r === "object" ? r.resting?.oid ?? r.filled?.oid ?? null : null;
          } catch { oid = null; }
        }
        remaining = Math.max(0, remaining - q);
        tps.push({ price: t.price, pct: t.pct, filled: false, oid });
      }
      const risk = Math.abs(entry - x.stop);
      const p: EnginePosition = {
        id: uid(), mode: "live", coin: a.coin, side, qty, initialQty: qty, entry, stop: x.stop, initialStop: x.stop, risk, tps, leverage: x.leverage,
        liqPrice: vp.liq, openedAt: now, barsHeld: 0, tf: x.tf, strategyId: x.strategyId, exitProfile: x.exitProfile, score: x.score, thesis: x.thesis,
        beMoved: false, trailingActive: false, feesUsd: 0, fundingUsd: 0, realizedUsd: 0, lastPrice: entry, maxFavorableR: 0, slOid: stopOid, lastFundingAt: now,
      };
      const tpNote = tps.some((t) => t.oid == null) ? " (some TP orders below the $10 minimum or rejected — managed by the stop/trailing logic)" : "";
      return { s: { ...s0, positions: [...s0.positions, p] }, ok: true, note: `LIVE ${side} ${qty} ${a.coin} filled @ ${entry} (verified), stop ${x.stop} verified on book (oid ${stopOid})${tpNote}.` };
    } catch (e) {
      return { s: s0, ok: false, critical: true, note: `Live entry error: ${errMsg(e)} — position state will be reconciled on the next tick.` };
    }
  }

  async moveStop(s0: EngineState, posId: string, stop: number, assets: Record<string, AssetInfo>): Promise<BrokerResult> {
    const p = s0.positions.find((x) => x.id === posId);
    const a = p && assets[p.coin];
    if (!p || !a) return { s: s0, ok: false, note: "position/asset not found" };
    try {
      const oid = await this.placeStop(a, p.side, p.qty, stop); // new first…
      if (oid == null) return { s: s0, ok: false, note: "new stop not verified — old stop kept" };
      await this.cancel(a, p.slOid); // …then remove the old one
      return { s: { ...s0, positions: s0.positions.map((x) => (x.id === posId ? { ...x, stop, slOid: oid } : x)) }, ok: true, note: `stop moved to ${stop} (verified)` };
    } catch (e) {
      return { s: s0, ok: false, note: `stop move failed: ${errMsg(e)} — old stop kept` };
    }
  }

  async close(s0: EngineState, posId: string, reason: string, assets: Record<string, AssetInfo>, now: number): Promise<BrokerResult> {
    const p = s0.positions.find((x) => x.id === posId);
    const a = p && assets[p.coin];
    if (!p || !a) return { s: s0, ok: false, note: "position/asset not found" };
    try {
      const v = (await this.venuePositions()).pos[p.coin];
      if (v) {
        const c = await this.marketClose(a, p.side, Math.abs(v.szi));
        if (!c.ok) return { s: s0, ok: false, critical: true, note: `market close failed: ${c.note}` };
        const still = (await this.venuePositions()).pos[p.coin];
        if (still) return { s: s0, ok: false, critical: true, note: `close partially filled — ${still.szi} ${p.coin} still open; retrying next tick` };
      }
      // clean up resting reduce-only orders for this coin
      const oo = await this.openOrders();
      for (const o of oo.filter((o) => o.coin === p.coin && o.reduceOnly)) await this.cancel(a, o.oid);
      const s = await this.bookFills(s0, p, now);
      return { s: finalizeTrade(s.s, s.p, 0, 0, reason, now), ok: true, note: `${p.coin} closed on Hyperliquid (verified flat): ${reason}` };
    } catch (e) {
      return { s: s0, ok: false, critical: true, note: `close error: ${errMsg(e)}` };
    }
  }

  /** Book realized PnL, fees and exit prices from actual venue fills since the position opened. */
  private async bookFills(s: EngineState, p0: EnginePosition, now: number) {
    const p = { ...p0 };
    try {
      const fills = await this.info.userFillsByTime({ user: this.user, startTime: p.openedAt - 5_000, endTime: now + 60_000 });
      const mine = fills.filter((f) => f.coin === p.coin);
      const closing = mine.filter((f) => Number(f.closedPnl) !== 0 || /^Close/.test(f.dir));
      p.feesUsd = mine.reduce((t, f) => t + Number(f.fee), 0);
      p.realizedUsd = closing.reduce((t, f) => t + Number(f.closedPnl), 0) - p.feesUsd;
      p.exitQty = closing.reduce((t, f) => t + Number(f.sz), 0);
      p.exitNotional = closing.reduce((t, f) => t + Number(f.sz) * Number(f.px), 0);
      // funding payments
      const fund = await this.info.userFunding({ user: this.user, startTime: p.openedAt, endTime: now });
      p.fundingUsd = -fund.filter((f) => f.delta.coin === p.coin).reduce((t, f) => t + Number(f.delta.usdc), 0);
    } catch { /* fills unavailable: PnL recorded as unknown-at-close (0) */ }
    return { s, p };
  }

  async sync(s0: EngineState, _feed: MarketFeed, assets: Record<string, AssetInfo>, now: number) {
    let s = s0;
    const notes: string[] = [];
    const live = s.positions.filter((p) => p.mode === "live");
    const { pos } = await this.venuePositions();
    for (const coin of Object.keys(pos)) if (!live.some((p) => p.coin === coin)) notes.push(`EMERGENCY check: untracked ${coin} position on Hyperliquid (opened manually or state lost) — the engine will not trade ${coin} until it is closed. Verify its stop on Hyperliquid.`);
    if (!live.length) return { s, notes };
    const oo = await this.openOrders();
    for (const p of live) {
      const v = pos[p.coin];
      const a = assets[p.coin];
      if (!v) {
        // flat on the venue: closed by stop, final TP, liquidation or manually
        for (const o of oo.filter((o) => o.coin === p.coin && o.reduceOnly)) if (a) await this.cancel(a, o.oid);
        const b = await this.bookFills(s, p, now);
        const slFilled = p.slOid != null && !oo.some((o) => o.oid === p.slOid);
        const reason = slFilled ? (p.trailingActive ? "trailing stop" : p.beMoved ? "break-even stop" : "stop-loss") : "closed on venue";
        s = finalizeTrade(b.s, b.p, 0, 0, reason, now);
        notes.push(`${p.coin} ${p.side} closed on Hyperliquid: ${reason} (verified from fills).`);
        continue;
      }
      const qty = Math.abs(v.szi);
      const tps = p.tps.map((t) => ({ ...t, filled: t.filled || (t.oid != null && !oo.some((o) => o.oid === t.oid)) }));
      const newlyFilled = tps.filter((t, k) => t.filled && !p.tps[k].filled);
      for (const t of newlyFilled) notes.push(`${p.coin} take-profit filled at ${t.price} (verified).`);
      let slOid = p.slOid;
      // the stop must always exist and cover the current size
      const sl = oo.find((o) => o.oid === slOid);
      if (a && (!sl || Math.abs(Number(sl.sz) - qty) > 10 ** -a.szDecimals / 2)) {
        try {
          const n = await this.placeStop(a, p.side, qty, p.stop);
          if (n != null) { if (sl) await this.cancel(a, sl.oid); slOid = n; notes.push(`${p.coin}: stop re-synced to ${qty} @ ${p.stop}.`); }
          else throw new Error("not verified");
        } catch (e) {
          const c = await this.marketClose(a, p.side, qty);
          notes.push(`EMERGENCY ${p.coin}: stop missing and could not be restored (${errMsg(e)}); ${c.ok ? "closed at market" : "CLOSE FAILED — CHECK HYPERLIQUID"}.`);
        }
      }
      s = { ...s, positions: s.positions.map((x) => (x.id === p.id ? { ...x, qty, tps, slOid, liqPrice: v.liq, lastPrice: a?.markPx ?? x.lastPrice, maxFavorableR: Math.max(x.maxFavorableR, ((p.side === "long" ? 1 : -1) * ((a?.markPx ?? x.lastPrice) - x.entry)) / x.risk) } : x)) };
    }
    return { s, notes };
  }
}
