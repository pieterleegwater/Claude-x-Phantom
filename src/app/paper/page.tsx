"use client";
import { useEffect, useMemo, useState } from "react";
import { FlaskConical, RotateCcw } from "lucide-react";
import { setState, useStore, getState, notify } from "@/lib/client/store";
import { useApi } from "@/lib/client/useApi";
import { available, closeQty, equity, moveStopToBreakeven, newPaperState, openPosition, stats, unrealized, type PaperMarket } from "@/lib/paper";
import { planPosition } from "@/lib/risk";
import type { Ticker } from "@/lib/types";
import { Badge, Button, Card, Field, Modal, NumInput, Notice, PageHeader, Segmented, Stat, Term, cn, inputCls, pct, price, usd, timeAgo } from "@/components/ui";
import { LineChart } from "@/components/charts";

export default function PaperPage() {
  const paper = useStore((s) => s.paper);
  const settings = useStore((s) => s.settings);
  const st = stats(paper);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBal, setResetBal] = useState(settings.accountEquity);
  const hydrated = useStore((s) => s.hydrated);
  useEffect(() => {
    if (hydrated) setResetBal(getState().settings.accountEquity);
  }, [hydrated]);
  const cost = { takerFeeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, mmr: settings.maintenanceMarginRate };
  const marginUsed = paper.positions.reduce((t, p) => t + p.margin, 0);
  const riskAtStop = paper.positions.reduce((t, p) => t + Math.max(0, (p.side === "long" ? p.entry - p.stop : p.stop - p.entry) * p.qty), 0);

  const closePart = (id: string, frac: number) => {
    const s = getState();
    const p = s.paper.positions.find((x) => x.id === id);
    if (!p) return;
    const r = closeQty(s.paper, id, p.qty * frac, p.lastPrice, "manual", cost);
    setState({ paper: r.state });
    if (r.fill) notify({ key: `manual-${r.fill.id}`, type: "info", title: `Closed ${(frac * 100).toFixed(0)}% of ${p.asset} (paper)`, body: `Simulated fill at ~${price(r.fill.exit)}. Net ${usd(r.fill.pnl)}.`, href: "/paper" });
  };
  const moveBE = (id: string) => setState((s) => ({ paper: moveStopToBreakeven(s.paper, id) }));

  return (
    <div>
      <PageHeader
        title="Paper Trading"
        subtitle="Real market prices, virtual money. Every fill here is simulated."
        beginner={<>Practise here first. Positions are opened at the live price plus simulated <Term k="slippage">slippage</Term> and fees, then monitored every 10 seconds for <Term k="stoploss">stop-loss</Term>, <Term k="takeprofit">take-profit</Term> and <Term k="liquidation">liquidation</Term> while EdgePilot is open.</>}
        right={
          <Button size="sm" variant="danger" onClick={() => setResetOpen(true)}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset account
          </Button>
        }
      />
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-info/25 bg-info-soft/30 px-3 py-2 text-xs leading-relaxed text-ink-2 sm:mb-4">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-info" />
        <p><b className="text-ink">SIMULATION</b> — fills are modelled (price ± {settings.slippageBps}bps slippage, {settings.takerFeeBps}bps fee/side, funding on perps). Real exchange fills, queue position and wicks between checks can differ.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-6">
        <Card><Stat label="Equity" value={usd(st.equity)} sub={`start ${usd(paper.startingBalance, 0)}`} /></Card>
        <Card><Stat label="Total PnL" value={usd(st.totalPnl)} tone={st.totalPnl >= 0 ? "bull" : "bear"} sub={pct(st.totalPnlPct)} /></Card>
        <Card><Stat label="Today PnL" value={usd(st.todayPnl)} tone={st.todayPnl >= 0 ? "bull" : "bear"} /></Card>
        <Card><Stat label="Available" value={usd(available(paper))} sub={`margin used ${usd(marginUsed)}`} /></Card>
        <Card><Stat label="Open risk at stops" value={usd(riskAtStop)} sub={`${((riskAtStop / Math.max(1, equity(paper))) * 100).toFixed(2)}% of equity`} tone={riskAtStop / Math.max(1, equity(paper)) > 0.05 ? "warn" : undefined} /></Card>
        <Card><Stat label="Win rate / PF" value={`${st.winRate == null ? "—" : (st.winRate * 100).toFixed(0) + "%"} / ${st.profitFactor == null ? "—" : Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"}`} sub={`${st.closed} closed · DD ${st.maxDrawdownPct.toFixed(1)}%`} /></Card>
      </div>

      <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-[420px_1fr]">
        <Ticket />
        <div className="min-w-0 space-y-4">
          <Card title="Open positions" subtitle={`${paper.positions.length} open · monitored every 10s`}>
            {paper.positions.length === 0 ? (
              <p className="text-sm text-ink-3">No open positions. Use the ticket or press &quot;Paper trade this&quot; on any actionable signal.</p>
            ) : (
              <>
              <div className="space-y-2 md:hidden">
                {paper.positions.map((p) => {
                  const u = unrealized(p);
                  return (
                    <div key={p.id} className="rounded-lg border border-line p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <Badge tone={p.side === "long" ? "bull" : "bear"}>{p.side}</Badge>
                          <span className="truncate text-sm font-semibold">{p.asset}</span>
                          {p.leverage > 1 && <span className="text-xs text-ink-3">{p.leverage}x</span>}
                        </div>
                        <span className={cn("num text-sm font-semibold", u >= 0 ? "text-bull" : "text-bear")}>{usd(u)}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-ink-3">{p.market} · {p.setup} · {timeAgo(p.openedAt)}</div>
                      <div className="num mt-2 grid grid-cols-3 gap-2 text-[11px]">
                        <div><div className="text-ink-3">Entry</div>{price(p.entry)}</div>
                        <div><div className="text-ink-3">Last</div>{price(p.lastPrice)}</div>
                        <div><div className="text-ink-3">Size</div>{p.qty.toPrecision(3)}</div>
                        <div><div className="text-ink-3">Stop</div><span className="text-bear">{price(p.stop)}</span></div>
                        <div><div className="text-ink-3">Next TP</div><span className="text-bull">{price(p.takeProfits.find((t) => !t.hit)?.price ?? null)}</span></div>
                        <div><div className="text-ink-3">Liq.</div><span className="text-warn">{p.liqPrice ? price(p.liqPrice) : "—"}</span></div>
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-1.5">
                        <Button size="sm" onClick={() => closePart(p.id, 0.25)}>25%</Button>
                        <Button size="sm" onClick={() => closePart(p.id, 0.5)}>50%</Button>
                        <Button size="sm" variant="ghost" disabled={p.stop === p.entry || u <= 0} onClick={() => moveBE(p.id)} title="Move stop to entry (only when in profit)">BE</Button>
                        <Button size="sm" variant="danger" onClick={() => closePart(p.id, 1)}>Close</Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[760px] text-xs">
                  <thead className="text-left text-ink-3">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Position</th>
                      <th className="px-2 py-1.5 text-right font-medium">Size</th>
                      <th className="px-2 py-1.5 text-right font-medium">Entry</th>
                      <th className="px-2 py-1.5 text-right font-medium">Last</th>
                      <th className="px-2 py-1.5 text-right font-medium">Stop</th>
                      <th className="px-2 py-1.5 text-right font-medium">Targets</th>
                      <th className="px-2 py-1.5 text-right font-medium">Liq.</th>
                      <th className="px-2 py-1.5 text-right font-medium">Unrealised</th>
                      <th className="px-2 py-1.5 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {paper.positions.map((p) => {
                      const u = unrealized(p);
                      return (
                        <tr key={p.id}>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              <Badge tone={p.side === "long" ? "bull" : "bear"}>{p.side}</Badge>
                              <span className="font-medium">{p.asset}</span>
                              {p.leverage > 1 && <span className="text-ink-3">{p.leverage}x</span>}
                            </div>
                            <div className="mt-0.5 text-[10px] text-ink-3">{p.market} · {p.setup} · {timeAgo(p.openedAt)}</div>
                          </td>
                          <td className="num px-2 py-2 text-right">{p.qty.toPrecision(4)}<div className="text-[10px] text-ink-3">{usd(p.qty * p.lastPrice, 0)}</div></td>
                          <td className="num px-2 py-2 text-right">{price(p.entry)}</td>
                          <td className="num px-2 py-2 text-right">{price(p.lastPrice)}</td>
                          <td className="num px-2 py-2 text-right text-bear">{price(p.stop)}{p.stop === p.entry && <div className="text-[10px] text-ink-3">break-even</div>}</td>
                          <td className="num px-2 py-2 text-right text-bull">{p.takeProfits.map((t, i) => <div key={i} className={t.hit ? "line-through opacity-50" : ""}>{price(t.price)} ({t.closePct}%)</div>)}</td>
                          <td className="num px-2 py-2 text-right text-warn">{p.liqPrice ? price(p.liqPrice) : "—"}</td>
                          <td className={cn("num px-2 py-2 text-right", u >= 0 ? "text-bull" : "text-bear")}>{usd(u)}<div className="text-[10px] text-ink-3">fund {usd(-p.fundingPaid)}</div></td>
                          <td className="px-2 py-2">
                            <div className="flex flex-wrap justify-end gap-1">
                              <Button size="sm" onClick={() => closePart(p.id, 0.25)}>25%</Button>
                              <Button size="sm" onClick={() => closePart(p.id, 0.5)}>50%</Button>
                              <Button size="sm" variant="danger" onClick={() => closePart(p.id, 1)}>Close</Button>
                              {p.stop !== p.entry && u > 0 && <Button size="sm" variant="ghost" onClick={() => moveBE(p.id)} title="Move stop to entry">BE</Button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              </>
            )}
          </Card>
          <Card title="Equity curve">
            {paper.equityHistory.length > 1 ? <LineChart points={paper.equityHistory.map((h) => ({ time: h.t / 1000, value: h.equity }))} baseline={paper.startingBalance} /> : <p className="py-8 text-center text-sm text-ink-3">No history yet.</p>}
          </Card>
          <Card title="Strategy performance (paper)" subtitle="Closed positions grouped by setup.">
            {Object.keys(st.bySetup).length === 0 ? (
              <p className="text-sm text-ink-3">No closed positions yet.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-ink-3"><tr><th className="py-1.5 font-medium">Setup</th><th className="py-1.5 text-right font-medium">Trades</th><th className="py-1.5 text-right font-medium">Win</th><th className="py-1.5 text-right font-medium">PnL</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {Object.entries(st.bySetup).map(([k, v]) => (
                    <tr key={k}><td className="py-1.5">{k}</td><td className="num py-1.5 text-right">{v.trades}</td><td className="num py-1.5 text-right">{((v.wins / v.trades) * 100).toFixed(0)}%</td><td className={cn("num py-1.5 text-right", v.pnl >= 0 ? "text-bull" : "text-bear")}>{usd(v.pnl)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-ink-3">Fees paid {usd(st.feesPaid)} · funding {usd(st.fundingPaid)}</p>
          </Card>
        </div>
      </div>
      <Modal open={resetOpen} onClose={() => setResetOpen(false)} title="Reset paper account">
        <div className="space-y-3">
          <p className="text-sm text-ink-2">This closes all simulated positions and deletes paper history. Trade history export is in the History page.</p>
          <Field label="Starting balance (USD)"><NumInput value={resetBal} onChange={setResetBal} min={100} /></Field>
          <Button variant="danger" onClick={() => { setState({ paper: newPaperState(resetBal) }); setResetOpen(false); }}>Reset</Button>
        </div>
      </Modal>
    </div>
  );
}

function Ticket() {
  const settings = useStore((s) => s.settings);
  const ticket = useStore((s) => s.ticket);
  const paper = useStore((s) => s.paper);
  const [market, setMarket] = useState<PaperMarket>("BTC-PERP");
  const [mint, setMint] = useState("");
  const [asset, setAsset] = useState("BTC");
  const [side, setSide] = useState<"long" | "short">("long");
  const [stop, setStop] = useState<number | null>(null);
  const [tps, setTps] = useState<{ price: number | null; closePct: number }[]>([{ price: null, closePct: 50 }, { price: null, closePct: 50 }]);
  const [lev, setLev] = useState(settings.defaultLeverage);
  const hydrated = useStore((s) => s.hydrated);
  useEffect(() => {
    if (hydrated && !getState().ticket) setLev(getState().settings.defaultLeverage);
  }, [hydrated]);
  const [qty, setQty] = useState<number | null>(null);
  const [setup, setSetup] = useState("Manual");
  const [signalId, setSignalId] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    if (!ticket) return;
    setMarket(ticket.market);
    setAsset(ticket.asset);
    setMint(ticket.market === "SOL-MEME" ? ticket.priceKey : "");
    setSide(ticket.side);
    setStop(ticket.stop);
    setTps(ticket.takeProfits.length ? ticket.takeProfits.map((t) => ({ price: t.price, closePct: t.closePct })) : [{ price: null, closePct: 100 }]);
    setLev(ticket.leverage);
    setQty(ticket.qty);
    setSetup(ticket.setup);
    setSignalId(ticket.signalId);
    setState({ ticket: null });
  }, [ticket]);

  const priceKey = market === "SOL-MEME" ? mint : "BTC";
  const btc = useApi<Ticker>(market !== "SOL-MEME" ? "/api/market/ticker?symbol=BTC" : null, 5_000);
  const meme = useApi<Record<string, { priceUsd: number; symbol: string }>>(market === "SOL-MEME" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? `/api/memecoins/prices?mints=${mint}` : null, 10_000);
  const live = market === "SOL-MEME" ? meme.data?.[mint]?.priceUsd : btc.data?.price;
  useEffect(() => {
    if (market === "SOL-MEME" && meme.data?.[mint]) setAsset(meme.data[mint].symbol);
    if (market !== "SOL-MEME") setAsset("BTC");
  }, [market, meme.data, mint]);

  const effLev = market === "BTC-PERP" ? lev : 1;
  const plan = useMemo(() => {
    if (!live || !stop) return null;
    if (side === "long" ? stop >= live : stop <= live) return null;
    return planPosition({ equity: equity(paper), riskPct: settings.riskPerTradePct, entry: live, stop, side, leverage: effLev, takerFeeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, maintenanceMarginRate: settings.maintenanceMarginRate, maxPositionUsd: market === "SOL-MEME" ? (equity(paper) * settings.memeMaxPositionPct) / 100 : undefined });
  }, [live, stop, side, effLev, paper, settings, market]);
  const finalQty = qty ?? plan?.quantity ?? null;

  const submit = () => {
    setMsg(undefined);
    if (!live) return setMsg({ ok: false, text: "No live price available." });
    if (!stop) return setMsg({ ok: false, text: "A stop-loss is mandatory." });
    if (!finalQty) return setMsg({ ok: false, text: "Enter a size or a valid stop so size can be computed from risk." });
    const tpList = tps.filter((t) => t.price && t.price > 0).map((t) => ({ price: t.price!, closePct: t.closePct }));
    const bad = tpList.find((t) => (side === "long" ? t.price <= live : t.price >= live));
    if (bad) return setMsg({ ok: false, text: "Take-profits must be above entry for longs, below for shorts." });
    const cur = getState().paper;
    const eqNow = equity(cur);
    const today = stats(cur).todayPnl;
    if (today < 0 && (-today / eqNow) * 100 >= settings.dailyLossLimitPct) return setMsg({ ok: false, text: `Daily loss limit reached (${settings.dailyLossLimitPct}%). The best trade now is no trade — come back tomorrow.` });
    const openRisk = cur.positions.reduce((t, p) => t + Math.max(0, (p.side === "long" ? p.entry - p.stop : p.stop - p.entry) * p.qty), 0);
    const newRisk = finalQty * Math.abs(live - stop);
    if (((openRisk + newRisk) / eqNow) * 100 > settings.maxOpenRiskPct) return setMsg({ ok: false, text: `This would raise total open risk to ${(((openRisk + newRisk) / eqNow) * 100).toFixed(2)}% (limit ${settings.maxOpenRiskPct}%). Reduce size or close something first.` });
    const cost = { takerFeeBps: market === "SOL-MEME" ? 30 : settings.takerFeeBps, slippageBps: market === "SOL-MEME" ? Math.max(50, settings.slippageBps) : settings.slippageBps, mmr: settings.maintenanceMarginRate };
    const r = openPosition(getState().paper, { market, asset, priceKey, side, qty: finalQty, stop, takeProfits: tpList.sort((a, b) => (side === "long" ? a.price - b.price : b.price - a.price)), leverage: effLev, setup, signalId }, live, cost);
    if (r.error) return setMsg({ ok: false, text: r.error });
    setState({ paper: r.state });
    setMsg({ ok: true, text: `Simulated ${side} opened: ${finalQty.toPrecision(4)} ${asset} at ~${price(r.position!.entry)}.` });
    setQty(null);
  };

  return (
    <Card title="Order ticket (simulated)" subtitle="Market order at live price. Stop-loss required.">
      <div className="space-y-3">
        <Segmented value={market} onChange={(m) => { setMarket(m); if (m !== "BTC-PERP") setSide("long"); }} options={[{ value: "BTC-PERP", label: "BTC Perp" }, { value: "BTC-SPOT", label: "BTC Spot" }, { value: "SOL-MEME", label: "Memecoin" }]} />
        {market === "SOL-MEME" && (
          <Field label="Token mint address"><input className={inputCls} value={mint} onChange={(e) => setMint(e.target.value.trim())} placeholder="Paste Solana mint" /></Field>
        )}
        <div className="flex items-center justify-between">
          <Segmented value={side} onChange={(s) => market === "BTC-PERP" && setSide(s)} options={[{ value: "long", label: "Long / Buy" }, { value: "short", label: "Short" }]} />
          <span className="num text-sm">{live ? `${asset} ${price(live)}` : "no price"}</span>
        </div>
        {market !== "BTC-PERP" && <p className="text-[11px] text-ink-3">Shorting is only available on BTC perpetuals.</p>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stop-loss"><NumInput value={stop} onChange={setStop} /></Field>
          {market === "BTC-PERP" ? (
            <Field label={`Leverage (max ${settings.maxLeverage}x)`}><NumInput value={lev} onChange={(v) => setLev(Math.round(v))} min={1} max={settings.maxLeverage} /></Field>
          ) : (
            <Field label="Leverage"><input className={inputCls} disabled value="1x (spot)" /></Field>
          )}
          {tps.map((t, i) => (
            <Field key={i} label={`TP${i + 1} price · close %`}>
              <div className="flex gap-1">
                <NumInput value={t.price} onChange={(v) => setTps(tps.map((x, j) => (j === i ? { ...x, price: v } : x)))} />
                <NumInput className="w-16" value={t.closePct} onChange={(v) => setTps(tps.map((x, j) => (j === i ? { ...x, closePct: v } : x)))} min={1} max={100} />
              </div>
            </Field>
          ))}
        </div>
        {tps.length < 3 && <button className="text-xs text-accent" onClick={() => setTps([...tps, { price: null, closePct: 25 }])}>+ add target</button>}
        <Field label="Quantity" hint={plan ? `Risk-based size: ${plan.quantity.toPrecision(4)} (${settings.riskPerTradePct}% risk). Leave blank to use it.` : "Set a stop to compute size from your risk setting."}>
          <NumInput value={qty} onChange={setQty} />
        </Field>
        {plan && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg border border-line p-2.5 text-xs">
            <span className="text-ink-3">Notional</span><span className="num text-right">{usd((finalQty ?? 0) * (live ?? 0))}</span>
            <span className="text-ink-3">Margin</span><span className="num text-right">{usd(((finalQty ?? 0) * (live ?? 0)) / effLev)}</span>
            <span className="text-ink-3">Loss at stop</span><span className="num text-right text-bear">{usd((finalQty ?? 0) * Math.abs((live ?? 0) - (stop ?? 0)))}</span>
            <span className="text-ink-3">Est. liquidation</span><span className="num text-right text-warn">{plan.liquidationPrice ? price(plan.liquidationPrice) : "—"}</span>
          </div>
        )}
        {plan?.warnings.map((w, i) => <Notice key={i} tone={w.startsWith("DANGER") || w.startsWith("EXTREME") ? "bear" : "warn"}>{w}</Notice>)}
        <Field label="Setup label"><input className={inputCls} value={setup} onChange={(e) => setSetup(e.target.value)} /></Field>
        <Button variant={side === "long" ? "bull" : "bear"} className="w-full" onClick={submit}>Open simulated {side}</Button>
        {msg && <p className={cn("text-xs", msg.ok ? "text-bull" : "text-bear")}>{msg.text}</p>}
      </div>
    </Card>
  );
}
