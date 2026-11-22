"use client";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { useBtcAnalysis, useMemeScan, useTicker } from "@/lib/client/hooks";
import { useStore } from "@/lib/client/store";
import { stats } from "@/lib/paper";
import { LineChart } from "@/components/charts";
import { Badge, Card, DataBadge, DirectionBadge, ErrorBox, Notice, PageHeader, ScoreRing, Skeleton, Stat, Term, cn, compact, pct, price, timeAgo, usd } from "@/components/ui";

const catTone = (c: string) => (c === "POSSIBLE RUG" || c === "AVOID" ? "bear" : c === "HIGH RISK" ? "warn" : "bull") as "bear" | "warn" | "bull";

export default function Overview() {
  const t = useTicker("BTC");
  const eth = useTicker("ETH", 30_000);
  const sol = useTicker("SOL", 30_000);
  const btc = useBtcAnalysis({ market: "BTC-PERP" });
  const memes = useMemeScan();
  const paper = useStore((s) => s.paper);
  const notifications = useStore((s) => s.notifications);
  const settings = useStore((s) => s.settings);
  const st = stats(paper);
  const sig = btc.analysis?.signal;
  const topMemes = memes.analyses.filter((m) => m.category !== "POSSIBLE RUG" && m.category !== "AVOID").slice(0, 5);
  const rugs = memes.analyses.filter((m) => m.category === "POSSIBLE RUG").length;

  return (
    <div>
      <PageHeader
        title="Overview"
        subtitle="Your market briefing: what the engine sees right now, and what it recommends doing (often: nothing)."
        beginner={
          <>
            Welcome! Start here each day. The <b>BTC signal</b> tells you whether there is a high-quality setup. If it says WAIT or NO TRADE, that is a good outcome — protecting capital is the first job. Practise every idea in <Link className="text-accent underline" href="/paper">Paper Trading</Link> before risking real money. Turn off Beginner mode in the top bar once you know the terms.
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        {[
          { label: "Bitcoin", q: t },
          { label: "Ethereum", q: eth },
          { label: "Solana", q: sol },
        ].map(({ label, q }) => (
          <Card key={label}>
            {q.data ? (
              <Stat label={label} value={`$${price(q.data.price)}`} sub={<span className={cn((q.data.change24hPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>{pct(q.data.change24hPct)} 24h · vol ${compact(q.data.volume24hQuote)}</span>} />
            ) : q.error ? (
              <Stat label={label} value="—" sub={<span className="text-bear">unavailable</span>} />
            ) : (
              <Skeleton className="h-12" />
            )}
            <div className="mt-2 min-w-0">
              <DataBadge meta={q.meta} />
            </div>
          </Card>
        ))}
        <Card>
          <Stat label="Paper account" value={usd(st.equity)} sub={<span className={st.totalPnl >= 0 ? "text-bull" : "text-bear"}>{pct(st.totalPnlPct)} all-time · {usd(st.todayPnl)} today</span>} />
          <div className="mt-2 text-[11px] text-ink-3">{paper.positions.length} open positions · simulated</div>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card title="Bitcoin — engine decision" subtitle={`BTC perpetual · ${btc.tf} · multi-timeframe with ${btc.htf}`} right={<Link href="/signals" className="inline-flex items-center gap-1 text-xs text-accent">All signals <ArrowRight className="h-3 w-3" /></Link>}>
          {btc.error ? (
            <ErrorBox message={btc.error} onRetry={btc.refresh} />
          ) : !sig ? (
            <Skeleton className="h-36" />
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-3">
                <ScoreRing score={sig.qualityScore} size={48} muted={sig.direction === "NO_TRADE"} />
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <DirectionBadge d={sig.direction} large />
                  <span className="text-sm text-ink-2">{sig.setupType}</span>
                </div>
              </div>
              <div className="space-y-2 sm:pl-[60px]">
                <p className="text-sm leading-relaxed">{sig.summary}</p>
                <p className="text-xs leading-relaxed text-ink-3">{sig.explanation.slice(0, 420)}{sig.explanation.length > 420 ? "…" : ""}</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs sm:flex sm:flex-wrap">
                  <span className="text-ink-3">
                    Long score <span className="num text-ink">{btc.analysis?.snapshot.longScore}</span>
                  </span>
                  <span className="text-ink-3">
                    Short score <span className="num text-ink">{btc.analysis?.snapshot.shortScore}</span>
                  </span>
                  <span className="text-ink-3">
                    Regime <span className="text-ink">{String(btc.analysis?.snapshot.regime)}</span>
                  </span>
                  <span className="text-ink-3">
                    Structure <span className="text-ink">{btc.analysis?.structure.label}</span>
                  </span>
                </div>
              </div>
            </div>
          )}
        </Card>

        <Card title="Memecoin radar" subtitle="Top-ranked Solana tokens that are not flagged. Speculative — size small." right={<Link href="/scanner" className="inline-flex items-center gap-1 text-xs text-accent">Scanner <ArrowRight className="h-3 w-3" /></Link>}>
          {memes.error ? (
            <ErrorBox message={memes.error} onRetry={memes.refresh} />
          ) : !memes.data ? (
            <Skeleton className="h-36" />
          ) : (
            <div className="space-y-2">
              {topMemes.length === 0 && <p className="text-sm text-ink-3">No token currently clears the basic risk filters.</p>}
              {topMemes.map((m) => (
                <Link key={m.token.mint} href={`/scanner/${m.token.mint}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-panel-2">
                  <span className="num w-8 text-right text-sm font-semibold">{m.score}</span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.token.symbol}</span>
                  <Badge tone={catTone(m.category)}>{m.category}</Badge>
                  <span className={cn("num w-16 text-right text-xs", m.token.priceChange.h1 >= 0 ? "text-bull" : "text-bear")}>{pct(m.token.priceChange.h1, 1)}</span>
                </Link>
              ))}
              {rugs > 0 && <p className="pt-1 text-xs text-bear">{rugs} scanned tokens flagged POSSIBLE RUG and excluded.</p>}
              <div className="pt-1">
                <DataBadge meta={memes.meta} />
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="mt-3 grid gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-[1.2fr_1fr]">
        <Card title="Paper equity curve" subtitle="Simulated account — real prices, virtual money.">
          {paper.equityHistory.length > 1 ? <LineChart points={paper.equityHistory.map((h) => ({ time: h.t / 1000, value: h.equity }))} baseline={paper.startingBalance} /> : <p className="py-10 text-center text-sm text-ink-3">Open a paper trade to start tracking performance.</p>}
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={<Term k="winrate">Win rate</Term>} value={st.winRate == null ? "—" : `${(st.winRate * 100).toFixed(0)}%`} sub={`${st.closed} closed`} />
            <Stat label={<Term k="profitfactor">Profit factor</Term>} value={st.profitFactor == null ? "—" : Number.isFinite(st.profitFactor) ? st.profitFactor.toFixed(2) : "∞"} />
            <Stat label={<Term k="drawdown">Max drawdown</Term>} value={`${st.maxDrawdownPct.toFixed(1)}%`} tone={st.maxDrawdownPct > 15 ? "bear" : undefined} />
            <Stat label="Avg result" value={st.avgR == null ? "—" : `${st.avgR.toFixed(2)}R`} />
          </div>
        </Card>
        <Card title="Recent alerts">
          {notifications.length === 0 ? (
            <p className="text-sm text-ink-3">No alerts yet. EdgePilot monitors markets while this tab is open.</p>
          ) : (
            <ul className="space-y-2">
              {notifications.slice(0, 7).map((n) => (
                <li key={n.id} className="text-xs">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium text-ink">{n.title}</span>
                    <span className="shrink-0 text-ink-3">{timeAgo(n.time)}</span>
                  </div>
                  <p className="text-ink-3">{n.body}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <Notice tone="info">
              <span className="inline-flex items-center gap-1 font-medium text-ink">
                <ShieldCheck className="h-3.5 w-3.5 text-bull" /> Capital preservation first.
              </span>{" "}
              Risk per trade is capped at {settings.riskPerTradePct}% of your {usd(settings.accountEquity, 0)} account, minimum reward:risk {settings.minRiskReward}, max leverage {settings.maxLeverage}x. Live wallet execution is disabled; EdgePilot never signs transactions for you.
            </Notice>
          </div>
        </Card>
      </div>
    </div>
  );
}
