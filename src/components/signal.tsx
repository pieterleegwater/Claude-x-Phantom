"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { HelpCircle, CheckCircle2, XCircle, AlertTriangle, Sparkles, Clock, FlaskConical } from "lucide-react";
import type { TradeSignal } from "@/lib/types";
import { Badge, Button, Card, DirectionBadge, Modal, Notice, ScoreBar, ScoreRing, Term, cn, pct, price, usd } from "./ui";
import { setState, useStore } from "@/lib/client/store";

export function FactorBreakdown({ s }: { s: TradeSignal }) {
  return (
    <div className="space-y-2.5">
      {s.factors.map((f) => (
        <div key={f.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium text-ink">{f.label}</span>
            <span className="num text-ink-3">
              {f.score == null ? "n/a" : `${f.score}/100`} · weight {(f.weight * 100).toFixed(0)}%
            </span>
          </div>
          <ScoreBar score={f.score} />
          <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{f.detail}</p>
        </div>
      ))}
      <p className="pt-1 text-[11px] text-ink-3">
        Quality score = Σ (factor score × weight). Unavailable factors are excluded and the remaining weights renormalised. The score never overrides a failed hard rule.
      </p>
    </div>
  );
}

export function RulesList({ s }: { s: TradeSignal }) {
  return (
    <ul className="space-y-1.5">
      {s.rules.map((r) => (
        <li key={r.id} className="flex items-start gap-2 text-xs">
          {r.passed ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bull" /> : r.severity === "reject" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-bear" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />}
          <span>
            <span className="font-medium text-ink">{r.label}</span> <span className="text-ink-3">— {r.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EdgeBox({ s }: { s: TradeSignal }) {
  const e = s.historicalEdge;
  if (!e)
    return (
      <div className="rounded-lg border border-line p-3 text-xs text-ink-3">
        <Term k="historical">Historical statistics</Term>: not available for this signal type (e.g. new tokens have no reliable history). Treat the quality score as rule agreement only — not a probability.
      </div>
    );
  return (
    <div className="rounded-lg border border-line p-3 text-xs">
      <div className="mb-2 flex items-center gap-2 font-medium text-ink">
        <FlaskConical className="h-3.5 w-3.5 text-accent" /> Measured history — {e.strategyName}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-ink-3">Trades</div>
          <div className="num text-sm text-ink">{e.trades}</div>
        </div>
        <div>
          <div className="text-ink-3">
            <Term k="winrate">Win rate</Term>
          </div>
          <div className="num text-sm text-ink">{e.winRate == null ? "—" : `${(e.winRate * 100).toFixed(0)}%`}</div>
          {e.winRateLow != null && <div className="num text-[10px] text-ink-3">95% CI {(e.winRateLow * 100).toFixed(0)}–{((e.winRateHigh ?? 0) * 100).toFixed(0)}%</div>}
        </div>
        <div>
          <div className="text-ink-3">
            <Term k="expectancy">Expectancy</Term>
          </div>
          <div className={cn("num text-sm", (e.expectancyR ?? 0) > 0 ? "text-bull" : "text-bear")}>{e.expectancyR == null ? "—" : `${e.expectancyR.toFixed(2)}R`}</div>
        </div>
        <div>
          <div className="text-ink-3">
            <Term k="profitfactor">Profit factor</Term>
          </div>
          <div className="num text-sm text-ink">{e.profitFactor == null ? "—" : Number.isFinite(e.profitFactor) ? e.profitFactor.toFixed(2) : "∞"}</div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-ink-3">{e.note}</p>
    </div>
  );
}

export function PlanTable({ s }: { s: TradeSignal }) {
  const p = s.position;
  const isPerp = s.market === "BTC-PERP";
  const rows: [React.ReactNode, React.ReactNode, string?][] = [];
  if (s.entry) rows.push(["Entry zone", `${price(s.entry.low)} – ${price(s.entry.high)}`]);
  if (s.trigger) rows.push(["Trigger", s.trigger]);
  if (s.stopLoss != null) rows.push([<Term key="sl" k="stoploss">Stop-loss</Term>, `${price(s.stopLoss)}${p ? ` (−${p.stopDistancePct.toFixed(2)}%)` : ""}`, "text-bear"]);
  s.takeProfits.forEach((t, i) => rows.push([<span key={i}><Term k="takeprofit">TP{i + 1}</Term> · close {t.closePct}%</span>, `${price(t.price)} (${t.r.toFixed(2)}R)`, "text-bull"]));
  if (s.riskReward != null) rows.push([<Term key="rr" k="riskreward">Blended R:R</Term>, `${s.riskReward.toFixed(2)} : 1`]);
  if (p) {
    rows.push(["Position size", `${p.quantity.toPrecision(4)} ${s.asset} (${usd(p.notionalUsd)})`]);
    rows.push(["Risk if stopped", `${usd(p.riskUsd)} (${((p.riskUsd / p.accountEquity) * 100).toFixed(2)}% of account)`]);
    if (isPerp) {
      rows.push([<Term key="lev" k="leverage">Leverage (selected)</Term>, `${p.leverage}x · margin ${usd(p.marginUsd)}`]);
      if (p.suggestedLeverage) rows.push(["Suggested leverage", `${p.suggestedLeverage.leverage}x — ${p.suggestedLeverage.reason}`]);
      rows.push([<Term key="liq" k="liquidation">Est. liquidation</Term>, p.liquidationPrice ? `${price(p.liquidationPrice)} (${p.liquidationDistancePct?.toFixed(2)}% away)` : "None (1x)", "text-warn"]);
      if (p.fundingUsdEstimate != null) rows.push([<Term key="f" k="funding">Funding estimate</Term>, `${usd(p.fundingUsdEstimate)} over expected hold`]);
    }
    rows.push(["Fees (round trip)", usd(p.feesUsd)]);
  }
  return (
    <div className="divide-y divide-line rounded-lg border border-line text-xs">
      {rows.map(([k, v, cls], i) => (
        <div key={i} className="flex items-start justify-between gap-4 px-3 py-2">
          <span className="shrink-0 text-ink-3">{k}</span>
          <span className={cn("num text-right text-ink", cls)}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function AiExplain({ s }: { s: TradeSignal }) {
  const code = useStore((st) => st.aiAccessCode);
  const [text, setText] = useState<string>();
  const [err, setErr] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const ask = async () => {
    setLoading(true);
    setErr(undefined);
    try {
      const payload = {
        question: q || undefined,
        signal: {
          asset: s.asset,
          market: s.market,
          direction: s.direction,
          setupType: s.setupType,
          timeframe: s.timeframe,
          price: s.price,
          entry: s.entry,
          trigger: s.trigger,
          stopLoss: s.stopLoss,
          takeProfits: s.takeProfits,
          riskReward: s.riskReward,
          qualityScore: s.qualityScore,
          factors: s.factors.map((f) => ({ label: f.label, score: f.score, weight: f.weight, detail: f.detail.slice(0, 500) })),
          rules: s.rules.map((r) => ({ label: r.label, passed: r.passed, detail: r.detail.slice(0, 400), severity: r.severity })),
          historicalEdge: s.historicalEdge ? { trades: s.historicalEdge.trades, winRate: s.historicalEdge.winRate, expectancyR: s.historicalEdge.expectancyR, note: s.historicalEdge.note } : null,
          reasons: s.reasons.slice(0, 15).map((x) => x.slice(0, 500)),
          risks: s.risks.slice(0, 25).map((x) => x.slice(0, 500)),
          summary: s.summary.slice(0, 600),
          position: s.position ? { leverage: s.position.leverage, riskUsd: s.position.riskUsd, notionalUsd: s.position.notionalUsd, liquidationPrice: s.position.liquidationPrice, warnings: s.position.warnings.slice(0, 10) } : null,
        },
      };
      const res = await fetch("/api/ai/explain", { method: "POST", headers: { "content-type": "application/json", ...(code ? { "x-access-code": code } : {}) }, body: JSON.stringify(payload) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      setText(j.text);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-ink">
        <Sparkles className="h-3.5 w-3.5 text-accent" /> Ask the AI analyst (optional)
      </div>
      <div className="flex gap-2">
        <input className="h-8 flex-1 rounded-md border border-line-2 bg-bg px-2 text-xs outline-none focus:border-accent/60" placeholder="e.g. Why is the stop placed there?" value={q} onChange={(e) => setQ(e.target.value)} maxLength={500} />
        <Button size="sm" variant="primary" onClick={ask} disabled={loading}>
          {loading ? "Thinking…" : "Explain"}
        </Button>
      </div>
      {err && <p className="mt-2 text-xs text-warn">{err}</p>}
      {text && <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-2">{text}</p>}
      <p className="mt-2 text-[10px] text-ink-3">The AI only explains the engine&apos;s numbers — it cannot change the decision or add data.</p>
    </div>
  );
}

export function WhyModal({ s, open, onClose }: { s: TradeSignal; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={`Why ${s.direction.replace("_", " ")}? — ${s.asset} · ${s.setupType}`} wide>
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-ink">{s.explanation}</p>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-4">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
                <Term k="quality">Quality score</Term> breakdown — {s.qualityScore}/100
              </h4>
              <FactorBreakdown s={s} />
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Hard rules</h4>
              <RulesList s={s} />
            </div>
            <EdgeBox s={s} />
            {(s.entry || s.trigger) && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">Trade plan</h4>
                <PlanTable s={s} />
              </div>
            )}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <ListBlock title="Reasons for" items={s.reasons} tone="bull" />
          <ListBlock title="How it could fail" items={s.risks} tone="bear" />
          <ListBlock title="Invalidated if" items={s.invalidation} tone="warn" />
        </div>
        <AiExplain s={s} />
        <p className="text-[11px] text-ink-3">
          Data: {s.dataSources.join(", ") || "—"} · Generated {new Date(s.createdAt).toLocaleString()} · Expires {new Date(s.expiresAt).toLocaleString()}. Not financial advice. Quality score ≠ probability of profit.
        </p>
      </div>
    </Modal>
  );
}

function ListBlock({ title, items, tone }: { title: string; items: string[]; tone: "bull" | "bear" | "warn" }) {
  return (
    <div className="rounded-lg border border-line p-3">
      <h4 className={cn("mb-2 text-xs font-semibold uppercase tracking-wider", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-warn")}>{title}</h4>
      {items.length ? (
        <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-ink-2">
          {items.slice(0, 10).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-3">—</p>
      )}
    </div>
  );
}

export function SignalCard({ s, compact }: { s: TradeSignal; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const expired = Date.now() > s.expiresAt;
  const actionable = (s.direction === "LONG" || s.direction === "SHORT" || s.direction === "BUY") && !expired;
  const paperTrade = () => {
    setState({
      ticket: {
        market: s.market,
        asset: s.asset,
        priceKey: s.market === "SOL-MEME" ? (s.id.split("-")[1] ?? s.asset) : "BTC",
        side: s.direction === "SHORT" ? "short" : "long",
        stop: s.stopLoss,
        takeProfits: s.takeProfits.map((t) => ({ price: t.price, closePct: t.closePct })),
        leverage: s.position?.leverage ?? 1,
        qty: s.position?.quantity ?? null,
        setup: s.setupType,
        signalId: s.id,
      },
    });
    router.push("/paper");
  };
  return (
    <Card className={cn(expired && "opacity-70")}>
      <div className="flex items-center gap-3">
        <ScoreRing score={s.qualityScore} size={46} muted={s.direction === "NO_TRADE"} label={s.direction === "NO_TRADE" ? "Market condition score — no qualifying setup, so this is not a trade score" : undefined} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <DirectionBadge d={s.direction} large />
          <span className="min-w-0 max-w-full truncate text-sm font-semibold">{s.asset}</span>
          <Badge>{s.market}</Badge>
          <Badge>{s.timeframe}</Badge>
          {expired && <Badge tone="warn">expired</Badge>}
        </div>
      </div>
      <div className="sm:pl-[58px]">
        <div>
          <p className="mt-3 text-sm leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{s.summary}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
            <span>Setup: {s.setupType}</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" /> expires {new Date(s.expiresAt).toLocaleTimeString()}
            </span>
            {s.historicalEdge && s.historicalEdge.trades > 0 && (
              <span>
                History: {s.historicalEdge.trades} trades, {s.historicalEdge.winRate != null ? `${(s.historicalEdge.winRate * 100).toFixed(0)}% win` : ""} {s.historicalEdge.expectancyR != null ? `· ${s.historicalEdge.expectancyR.toFixed(2)}R avg` : ""}
              </span>
            )}
          </div>
        </div>
      </div>
      {!compact && (s.entry || s.trigger) && (
        <div className="mt-4">
          <PlanTable s={s} />
        </div>
      )}
      {!compact && s.position?.warnings.length ? (
        <div className="mt-3 space-y-2">
          {s.position.warnings.map((w, i) => (
            <Notice key={i} tone={w.startsWith("DANGER") || w.startsWith("EXTREME") ? "bear" : "warn"}>
              {w}
            </Notice>
          ))}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          <HelpCircle className="h-3.5 w-3.5" /> Why this trade?
        </Button>
        {actionable && (
          <Button size="sm" variant="primary" onClick={paperTrade}>
            Paper trade this
          </Button>
        )}
        {s.market !== "SOL-MEME" && s.price ? <span className="num ml-auto self-center text-xs text-ink-3">at {price(s.price)}</span> : null}
        {s.market === "SOL-MEME" && s.position ? <span className="num ml-auto self-center text-xs text-ink-3">max size {usd(s.position.notionalUsd)} · {pct(-s.position.stopDistancePct, 0)} stop</span> : null}
      </div>
      <WhyModal s={s} open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
