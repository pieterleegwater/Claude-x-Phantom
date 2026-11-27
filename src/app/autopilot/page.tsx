"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, OctagonX, Play, RefreshCw, ShieldAlert } from "lucide-react";
import type { EngineConfig, EngineState, Opportunity } from "@/lib/engine/types";
import { LIVE_CONFIRM_PHRASE } from "@/lib/engine/types";
import { REGIME_LABEL } from "@/lib/engine/regime";
import { byStrategy, perf, periodPnl, unrealized } from "@/lib/engine/stats";
import { LineChart } from "@/components/charts";
import { Badge, Button, Card, Empty, Field, Modal, NumInput, Notice, PageHeader, Segmented, Stat, Toggle, cn, inputCls, pct, price, timeAgo, usd } from "@/components/ui";

interface EnvInfo { adminConfigured: boolean; liveEnabled: boolean; liveConfigured: boolean; testnet: boolean; account: string | null }
interface StateResp { ok: boolean; state?: EngineState; env?: EnvInfo; error?: string; needsToken?: boolean; serverTime?: number }

const TOKEN_KEY = "edgepilot-engine-token";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };

function useEngine() {
  const [token, setTokenState] = useState("");
  const [resp, setResp] = useState<StateResp | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => setTokenState(readToken()), []);
  const setToken = (t: string) => { setTokenState(t); try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/engine/state", { headers: { "x-engine-token": readToken() }, cache: "no-store" });
      setResp(await r.json());
    } catch (e) {
      setResp({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load, token]);
  const control = useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch("/api/engine/control", { method: "POST", headers: { "content-type": "application/json", "x-engine-token": readToken() }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (j.state) setResp((p) => (p ? { ...p, state: j.state } : p));
    else load();
    if (!j.ok) throw new Error(j.error ?? "Request failed");
    return j as { ok: true; why?: string; note?: string };
  }, [load]);
  return { token, setToken, resp, loading, load, control };
}

const decisionTone = (d: Opportunity["decision"]) => (d === "TRADE" ? "bull" : d === "PAPER_ONLY" ? "info" : d === "WAIT" ? "neutral" : "warn");

export default function AutopilotPage() {
  const { token, setToken, resp, loading, load, control } = useEngine();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "info" | "warn" | "bear"; text: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [armOpen, setArmOpen] = useState(false);
  const [tab, setTab] = useState<"positions" | "opps" | "history" | "strategies" | "alerts" | "settings">("positions");

  const run = async (key: string, body: Record<string, unknown>, ok?: string) => {
    setBusy(key); setMsg(null);
    try { const r = await control(body); setMsg({ tone: "info", text: r.why ?? r.note ?? ok ?? "Done." }); }
    catch (e) { setMsg({ tone: "bear", text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const s = resp?.state;
  const env = resp?.env;
  const mode = s?.config.mode ?? "paper";
  const trades = useMemo(() => (s ? s.trades.filter((t) => t.mode === mode) : []), [s, mode]);
  const stats = useMemo(() => perf(trades), [trades]);
  const strat = useMemo(() => byStrategy(trades), [trades]);
  const positions = s ? s.positions.filter((p) => p.mode === mode) : [];
  const upnl = positions.reduce((a, p) => a + unrealized(p, p.lastPrice), 0);
  const eqHist = s ? s.equityHistory.filter((e) => e.mode === mode) : [];
  const equity = eqHist.length ? eqHist[eqHist.length - 1].equity : mode === "paper" ? s?.paperCash ?? 0 : 0;
  const pp = s ? periodPnl(s, mode) : { today: 0, week: 0 };
  const dailyPct = s && s.day.startEquity > 0 ? ((equity - s.day.startEquity) / s.day.startEquity) * 100 : 0;
  const weeklyDd = s && s.week.peak > 0 ? ((equity - s.week.peak) / s.week.peak) * 100 : 0;
  const tickAge = s?.lastTick ? Date.now() - s.lastTick.at : null;
  const healthy = !!s?.lastTick?.ok && tickAge != null && tickAge < 5 * 60_000;
  const canControl = !!env?.adminConfigured && !resp?.needsToken;
  const validated = s ? Object.values(s.validation) : [];

  if (resp?.needsToken || (resp && !resp.ok && !s)) {
    return (
      <div>
        <PageHeader title="Autopilot" subtitle="Autonomous trading engine" />
        <Card title="Engine access">
          {resp.error && <div className="mb-3"><Notice tone={resp.needsToken ? "info" : "bear"}>{resp.error}</Notice></div>}
          <TokenForm token={token} onSave={(t) => { setToken(t); setTimeout(load, 50); }} />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Autopilot"
        subtitle="Autonomous perps engine on Hyperliquid: scans BTC/ETH/SOL every minute, trades only validated edges, risk-first."
        beginner={<>The engine runs on the server every minute, even when this page is closed. It only takes a trade when a strategy has proven a positive edge <b>after fees and slippage on unseen (out-of-sample) data</b>, the setup scores high enough, and every risk limit allows it. Otherwise it says <b>WAIT</b> — that is normal and intended. Start in <b>paper</b> mode.</>}
        right={
          <>
            <Badge tone={mode === "live" ? "bear" : "info"}>{mode === "live" ? `LIVE${env?.testnet ? " · testnet" : ""}` : "PAPER"}</Badge>
            <Button size="sm" variant="ghost" onClick={load} ariaLabel="Refresh"><RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /></Button>
          </>
        }
      />
      {!s ? <Card><Empty>Loading engine state…</Empty></Card> : (
        <>
          {!env?.adminConfigured && <div className="mb-3"><Notice tone="warn">Controls are disabled: set <b>ENGINE_ADMIN_TOKEN</b> (16+ random characters) in your Netlify environment variables, redeploy, then enter it below. The engine state is visible but cannot be changed.</Notice></div>}
          {s.killSwitch && <div className="mb-3"><Notice tone="bear"><b>EMERGENCY STOP ACTIVE.</b> All positions are being flattened and no new trades are allowed. {canControl && <button className="ml-1 underline" onClick={() => run("clear", { action: "clear_stop" }, "Emergency stop cleared.")}>Clear stop</button>}</Notice></div>}
          {s.halted && <div className="mb-3"><Notice tone="warn"><b>Automatic shutdown:</b> {s.halted.reason}{s.halted.until ? ` (until ${new Date(s.halted.until).toUTCString()})` : ""} {canControl && <button className="ml-1 underline" onClick={() => run("halt", { action: "clear_halt" }, "Halt cleared.")}>Clear after review</button>}</Notice></div>}
          {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}

          {/* control strip */}
          <Card className="mb-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <Bot className={cn("h-5 w-5", healthy ? "text-bull" : "text-warn")} />
                <div>
                  <div className="text-sm font-semibold">{healthy ? "Engine running" : s.lastTick ? "Engine stale / error" : "Waiting for first cycle"}</div>
                  <div className="text-xs text-ink-3">{s.lastTick ? `last cycle ${timeAgo(s.lastTick.at)} · ${s.lastTick.ms} ms${s.lastTick.error ? ` · ${s.lastTick.error}` : ""}` : "The scheduled function runs every minute after deploy."}</div>
                </div>
              </div>
              <Toggle checked={s.config.autoTrading} onChange={(v) => canControl && run("auto", { action: "set_auto", on: v }, `Automatic trading ${v ? "ON" : "OFF"}.`)} label={<span className="font-medium">Auto trading {s.config.autoTrading ? "ON" : "OFF"}</span>} />
              <div className="flex flex-wrap gap-2 sm:ml-auto">
                <Button size="sm" disabled={!canControl || !!busy} onClick={() => run("tick", { action: "tick" }, "Cycle finished.")}><Play className="h-4 w-4" />{busy === "tick" ? "Running…" : "Run cycle now"}</Button>
                <Button size="sm" variant="danger" disabled={!canControl || !!busy} onClick={() => setConfirmStop(true)}><OctagonX className="h-4 w-4" />STOP ALL</Button>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-8">
            <Card><Stat label="Equity" value={usd(equity)} sub={mode === "paper" ? "simulated" : env?.account ?? ""} /></Card>
            <Card><Stat label="Unrealised" value={usd(upnl)} tone={upnl >= 0 ? "bull" : "bear"} sub={`${positions.length} open`} /></Card>
            <Card><Stat label="Realised" value={usd(stats.netUsd)} tone={stats.netUsd >= 0 ? "bull" : "bear"} sub={`fees ${usd(stats.feesUsd)}`} /></Card>
            <Card><Stat label="Today" value={pct(dailyPct)} tone={dailyPct >= 0 ? "bull" : "bear"} sub={`${usd(pp.today)} · limit −${s.config.maxDailyLossPct}%`} /></Card>
            <Card><Stat label="Week DD" value={pct(weeklyDd)} tone={weeklyDd > -s.config.maxWeeklyDrawdownPct / 2 ? undefined : "bear"} sub={`${usd(pp.week)} · limit −${s.config.maxWeeklyDrawdownPct}%`} /></Card>
            <Card><Stat label="Win rate" value={stats.winRate == null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`} sub={`${stats.wins}/${stats.trades} trades`} /></Card>
            <Card><Stat label="Avg R / PF" value={stats.avgR == null ? "—" : `${stats.avgR.toFixed(2)}R`} sub={stats.profitFactor == null ? "PF —" : `PF ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : "∞"}`} /></Card>
            <Card><Stat label="Max DD" value={usd(stats.maxDrawdownUsd)} tone={stats.maxDrawdownUsd < 0 ? "bear" : undefined} sub={`loss streak ${s.lossStreak}`} /></Card>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <Card className="xl:col-span-2" title="Equity" subtitle={`${mode} account · snapshot every 15 min`}>
              {eqHist.length > 1 ? <LineChart points={eqHist.map((e) => ({ time: Math.floor(e.t / 1000), value: e.equity }))} height={220} /> : <Empty>The equity curve appears after a few cycles.</Empty>}
            </Card>
            <Card title="Market regime" subtitle="Detected per coin and timeframe on closed candles">
              {Object.keys(s.regimes).length === 0 ? <Empty>No regime data yet.</Empty> : (
                <div className="space-y-2">
                  {Object.entries(s.regimes).map(([coin, tfs]) => (
                    <div key={coin} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-12 font-semibold">{coin}</span>
                      {Object.entries(tfs).map(([tf, r]) => (
                        <span key={tf} title={r.detail} className="inline-flex items-center gap-1 rounded-md border border-line-2 bg-panel-2 px-2 py-0.5 text-xs">
                          <span className="text-ink-3">{tf}</span> {REGIME_LABEL[r.regime]} <span className="text-ink-3">ADX {r.adx.toFixed(0)}</span>
                        </span>
                      ))}
                    </div>
                  ))}
                  <p className="pt-1 text-xs text-ink-3">Validated combinations: {validated.filter((v) => v.validated).length} of {validated.length} tested.</p>
                </div>
              )}
            </Card>
          </div>

          <div className="mt-4 overflow-x-auto">
            <Segmented size="sm" value={tab} onChange={setTab} options={[
              { value: "positions", label: `Positions (${positions.length})` },
              { value: "opps", label: "Opportunities" },
              { value: "history", label: `History (${trades.length})` },
              { value: "strategies", label: "Strategies" },
              { value: "alerts", label: `Alerts` },
              { value: "settings", label: "Settings" },
            ]} />
          </div>

          <div className="mt-3">
            {tab === "positions" && (
              <Card title="Live positions" subtitle="Stops and targets are resting reduce-only orders on the exchange (simulated in paper mode).">
                {positions.length === 0 ? <Empty>No open positions.</Empty> : (
                  <div className="space-y-3">
                    {positions.map((p) => {
                      const u = unrealized(p, p.lastPrice);
                      const r = (u - p.feesUsd) / (p.risk * p.initialQty);
                      return (
                        <div key={p.id} className="rounded-lg border border-line-2 p-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={p.side === "long" ? "bull" : "bear"}>{p.side}</Badge>
                            <span className="font-semibold">{p.coin}</span>
                            <span className="text-xs text-ink-3">{p.strategyId} · {p.tf} · score {p.score} · {p.leverage}x</span>
                            <span className={cn("num ml-auto font-semibold", u >= 0 ? "text-bull" : "text-bear")}>{usd(u)} ({r.toFixed(2)}R)</span>
                          </div>
                          <div className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4 lg:grid-cols-7">
                            <span><span className="text-ink-3">Entry</span> {price(p.entry)}</span>
                            <span><span className="text-ink-3">Price</span> {price(p.lastPrice)}</span>
                            <span><span className="text-ink-3">Stop</span> <span className="text-bear">{price(p.stop)}</span>{p.beMoved ? " (BE)" : ""}{p.trailingActive ? " (trail)" : ""}</span>
                            <span><span className="text-ink-3">Liq.</span> {p.liqPrice ? price(p.liqPrice) : "—"}</span>
                            <span><span className="text-ink-3">Size</span> {p.qty}/{p.initialQty}</span>
                            <span><span className="text-ink-3">Opened</span> {timeAgo(p.openedAt)}</span>
                            <span><span className="text-ink-3">Funding</span> {usd(-p.fundingUsd, 3)}</span>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {p.tps.map((t, k) => <Badge key={k} tone={t.filled ? "bull" : "neutral"}>TP{k + 1} {price(t.price)} · {t.pct}%{t.filled ? " ✓" : ""}</Badge>)}
                          </div>
                          <p className="mt-2 text-xs text-ink-3 [overflow-wrap:anywhere]">{p.thesis}</p>
                          {canControl && <div className="mt-2"><Button size="sm" variant="bear" disabled={!!busy} onClick={() => run(`close-${p.id}`, { action: "close_position", id: p.id }, `${p.coin} closed.`)}>{busy === `close-${p.id}` ? "Closing…" : "Close now"}</Button></div>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            )}

            {tab === "opps" && (
              <Card title="Opportunities (last cycle)" subtitle={`TRADE needs score ≥ ${mode === "live" ? s.config.liveMinScore : s.config.paperMinScore}, a validated edge and zero critical flags.`}>
                {s.opportunities.length === 0 ? <Empty>No scan yet.</Empty> : (
                  <div className="space-y-2">
                    {s.opportunities.map((o, k) => (
                      <div key={k} className="rounded-lg border border-line-2 p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={decisionTone(o.decision)}>{o.decision.replace("_", " ")}</Badge>
                          <span className="font-semibold">{o.coin} {o.tf}</span>
                          {o.side && <Badge tone={o.side === "long" ? "bull" : "bear"}>{o.side}</Badge>}
                          <span className="text-xs text-ink-3">{REGIME_LABEL[o.regime]}{o.strategyId ? ` · ${o.strategyId}` : ""}</span>
                          {o.score > 0 && <span className="num ml-auto font-semibold">{o.score}/100</span>}
                        </div>
                        {o.entry != null && (
                          <div className="num mt-1 flex flex-wrap gap-x-4 text-xs text-ink-2">
                            <span>entry {price(o.entry)}</span><span>stop {price(o.stop)}</span>
                            {o.tps?.length ? <span>TPs {o.tps.map((t) => price(t)).join(" / ")}</span> : null}
                            {o.qty ? <span>size {o.qty} ({usd(o.notional)}) · {o.leverage}x · risk {usd(o.riskUsd, 3)}</span> : null}
                          </div>
                        )}
                        <ul className="mt-1 list-disc pl-5 text-xs text-ink-3">{o.reasons.slice(0, 4).map((r, j) => <li key={j}>{r}</li>)}</ul>
                        {o.flags.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-warn">{o.flags.map((r, j) => <li key={j}>{r}</li>)}</ul>}
                      </div>
                    ))}
                  </div>
                )}
                {s.lastTick?.notes?.length ? <div className="mt-3 text-xs text-ink-3"><b>Cycle notes:</b> {s.lastTick.notes.join(" · ")}</div> : null}
              </Card>
            )}

            {tab === "history" && (
              <Card title="Trade history" pad={false}>
                {trades.length === 0 ? <div className="p-4"><Empty>No closed trades yet.</Empty></div> : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[720px] text-xs">
                      <thead className="text-left text-ink-3"><tr className="border-b border-line">{["Closed", "Coin", "Side", "Strategy", "Entry", "Exit", "PnL", "R", "Fees", "Reason"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                      <tbody className="num">
                        {trades.slice(0, 200).map((t) => (
                          <tr key={t.id} className="border-b border-line/60">
                            <td className="px-3 py-2">{new Date(t.closedAt).toLocaleString()}</td>
                            <td className="px-3 py-2 font-semibold">{t.coin}</td>
                            <td className={cn("px-3 py-2", t.side === "long" ? "text-bull" : "text-bear")}>{t.side}</td>
                            <td className="px-3 py-2">{t.strategyId}</td>
                            <td className="px-3 py-2">{price(t.entry)}</td>
                            <td className="px-3 py-2">{price(t.exitAvg)}</td>
                            <td className={cn("px-3 py-2 font-semibold", t.pnlUsd >= 0 ? "text-bull" : "text-bear")}>{usd(t.pnlUsd, 3)}</td>
                            <td className="px-3 py-2">{t.r.toFixed(2)}</td>
                            <td className="px-3 py-2">{usd(t.feesUsd, 3)}</td>
                            <td className="px-3 py-2">{t.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}

            {tab === "strategies" && (
              <div className="space-y-4">
                <Card title="Realised performance by strategy" pad={false}>
                  {strat.length === 0 ? <div className="p-4"><Empty>No closed trades yet.</Empty></div> : (
                    <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-xs">
                      <thead className="text-left text-ink-3"><tr className="border-b border-line">{["Strategy", "Trades", "Win rate", "Avg R", "PF", "Net"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                      <tbody className="num">{strat.map((x) => (
                        <tr key={x.id} className="border-b border-line/60"><td className="px-3 py-2">{x.id}</td><td className="px-3 py-2">{x.trades}</td><td className="px-3 py-2">{x.winRate == null ? "—" : `${(x.winRate * 100).toFixed(0)}%`}</td><td className="px-3 py-2">{x.avgR?.toFixed(2) ?? "—"}</td><td className="px-3 py-2">{x.profitFactor == null ? "—" : Number.isFinite(x.profitFactor) ? x.profitFactor.toFixed(2) : "∞"}</td><td className={cn("px-3 py-2 font-semibold", x.netUsd >= 0 ? "text-bull" : "text-bear")}>{usd(x.netUsd, 3)}</td></tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </Card>
                <Card title="Walk-forward validation" subtitle={`Out-of-sample results after fees, slippage and funding. Validated = ≥${s.config.minOosTrades} OOS trades, expectancy ≥ ${s.config.minOosExpectancyR}R, PF ≥ 1.1, beats the benchmark, robust across folds.`} pad={false} right={canControl ? <Button size="sm" variant="ghost" onClick={() => run("reval", { action: "revalidate" }, "Validation cleared.")}>Re-test all</Button> : undefined}>
                  {validated.length === 0 ? <div className="p-4"><Empty>Validation runs in the background during the first cycles (a few minutes).</Empty></div> : (
                    <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-xs">
                      <thead className="text-left text-ink-3"><tr className="border-b border-line">{["Market", "Strategy", "OOS trades", "Exp. R", "PF", "Win", "Bench R", "Robust", "Exit", "Status"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
                      <tbody className="num">{[...validated].sort((a, b) => Number(b.validated) - Number(a.validated) || (b.oosExpectancyR ?? -9) - (a.oosExpectancyR ?? -9)).map((v) => (
                        <tr key={v.key} className="border-b border-line/60" title={v.why}>
                          <td className="px-3 py-2">{v.coin} {v.tf}</td><td className="px-3 py-2">{v.strategyId}</td><td className="px-3 py-2">{v.oosTrades}</td>
                          <td className={cn("px-3 py-2", (v.oosExpectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{v.oosExpectancyR?.toFixed(3) ?? "—"}</td>
                          <td className="px-3 py-2">{v.oosProfitFactor?.toFixed(2) ?? "—"}</td><td className="px-3 py-2">{v.oosWinRate == null ? "—" : `${(v.oosWinRate * 100).toFixed(0)}%`}</td>
                          <td className="px-3 py-2">{v.benchmarkExpectancyR?.toFixed(3) ?? "—"}</td><td className="px-3 py-2">{(v.robustness * 100).toFixed(0)}%</td><td className="px-3 py-2">{v.exitProfile}</td>
                          <td className="px-3 py-2">{v.validated ? <Badge tone="bull">validated</Badge> : <span className="text-ink-3">{v.why.slice(0, 60)}</span>}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  )}
                </Card>
              </div>
            )}

            {tab === "alerts" && (
              <Card title="Risk alerts & events">
                {s.alerts.length === 0 ? <Empty>No alerts.</Empty> : (
                  <ul className="space-y-1.5 text-sm">
                    {s.alerts.slice(0, 100).map((a) => (
                      <li key={a.id} className="flex gap-2">
                        <span className="num w-20 shrink-0 text-xs text-ink-3">{timeAgo(a.at)}</span>
                        <span className={cn("[overflow-wrap:anywhere]", a.level === "critical" && "text-bear", a.level === "warn" && "text-warn")}>{a.level === "critical" && <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />}{a.msg}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}

            {tab === "settings" && <SettingsPanel s={s} env={env} canControl={canControl} busy={!!busy} run={run} onArm={() => setArmOpen(true)} token={token} setToken={(t) => { setToken(t); setTimeout(load, 50); }} />}
          </div>
        </>
      )}

      <Modal open={confirmStop} onClose={() => setConfirmStop(false)} title="STOP ALL">
        <p className="text-sm text-ink-2">This immediately turns automatic trading OFF, blocks new entries and closes <b>every open {mode} position at market</b>.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmStop(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setConfirmStop(false); run("stop", { action: "stop_all" }, "STOP ALL executed."); }}><OctagonX className="h-4 w-4" />Stop everything</Button>
        </div>
      </Modal>
      <ArmModal open={armOpen} onClose={() => setArmOpen(false)} onConfirm={(c) => { setArmOpen(false); run("arm", { action: "arm_live", confirm: c }, "Live trading armed."); }} />
    </div>
  );
}

function TokenForm({ token, onSave }: { token: string; onSave: (t: string) => void }) {
  const [t, setT] = useState(token);
  useEffect(() => setT(token), [token]);
  return (
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); onSave(t.trim()); }}>
      <input type="password" autoComplete="off" className={inputCls} placeholder="ENGINE_ADMIN_TOKEN" value={t} onChange={(e) => setT(e.target.value)} />
      <Button type="submit" variant="primary">Save token</Button>
    </form>
  );
}

function ArmModal({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (c: string) => void }) {
  const [c, setC] = useState("");
  return (
    <Modal open={open} onClose={onClose} title="Arm live trading">
      <div className="space-y-3 text-sm text-ink-2">
        <Notice tone="bear">Real money. Leveraged perpetuals can lose your entire margin quickly. Past or simulated results do not guarantee future results. The engine only trades validated setups and always places a verified stop-loss, but losses will happen.</Notice>
        <p>Type <b className="num">{LIVE_CONFIRM_PHRASE}</b> to confirm:</p>
        <input className={inputCls} value={c} onChange={(e) => setC(e.target.value)} autoComplete="off" />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={c.trim() !== LIVE_CONFIRM_PHRASE} onClick={() => onConfirm(c)}>Arm live</Button>
        </div>
      </div>
    </Modal>
  );
}

function SettingsPanel({ s, env, canControl, busy, run, onArm, token, setToken }: { s: EngineState; env?: EnvInfo; canControl: boolean; busy: boolean; run: (k: string, b: Record<string, unknown>, ok?: string) => void; onArm: () => void; token: string; setToken: (t: string) => void }) {
  const [c, setC] = useState<EngineConfig>(s.config);
  useEffect(() => setC(s.config), [s.config]);
  const set = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K]) => setC((x) => ({ ...x, [k]: v }));
  const keys: (keyof EngineConfig)[] = ["coins", "timeframes", "riskPerTradePct", "maxDailyLossPct", "maxWeeklyDrawdownPct", "maxOpenPositions", "maxTradesPerDay", "cooldownMinAfterLoss", "maxLeverageLive", "simLeverage", "liveMinScore", "paperMinScore", "paperStartingEquity"];
  const patch = Object.fromEntries(keys.filter((k) => JSON.stringify(c[k]) !== JSON.stringify(s.config[k])).map((k) => [k, c[k]]));
  const toggleIn = <T extends string>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Mode & live activation">
        <div className="space-y-3 text-sm">
          <Segmented value={s.config.mode} onChange={(m) => canControl && run("mode", { action: "set_mode", mode: m }, `Mode: ${m}.`)} options={[{ value: "paper", label: "Paper (simulation)" }, { value: "live", label: "Live (Hyperliquid)" }]} />
          <ul className="space-y-1 text-xs text-ink-2">
            <li>{env?.liveEnabled ? "✅" : "⛔"} LIVE_TRADING_ENABLED=true on the server</li>
            <li>{env?.liveConfigured ? "✅" : "⛔"} Hyperliquid API wallet configured {env?.account ? `(${env.account})` : ""}{env?.testnet ? " · testnet" : ""}</li>
            <li>{s.liveArmed ? "✅" : "⛔"} Armed in this dashboard (typed confirmation)</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            {!s.liveArmed ? <Button size="sm" variant="danger" disabled={!canControl || busy || !env?.liveEnabled || !env?.liveConfigured} onClick={onArm}>Arm live trading</Button> : <Button size="sm" disabled={!canControl || busy} onClick={() => run("disarm", { action: "disarm_live" }, "Live disarmed.")}>Disarm live</Button>}
            {s.config.mode === "paper" && <Button size="sm" variant="ghost" disabled={!canControl || busy} onClick={() => run("reset", { action: "reset_paper" }, "Paper account reset.")}>Reset paper account</Button>}
          </div>
          <p className="text-xs text-ink-3">Live uses a Hyperliquid <b>API wallet</b> (can trade, cannot withdraw). Your seed phrase / main private key is never needed. See README → Autopilot.</p>
        </div>
      </Card>
      <Card title="Engine access">
        <TokenForm token={token} onSave={setToken} />
        <p className="mt-2 text-xs text-ink-3">Stored only in this browser. Required for every control action.</p>
      </Card>
      <Card title="Markets" className="lg:col-span-2">
        <div className="space-y-3">
          <Field label="Coins (Hyperliquid perps)">
            <div className="flex flex-wrap gap-1.5">{["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE", "AVAX", "LINK", "SUI", "BNB"].map((x) => <button key={x} onClick={() => set("coins", toggleIn(c.coins, x))} className={cn("rounded-md border px-2 py-1 text-xs", c.coins.includes(x) ? "border-accent/60 bg-accent/15 text-ink" : "border-line-2 text-ink-3")}>{x}</button>)}</div>
          </Field>
          <Field label="Execution timeframes" hint="Higher timeframe confirmation is automatic (15m→1h, 1h→4h).">
            <div className="flex flex-wrap gap-1.5">{(["5m", "15m", "1h"] as const).map((x) => <button key={x} onClick={() => set("timeframes", toggleIn(c.timeframes, x))} className={cn("rounded-md border px-2 py-1 text-xs", c.timeframes.includes(x) ? "border-accent/60 bg-accent/15 text-ink" : "border-line-2 text-ink-3")}>{x}</button>)}</div>
          </Field>
        </div>
      </Card>
      <Card title="Risk limits" className="lg:col-span-2">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <Field label="Risk per trade %"><NumInput value={c.riskPerTradePct} step={0.1} min={0.1} max={1} onChange={(v) => set("riskPerTradePct", v)} /></Field>
          <Field label="Max daily loss %"><NumInput value={c.maxDailyLossPct} step={0.1} min={0.5} max={3} onChange={(v) => set("maxDailyLossPct", v)} /></Field>
          <Field label="Max weekly DD %"><NumInput value={c.maxWeeklyDrawdownPct} step={0.5} min={1} max={10} onChange={(v) => set("maxWeeklyDrawdownPct", v)} /></Field>
          <Field label="Max open positions"><NumInput value={c.maxOpenPositions} step={1} min={1} max={4} onChange={(v) => set("maxOpenPositions", v)} /></Field>
          <Field label="Max trades / day"><NumInput value={c.maxTradesPerDay} step={1} min={1} max={20} onChange={(v) => set("maxTradesPerDay", v)} /></Field>
          <Field label="Cooldown after loss (min)"><NumInput value={c.cooldownMinAfterLoss} step={5} min={0} max={1440} onChange={(v) => set("cooldownMinAfterLoss", v)} /></Field>
          <Field label="Max leverage LIVE" hint="Hard cap 10x"><NumInput value={c.maxLeverageLive} step={1} min={1} max={10} onChange={(v) => set("maxLeverageLive", v)} /></Field>
          <Field label="Leverage PAPER" hint="Up to 40x in simulation"><NumInput value={c.simLeverage} step={1} min={1} max={40} onChange={(v) => set("simLeverage", v)} /></Field>
          <Field label="Min score LIVE"><NumInput value={c.liveMinScore} step={1} min={80} max={100} onChange={(v) => set("liveMinScore", v)} /></Field>
          <Field label="Min score PAPER"><NumInput value={c.paperMinScore} step={1} min={70} max={100} onChange={(v) => set("paperMinScore", v)} /></Field>
          <Field label="Paper start equity $"><NumInput value={c.paperStartingEquity} step={10} min={10} onChange={(v) => set("paperStartingEquity", v)} /></Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" size="sm" disabled={!canControl || busy || Object.keys(patch).length === 0} onClick={() => run("cfg", { action: "set_config", patch }, "Settings saved.")}>Save settings</Button>
          <span className="text-xs text-ink-3">Risk is never increased after losses: the engine halves risk after 3 consecutive losses.</span>
        </div>
      </Card>
    </div>
  );
}
