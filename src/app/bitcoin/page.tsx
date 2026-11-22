"use client";
import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useBtcAnalysis } from "@/lib/client/hooks";
import { useApi } from "@/lib/client/useApi";
import { useStore } from "@/lib/client/store";
import type { Candle, Timeframe } from "@/lib/types";
import { ema, rsi, sessionVwap, rollingVwap, atr } from "@/lib/indicators";
import { planPosition, suggestLeverage } from "@/lib/risk";
import { CandleChart, type Overlay, type PriceLineDef } from "@/components/charts";
import { SignalCard } from "@/components/signal";
import { Badge, Button, Card, DataBadge, ErrorBox, Field, NumInput, Notice, PageHeader, Segmented, Skeleton, Stat, Term, cn, pct, price, usd, compact } from "@/components/ui";

const CHART_TFS: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export default function BitcoinPage() {
  const settings = useStore((s) => s.settings);
  const [market, setMarket] = useState<"BTC-PERP" | "BTC-SPOT">("BTC-PERP");
  const [tf, setTf] = useState<"15m" | "1h" | "4h">(settings.primaryTimeframe);
  const [chartTf, setChartTf] = useState<Timeframe>("1h");
  const [leverage, setLeverage] = useState(settings.defaultLeverage);
  const a = useBtcAnalysis({ market, tf, leverage: market === "BTC-PERP" ? leverage : 1 });
  const chart = useApi<Candle[]>(`/api/market/candles?symbol=BTC&tf=${chartTf}&limit=500`, chartTf === "1m" ? 15_000 : 60_000);
  const sig = a.analysis?.signal;

  const overlays = useMemo<Overlay[]>(() => {
    const c = chart.data;
    if (!c?.length) return [];
    const cl = c.map((k) => k.close);
    return [
      { values: ema(cl, 20), color: "#8b9cff", title: "EMA20" },
      { values: ema(cl, 50), color: "#f59e0b", title: "EMA50" },
      { values: ema(cl, 200), color: "#e879f9", title: "EMA200", width: 2 },
      { values: chartTf === "1d" ? rollingVwap(c, 20) : sessionVwap(c), color: "#38bdf8", title: "VWAP" },
    ];
  }, [chart.data, chartTf]);

  const priceLines = useMemo<PriceLineDef[]>(() => {
    const out: PriceLineDef[] = [];
    if (sig?.entry) out.push({ price: (sig.entry.low + sig.entry.high) / 2, color: "#8b9cff", title: "Entry" });
    if (sig?.stopLoss) out.push({ price: sig.stopLoss, color: "#ef4444", title: "Stop" });
    sig?.takeProfits.forEach((t, i) => out.push({ price: t.price, color: "#22c55e", title: `TP${i + 1}`, dashed: true }));
    if (sig?.position?.liquidationPrice) out.push({ price: sig.position.liquidationPrice, color: "#f59e0b", title: "Liq (est.)", dashed: true });
    const levels = a.analysis?.levels ?? [];
    const close = a.analysis?.snapshot.close as number | undefined;
    if (close) {
      const above = levels.filter((l) => l.price > close).slice(0, 2);
      const below = levels.filter((l) => l.price < close).slice(-2);
      for (const l of [...above, ...below]) out.push({ price: l.price, color: l.price > close ? "rgba(239,68,68,0.45)" : "rgba(34,197,94,0.45)", title: `${l.price > close ? "R" : "S"} ×${l.touches}`, dashed: true });
    }
    return out;
  }, [sig, a.analysis]);

  return (
    <div>
      <PageHeader
        title="Bitcoin Terminal"
        subtitle="Spot & perpetual futures analysis with mandatory risk calculations."
        beginner={
          <>
            This page analyses Bitcoin across timeframes. <Term k="perp">Perpetual futures</Term> let you go long or short with <Term k="leverage">leverage</Term>; <Term k="spot">spot</Term> means simply buying BTC. Whatever leverage you pick, the position size is calculated so a stop-loss only loses your chosen % of the account.
          </>
        }
        right={
          <>
            <Segmented value={market} onChange={setMarket} options={[{ value: "BTC-PERP", label: "Perp" }, { value: "BTC-SPOT", label: "Spot" }]} />
            <Segmented value={tf} onChange={setTf} options={[{ value: "15m", label: "15m" }, { value: "1h", label: "1h" }, { value: "4h", label: "4h" }]} />
            <Button size="sm" variant="ghost" onClick={a.refresh}>
              <RefreshCw className={cn("h-3.5 w-3.5", a.loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-4">
          <Card
            pad={false}
            title={
              <span className="flex flex-wrap items-center gap-3">
                BTC/USD <Segmented size="sm" value={chartTf} onChange={setChartTf} options={CHART_TFS.map((t) => ({ value: t, label: t }))} />
              </span>
            }
            right={<DataBadge meta={chart.meta} loading={chart.loading} />}
          >
            {chart.error ? (
              <div className="p-4">
                <ErrorBox message={chart.error} onRetry={chart.refresh} />
              </div>
            ) : chart.data ? (
              <CandleChart candles={chart.data} overlays={overlays} priceLines={priceLines} height={440} />
            ) : (
              <Skeleton className="m-4 h-[420px]" />
            )}
            <div className="flex flex-wrap gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-3">
              <span><span className="text-[#8b9cff]">━</span> EMA20</span>
              <span><span className="text-[#f59e0b]">━</span> EMA50</span>
              <span><span className="text-[#e879f9]">━</span> EMA200</span>
              <span><span className="text-[#38bdf8]">━</span> VWAP {chartTf === "1d" ? "(20-bar rolling)" : "(UTC session)"}</span>
              <span>Dashed: support/resistance (×touches), targets, est. liquidation</span>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <IndicatorPanel a={a} />
            <DerivativesPanel a={a} />
          </div>
          <MultiTimeframe />
          <Scenarios a={a} leverage={market === "BTC-PERP" ? leverage : 1} />
          <StrategyStatus a={a} />
        </div>

        <div className="min-w-0 space-y-4">
          {market === "BTC-PERP" && <LeverageSelector leverage={leverage} setLeverage={setLeverage} max={settings.maxLeverage} />}
          {a.error ? <ErrorBox title="Analysis unavailable" message={a.error} onRetry={a.refresh} /> : sig ? <SignalCard s={sig} /> : <Skeleton className="h-80" />}
          <RiskCalculator defaultPrice={(a.analysis?.snapshot.close as number) ?? null} leverage={market === "BTC-PERP" ? leverage : 1} perp={market === "BTC-PERP"} />
          {a.analysis && <LiqZones a={a} />}
        </div>
      </div>
    </div>
  );
}

type A = ReturnType<typeof useBtcAnalysis>;

function LeverageSelector({ leverage, setLeverage, max }: { leverage: number; setLeverage: (n: number) => void; max: number }) {
  const presets = [1, 2, 3, 5, 10, 20, 50, 100].filter((x) => x <= max);
  return (
    <Card title={<Term k="leverage">Leverage</Term>} subtitle={`Max allowed by your settings: ${max}x`}>
      <div className="flex items-center gap-3">
        <input type="range" min={1} max={max} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="flex-1 accent-[#8b9cff]" />
        <span className={cn("num w-14 text-right text-lg font-semibold", leverage >= 20 ? "text-bear" : leverage > 10 ? "text-warn" : "text-ink")}>{leverage}x</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {presets.map((p) => (
          <button key={p} onClick={() => setLeverage(p)} className={cn("num rounded-md border px-2 py-0.5 text-xs", p === leverage ? "border-accent text-accent" : "border-line-2 text-ink-3 hover:text-ink")}>
            {p}x
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-3">Leverage never comes from the confidence score. It only changes margin and liquidation distance — risk is fixed by your stop and risk-per-trade setting.</p>
      {leverage >= 20 && <div className="mt-2"><Notice tone="bear">At {leverage}x, a {(100 / leverage).toFixed(1)}% move against you liquidates the position. Normal BTC hourly wicks are often larger.</Notice></div>}
    </Card>
  );
}

function IndicatorPanel({ a }: { a: A }) {
  const s = a.analysis?.snapshot;
  return (
    <Card title="Indicators" subtitle={`${a.tf} closed candles`} right={<DataBadge meta={a.primaryMeta} loading={a.loading} />}>
      {!s ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label={<Term k="ema">EMA 20</Term>} value={price(s.ema20 as number)} sub={(s.close as number) > (s.ema20 as number) ? "price above" : "price below"} />
          <Stat label="EMA 50" value={price(s.ema50 as number)} sub={(s.close as number) > (s.ema50 as number) ? "price above" : "price below"} />
          <Stat label="EMA 200" value={price(s.ema200 as number)} sub={(s.close as number) > (s.ema200 as number) ? "long-term uptrend" : "long-term downtrend"} tone={(s.close as number) > (s.ema200 as number) ? "bull" : "bear"} />
          <Stat label={<Term k="rsi">RSI 14</Term>} value={(s.rsi14 as number).toFixed(1)} tone={(s.rsi14 as number) > 70 ? "warn" : (s.rsi14 as number) < 30 ? "warn" : undefined} sub={(s.rsi14 as number) > 70 ? "stretched up" : (s.rsi14 as number) < 30 ? "stretched down" : "neutral zone"} />
          <Stat label={<Term k="atr">ATR 14</Term>} value={price(s.atr14 as number)} sub={`${(s.atrPct as number).toFixed(2)}% of price`} />
          <Stat label={<Term k="vwap">VWAP</Term>} value={price(s.vwap as number)} sub={(s.close as number) > (s.vwap as number) ? "above VWAP" : "below VWAP"} />
          <Stat label="ADX 14" value={(s.adx14 as number).toFixed(1)} sub={(s.adx14 as number) > 25 ? "trending" : "weak trend"} />
          <Stat label="Rel. volume" value={`${(s.relVolume as number).toFixed(2)}×`} sub="vs 20-bar avg" />
          <Stat label="Regime" value={<span className="text-sm">{String(s.regime)}</span>} sub={a.analysis?.structure.label} />
        </div>
      )}
    </Card>
  );
}

function DerivativesPanel({ a }: { a: A }) {
  const d = a.derivatives;
  return (
    <Card title="Derivatives positioning" subtitle="BTC perpetuals" right={<DataBadge meta={a.derivMeta} />}>
      {a.derivError && !d ? (
        <ErrorBox message={a.derivError} />
      ) : !d ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Stat label={<Term k="funding">Funding (8h eq.)</Term>} value={d.funding8h == null ? "—" : `${(d.funding8h * 100).toFixed(4)}%`} tone={d.funding8h != null && Math.abs(d.funding8h) > 0.0005 ? "warn" : undefined} sub={d.funding8h == null ? "unavailable" : d.funding8h > 0 ? "longs pay shorts" : "shorts pay longs"} />
          <Stat label={<Term k="oi">Open interest</Term>} value={d.openInterestUsd ? `$${compact(d.openInterestUsd)}` : d.openInterestBase ? `${compact(d.openInterestBase)} BTC` : "—"} sub={d.openInterestChangePct24h != null ? `${pct(d.openInterestChangePct24h)} 24h` : "24h change unavailable"} />
          <Stat label="Long/short ratio" value={d.longShortRatio?.toFixed(2) ?? "—"} sub={d.longShortSource ?? "unavailable"} />
          <Stat label="Liquidations 24h" value={d.liquidations24h ? `${usd(d.liquidations24h.longUsd, 0)} L` : "—"} sub={d.liquidations24h ? `${usd(d.liquidations24h.shortUsd, 0)} shorts · ${d.liquidations24h.source}` : "needs COINGLASS_API_KEY"} />
          <div className="col-span-2 text-[11px] text-ink-3">Funding venue: {d.venue}{d.fundingIntervalHours ? ` (pays every ${d.fundingIntervalHours}h; normalised to 8h)` : ""}. {d.fundingHistory.length} funding datapoints loaded for backtests.</div>
        </div>
      )}
    </Card>
  );
}

function trendOf(c: Candle[]) {
  const cl = c.map((k) => k.close);
  const i = cl.length - 1;
  const e20 = ema(cl, 20)[i], e50 = ema(cl, 50)[i], e200 = ema(cl, 200)[i];
  const r = rsi(cl, 14)[i];
  let score = 0;
  if (Number.isFinite(e200)) score += cl[i] > e200 ? 1 : -1;
  score += e20 > e50 ? 1 : -1;
  score += cl[i] > e20 ? 1 : -1;
  return { trend: score >= 2 ? "Bullish" : score <= -2 ? "Bearish" : "Neutral", rsi: r, aboveE200: Number.isFinite(e200) ? cl[i] > e200 : null };
}

function MtfRow({ tf }: { tf: Timeframe }) {
  const r = useApi<Candle[]>(`/api/market/candles?symbol=BTC&tf=${tf}&limit=300`, 120_000);
  const t = r.data ? trendOf(r.data.slice(0, -1)) : null;
  return (
    <tr>
      <td className="px-3 py-2 font-medium">{tf}</td>
      <td className="px-3 py-2">{t ? <Badge tone={t.trend === "Bullish" ? "bull" : t.trend === "Bearish" ? "bear" : "neutral"}>{t.trend}</Badge> : r.error ? <span className="text-bear">error</span> : "…"}</td>
      <td className="num px-3 py-2">{t ? t.rsi.toFixed(1) : "—"}</td>
      <td className="px-3 py-2">{t?.aboveE200 == null ? "—" : t.aboveE200 ? "Above" : "Below"}</td>
    </tr>
  );
}

function MultiTimeframe() {
  return (
    <Card title="Multi-timeframe alignment" subtitle="Trades are higher quality when timeframes agree.">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-3 py-1.5 font-medium">Timeframe</th>
              <th className="px-3 py-1.5 font-medium">Trend (EMA 20/50/200)</th>
              <th className="px-3 py-1.5 font-medium">RSI 14</th>
              <th className="px-3 py-1.5 font-medium">vs EMA200</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(["15m", "1h", "4h", "1d"] as Timeframe[]).map((t) => (
              <MtfRow key={t} tf={t} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Scenarios({ a, leverage }: { a: A; leverage: number }) {
  const settings = useStore((s) => s.settings);
  const an = a.analysis;
  if (!an) return null;
  const c = an.closedCandles;
  const close = c[c.length - 1].close;
  const atrNow = atr(c, 14)[c.length - 1];
  const mk = (side: "long" | "short") => {
    const swing = side === "long" ? an.structure.lastLow?.price : an.structure.lastHigh?.price;
    let stop = side === "long" ? close - 1.5 * atrNow : close + 1.5 * atrNow;
    if (swing && (side === "long" ? swing < close && close - swing < 3 * atrNow : swing > close && swing - close < 3 * atrNow)) stop = side === "long" ? swing - 0.25 * atrNow : swing + 0.25 * atrNow;
    const risk = Math.abs(close - stop);
    const s = side === "long" ? 1 : -1;
    const plan = planPosition({ equity: settings.accountEquity, riskPct: settings.riskPerTradePct, entry: close, stop, side, leverage, takerFeeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, maintenanceMarginRate: settings.maintenanceMarginRate, funding8h: a.derivatives?.funding8h, expectedHoldHours: 24 });
    return { side, stop, tp1: close + s * 2 * risk, tp2: close + s * 3 * risk, plan, score: side === "long" ? (an.snapshot.longScore as number) : (an.snapshot.shortScore as number) };
  };
  const rows = [mk("long"), mk("short")];
  return (
    <Card title="Long / short scenarios" subtitle="Hypothetical plans at the current price — NOT signals. Use them to understand the risk of each side.">
      <div className="grid gap-4 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.side} className={cn("rounded-lg border p-3", r.side === "long" ? "border-bull/25" : "border-bear/25")}>
            <div className="mb-2 flex items-center justify-between">
              <Badge tone={r.side === "long" ? "bull" : "bear"}>{r.side}</Badge>
              <span className="text-xs text-ink-3">factor score {r.score}/100</span>
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-ink-3">Entry</dt>
              <dd className="num text-right">{price(close)}</dd>
              <dt className="text-ink-3">Stop</dt>
              <dd className="num text-right text-bear">{price(r.stop)}</dd>
              <dt className="text-ink-3">TP1 / TP2</dt>
              <dd className="num text-right text-bull">{price(r.tp1)} / {price(r.tp2)}</dd>
              <dt className="text-ink-3">Size</dt>
              <dd className="num text-right">{r.plan.quantity.toFixed(4)} BTC</dd>
              <dt className="text-ink-3">Margin ({r.plan.leverage}x)</dt>
              <dd className="num text-right">{usd(r.plan.marginUsd)}</dd>
              <dt className="text-ink-3">Risk</dt>
              <dd className="num text-right">{usd(r.plan.riskUsd)} ({((r.plan.riskUsd / settings.accountEquity) * 100).toFixed(2)}%)</dd>
              <dt className="text-ink-3">Liquidation</dt>
              <dd className="num text-right text-warn">{r.plan.liquidationPrice ? `${price(r.plan.liquidationPrice)} (${r.plan.liquidationDistancePct?.toFixed(1)}%)` : "none"}</dd>
            </dl>
            {r.plan.warnings.slice(0, 2).map((w, i) => (
              <p key={i} className="mt-2 text-[11px] text-warn">{w}</p>
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

function StrategyStatus({ a }: { a: A }) {
  const st = a.analysis?.strategies;
  if (!st) return null;
  return (
    <Card title="Strategy engine status" subtitle={`Every strategy evaluated on the latest closed ${a.tf} candle, with its measured performance on the loaded history (default parameters, after costs).`}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-ink-3">
            <tr>
              <th className="px-2 py-1.5 font-medium">Strategy</th>
              <th className="px-2 py-1.5 font-medium">Now</th>
              <th className="px-2 py-1.5 text-right font-medium">Trades</th>
              <th className="px-2 py-1.5 text-right font-medium">Win</th>
              <th className="px-2 py-1.5 text-right font-medium">PF</th>
              <th className="px-2 py-1.5 text-right font-medium">Exp.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {st.map((s) => (
              <tr key={s.strategy.id}>
                <td className="px-2 py-2">{s.strategy.name}</td>
                <td className="px-2 py-2">
                  {!s.available ? (
                    <span className="text-ink-3" title={s.unavailableReason}>n/a</span>
                  ) : s.triggered ? (
                    <Badge tone={s.triggered.side === "long" ? "bull" : "bear"}>{s.triggered.side} signal</Badge>
                  ) : s.forming ? (
                    <Badge tone="warn">forming</Badge>
                  ) : (
                    <span className="text-ink-3">no setup</span>
                  )}
                </td>
                <td className="num px-2 py-2 text-right">{s.metrics.trades}</td>
                <td className="num px-2 py-2 text-right">{s.metrics.winRate == null ? "—" : `${(s.metrics.winRate * 100).toFixed(0)}%`}</td>
                <td className="num px-2 py-2 text-right">{s.metrics.profitFactor == null ? "—" : Number.isFinite(s.metrics.profitFactor) ? s.metrics.profitFactor.toFixed(2) : "∞"}</td>
                <td className={cn("num px-2 py-2 text-right", (s.metrics.expectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{s.metrics.expectancyR == null ? "—" : `${s.metrics.expectancyR.toFixed(2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">These are in-sample numbers on ~1,000 candles. Use the Strategy Lab for longer, walk-forward (out-of-sample) tests before trusting any strategy.</p>
    </Card>
  );
}

function LiqZones({ a }: { a: A }) {
  const close = a.analysis!.snapshot.close as number;
  const zones = a.analysis!.liqZones.filter((z) => Math.abs(z.price - close) / close < 0.12).sort((x, y) => y.price - x.price).slice(0, 12);
  return (
    <Card title="Modelled liquidation zones" subtitle="Estimate: where traders entering at recent swing points with 10–100x would be liquidated. Not observed exchange data.">
      <ul className="space-y-1 text-xs">
        {zones.map((z, i) => (
          <li key={i} className="flex justify-between">
            <span className={z.side === "short-liqs" ? "text-bull" : "text-bear"}>{z.side === "short-liqs" ? "Short liqs" : "Long liqs"} · {z.leverage}x</span>
            <span className="num">{price(z.price)} <span className="text-ink-3">({pct(((z.price - close) / close) * 100, 1)})</span></span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RiskCalculator({ defaultPrice, leverage, perp }: { defaultPrice: number | null; leverage: number; perp: boolean }) {
  const settings = useStore((s) => s.settings);
  const [side, setSide] = useState<"long" | "short">("long");
  const [entry, setEntry] = useState<number | null>(null);
  const [stop, setStop] = useState<number | null>(null);
  const [tp, setTp] = useState<number | null>(null);
  const [risk, setRisk] = useState(settings.riskPerTradePct);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const e = entry ?? (defaultPrice ? r2(defaultPrice) : null);
  const s = stop ?? (e ? r2(side === "long" ? e * 0.985 : e * 1.015) : null);
  const valid = e && s && (side === "long" ? s < e : s > e);
  const plan = valid ? planPosition({ equity: settings.accountEquity, riskPct: risk, entry: e!, stop: s!, side, leverage, takerFeeBps: settings.takerFeeBps, slippageBps: settings.slippageBps, maintenanceMarginRate: settings.maintenanceMarginRate }) : null;
  const sugg = plan && perp ? suggestLeverage({ equity: settings.accountEquity, notionalUsd: plan.notionalUsd, stopDistancePct: plan.stopDistancePct, maxLeverage: settings.maxLeverage, mmr: settings.maintenanceMarginRate }) : null;
  const rr = plan && tp && e && s ? Math.abs(tp - e) / Math.abs(e - s) : null;
  return (
    <Card title="Risk calculator" subtitle={`Account ${usd(settings.accountEquity, 0)} · fees ${settings.takerFeeBps}bps · slippage ${settings.slippageBps}bps`}>
      <div className="space-y-3">
        <Segmented value={side} onChange={setSide} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Entry">
            <NumInput value={e} onChange={setEntry} />
          </Field>
          <Field label="Stop-loss">
            <NumInput value={s} onChange={setStop} />
          </Field>
          <Field label="Take-profit (optional)">
            <NumInput value={tp} onChange={setTp} />
          </Field>
          <Field label="Risk % of account">
            <NumInput value={risk} onChange={setRisk} min={0.1} max={5} />
          </Field>
        </div>
        {!valid ? (
          <p className="text-xs text-warn">Stop must be below entry for a long, above entry for a short.</p>
        ) : (
          plan && (
            <div className="space-y-2">
              <div className="divide-y divide-line rounded-lg border border-line text-xs">
                {[
                  ["Position size", `${plan.quantity.toFixed(5)} BTC`],
                  ["Notional", usd(plan.notionalUsd)],
                  ["Leverage", `${plan.leverage}x`],
                  ["Margin required", usd(plan.marginUsd)],
                  ["Risk in dollars", usd(plan.riskUsd)],
                  ["Risk % of account", `${((plan.riskUsd / settings.accountEquity) * 100).toFixed(2)}%`],
                  ["Stop distance", `${plan.stopDistancePct.toFixed(2)}%`],
                  ["Est. liquidation", plan.liquidationPrice ? `${price(plan.liquidationPrice)} (${plan.liquidationDistancePct?.toFixed(2)}% away)` : "None"],
                  ["Fees (round trip)", usd(plan.feesUsd)],
                  ...(rr ? [["Reward:risk", `${rr.toFixed(2)} : 1`]] : []),
                  ...(sugg ? [["Suggested leverage", `${sugg.leverage}x — ${sugg.reason}`]] : []),
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                    <span className="text-ink-3">{k}</span>
                    <span className="num text-right">{v}</span>
                  </div>
                ))}
              </div>
              {plan.capped && <Notice tone="warn">{plan.capped}</Notice>}
              {plan.warnings.map((w, i) => (
                <Notice key={i} tone={w.startsWith("DANGER") || w.startsWith("EXTREME") ? "bear" : "warn"}>
                  {w}
                </Notice>
              ))}
            </div>
          )
        )}
      </div>
    </Card>
  );
}

