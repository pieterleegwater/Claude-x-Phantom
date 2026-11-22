"use client";
import { CheckCircle2, XCircle } from "lucide-react";
import { useStore } from "@/lib/client/store";
import { equity, stats, unrealized } from "@/lib/paper";
import { WalletPanel } from "@/components/wallet";
import { LineChart } from "@/components/charts";
import { Card, Notice, PageHeader, ScoreBar, Stat, Term, cn, usd, pct } from "@/components/ui";

export default function PortfolioPage() {
  const paper = useStore((s) => s.paper);
  const settings = useStore((s) => s.settings);
  const st = stats(paper);
  const eq = equity(paper);
  const positions = paper.positions.map((p) => {
    const notional = p.qty * p.lastPrice;
    const riskAtStop = Math.max(0, (p.side === "long" ? p.lastPrice - p.stop : p.stop - p.lastPrice) * p.qty);
    return { p, notional, riskAtStop, pctEq: (notional / eq) * 100, riskPct: (riskAtStop / eq) * 100, u: unrealized(p) };
  });
  const totalNotional = positions.reduce((t, x) => t + x.notional, 0);
  const netNotional = positions.reduce((t, x) => t + (x.p.side === "long" ? x.notional : -x.notional), 0);
  const openRiskPct = positions.reduce((t, x) => t + x.riskPct, 0);
  const effLev = totalNotional / Math.max(eq, 1);
  const largest = positions.reduce((m, x) => Math.max(m, x.pctEq), 0);
  const memeMax = positions.filter((x) => x.p.market === "SOL-MEME").reduce((m, x) => Math.max(m, x.pctEq), 0);
  const dayLossPct = (-Math.min(0, st.todayPnl) / Math.max(eq, 1)) * 100;

  const rules = [
    { label: `Open risk at stops ≤ ${settings.maxOpenRiskPct}% of equity`, ok: openRiskPct <= settings.maxOpenRiskPct, value: `${openRiskPct.toFixed(2)}%` },
    { label: `Effective leverage ≤ ${settings.maxLeverage}x`, ok: effLev <= settings.maxLeverage, value: `${effLev.toFixed(2)}x` },
    { label: `Daily loss < ${settings.dailyLossLimitPct}%`, ok: dayLossPct < settings.dailyLossLimitPct, value: `${dayLossPct.toFixed(2)}%` },
    { label: `Each memecoin ≤ ${settings.memeMaxPositionPct}% of equity`, ok: memeMax <= settings.memeMaxPositionPct * 1.05, value: `${memeMax.toFixed(2)}%` },
    { label: "Every position has a stop-loss", ok: paper.positions.every((p) => p.stop > 0), value: `${paper.positions.length} open` },
    { label: "Drawdown under 20%", ok: st.maxDrawdownPct < 20, value: `${st.maxDrawdownPct.toFixed(1)}%` },
  ];

  return (
    <div>
      <PageHeader
        title="Portfolio & Risk"
        subtitle="Your connected wallet (read-only) and the risk profile of your paper portfolio."
        beginner={<>Professional traders survive by limiting how much they can lose — per trade, per day and in total. This page checks your portfolio against those limits. Green means within limits.</>}
      />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Phantom wallet" subtitle="Read-only: balances and tokens. No signing.">
          <WalletPanel />
        </Card>
        <Card title="Risk rules" subtitle="Configured in Settings → Account & risk.">
          <ul className="space-y-2">
            {rules.map((r) => (
              <li key={r.label} className="flex items-center gap-2 text-sm">
                {r.ok ? <CheckCircle2 className="h-4 w-4 text-bull" /> : <XCircle className="h-4 w-4 text-bear" />}
                <span className="flex-1">{r.label}</span>
                <span className={cn("num text-xs", r.ok ? "text-ink-3" : "text-bear")}>{r.value}</span>
              </li>
            ))}
          </ul>
          {rules.some((r) => !r.ok) && <div className="mt-3"><Notice tone="bear">One or more risk limits are breached. Reduce exposure before opening anything new.</Notice></div>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Card><Stat label="Paper equity" value={usd(eq)} sub={pct(st.totalPnlPct)} /></Card>
        <Card><Stat label="Gross exposure" value={usd(totalNotional, 0)} sub={`net ${usd(netNotional, 0)}`} /></Card>
        <Card><Stat label={<Term k="leverage">Effective leverage</Term>} value={`${effLev.toFixed(2)}x`} tone={effLev > settings.maxLeverage ? "bear" : undefined} /></Card>
        <Card><Stat label="Open risk" value={`${openRiskPct.toFixed(2)}%`} sub="loss if all stops hit" tone={openRiskPct > settings.maxOpenRiskPct ? "bear" : undefined} /></Card>
        <Card><Stat label="Largest position" value={`${largest.toFixed(1)}%`} sub="of equity (notional)" /></Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card title="Exposure by position">
          {positions.length === 0 ? (
            <p className="text-sm text-ink-3">No open paper positions.</p>
          ) : (
            <div className="space-y-3">
              {positions.map((x) => (
                <div key={x.p.id}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span>
                      {x.p.asset} <span className="text-ink-3">{x.p.side} · {x.p.market}{x.p.leverage > 1 ? ` · ${x.p.leverage}x` : ""}</span>
                    </span>
                    <span className="num">{usd(x.notional, 0)} · risk {x.riskPct.toFixed(2)}% · <span className={x.u >= 0 ? "text-bull" : "text-bear"}>{usd(x.u)}</span></span>
                  </div>
                  <ScoreBar score={Math.min(100, x.pctEq)} />
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Equity">
          {paper.equityHistory.length > 1 ? <LineChart points={paper.equityHistory.map((h) => ({ time: h.t / 1000, value: h.equity }))} baseline={paper.startingBalance} /> : <p className="py-8 text-center text-sm text-ink-3">No history yet.</p>}
        </Card>
      </div>
    </div>
  );
}
