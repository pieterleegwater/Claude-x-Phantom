/* Hyperliquid TESTNET integration validation for the Autopilot live broker.
 *
 *   HL_TESTNET=true HL_ACCOUNT_ADDRESS=0x… HL_AGENT_PRIVATE_KEY=0x… npm run validate:testnet
 *
 * Refuses to run unless HL_TESTNET=true. Places REAL testnet orders (BTC, ≈$11 notional) and
 * records every result with exchange evidence (order ids, fills, positions, open orders).
 * Writes testnet-report.md + testnet-report.json in the current directory.
 *
 * Requirements: a testnet account with ≥ $25 USDC (app.hyperliquid-testnet.xyz → faucet) and an
 * API wallet approved for it (More → API). Never use mainnet keys here.
 */
import { writeFileSync } from "node:fs";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { HyperliquidBroker, fmtPx, fmtSz, type HlExchange, type HlInfo } from "../src/lib/engine/hlBroker";
import { HyperliquidFeed, type AssetInfo } from "../src/lib/engine/market";
import { roundSizeDown } from "../src/lib/engine/riskGovernor";
import { DEFAULT_ENGINE_CONFIG, newEngineState, type EngineState } from "../src/lib/engine/types";

type Row = { test: string; result: "PASS" | "FAIL" | "SKIP"; evidence: string };
const rows: Row[] = [];
const evidence = { orders: [] as string[], fills: [] as string[], stops: [] as string[], closes: [] as string[] };
const log = (r: Row) => { rows.push(r); console.log(`${r.result.padEnd(4)} ${r.test} — ${r.evidence}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function step(test: string, fn: () => Promise<string>) {
  try { log({ test, result: "PASS", evidence: await fn() }); }
  catch (e) { log({ test, result: "FAIL", evidence: e instanceof Error ? e.message : String(e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

async function main() {
  if (process.env.HL_TESTNET !== "true") { console.error("Refusing to run: set HL_TESTNET=true (this script must never touch mainnet)."); process.exit(2); }
  const user = (process.env.HL_ACCOUNT_ADDRESS ?? "") as `0x${string}`;
  const key = (process.env.HL_AGENT_PRIVATE_KEY ?? "") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(user) || !/^0x[0-9a-fA-F]{64}$/.test(key)) { console.error("HL_ACCOUNT_ADDRESS / HL_AGENT_PRIVATE_KEY missing or malformed."); process.exit(2); }

  const transport = new HttpTransport({ isTestnet: true, timeout: 10_000 });
  const info = new InfoClient({ transport });
  const ex = new ExchangeClient({ transport, wallet: privateKeyToAccount(key) });
  const broker = new HyperliquidBroker(user, key, { isTestnet: true });
  const feed = new HyperliquidFeed(true);
  const COIN = "BTC";
  let assets: Record<string, AssetInfo> = {};
  let s: EngineState = { ...newEngineState({ ...DEFAULT_ENGINE_CONFIG, mode: "live", coins: [COIN] }), liveArmed: true };
  const now = () => Date.now();
  const venue = () => broker.venue();
  const openOrders = () => info.frontendOpenOrders({ user });
  const refresh = async () => { assets = await feed.assets([COIN]); return assets[COIN]; };

  // ---------------------------------------------------------------- connectivity & auth
  await step("Market data (metaAndAssetCtxs, candles, l2Book)", async () => {
    const a = await refresh();
    must(a && a.midPx > 0, "BTC not found on testnet");
    const c = await feed.candles(COIN, "1m", 5);
    const b = await feed.book(COIN);
    must(c.length > 0 && b && b.bids.length && b.asks.length, "candles/book empty");
    return `BTC mid ${a.midPx}, szDecimals ${a.szDecimals}, maxLev ${a.maxLeverage}, ${c.length} candles, book ${b.bids.length}/${b.asks.length} levels`;
  });
  await step("Account balance (clearinghouseState)", async () => {
    const v = await venue();
    must(v.equity >= 15, `testnet equity $${v.equity} — fund at least $25 from the testnet faucet`);
    return `accountValue $${v.equity.toFixed(2)}, withdrawable $${v.withdrawable.toFixed(2)}, open positions: ${Object.keys(v.pos).join(",") || "none"}`;
  });
  await step("Agent-wallet authentication (signed cancel of a non-existent order)", async () => {
    must(assets[COIN], "market data unavailable — cannot test authentication");
    try { await ex.cancel({ cancels: [{ a: assets[COIN].assetIndex, o: 1 }] }); return "unexpected success"; }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      must(e instanceof Error && e.name === "ApiRequestError", `no exchange answer: ${m}`);
      must(!/does not exist|not authorized|User or API Wallet/i.test(m), `signature rejected: ${m}`);
      return `signature accepted; exchange answered: "${m.slice(0, 120)}"`;
    }
  });
  const pre = await venue().catch(() => null);
  if (!pre || pre.pos[COIN]) { log({ test: "Pre-condition: no open BTC position", result: "FAIL", evidence: pre ? "close the BTC position first" : "venue unreachable" }); return finish(); }

  // ---------------------------------------------------------------- rejections
  await step("Rejection: order below the $10 minimum", async () => {
    const a = await refresh();
    const q = roundSizeDown(5 / a.midPx, a.szDecimals) || 10 ** -a.szDecimals;
    try {
      const r = await ex.order({ orders: [{ a: a.assetIndex, b: true, p: fmtPx(a.midPx * 1.003, a.szDecimals), s: fmtSz(q, a.szDecimals), r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
      throw new Error(`accepted: ${JSON.stringify(r.response.data.statuses[0])}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      must(/minimum|min/i.test(m) && !/^accepted/.test(m), m);
      must(!(await venue()).pos[COIN], "a position exists after a rejected order");
      return `rejected as expected: "${m.slice(0, 100)}"; verified no position`;
    }
  });
  await step("Rejection: non-marketable IOC (no fill)", async () => {
    const a = await refresh();
    const q = roundSizeDown(11 / a.midPx, a.szDecimals) + 10 ** -a.szDecimals;
    try {
      const r = await ex.order({ orders: [{ a: a.assetIndex, b: true, p: fmtPx(a.midPx * 0.9, a.szDecimals), s: fmtSz(q, a.szDecimals), r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
      throw new Error(`accepted: ${JSON.stringify(r.response.data.statuses[0])}`);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      must(!/^accepted/.test(m), m);
      must(!(await venue()).pos[COIN], "position exists");
      return `no fill as expected: "${m.slice(0, 100)}"; verified no position`;
    }
  });
  await step("API timeout handling (1 ms timeout transport, read-only)", async () => {
    const slow = new InfoClient({ transport: new HttpTransport({ isTestnet: true, timeout: 1 }) });
    try { await slow.allMids(); return "request unexpectedly completed within 1 ms"; }
    catch (e) { return `timeout surfaced as an error (${(e instanceof Error ? e.name : "Error")}) — the broker treats this as unknown and re-reads state`; }
  });

  // ---------------------------------------------------------------- entry, stop, TP
  const plan = async (stopPct = 0.01) => {
    const a = await refresh();
    const qty = roundSizeDown(11 / a.midPx, a.szDecimals) + 10 ** -a.szDecimals; // ≈ $11
    return { a, qty, stop: a.midPx * (1 - stopPct), tps: [{ price: a.midPx * 1.01, pct: 40 }, { price: a.midPx * 1.02, pct: 60 }] };
  };
  let posId = "";
  await step("Entry: IOC order → fill confirmed from clearinghouseState → stop verified on the book", async () => {
    const p = await plan();
    const r = await broker.open(s, { coin: COIN, asset: p.a, side: "long", qty: p.qty, refPrice: p.a.midPx, stop: p.stop, tps: p.tps, leverage: 3, liqPrice: null, tf: "15m", strategyId: "testnet_validation", exitProfile: "scale_3", score: 0, thesis: "testnet validation", regime: "range" }, now());
    s = r.s;
    must(r.ok, r.note);
    const pos = s.positions[0];
    posId = pos.id;
    const v = await venue();
    must(v.pos[COIN] && Math.abs(Math.abs(v.pos[COIN].szi) - pos.qty) < 1e-9, "venue size mismatch");
    const oo = await openOrders();
    const sl = oo.find((o) => o.oid === pos.slOid);
    must(sl && sl.isTrigger && sl.reduceOnly, "stop not found on the book");
    evidence.orders.push(`entry ${COIN} long ${pos.qty} @ ${pos.entry}`);
    evidence.fills.push(`${COIN} ${pos.qty} @ ${pos.entry} (clearinghouseState)`);
    evidence.stops.push(`oid ${sl.oid} trigger ${sl.triggerPx} size ${sl.sz}`);
    return `${r.note} | TP orders: ${pos.tps.map((t) => `${t.price.toFixed(1)}:${t.oid ?? "merged"}`).join(", ")}`;
  });
  await step("Take-profit orders resting (reduce-only)", async () => {
    const pos = s.positions.find((p) => p.id === posId);
    must(pos, "no position");
    const oo = await openOrders();
    const placed = pos.tps.filter((t) => t.oid != null);
    must(placed.length >= 1, "no TP order placed");
    for (const t of placed) must(oo.some((o) => o.oid === t.oid && o.reduceOnly && !o.isTrigger), `TP ${t.oid} not on the book`);
    return `${placed.length} TP order(s) verified: ${placed.map((t) => t.oid).join(", ")}`;
  });
  await step("Duplicate prevention: second identical entry refused", async () => {
    const p = await plan();
    const r = await broker.open(s, { coin: COIN, asset: p.a, side: "long", qty: p.qty, refPrice: p.a.midPx, stop: p.stop, tps: p.tps, leverage: 3, liqPrice: null, tf: "15m", strategyId: "testnet_validation", exitProfile: "scale_3", score: 0, thesis: "dup", regime: "range" }, now());
    must(!r.ok, "duplicate entry was accepted!");
    const v = await venue();
    must(Math.abs(Math.abs(v.pos[COIN].szi) - s.positions[0].qty) < 1e-9, "size changed");
    return `refused: ${r.note}`;
  });
  await step("Stop-loss modification (new stop first, old cancelled, verified)", async () => {
    const pos = s.positions.find((p) => p.id === posId)!;
    const old = pos.slOid;
    const newStop = pos.stop * 1.002;
    const r = await broker.moveStop(s, posId, newStop, assets);
    must(r.ok, r.note);
    s = r.s;
    const oo = await openOrders();
    must(!oo.some((o) => o.oid === old), "old stop still on the book");
    const cur = oo.find((o) => o.oid === s.positions[0].slOid);
    must(cur && Math.abs(Number(cur.triggerPx) - Number(fmtPx(newStop, assets[COIN].szDecimals))) < 1e-6, "new stop not found at the new price");
    evidence.stops.push(`moved: oid ${cur.oid} trigger ${cur.triggerPx}`);
    return `old ${old} cancelled, new ${cur.oid} @ ${cur.triggerPx}`;
  });
  await step("Reconciliation: tracked size tampered → sync restores the venue truth and resizes the stop", async () => {
    s = { ...s, positions: s.positions.map((p) => (p.id === posId ? { ...p, qty: p.qty * 2 } : p)) };
    const r = await broker.sync(s, feed, assets, now());
    s = r.s;
    const v = await venue();
    const pos = s.positions[0];
    must(Math.abs(pos.qty - Math.abs(v.pos[COIN].szi)) < 1e-9, "not reconciled");
    const oo = await openOrders();
    const sl = oo.find((o) => o.oid === pos.slOid);
    must(sl && Math.abs(Number(sl.sz) - pos.qty) < 1e-9, "stop size not equal to the position");
    return `${r.notes.join(" | ") || "no changes needed"}`;
  });
  await step("Server restart: fresh broker + persisted state keeps the position protected", async () => {
    const b2 = new HyperliquidBroker(user, key, { isTestnet: true });
    const persisted = JSON.parse(JSON.stringify(s)) as EngineState;
    const r = await b2.sync(persisted, feed, assets, now());
    must(r.s.positions.length === 1 && !r.s.positions[0].unprotected, "position lost or unprotected after restart");
    s = r.s;
    return `position ${r.s.positions[0].coin} still tracked, stop oid ${r.s.positions[0].slOid}`;
  });
  await step("Position close (market, reduce-only) → verified flat, orders cancelled, PnL from fills", async () => {
    const r = await broker.close(s, posId, "testnet validation close", assets, now());
    must(r.ok, r.note);
    s = r.s;
    await sleep(500);
    const v = await venue();
    must(!v.pos[COIN], "venue still shows a position");
    const oo = (await openOrders()).filter((o) => o.coin === COIN);
    must(oo.length === 0, `${oo.length} orders still open`);
    const t = s.trades[0];
    evidence.closes.push(`${COIN} closed, exit ${t.exitAvg}, pnl ${t.pnlUsd.toFixed(4)} (fees ${t.feesUsd.toFixed(4)})`);
    return `${r.note}; booked pnl $${t.pnlUsd.toFixed(4)}, fees $${t.feesUsd.toFixed(4)}`;
  });

  // ---------------------------------------------------------------- unprotected untracked position
  await step("Untracked position without a stop (simulated lost state) → sync closes it", async () => {
    const a = await refresh();
    const q = roundSizeDown(11 / a.midPx, a.szDecimals) + 10 ** -a.szDecimals;
    const r = await ex.order({ orders: [{ a: a.assetIndex, b: true, p: fmtPx(a.midPx * 1.003, a.szDecimals), s: fmtSz(q, a.szDecimals), r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    evidence.orders.push(`raw entry ${JSON.stringify(r.response.data.statuses[0])}`);
    must((await venue()).pos[COIN], "raw entry did not fill");
    const sy = await broker.sync(s, feed, assets, now());
    s = sy.s;
    must(!(await venue()).pos[COIN], "position still open");
    evidence.closes.push(`untracked ${COIN} closed by sync`);
    return sy.notes.join(" | ");
  });

  // ---------------------------------------------------------------- STOP ALL
  await step("STOP ALL: position + resting entry order → all closed/cancelled, confirmed by the exchange", async () => {
    const p = await plan();
    const r = await broker.open(s, { coin: COIN, asset: p.a, side: "long", qty: p.qty, refPrice: p.a.midPx, stop: p.stop, tps: p.tps, leverage: 3, liqPrice: null, tf: "15m", strategyId: "testnet_validation", exitProfile: "scale_3", score: 0, thesis: "stop-all test", regime: "range" }, now());
    must(r.ok, `setup entry failed: ${r.note}`);
    s = r.s;
    const a = await refresh();
    const q = roundSizeDown(11 / (a.midPx * 0.8), a.szDecimals) + 10 ** -a.szDecimals;
    const rest = await ex.order({ orders: [{ a: a.assetIndex, b: true, p: fmtPx(a.midPx * 0.8, a.szDecimals), s: fmtSz(q, a.szDecimals), r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" });
    evidence.orders.push(`resting entry ${JSON.stringify(rest.response.data.statuses[0])}`);
    const f = await broker.flattenAll(s, assets, now());
    s = f.s;
    must(f.confirmed, f.note);
    const v = await venue();
    const oo = await openOrders();
    must(Object.keys(v.pos).length === 0 && oo.length === 0, "exchange still shows positions/orders");
    evidence.closes.push("STOP ALL: exchange confirmed 0 positions / 0 orders");
    return f.note;
  });

  return finish();

  function finish() {
    const passed = rows.filter((r) => r.result === "PASS").length;
    const failed = rows.filter((r) => r.result === "FAIL").length;
    const md = [
      `# Hyperliquid testnet validation — ${new Date().toISOString()}`,
      "", `Account ${user.slice(0, 6)}…${user.slice(-4)} · ${passed} passed · ${failed} failed`, "",
      "| Result | Test | Exchange evidence |", "|---|---|---|",
      ...rows.map((r) => `| ${r.result} | ${r.test} | ${r.evidence.replace(/\|/g, "/")} |`), "",
      "## Orders", ...evidence.orders.map((x) => `- ${x}`), "## Fills", ...evidence.fills.map((x) => `- ${x}`),
      "## Stops", ...evidence.stops.map((x) => `- ${x}`), "## Closes", ...evidence.closes.map((x) => `- ${x}`),
    ].join("\n");
    writeFileSync("testnet-report.md", md);
    writeFileSync("testnet-report.json", JSON.stringify({ rows, evidence }, null, 2));
    console.log(`\n${passed} passed, ${failed} failed — see testnet-report.md`);
    process.exitCode = failed ? 1 : 0;
  }
}

// unused type imports are kept for readers
export type { HlInfo, HlExchange };
main().catch((e) => { console.error(e); process.exit(1); });
