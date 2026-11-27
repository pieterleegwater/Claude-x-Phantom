// TEST-ONLY scripted Hyperliquid exchange. Mimics the API semantics the broker relies on
// (IOC/GTC/trigger orders, reduce-only, $10 minimum, margin check, positions, open orders) and
// lets tests inject failures: rejections, timeouts after acceptance, hidden orders, partial fills.
// It is NOT a substitute for the real testnet run in scripts/hl-testnet-validate.ts.
import type { HlExchange, HlInfo } from "@/lib/engine/hlBroker";

type Order = { oid: number; coin: string; isBuy: boolean; px: number; sz: number; reduceOnly: boolean; trigger: number | null; tif: string };
type Fail = "reject" | "timeout_after_accept" | "throw";
export type Kind = "entry" | "stop" | "tp" | "close";

export class FakeHl {
  coins = ["BTC", "ETH", "SOL"];
  mids: Record<string, number> = { BTC: 60_000, ETH: 3_000, SOL: 150 };
  pos: Record<string, { szi: number; entryPx: number }> = {};
  orders: Order[] = [];
  fills: { coin: string; px: string; sz: string; fee: string; closedPnl: string; dir: string; oid: number; time: number }[] = [];
  withdrawable = 10;
  accountValue = 10;
  leverage: Record<number, number> = {};
  fillRatio = 1; // < 1 => partial IOC fills
  failures: { kind: Kind; mode: Fail; times: number }[] = [];
  hideOrders = false; // frontendOpenOrders omits everything (verification failure)
  infoDown = 0; // next N info calls throw
  log: string[] = [];
  private nextOid = 1;

  failNext(kind: Kind, mode: Fail, times = 1) { this.failures.push({ kind, mode, times }); }
  private takeFailure(kind: Kind): Fail | null {
    const f = this.failures.find((x) => x.kind === kind && x.times > 0);
    if (!f) return null;
    f.times--;
    return f.mode;
  }
  private infoGuard() { if (this.infoDown > 0) { this.infoDown--; throw new Error("fetch failed (network)"); } }

  private applyFill(coin: string, isBuy: boolean, sz: number, px: number, oid: number) {
    const cur = this.pos[coin] ?? { szi: 0, entryPx: px };
    const d = isBuy ? sz : -sz;
    const closing = cur.szi !== 0 && Math.sign(d) !== Math.sign(cur.szi);
    const closedPnl = closing ? Math.min(Math.abs(d), Math.abs(cur.szi)) * (px - cur.entryPx) * Math.sign(cur.szi) : 0;
    const szi = +(cur.szi + d).toFixed(10);
    const entryPx = !closing && cur.szi !== 0 ? (cur.entryPx * Math.abs(cur.szi) + px * sz) / Math.abs(szi) : closing ? cur.entryPx : px;
    if (szi === 0) delete this.pos[coin];
    else this.pos[coin] = { szi, entryPx };
    this.fills.push({ coin, px: String(px), sz: String(sz), fee: String(px * sz * 0.00045), closedPnl: String(closedPnl), dir: closing ? `Close ${cur.szi > 0 ? "Long" : "Short"}` : `Open ${isBuy ? "Long" : "Short"}`, oid, time: Date.now() });
  }

  /** Move the market; resting triggers/limits fire like the exchange would. */
  setMid(coin: string, px: number) {
    this.mids[coin] = px;
    for (const o of [...this.orders]) {
      if (o.coin !== coin) continue;
      const p = this.pos[coin];
      const hit = o.trigger != null ? (o.isBuy ? px >= o.trigger : px <= o.trigger) : o.isBuy ? px <= o.px : px >= o.px;
      if (!hit) continue;
      this.orders = this.orders.filter((x) => x.oid !== o.oid);
      if (o.reduceOnly && (!p || (o.isBuy ? p.szi > 0 : p.szi < 0))) continue;
      const sz = o.reduceOnly && p ? Math.min(o.sz, Math.abs(p.szi)) : o.sz;
      this.applyFill(coin, o.isBuy, sz, o.trigger != null ? px : o.px, o.oid);
    }
  }

  info: HlInfo = {
    clearinghouseState: async () => {
      this.infoGuard();
      return {
        assetPositions: Object.entries(this.pos).map(([coin, p]) => ({ position: { coin, szi: String(p.szi), entryPx: String(p.entryPx), liquidationPx: String(p.szi > 0 ? p.entryPx * 0.85 : p.entryPx * 1.15) } })),
        marginSummary: { accountValue: String(this.accountValue) },
        withdrawable: String(this.withdrawable),
      };
    },
    frontendOpenOrders: async () => {
      this.infoGuard();
      if (this.hideOrders) return [];
      return this.orders.map((o) => ({ coin: o.coin, oid: o.oid, sz: String(o.sz), isTrigger: o.trigger != null, reduceOnly: o.reduceOnly, triggerPx: String(o.trigger ?? 0), side: o.isBuy ? "B" : "A", limitPx: String(o.px) }));
    },
    allMids: async () => { this.infoGuard(); return Object.fromEntries(Object.entries(this.mids).map(([k, v]) => [k, String(v)])); },
    userFillsByTime: async () => { this.infoGuard(); return this.fills; },
    userFunding: async () => { this.infoGuard(); return []; },
  };

  ex: HlExchange = {
    updateLeverage: async (p) => { this.leverage[p.asset] = p.leverage; return { status: "ok" }; },
    cancel: async (p) => {
      for (const c of p.cancels) {
        const had = this.orders.some((o) => o.oid === c.o);
        this.orders = this.orders.filter((o) => o.oid !== c.o);
        this.log.push(`cancel ${c.o}${had ? "" : " (missing)"}`);
        if (!had) throw new Error("Order was never placed, already canceled, or filled.");
      }
      return { status: "ok" };
    },
    order: async (p) => {
      const o = p.orders[0] as { a: number; b: boolean; p: string; s: string; r: boolean; t: { limit?: { tif: string }; trigger?: { triggerPx: string; tpsl: string } } };
      const coin = this.coins[o.a];
      const px = Number(o.p), sz = Number(o.s);
      const kind: Kind = o.t.trigger ? "stop" : o.r && o.t.limit?.tif === "Gtc" ? "tp" : o.r ? "close" : "entry";
      this.log.push(`order ${kind} ${coin} ${o.b ? "buy" : "sell"} ${o.s}@${o.p}${o.t.trigger ? ` trig ${o.t.trigger.triggerPx}` : ""}`);
      const fail = this.takeFailure(kind);
      if (fail === "throw") throw new Error("Request timed out (network)");
      if (fail === "reject") return { response: { data: { statuses: [{ error: `Injected rejection (${kind})` }] } } };
      const oid = this.nextOid++;
      let status: unknown;
      const mid = this.mids[coin];
      if (!o.r && sz * mid < 10) status = { error: "Order must have minimum value of $10." };
      else if (!o.r && (sz * mid) / (this.leverage[o.a] ?? 20) > this.withdrawable) status = { error: "Insufficient margin to place order." };
      else if (o.t.trigger) { this.orders.push({ oid, coin, isBuy: o.b, px, sz, reduceOnly: o.r, trigger: Number(o.t.trigger.triggerPx), tif: "trigger" }); status = { resting: { oid } }; }
      else if (o.t.limit?.tif === "Gtc") { this.orders.push({ oid, coin, isBuy: o.b, px, sz, reduceOnly: o.r, trigger: null, tif: "Gtc" }); status = { resting: { oid } }; }
      else {
        // IOC: fills at mid if the limit allows it
        const marketable = o.b ? px >= mid : px <= mid;
        const p0 = this.pos[coin];
        if (!marketable) status = { error: "Order could not immediately match against any resting orders." };
        else if (o.r && (!p0 || (o.b ? p0.szi > 0 : p0.szi < 0))) status = { error: "Reduce only order would increase position." };
        else {
          const fsz = o.r ? Math.min(sz, Math.abs(p0!.szi)) : +(sz * this.fillRatio).toFixed(8);
          this.applyFill(coin, o.b, fsz, mid, oid);
          status = { filled: { totalSz: String(fsz), avgPx: String(mid), oid } };
        }
      }
      if (fail === "timeout_after_accept") throw new Error("Request timed out after 10000ms");
      return { response: { data: { statuses: [status] } } };
    },
  };
}
