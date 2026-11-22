"use client";
import { useMemo, useState } from "react";
import { Play, Trophy, BookOpen } from "lucide-react";
import { STRATEGIES, defaultParams, getStrategy } from "@/lib/strategies";
import { runBacktest, walkForward, alignFunding, DEFAULT_BT, type BacktestResult, type WalkForwardResult, type BacktestConfig } from "@/lib/backtest";
import { apiGet } from "@/lib/client/useApi";
import { setState, useStore } from "@/lib/client/store";
import type { Candle, DataMeta, DerivativesSnapshot } from "@/lib/types";
import { LineChart } from "@/components/charts";
import { Badge, Button, Card, DataBadge, Empty, ErrorBox, Field, NumInput, Notice, PageHeader, Segmented, Select, Stat, Term, cn, pct, price, usd, inputCls } from "@/components/ui";

type Sym = "BTC" | "ETH" | "SOL";
type Tf = "15m" | "1h" | "4h" | "1d";
const TF_DAYS: Record<Tf, number> = { "15m": 60, "1h": 365, "4h": 1095, "1d": 2190 };
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function LabPage() {
  const settings = useStore((s) => s.settings);
  const leaderboard = useStore((s) => s.leaderboard);
  const [stratId, setStratId] = useState(STRATEGIES[0].id);
  const [sym, setSym] = useState<Sym>("BTC");
  const [tf, setTf] = useState<Tf>("1h");
  const [from, setFrom] = useState(isoDay(Date.now() - TF_DAYS["1h"] * 86_400_000));
  const [to, setTo] = useState(isoDay(Date.now()));
  const [mode, setMode] = useState<"single" | "wf">("wf");
  const strat = getStrategy(stratId)!;
  const [params, setParams] = useState<Record<string, number>>(defaultParams(strat));
  const [cfg, setCfg] = useState<BacktestConfig>({ ...DEFAULT_BT, feeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, riskPct: settings.riskPerTradePct });
  const [running, setRunning] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  const [meta, setMeta] = useState<DataMeta>();
  const [result, setResult] = useState<{ single?: BacktestResult; wf?: WalkForwardResult; bars: number; first: number; last: number }>();
  const [ranking, setRanking] = useState<{ id: string; name: string; wf: WalkForwardResult }[]>();

  const chooseStrategy = (id: string) => {
    setStratId(id);
    setParams(defaultParams(getStrategy(id)!));
  };

  async function loadData(): Promise<{ candles: Candle[]; funding?: (number | null)[] }> {
    const f = new Date(from).getTime(), t = new Date(to).getTime() + 86_400_000;
    const r = await apiGet<Candle[]>(`/api/market/history?symbol=${sym}&tf=${tf}&from=${f}&to=${t}`);
    setMeta(r.meta);
    if (r.data.length < 300) throw new Error(`Only ${r.data.length} candles returned — choose a longer range or a lower timeframe (need ≥300).`);
    let funding: (number | null)[] | undefined;
    if (sym === "BTC") {
      try {
        const d = await apiGet<DerivativesSnapshot>("/api/btc/derivatives");
        if (d.data.fundingHistory.length) funding = alignFunding(r.data, d.data.fundingHistory);
      } catch {
        /* funding optional */
      }
    }
    return { candles: r.data, funding };
  }

  const run = async () => {
    setErr(undefined);
    setRunning("Loading historical candles…");
    setResult(undefined);
    try {
      const { candles, funding } = await loadData();
      setRunning(mode === "wf" ? "Running walk-forward optimisation…" : "Running backtest…");
      await new Promise((r) => setTimeout(r, 30));
      const c2 = { ...cfg, funding: sym === "BTC" ? funding : undefined };
      if (mode === "single") {
        const single = runBacktest(candles, strat, params, c2);
        setResult({ single, bars: candles.length, first: candles[0].time, last: candles[candles.length - 1].time });
      } else {
        const wf = walkForward(candles, strat, params, c2, 4);
        setResult({ wf, bars: candles.length, first: candles[0].time, last: candles[candles.length - 1].time });
        saveLb(stratId, wf);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const saveLb = (id: string, wf: WalkForwardResult) => {
    const m = wf.oos.metrics;
    setState((s) => ({
      leaderboard: { ...s.leaderboard, [`${id}:${sym}:${tf}`]: { strategyId: id, symbol: sym, tf, oosExpectancyR: m.expectancyR, oosTrades: m.trades, oosProfitFactor: m.profitFactor, oosReturnPct: m.totalReturnPct, oosMaxDD: m.maxDrawdownPct, robustness: wf.robustness, testedAt: Date.now() } },
    }));
  };

  const compareAll = async () => {
    setErr(undefined);
    setRanking(undefined);
    setRunning("Loading historical candles…");
    try {
      const { candles, funding } = await loadData();
      const out: { id: string; name: string; wf: WalkForwardResult }[] = [];
      for (const s of STRATEGIES) {
        if (s.requiresFunding && !funding) continue;
        setRunning(`Walk-forward: ${s.name}…`);
        await new Promise((r) => setTimeout(r, 20));
        const wf = walkForward(candles, s, defaultParams(s), { ...cfg, funding: sym === "BTC" ? funding : undefined }, 4);
        out.push({ id: s.id, name: s.name, wf });
        saveLb(s.id, wf);
      }
      out.sort((a, b) => score(b.wf) - score(a.wf));
      setRanking(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  };

  const res = result?.single ?? result?.wf?.oos;
  const lbRows = useMemo(() => Object.values(leaderboard).sort((a, b) => (b.oosExpectancyR ?? -9) - (a.oosExpectancyR ?? -9)), [leaderboard]);

  return (
    <div>
      <PageHeader
        title="Strategy Lab"
        subtitle="Test, compare and rank strategies on real historical data with fees, slippage and funding — out-of-sample."
        beginner={
          <>
            A backtest replays a strategy on past prices. Past results never guarantee future ones, and it is easy to fool yourself by tuning a strategy until it looks perfect (<i>overfitting</i>). That&apos;s why the default mode is a <Term k="walkforward">walk-forward test</Term>: parameters are chosen on one period and judged only on the next, unseen period.
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="min-w-0 space-y-4">
          <Card title="Configuration">
            <div className="space-y-3">
              <Field label="Strategy">
                <Select value={stratId} onChange={chooseStrategy} options={STRATEGIES.map((s) => ({ value: s.id, label: s.name }))} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Asset">
                  <Select value={sym} onChange={setSym} options={[{ value: "BTC", label: "BTC/USD" }, { value: "ETH", label: "ETH/USD" }, { value: "SOL", label: "SOL/USD" }]} />
                </Field>
                <Field label="Timeframe">
                  <Select
                    value={tf}
                    onChange={(v) => {
                      setTf(v);
                      setFrom(isoDay(Date.now() - TF_DAYS[v] * 86_400_000));
                    }}
                    options={(["15m", "1h", "4h", "1d"] as Tf[]).map((t) => ({ value: t, label: t }))}
                  />
                </Field>
                <Field label="From">
                  <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </div>
              <p className="text-[11px] text-ink-3">Up to 10,000 candles per test (≈{TF_DAYS[tf]} days on {tf}).</p>
              <Segmented value={mode} onChange={setMode} options={[{ value: "wf", label: "Walk-forward (OOS)" }, { value: "single", label: "Single backtest" }]} />
            </div>
          </Card>
          <Card title="Parameters" subtitle={mode === "wf" ? "In walk-forward mode, parameters with a grid are re-optimised on each in-sample window." : "Fixed for the whole test."}>
            <div className="space-y-3">
              {strat.params.map((p) => (
                <Field key={p.key} label={`${p.label}${p.grid ? ` · grid ${p.grid.join("/")}` : ""}`}>
                  <div className="flex items-center gap-2">
                    <input type="range" min={p.min} max={p.max} step={p.step} value={params[p.key]} onChange={(e) => setParams({ ...params, [p.key]: Number(e.target.value) })} className="flex-1 accent-[#8b9cff]" />
                    <span className="num w-12 text-right text-xs">{params[p.key]}</span>
                  </div>
                </Field>
              ))}
            </div>
          </Card>
          <Card title="Costs & sizing">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Taker fee (bps/side)">
                <NumInput value={cfg.feeBps} onChange={(v) => setCfg({ ...cfg, feeBps: v })} min={0} max={100} />
              </Field>
              <Field label="Slippage (bps/side)">
                <NumInput value={cfg.slippageBps} onChange={(v) => setCfg({ ...cfg, slippageBps: v })} min={0} max={200} />
              </Field>
              <Field label="Risk per trade %">
                <NumInput value={cfg.riskPct} onChange={(v) => setCfg({ ...cfg, riskPct: v })} min={0.1} max={10} />
              </Field>
              <Field label="Max leverage">
                <NumInput value={cfg.maxLeverage} onChange={(v) => setCfg({ ...cfg, maxLeverage: v })} min={1} max={20} />
              </Field>
              <Field label="Funding /8h (bps)" hint="Used when no funding history">
                <NumInput value={cfg.fundingPer8h * 10_000} onChange={(v) => setCfg({ ...cfg, fundingPer8h: v / 10_000 })} min={-10} max={20} />
              </Field>
              <Field label="Start equity">
                <NumInput value={cfg.initialEquity} onChange={(v) => setCfg({ ...cfg, initialEquity: v })} min={100} />
              </Field>
            </div>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={run} disabled={!!running}>
              <Play className="h-3.5 w-3.5" /> Run {mode === "wf" ? "walk-forward" : "backtest"}
            </Button>
            <Button onClick={compareAll} disabled={!!running}>
              <Trophy className="h-3.5 w-3.5" /> Compare all strategies
            </Button>
          </div>
          {running && <p className="animate-pulse-soft text-xs text-ink-2">{running}</p>}
        </div>

        <div className="min-w-0 space-y-4">
          {err && <ErrorBox title="Backtest failed" message={err} />}
          {meta && (
            <div className="flex justify-end">
              <DataBadge meta={meta} />
            </div>
          )}
          {ranking && <Ranking rows={ranking} sym={sym} tf={tf} />}
          {res && result ? (
            <Results res={res} wf={result.wf} bars={result.bars} first={result.first} last={result.last} initial={cfg.initialEquity} name={strat.name} />
          ) : (
            !ranking && <Empty>Configure a test and press Run. Results include equity curve, win rate, profit factor, drawdown, fees, slippage and performance by market regime.</Empty>
          )}
          <Card title="Leaderboard (your walk-forward results)" subtitle="Ranked by out-of-sample expectancy. The AI signal engine reports each live setup's measured history; use this board to judge which strategies deserve trust.">
            {lbRows.length === 0 ? (
              <p className="text-sm text-ink-3">No results yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-ink-3">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Strategy</th>
                      <th className="px-2 py-1.5 font-medium">Market</th>
                      <th className="px-2 py-1.5 text-right font-medium">OOS trades</th>
                      <th className="px-2 py-1.5 text-right font-medium">Exp.</th>
                      <th className="px-2 py-1.5 text-right font-medium">PF</th>
                      <th className="px-2 py-1.5 text-right font-medium">Return</th>
                      <th className="px-2 py-1.5 text-right font-medium">Max DD</th>
                      <th className="px-2 py-1.5 text-right font-medium">Robust</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {lbRows.map((r) => (
                      <tr key={`${r.strategyId}:${r.symbol}:${r.tf}`}>
                        <td className="px-2 py-1.5">{getStrategy(r.strategyId)?.name ?? r.strategyId}</td>
                        <td className="px-2 py-1.5">{r.symbol} {r.tf}</td>
                        <td className="num px-2 py-1.5 text-right">{r.oosTrades}</td>
                        <td className={cn("num px-2 py-1.5 text-right", (r.oosExpectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{r.oosExpectancyR?.toFixed(2) ?? "—"}R</td>
                        <td className="num px-2 py-1.5 text-right">{fmtPf(r.oosProfitFactor)}</td>
                        <td className="num px-2 py-1.5 text-right">{pct(r.oosReturnPct, 1)}</td>
                        <td className="num px-2 py-1.5 text-right">{r.oosMaxDD.toFixed(1)}%</td>
                        <td className="num px-2 py-1.5 text-right">{r.robustness.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Research />
        </div>
      </div>
    </div>
  );
}

const score = (wf: WalkForwardResult) => (wf.oos.metrics.trades < 15 ? -10 : (wf.oos.metrics.expectancyR ?? -10));
const fmtPf = (x: number | null) => (x == null ? "—" : Number.isFinite(x) ? x.toFixed(2) : "∞");

function Ranking({ rows, sym, tf }: { rows: { id: string; name: string; wf: WalkForwardResult }[]; sym: string; tf: string }) {
  return (
    <Card title={`Strategy ranking — ${sym} ${tf}`} subtitle="Out-of-sample only (4 rolling folds, 2:1 in-sample/out-of-sample). Strategies with fewer than 15 OOS trades rank last — not enough evidence.">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-2 py-1.5 font-medium">#</th>
              <th className="px-2 py-1.5 font-medium">Strategy</th>
              <th className="px-2 py-1.5 text-right font-medium">Trades</th>
              <th className="px-2 py-1.5 text-right font-medium">Win</th>
              <th className="px-2 py-1.5 text-right font-medium">PF</th>
              <th className="px-2 py-1.5 text-right font-medium">Exp. (OOS)</th>
              <th className="px-2 py-1.5 text-right font-medium">Exp. (IS)</th>
              <th className="px-2 py-1.5 text-right font-medium">Return</th>
              <th className="px-2 py-1.5 text-right font-medium">Max DD</th>
              <th className="px-2 py-1.5 text-right font-medium" title="% of parameter combinations profitable in-sample">Robust</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r, i) => {
              const m = r.wf.oos.metrics;
              const degr = r.wf.isAvgExpectancyR != null && m.expectancyR != null && r.wf.isAvgExpectancyR > 0 && m.expectancyR < r.wf.isAvgExpectancyR * 0.3;
              return (
                <tr key={r.id}>
                  <td className="num px-2 py-1.5">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    {r.name} {degr && <Badge tone="warn">overfit?</Badge>}
                  </td>
                  <td className="num px-2 py-1.5 text-right">{m.trades}</td>
                  <td className="num px-2 py-1.5 text-right">{m.winRate == null ? "—" : `${(m.winRate * 100).toFixed(0)}%`}</td>
                  <td className="num px-2 py-1.5 text-right">{fmtPf(m.profitFactor)}</td>
                  <td className={cn("num px-2 py-1.5 text-right", (m.expectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{m.expectancyR?.toFixed(2) ?? "—"}R</td>
                  <td className="num px-2 py-1.5 text-right text-ink-3">{r.wf.isAvgExpectancyR?.toFixed(2) ?? "—"}R</td>
                  <td className="num px-2 py-1.5 text-right">{pct(m.totalReturnPct, 1)}</td>
                  <td className="num px-2 py-1.5 text-right">{m.maxDrawdownPct.toFixed(1)}%</td>
                  <td className="num px-2 py-1.5 text-right">{r.wf.robustness.toFixed(0)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">&quot;overfit?&quot; = out-of-sample expectancy fell below 30% of in-sample. Robust = share of parameter combinations that were profitable in-sample (higher = less sensitive to exact settings).</p>
    </Card>
  );
}

function Results({ res, wf, bars, first, last, initial, name }: { res: BacktestResult; wf?: WalkForwardResult; bars: number; first: number; last: number; initial: number; name: string }) {
  const m = res.metrics;
  return (
    <>
      <Card title={`${name} — ${wf ? "walk-forward out-of-sample" : "single backtest"} results`} subtitle={`${bars.toLocaleString()} candles · ${new Date(first * 1000).toLocaleDateString()} → ${new Date(last * 1000).toLocaleDateString()}${wf ? ` · OOS from ${new Date(res.equity[0]?.time * 1000).toLocaleDateString()}` : ""}`}>
        {!wf && <div className="mb-3"><Notice tone="warn">Single backtests are in-sample: if you tuned the parameters on this same period, these numbers are optimistic. Confirm with walk-forward.</Notice></div>}
        {m.trades < 30 && <div className="mb-3"><Notice tone="warn">Only {m.trades} trades — statistically weak. Win-rate 95% CI: {m.winRateCI ? `${(m.winRateCI[0] * 100).toFixed(0)}–${(m.winRateCI[1] * 100).toFixed(0)}%` : "—"}.</Notice></div>}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Total return" value={pct(m.totalReturnPct, 1)} tone={m.totalReturnPct >= 0 ? "bull" : "bear"} sub={`buy & hold ${pct(m.buyHoldReturnPct, 1)}`} />
          <Stat label={<Term k="winrate">Win rate</Term>} value={m.winRate == null ? "—" : `${(m.winRate * 100).toFixed(1)}%`} sub={m.winRateCI ? `CI ${(m.winRateCI[0] * 100).toFixed(0)}–${(m.winRateCI[1] * 100).toFixed(0)}%` : undefined} />
          <Stat label={<Term k="profitfactor">Profit factor</Term>} value={fmtPf(m.profitFactor)} tone={(m.profitFactor ?? 0) > 1 ? "bull" : "bear"} />
          <Stat label={<Term k="drawdown">Max drawdown</Term>} value={`${m.maxDrawdownPct.toFixed(1)}%`} tone={m.maxDrawdownPct > 25 ? "bear" : undefined} />
          <Stat label="Trades" value={m.trades} sub={Number.isFinite(m.exposurePct) ? `${m.exposurePct.toFixed(0)}% time in market` : undefined} />
          <Stat label={<Term k="expectancy">Expectancy</Term>} value={m.expectancyR == null ? "—" : `${m.expectancyR.toFixed(3)}R`} tone={(m.expectancyR ?? 0) > 0 ? "bull" : "bear"} />
          <Stat label="Avg win" value={usd(m.avgWin)} sub={m.avgWinR != null ? `${m.avgWinR.toFixed(2)}R` : undefined} />
          <Stat label="Avg loss" value={usd(m.avgLoss)} sub={m.avgLossR != null ? `${m.avgLossR.toFixed(2)}R` : undefined} />
          <Stat label="Sharpe (ann.)" value={m.sharpe == null ? "n/a" : m.sharpe.toFixed(2)} sub={m.sharpe == null ? "needs ≥30 trades" : "per-bar returns"} />
          <Stat label="Fees paid" value={usd(m.fees, 0)} />
          <Stat label="Slippage cost" value={usd(m.slippage, 0)} />
          <Stat label="Funding" value={usd(m.funding, 0)} />
        </div>
        <div className="mt-4">{res.equity.length > 1 ? <LineChart points={res.equity.map((e) => ({ time: e.time, value: e.equity }))} baseline={initial} height={260} /> : <p className="text-sm text-ink-3">No equity data.</p>}</div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Results by market regime" subtitle="Regime at entry: ADX + EMA200 trend, ATR percentile for high volatility.">
          <table className="w-full text-xs">
            <thead className="text-left text-ink-3">
              <tr>
                <th className="py-1.5 font-medium">Regime</th>
                <th className="py-1.5 text-right font-medium">Trades</th>
                <th className="py-1.5 text-right font-medium">Win</th>
                <th className="py-1.5 text-right font-medium">Exp.</th>
                <th className="py-1.5 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {Object.entries(res.byRegime).map(([k, v]) => (
                <tr key={k}>
                  <td className="py-1.5">{k}</td>
                  <td className="num py-1.5 text-right">{v.trades}</td>
                  <td className="num py-1.5 text-right">{v.winRate == null ? "—" : `${(v.winRate * 100).toFixed(0)}%`}</td>
                  <td className={cn("num py-1.5 text-right", (v.expectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{v.expectancyR?.toFixed(2) ?? "—"}R</td>
                  <td className={cn("num py-1.5 text-right", v.pnl >= 0 ? "text-bull" : "text-bear")}>{usd(v.pnl, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {wf && (
          <Card title="Walk-forward folds" subtitle={`${wf.combosTested} parameter combinations per fold · robustness ${wf.robustness.toFixed(0)}%`}>
            <table className="w-full text-xs">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Fold</th>
                  <th className="py-1.5 font-medium">Chosen params</th>
                  <th className="py-1.5 text-right font-medium">IS exp.</th>
                  <th className="py-1.5 text-right font-medium">OOS exp.</th>
                  <th className="py-1.5 text-right font-medium">OOS trades</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {wf.folds.map((f, i) => (
                  <tr key={i}>
                    <td className="py-1.5">{i + 1}</td>
                    <td className="num py-1.5 text-[10px] text-ink-3">{Object.entries(f.chosen).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                    <td className="num py-1.5 text-right">{f.isExpectancyR?.toFixed(2) ?? "—"}</td>
                    <td className={cn("num py-1.5 text-right", (f.oosExpectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{f.oosExpectancyR?.toFixed(2) ?? "—"}</td>
                    <td className="num py-1.5 text-right">{f.oosTrades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-ink-3">Average expectancy: in-sample {wf.isAvgExpectancyR?.toFixed(2) ?? "—"}R vs out-of-sample {wf.oosAvgExpectancyR?.toFixed(2) ?? "—"}R. A large drop indicates overfitting.</p>
          </Card>
        )}
      </div>
      <Card title="Trades" subtitle="Most recent 100. Entries fill at the next candle's open after the signal; stops checked before targets within a candle.">
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-left text-ink-3">
              <tr>
                <th className="px-2 py-1.5 font-medium">Entry time</th>
                <th className="px-2 py-1.5 font-medium">Side</th>
                <th className="px-2 py-1.5 text-right font-medium">Entry</th>
                <th className="px-2 py-1.5 text-right font-medium">Exit</th>
                <th className="px-2 py-1.5 font-medium">Exit reason</th>
                <th className="px-2 py-1.5 text-right font-medium">R</th>
                <th className="px-2 py-1.5 text-right font-medium">PnL</th>
                <th className="px-2 py-1.5 font-medium">Regime</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {res.trades.slice(-100).reverse().map((t, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5 text-ink-3">{new Date(t.entryTime * 1000).toLocaleString()}</td>
                  <td className="px-2 py-1.5"><Badge tone={t.side === "long" ? "bull" : "bear"}>{t.side}</Badge></td>
                  <td className="num px-2 py-1.5 text-right">{price(t.entry)}</td>
                  <td className="num px-2 py-1.5 text-right">{price(t.exit)}</td>
                  <td className="px-2 py-1.5">{t.exitReason}</td>
                  <td className={cn("num px-2 py-1.5 text-right", t.r > 0 ? "text-bull" : "text-bear")}>{t.r.toFixed(2)}</td>
                  <td className={cn("num px-2 py-1.5 text-right", t.pnl > 0 ? "text-bull" : "text-bear")}>{usd(t.pnl)}</td>
                  <td className="px-2 py-1.5 text-ink-3">{t.regime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function Research() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><BookOpen className="h-4 w-4 text-accent" /> Strategy research notes</span>} subtitle="What each strategy does, the public evidence behind it, and where it fails. Influencer claims and unverified PnL screenshots are deliberately not used as evidence.">
      <div className="space-y-2">
        {STRATEGIES.map((s) => (
          <div key={s.id} className="rounded-lg border border-line">
            <button onClick={() => setOpen(open === s.id ? null : s.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm">
              <span className="font-medium">{s.name}</span>
              <span className="flex items-center gap-2">
                <Badge>{s.family}</Badge>
                <Badge tone={s.evidence.level === "academic" ? "bull" : s.evidence.level === "mixed" ? "info" : "warn"}>{s.evidence.level} evidence</Badge>
              </span>
            </button>
            {open === s.id && (
              <div className="space-y-2 border-t border-line px-3 py-3 text-xs text-ink-2">
                <p>{s.summary}</p>
                <ul className="list-disc pl-4">
                  {s.rules.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
                <p><span className="text-bull">Works best:</span> {s.goodIn} <span className="ml-2 text-bear">Fails:</span> {s.badIn}</p>
                <p className="text-ink-3">{s.evidence.notes}</p>
                <ul className="list-disc pl-4 text-ink-3">
                  {s.evidence.sources.map((src, i) => (
                    <li key={i}>{src.title}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
        <p className="pt-2 text-[11px] leading-relaxed text-ink-3">
          Overfitting defences used here: small parameter grids, rolling walk-forward with unseen out-of-sample windows, minimum trade counts, Wilson confidence intervals, parameter-robustness scores, realistic costs, next-bar-open fills and stop-before-target ambiguity resolution. See also Bailey, Borwein, López de Prado &amp; Zhu (2014), &quot;The Probability of Backtest Overfitting&quot;.
        </p>
      </div>
    </Card>
  );
}
