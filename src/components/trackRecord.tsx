"use client";
import Link from "next/link";
import { useMemeTrackRecord } from "@/lib/client/hooks";
import { Badge, Card, Term, cn, pct, price } from "./ui";

/** Measured results of past scanner BUY signals (forward test on real pool candles). */
export function TrackRecordCard({ compact }: { compact?: boolean }) {
  const { stats: st, outcomes, pending, horizonHours } = useMemeTrackRecord();
  return (
    <Card title="Scanner track record (forward test)" subtitle={`Every BUY signal is re-checked on real pool candles: did it reach TP1 before the stop within ${horizonHours}h? This — not the quality score — tells you whether the scanner works.`}>
      {st.total === 0 ? (
        <p className="text-sm text-ink-3">{pending ? `${pending} BUY signal(s) logged — results appear 15 minutes after each signal.` : "No BUY signals logged yet. They are recorded automatically while EdgePilot is open."}</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3"><Term k="winrate">TP1 before stop</Term></div>
              <div className={cn("num mt-1 text-lg font-semibold", (st.hitRate ?? 0) >= 0.5 ? "text-bull" : "text-bear")}>{st.hitRate == null ? "—" : `${(st.hitRate * 100).toFixed(0)}%`}</div>
              <div className="num text-[11px] text-ink-3">{st.tp1}/{st.resolved} finished{st.hitRateCI ? ` · CI ${(st.hitRateCI[0] * 100).toFixed(0)}–${(st.hitRateCI[1] * 100).toFixed(0)}%` : ""}</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Avg result</div>
              <div className={cn("num mt-1 text-lg font-semibold", (st.avgExitPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>{pct(st.avgExitPct, 1)}</div>
              <div className="text-[11px] text-ink-3">per signal, mechanical</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">One-candle crashes</div>
              <div className={cn("num mt-1 text-lg font-semibold", st.gapCrashes ? "text-bear" : "")}>{st.gapCrashes}</div>
              <div className="text-[11px] text-ink-3">fell through the stop</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Still running</div>
              <div className="num mt-1 text-lg font-semibold">{st.open + pending}</div>
              <div className="text-[11px] text-ink-3">worst {pct(st.worstExitPct, 0)}</div>
            </div>
          </div>
          {st.resolved < 30 && (
            <p className="rounded-lg border border-warn/30 bg-warn-soft/40 p-2.5 text-xs text-ink-2">
              Only {st.resolved} finished signals — not enough to judge the scanner. Treat memecoin signals as unproven and use paper trading until there are at least 30.
            </p>
          )}
          {!compact && (
            <ul className="divide-y divide-line">
              {outcomes.slice(0, 12).map((o) => (
                <li key={o.signalId} className="flex items-center justify-between gap-3 py-2 text-xs">
                  <div className="min-w-0">
                    <Link href={`/scanner/${o.mint}`} className="font-medium text-ink hover:text-accent">{o.symbol}</Link>
                    <span className="ml-2 text-ink-3">score {o.score} · {new Date(o.time).toLocaleString()}</span>
                    <div className="num text-[11px] text-ink-3">entry {price(o.entry)} · max +{o.maxGainPct.toFixed(0)}% / {o.maxDrawdownPct.toFixed(0)}%</div>
                  </div>
                  <div className="text-right">
                    <Badge tone={o.status === "tp1" ? "bull" : o.status === "stop" ? "bear" : o.status === "expired" ? "neutral" : "warn"}>{o.status === "tp1" ? "TP1 hit" : o.status === "stop" ? (o.gapCrash ? "crashed" : "stopped") : o.status === "expired" ? "24h close" : "running"}</Badge>
                    <div className={cn("num mt-0.5", (o.exitPct ?? 0) >= 0 ? "text-bull" : "text-bear")}>{o.exitPct == null ? "" : pct(o.exitPct, 1)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
