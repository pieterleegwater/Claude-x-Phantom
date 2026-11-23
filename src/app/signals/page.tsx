"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useBtcAnalysis, useMemeScan } from "@/lib/client/hooks";
import { logSignal, useStore } from "@/lib/client/store";
import { SignalCard } from "@/components/signal";
import { TrackRecordCard } from "@/components/trackRecord";
import { Card, DataBadge, DirectionBadge, Empty, ErrorBox, PageHeader, Segmented, Skeleton, Term, Badge, price } from "@/components/ui";

export default function SignalsPage() {
  const settings = useStore((s) => s.settings);
  const [tf, setTf] = useState<"15m" | "1h" | "4h">(settings.primaryTimeframe);
  const perp = useBtcAnalysis({ market: "BTC-PERP", tf });
  const spot = useBtcAnalysis({ market: "BTC-SPOT", tf, leverage: 1 });
  const memes = useMemeScan();
  const log = useStore((s) => s.signalLog);

  useEffect(() => {
    for (const s of [perp.analysis?.signal, spot.analysis?.signal]) if (s && s.direction !== "NO_TRADE" && s.direction !== "WAIT") logSignal(s);
  }, [perp.analysis, spot.analysis]);
  const memeSignals = memes.analyses.filter((a) => a.signal.direction === "BUY" || a.signal.direction === "WAIT").slice(0, 6);
  useEffect(() => {
    for (const m of memeSignals) if (m.signal.direction === "BUY") logSignal(m.signal);
  }, [memeSignals]);
  const rejected = memes.analyses.length - memeSignals.length;

  return (
    <div>
      <PageHeader
        title="AI Signals"
        subtitle="Only setups that pass every hard rule become trades. Most of the time the right answer is WAIT or NO TRADE."
        beginner={
          <>
            Each signal has a <Term k="quality">quality score</Term> (how many measurable conditions agree) and, where possible, a <Term k="historical">historical win rate</Term> measured on real data. They are different things: a high score is not a guarantee. Press <b>Why this trade?</b> on any card for a plain-English explanation.
          </>
        }
        right={<Segmented value={tf} onChange={setTf} options={[{ value: "15m", label: "15m" }, { value: "1h", label: "1h" }, { value: "4h", label: "4h" }]} />}
      />
      <div className="grid gap-5 lg:grid-cols-2 lg:gap-4">
        <div className="space-y-2">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-ink-2">BTC Perpetual ({settings.defaultLeverage}x default)</h2>
            <DataBadge meta={perp.primaryMeta} loading={perp.loading} />
          </div>
          {perp.error ? <ErrorBox message={perp.error} onRetry={perp.refresh} /> : perp.analysis ? <SignalCard s={perp.analysis.signal} /> : <Skeleton className="h-72" />}
        </div>
        <div className="space-y-2">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-ink-2">BTC Spot (no leverage, no shorting)</h2>
            <DataBadge meta={spot.primaryMeta} loading={spot.loading} />
          </div>
          {spot.error ? <ErrorBox message={spot.error} onRetry={spot.refresh} /> : spot.analysis ? <SignalCard s={spot.analysis.signal} /> : <Skeleton className="h-72" />}
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-semibold text-ink-2">Solana memecoins — speculative</h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-3">
            <span className="text-xs text-ink-3">{rejected > 0 && `${rejected} scanned tokens rejected`}</span>
            <DataBadge meta={memes.meta} loading={memes.loading} />
          </div>
        </div>
        {memes.error ? (
          <ErrorBox message={memes.error} onRetry={memes.refresh} />
        ) : !memes.data ? (
          <Skeleton className="h-40" />
        ) : memeSignals.length === 0 ? (
          <Empty>
            NO TRADE — none of the {memes.analyses.length} scanned tokens passes the safety and quality rules right now. See the <Link className="text-accent underline" href="/scanner">scanner</Link> for details on each.
          </Empty>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {memeSignals.map((m) => (
              <SignalCard key={m.token.mint} s={m.signal} />
            ))}
          </div>
        )}
      </div>

      <div className="mt-6">
        <TrackRecordCard compact />
      </div>

      <Card className="mt-6" title="Signal log" subtitle="Actionable signals generated in this browser (most recent first).">
        {log.length === 0 ? (
          <p className="text-sm text-ink-3">No actionable signals logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-ink-3">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Asset</th>
                  <th className="px-2 py-1.5 font-medium">Decision</th>
                  <th className="px-2 py-1.5 font-medium">Setup</th>
                  <th className="px-2 py-1.5 text-right font-medium">Score</th>
                  <th className="px-2 py-1.5 text-right font-medium">Entry</th>
                  <th className="px-2 py-1.5 text-right font-medium">Stop</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {log.slice(0, 40).map((s) => (
                  <tr key={s.id}>
                    <td className="px-2 py-1.5 text-ink-3">{new Date(s.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-1.5">
                      {s.asset} <Badge>{s.market}</Badge>
                    </td>
                    <td className="px-2 py-1.5">
                      <DirectionBadge d={s.direction} />
                    </td>
                    <td className="px-2 py-1.5">{s.setupType}</td>
                    <td className="num px-2 py-1.5 text-right">{s.qualityScore}</td>
                    <td className="num px-2 py-1.5 text-right">{s.entry ? price((s.entry.low + s.entry.high) / 2) : "—"}</td>
                    <td className="num px-2 py-1.5 text-right">{price(s.stopLoss)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
