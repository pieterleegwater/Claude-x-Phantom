"use client";
import { use, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Star } from "lucide-react";
import { useApi } from "@/lib/client/useApi";
import { setState, useStore } from "@/lib/client/store";
import { analyzeMeme, type MemeToken } from "@/lib/analysis/memeEngine";
import type { Candle } from "@/lib/types";
import { CandleChart } from "@/components/charts";
import { SignalCard, FactorBreakdown } from "@/components/signal";
import { TxPreview } from "@/components/txPreview";
import { Badge, Card, DataBadge, ErrorBox, Notice, PageHeader, Segmented, Skeleton, Stat, Term, cn, compact, pct } from "@/components/ui";
import { shortAddr } from "@/components/wallet";
import { ema } from "@/lib/indicators";

const catTone = (c: string) => (c === "POSSIBLE RUG" || c === "AVOID" ? "bear" : c === "HIGH RISK" ? "warn" : "bull") as "bear" | "warn" | "bull";

export default function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = use(params);
  const [tf, setTf] = useState<"1m" | "5m" | "15m" | "1h" | "4h">("5m");
  const r = useApi<{ token: MemeToken; candles: Candle[]; decimals: number | null }>(`/api/memecoins/token?mint=${encodeURIComponent(mint)}&tf=${tf}`, 30_000);
  const settings = useStore((s) => s.settings);
  const prevLiq = useStore((s) => s.memeLiquidity[mint]?.liq);
  const watch = useStore((s) => s.watchlist.includes(mint));
  const a = useMemo(() => (r.data ? analyzeMeme(r.data.token, settings, { prevLiquidity: prevLiq }) : null), [r.data, settings, prevLiq]);
  const overlays = useMemo(() => {
    const c = r.data?.candles;
    if (!c?.length) return [];
    return [{ values: ema(c.map((k) => k.close), 20), color: "#8b9cff", title: "EMA20" }];
  }, [r.data]);

  if (r.error) return <ErrorBox message={r.error} onRetry={r.refresh} />;
  if (!r.data || !a) return <Skeleton className="h-[600px]" />;
  const t = r.data.token;
  const risk = t.risk;

  return (
    <div>
      <Link href="/scanner" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
        <ArrowLeft className="h-3 w-3" /> Scanner
      </Link>
      <PageHeader
        title={`${t.symbol} — ${t.name}`}
        subtitle={`${shortAddr(t.mint)} · ${t.dexId} · pair ${shortAddr(t.pairAddress)}`}
        right={
          <>
            <Badge tone={catTone(a.category)} className="px-2 py-1 text-xs">
              {a.category}
            </Badge>
            <button onClick={() => setState((s) => ({ watchlist: watch ? s.watchlist.filter((m) => m !== mint) : [...s.watchlist, mint] }))} className="inline-flex items-center gap-1 rounded-lg border border-line-2 px-2.5 py-1 text-xs">
              <Star className={cn("h-3.5 w-3.5", watch ? "fill-warn text-warn" : "text-ink-3")} /> {watch ? "Watching" : "Watch"}
            </button>
            <a href={t.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent">
              DexScreener <ExternalLink className="h-3 w-3" />
            </a>
            <a href={`https://rugcheck.xyz/tokens/${t.mint}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-accent">
              RugCheck <ExternalLink className="h-3 w-3" />
            </a>
          </>
        }
      />
      {a.critical.length > 0 && (
        <div className="mb-4">
          <Notice tone="bear">
            <b>Critical red flags:</b> {a.critical.join(" ")}
          </Notice>
        </div>
      )}
      <div className="mb-3 xl:hidden">
        <SignalCard s={a.signal} />
      </div>
      <div className="grid gap-3 sm:gap-4 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-4">
          <Card pad={false} title={<span className="flex items-center gap-3">Price (USD) <Segmented size="sm" value={tf} onChange={setTf} options={(["1m", "5m", "15m", "1h", "4h"] as const).map((x) => ({ value: x, label: x }))} /></span>} right={<DataBadge meta={r.meta} loading={r.loading} />}>
            {r.data.candles.length ? <CandleChart candles={r.data.candles} overlays={overlays} height={360} /> : <p className="p-6 text-center text-sm text-ink-3">Pool candles unavailable from GeckoTerminal for this pair.</p>}
          </Card>
          <Card>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
              <Stat label="Price" value={`$${t.priceUsd.toPrecision(5)}`} sub={`${pct(t.priceChange.h1, 1)} 1h · ${pct(t.priceChange.h24, 1)} 24h`} />
              <Stat label={<Term k="liquidity">Liquidity</Term>} value={`$${compact(t.liquidityUsd)}`} sub={a.liquidityChangePct != null ? `${pct(a.liquidityChangePct, 1)} since last scan` : undefined} />
              <Stat label={<Term k="marketcap">Market cap</Term>} value={`$${compact(t.marketCap ?? t.fdv)}`} sub={t.fdv ? `FDV $${compact(t.fdv)}` : undefined} />
              <Stat label="Volume 24h" value={`$${compact(t.volume.h24)}`} sub={`1h $${compact(t.volume.h1)}`} />
              <Stat label="Buys / sells 1h" value={`${t.txns.h1.buys} / ${t.txns.h1.sells}`} sub={`24h ${t.txns.h24.buys} / ${t.txns.h24.sells}`} />
              <Stat label="Holders" value={risk?.totalHolders ? compact(risk.totalHolders) : t.holderCount ? compact(t.holderCount.value) : "—"} sub={risk?.totalHolders ? "RugCheck" : t.holderCount?.source ?? "unavailable"} />
              <Stat label="Top 10 holders" value={risk?.top10Pct != null ? `${risk.top10Pct.toFixed(1)}%` : "—"} tone={risk?.top10Pct != null && risk.top10Pct > 35 ? "warn" : undefined} sub="excluding pools" />
              <Stat label="Dump risk" value={a.dumpRiskTop1 == null ? "unknown" : `−${a.dumpRiskTop1.toFixed(0)}%`} tone={a.dumpRiskTop1 == null || a.dumpRiskTop1 > 40 ? "bear" : undefined} sub={a.dumpRiskTop10 != null ? `if largest holder sells · top 10: −${a.dumpRiskTop10.toFixed(0)}%` : "if largest holder sells"} />
              <Stat label={<Term k="slippage">Est. price impact</Term>} value={`${a.slippagePct.toFixed(2)}%`} sub={`for $${settings.memeTradeSizeUsd} (pool model)`} tone={a.slippagePct > 3 ? "warn" : undefined} />
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Contract & token risk" subtitle={risk?.fetched ? "Source: RugCheck" : "Risk report unavailable"}>
              {!risk?.fetched ? (
                <p className="text-sm text-warn">Could not load RugCheck report{risk?.error ? `: ${risk.error}` : ""}. Treat as high risk.</p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-ink-3"><Term k="mintauthority">Mint authority</Term></div>
                      <div className={risk.mintAuthority ? "font-semibold text-bear" : "text-bull"}>{risk.mintAuthority ? "ENABLED" : risk.mintAuthority === null ? "Revoked" : "Unknown"}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">Freeze authority</div>
                      <div className={risk.freezeAuthority ? "font-semibold text-bear" : "text-bull"}>{risk.freezeAuthority ? "ENABLED" : risk.freezeAuthority === null ? "Revoked" : "Unknown"}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">LP locked/burned</div>
                      <div className={risk.lpLockedPct != null && risk.lpLockedPct < 80 ? "text-warn" : ""}>{risk.lpLockedPct != null ? `${risk.lpLockedPct.toFixed(0)}%` : "Unknown"}</div>
                    </div>
                    <div>
                      <div className="text-ink-3">Insider wallets</div>
                      <div>{risk.insidersDetected ?? "—"}</div>
                    </div>
                  </div>
                  <ul className="space-y-1.5">
                    {risk.risks.length === 0 && <li className="text-ink-3">No risk items reported (this does not mean safe).</li>}
                    {risk.risks.map((x, i) => (
                      <li key={i} className="flex gap-2">
                        <Badge tone={x.level === "danger" ? "bear" : x.level === "warn" ? "warn" : "neutral"}>{x.level}</Badge>
                        <span>
                          <span className="font-medium text-ink">{x.name}</span> <span className="text-ink-3">{x.description}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {risk.topHolders.length > 0 && (
                    <div>
                      <div className="mb-1 text-ink-3">Top holders (excluding liquidity pools)</div>
                      <ul className="space-y-0.5">
                        {risk.topHolders.slice(0, 8).map((h) => (
                          <li key={h.address} className="num flex justify-between">
                            <span>
                              {shortAddr(h.address)} {h.insider && <Badge tone="warn">insider</Badge>}
                            </span>
                            <span>{h.pct.toFixed(2)}%</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </Card>
            <Card title="Score breakdown" subtitle={`${a.score}/100 — memecoin weights`}>
              <FactorBreakdown s={a.signal} />
            </Card>
          </div>
          <Card title="Warnings" subtitle="Everything that could go wrong, as far as the data shows.">
            {a.warnings.length === 0 && a.critical.length === 0 ? (
              <p className="text-sm text-ink-3">No warnings detected — remember checks are incomplete.</p>
            ) : (
              <ul className="list-disc space-y-1 pl-4 text-xs text-ink-2">
                {[...a.critical, ...a.warnings].map((w, i) => (
                  <li key={i} className={i < a.critical.length ? "text-bear" : ""}>
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="min-w-0 space-y-4">
          <div className="hidden xl:block">
            <SignalCard s={a.signal} />
          </div>
          <Card title="Transaction preview" subtitle="Read-only. Shows token, amount, slippage, fees and destination before anything is signed.">
            <TxPreview mint={t.mint} symbol={t.symbol} defaultUsd={Math.min(settings.memeTradeSizeUsd, settings.liveMaxTradeUsd, 500)} />
          </Card>
        </div>
      </div>
    </div>
  );
}
