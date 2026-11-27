// Failure-mode tests of the LIVE broker against a scripted exchange (tests/fakeHl.ts).
// These prove the broker's protective logic; they do not replace the real testnet run.
import { describe, it, expect } from "vitest";
import { HyperliquidBroker, fmtPx, fmtSz } from "@/lib/engine/hlBroker";
import type { EntryIntent } from "@/lib/engine/broker";
import type { AssetInfo } from "@/lib/engine/market";
import { mergeSmallTargets } from "@/lib/engine/riskGovernor";
import { newEngineState, type EngineState } from "@/lib/engine/types";
import { FakeHl } from "./fakeHl";

const USER = "0x1111111111111111111111111111111111111111" as const;
const now = 1_800_000_000_000;
const ASSETS = (fx: FakeHl): Record<string, AssetInfo> => ({
  BTC: { coin: "BTC", assetIndex: 0, szDecimals: 5, maxLeverage: 40, markPx: fx.mids.BTC, midPx: fx.mids.BTC, funding: 0, openInterest: 1, dayNtlVlm: 1, prevDayPx: fx.mids.BTC },
  ETH: { coin: "ETH", assetIndex: 1, szDecimals: 4, maxLeverage: 25, markPx: fx.mids.ETH, midPx: fx.mids.ETH, funding: 0, openInterest: 1, dayNtlVlm: 1, prevDayPx: fx.mids.ETH },
});
const setup = (equity = 10) => {
  const fx = new FakeHl();
  fx.withdrawable = equity; fx.accountValue = equity;
  const b = new HyperliquidBroker(USER, null, { clients: { info: fx.info, ex: fx.ex }, verifyDelayMs: 0 });
  const s: EngineState = { ...newEngineState(), config: { ...newEngineState().config, mode: "live" } };
  return { fx, b, s, assets: ASSETS(fx) };
};
// $10 account, 0.3% stop: qty 0.00017 BTC ≈ $10.20 notional (what sizePosition produces)
const intent = (a: AssetInfo, over: Partial<EntryIntent> = {}): EntryIntent => ({
  coin: "BTC", asset: a, side: "long", qty: 0.00017, refPrice: 60_000, stop: 59_820, tps: [{ price: 60_180, pct: 40 }, { price: 60_360, pct: 35 }, { price: 60_540, pct: 25 }],
  leverage: 5, liqPrice: 48_600, tf: "15m", strategyId: "ema_trend", exitProfile: "scale_3", score: 86, thesis: "test", regime: "bull_trend", ...over,
});
const stops = (fx: FakeHl) => fx.orders.filter((o) => o.trigger != null && o.reduceOnly);

describe("price/size formatting for the exchange", () => {
  it("never strips significant integer zeros", () => {
    expect(fmtPx(60000, 5)).toBe("60000");
    expect(fmtPx(60000, 6)).toBe("60000");
    expect(fmtPx(3012.5, 4)).toBe("3012.5");
    expect(fmtPx(0.123456789, 0)).toBe("0.12346");
    expect(fmtSz(0.000179, 5)).toBe("0.00017");
  });
});

describe("live broker — happy path", () => {
  it("fills, verifies the position, places + verifies the stop and merges sub-$10 targets", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(true);
    expect(fx.pos.BTC.szi).toBeCloseTo(0.00017);
    const p = r.s.positions[0];
    expect(p.slOid).toBe(stops(fx)[0].oid);
    expect(stops(fx)[0].sz).toBeCloseTo(0.00017);
    // 40%/35% of a $10 position are below the $10 minimum → everything on the last target
    const tpOrders = fx.orders.filter((o) => o.tif === "Gtc");
    expect(tpOrders).toHaveLength(1);
    expect(tpOrders[0].sz).toBeCloseTo(0.00017);
    expect(fx.leverage[0]).toBe(5);
  });
  it("mergeSmallTargets never increases size and keeps 100% in total", () => {
    expect(mergeSmallTargets([{ price: 101, pct: 40 }, { price: 102, pct: 35 }, { price: 103, pct: 25 }], 0.1)).toEqual([{ price: 103, pct: 100 }]);
    expect(mergeSmallTargets([{ price: 101, pct: 40 }, { price: 102, pct: 35 }, { price: 103, pct: 25 }], 1).map((t) => t.pct)).toEqual([40, 35, 25]);
  });
});

describe("live broker — critical failures", () => {
  it("entry fills but the stop cannot be placed → closes at market and verifies flat", async () => {
    const { fx, b, s, assets } = setup();
    fx.failNext("stop", "reject", 2);
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.note).toMatch(/closed at market \(verified flat\)/);
    expect(fx.pos.BTC).toBeUndefined();
    expect(r.s.positions).toHaveLength(0);
  });
  it("stop placed but not visible on the book (verification fails) → treated as missing → flat", async () => {
    const { fx, b, s, assets } = setup();
    fx.hideOrders = true;
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(false);
    expect(fx.pos.BTC).toBeUndefined();
  });
  it("stop fails AND the emergency close fails → stays tracked as UNPROTECTED and is protected next cycle", async () => {
    const { fx, b, s, assets } = setup();
    fx.failNext("stop", "reject", 2);
    fx.failNext("close", "reject", 1);
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.critical).toBe(true);
    expect(fx.pos.BTC).toBeDefined();
    expect(r.s.positions[0].unprotected).toBe(true);
    const sy = await b.sync(r.s, null as never, assets, now + 60_000);
    expect(sy.s.positions[0].unprotected).toBe(false);
    expect(stops(fx)).toHaveLength(1);
  });
  it("exchange accepts the entry but the call times out → verifies on the venue and protects it", async () => {
    const { fx, b, s, assets } = setup();
    fx.failNext("entry", "timeout_after_accept");
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(true);
    expect(r.s.positions).toHaveLength(1);
    expect(stops(fx)).toHaveLength(1);
    expect(r.s.pendingEntry).toBeNull();
  });
  it("timeout AND venue unreachable → pending entry recorded, adopted + protected by the next sync", async () => {
    const { fx, b, s, assets } = setup();
    fx.failNext("entry", "timeout_after_accept");
    const orig = fx.info.clearinghouseState;
    let calls = 0;
    fx.info.clearinghouseState = async (p) => { calls++; if (calls > 1 && calls <= 3) throw new Error("network down"); return orig(p); };
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(false);
    expect(r.critical).toBe(true);
    expect(r.s.pendingEntry?.coin).toBe("BTC");
    expect(stops(fx)).toHaveLength(0); // unprotected on the venue right now
    // a second open must be refused while unverified
    const again = await b.open(r.s, intent(assets.BTC, { coin: "ETH", asset: assets.ETH, refPrice: 3000, stop: 2991, qty: 0.004, tps: [{ price: 3009, pct: 100 }] }), now + 1000);
    expect(again.ok).toBe(false);
    const sy = await b.sync(r.s, null as never, assets, now + 60_000);
    expect(sy.s.positions).toHaveLength(1);
    expect(stops(fx)).toHaveLength(1);
    expect(sy.s.pendingEntry).toBeNull();
    expect(sy.notes.join(" ")).toMatch(/recovery/);
  });
  it("stop modification fails → old stop kept on the exchange and in state", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    const old = r.s.positions[0].slOid;
    fx.failNext("stop", "reject");
    const m = await b.moveStop(r.s, r.s.positions[0].id, 60_010, assets);
    expect(m.ok).toBe(false);
    expect(m.s.positions[0].slOid).toBe(old);
    expect(stops(fx).map((o) => o.oid)).toEqual([old]);
  });
  it("stop modification places the new stop BEFORE cancelling the old one", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    fx.log = [];
    const m = await b.moveStop(r.s, r.s.positions[0].id, 60_010, assets);
    expect(m.ok).toBe(true);
    expect(fx.log[0]).toMatch(/^order stop/);
    expect(fx.log[1]).toMatch(/^cancel/);
    expect(stops(fx)).toHaveLength(1);
    expect(stops(fx)[0].trigger).toBe(60010);
  });
  it("venue size differs from tracked size → reconciled and the stop is resized", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    fx.pos.BTC.szi = 0.0001; // e.g. manual partial close on the exchange
    const sy = await b.sync(r.s, null as never, assets, now + 60_000);
    expect(sy.s.positions[0].qty).toBeCloseTo(0.0001);
    expect(stops(fx)).toHaveLength(1);
    expect(stops(fx)[0].sz).toBeCloseTo(0.0001);
    expect(sy.notes.join(" ")).toMatch(/differs/);
  });
  it("partial fill → tracks the real filled size and sizes the stop to it", async () => {
    const { fx, b, s, assets } = setup();
    fx.fillRatio = 0.6;
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(true);
    expect(r.s.positions[0].qty).toBeCloseTo(0.000102);
    expect(stops(fx)[0].sz).toBeCloseTo(0.000102);
  });
  it("server restart with an open position → state reloaded, sync keeps it protected", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    const persisted = JSON.parse(JSON.stringify(r.s)) as EngineState;
    const b2 = new HyperliquidBroker(USER, null, { clients: { info: fx.info, ex: fx.ex }, verifyDelayMs: 0 });
    const sy = await b2.sync(persisted, null as never, assets, now + 120_000);
    expect(sy.s.positions).toHaveLength(1);
    expect(stops(fx)).toHaveLength(1);
  });
  it("state lost with a position that has NO stop on the exchange → closed at market", async () => {
    const { fx, b, s, assets } = setup();
    fx.pos.BTC = { szi: 0.0002, entryPx: 60_000 };
    const sy = await b.sync(s, null as never, assets, now);
    expect(fx.pos.BTC).toBeUndefined();
    expect(sy.notes.join(" ")).toMatch(/WITHOUT a stop-loss/);
  });
  it("two cycles attempting the same trade → the second is refused (venue already has the position)", async () => {
    const { fx, b, s, assets } = setup(100);
    const r1 = await b.open(s, intent(assets.BTC), now);
    const r2 = await b.open(s, intent(assets.BTC), now); // stale state, as if a parallel cycle
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(fx.pos.BTC.szi).toBeCloseTo(0.00017);
  });
  it("insufficient margin → refused before sending, nothing on the exchange", async () => {
    const { fx, b, s, assets } = setup(1);
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Insufficient free margin/);
    expect(fx.log.filter((l) => l.startsWith("order"))).toHaveLength(0);
  });
  it("exchange-side margin rejection → verified: no position", async () => {
    const { fx, b, s, assets } = setup();
    fx.withdrawable = 10; // pre-check passes…
    fx.leverage[0] = 1;
    const ex = fx.ex.updateLeverage;
    fx.ex.updateLeverage = async () => ({}); // …but the venue still uses 1x
    void ex;
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/Insufficient margin/);
    expect(fx.pos.BTC).toBeUndefined();
  });
  it("below the $10 minimum → skipped without sending (size never increased)", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC, { qty: 0.00015 }), now);
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/below Hyperliquid's \$10 minimum/);
    expect(fx.log.filter((l) => l.startsWith("order"))).toHaveLength(0);
  });
  it("a stop that fills on the exchange is detected and booked from fills", async () => {
    const { fx, b, s, assets } = setup();
    const r = await b.open(s, intent(assets.BTC), now);
    fx.setMid("BTC", 59_800); // through the stop
    const sy = await b.sync(r.s, null as never, assets, now + 60_000);
    expect(sy.s.positions).toHaveLength(0);
    expect(sy.s.trades[0].reason).toBe("stop-loss");
    expect(sy.s.trades[0].pnlUsd).toBeLessThan(0);
    expect(fx.orders).toHaveLength(0); // leftover TP cancelled
  });
  it("info API outage during sync throws (cycle aborts, no trading on unknown state)", async () => {
    const { fx, b, s, assets } = setup();
    fx.infoDown = 2;
    await expect(b.sync(s, null as never, assets, now)).rejects.toThrow(/network/);
  });
  it("one transient info failure is retried", async () => {
    const { fx, b, s, assets } = setup();
    fx.infoDown = 1;
    const r = await b.open(s, intent(assets.BTC), now);
    expect(r.ok).toBe(true);
  });
});

describe("STOP ALL", () => {
  it("closes every position, cancels entry + protective orders and confirms with the exchange", async () => {
    const { fx, b, s, assets } = setup(100);
    const r = await b.open(s, intent(assets.BTC), now);
    fx.orders.push({ oid: 999, coin: "ETH", isBuy: true, px: 2900, sz: 0.01, reduceOnly: false, trigger: null, tif: "Gtc" }); // stray entry order
    fx.pos.ETH = { szi: -0.004, entryPx: 3000 }; // untracked position
    const f = await b.flattenAll(r.s, assets, now + 1000);
    expect(f.confirmed).toBe(true);
    expect(Object.keys(fx.pos)).toHaveLength(0);
    expect(fx.orders).toHaveLength(0);
    expect(f.s.positions).toHaveLength(0);
    expect(f.s.trades[0].reason).toBe("EMERGENCY STOP");
    expect(f.note).toMatch(/0 open positions, 0 open orders/);
  });
  it("does NOT report success when the exchange still shows a position", async () => {
    const { fx, b, s, assets } = setup(100);
    const r = await b.open(s, intent(assets.BTC), now);
    fx.failNext("close", "reject", 5);
    const f = await b.flattenAll(r.s, assets, now + 1000);
    expect(f.confirmed).toBe(false);
    expect(f.ok).toBe(false);
    expect(f.s.positions).toHaveLength(1); // still tracked → retried next cycle
  });
});
