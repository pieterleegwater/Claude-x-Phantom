"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Star, Search } from "lucide-react";
import { useMemeScan } from "@/lib/client/hooks";
import { setState, useStore } from "@/lib/client/store";
import type { MemeCategory } from "@/lib/analysis/memeEngine";
import { Badge, Button, Card, DataBadge, Empty, ErrorBox, Notice, PageHeader, Segmented, Skeleton, Term, cn, compact, pct, inputCls } from "@/components/ui";
import { useRouter } from "next/navigation";

const CATS: (MemeCategory | "ALL")[] = ["ALL", "EARLY MOMENTUM", "BREAKOUT", "TRENDING", "HIGH RISK", "POSSIBLE RUG", "AVOID"];
const catTone = (c: string) => (c === "POSSIBLE RUG" || c === "AVOID" ? "bear" : c === "HIGH RISK" ? "warn" : "bull") as "bear" | "warn" | "bull";

export default function ScannerPage() {
  const scan = useMemeScan();
  const watchlist = useStore((s) => s.watchlist);
  const [cat, setCat] = useState<(typeof CATS)[number]>("ALL");
  const [sort, setSort] = useState<"score" | "liq" | "vol" | "h1">("score");
  const [q, setQ] = useState("");
  const router = useRouter();

  const rows = useMemo(() => {
    let r = scan.analyses;
    if (cat !== "ALL") r = r.filter((a) => a.category === cat);
    if (q) r = r.filter((a) => a.token.symbol.toLowerCase().includes(q.toLowerCase()) || a.token.mint === q);
    const key = { score: (a: (typeof r)[0]) => a.score, liq: (a: (typeof r)[0]) => a.token.liquidityUsd, vol: (a: (typeof r)[0]) => a.token.volume.h1, h1: (a: (typeof r)[0]) => a.token.priceChange.h1 }[sort];
    return [...r].sort((a, b) => key(b) - key(a));
  }, [scan.analyses, cat, sort, q]);

  const counts = useMemo(() => Object.fromEntries(CATS.map((c) => [c, c === "ALL" ? scan.analyses.length : scan.analyses.filter((a) => a.category === c).length])), [scan.analyses]);
  const toggleWatch = (mint: string) => setState((s) => ({ watchlist: s.watchlist.includes(mint) ? s.watchlist.filter((m) => m !== mint) : [...s.watchlist, mint] }));

  return (
    <div>
      <PageHeader
        title="Memecoin Scanner"
        subtitle="Automated Solana token scan ranked by a transparent score. Red flags override everything."
        beginner={
          <>
            Memecoins are extremely risky — most go to zero. The scanner looks for momentum and <Term k="liquidity">liquidity</Term> and checks for scam signs like enabled <Term k="mintauthority">mint authority</Term>, <Term k="honeypot">honeypot</Term> behaviour and concentrated holders. <b>No check can prove a token is safe.</b> Only ever risk small amounts.
          </>
        }
        right={
          <>
            <DataBadge meta={scan.meta} loading={scan.loading} />
            <Button size="sm" variant="ghost" onClick={scan.refresh}>
              <RefreshCw className={cn("h-3.5 w-3.5", scan.loading && "animate-spin")} />
            </Button>
          </>
        }
      />
      <div className="no-scrollbar -mx-3 mb-3 flex items-center gap-2 overflow-x-auto px-3 sm:mx-0 sm:mb-4 sm:flex-wrap sm:px-0">
        {CATS.map((c) => (
          <button key={c} onClick={() => setCat(c)} className={cn("shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors", cat === c ? "border-accent/60 bg-accent/10 text-ink" : "border-line-2 text-ink-3 hover:text-ink")}>
            {c} <span className="num text-ink-3">{counts[c] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" />
          <input className={cn(inputCls, "pl-8 font-sans")} placeholder="Filter by symbol or paste a mint…" value={q} onChange={(e) => setQ(e.target.value.trim())} />
        </div>
        {q.length >= 32 && (
          <Button size="sm" onClick={() => router.push(`/scanner/${q}`)}>
            Analyse this mint
          </Button>
        )}
                <Segmented size="sm" value={sort} onChange={setSort} options={[{ value: "score", label: "Score" }, { value: "liq", label: "Liquidity" }, { value: "vol", label: "1h volume" }, { value: "h1", label: "1h change" }]} />
      </div>

      {scan.error ? (
        <ErrorBox message={scan.error} onRetry={scan.refresh} />
      ) : !scan.data ? (
        <Skeleton className="h-96" />
      ) : rows.length === 0 ? (
        <Empty>No tokens in this category right now.</Empty>
      ) : (
        <>
        {/* Phones: compact cards */}
        <div className="space-y-2 md:hidden">
          {rows.map((a) => {
            const t = a.token;
            const accel = t.volume.h6 > 0 ? t.volume.h1 / (t.volume.h6 / 6) : 0;
            return (
              <div key={t.mint} className="rounded-xl border border-line bg-panel p-3">
                <div className="flex items-center gap-2.5">
                  <button onClick={() => toggleWatch(t.mint)} aria-label="Watchlist" className="-m-1 p-1">
                    <Star className={cn("h-4 w-4", watchlist.includes(t.mint) ? "fill-warn text-warn" : "text-ink-3")} />
                  </button>
                  <Link href={`/scanner/${t.mint}`} className="flex min-w-0 flex-1 items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {t.imageUrl ? <img src={t.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-full" /> : <span className="h-8 w-8 shrink-0 rounded-full bg-panel-2" />}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-ink">{t.symbol}</span>
                      <span className="block truncate text-[11px] text-ink-3">{t.name}</span>
                    </span>
                  </Link>
                  <div className="text-right">
                    <div className="num text-lg font-semibold leading-none">{a.score}</div>
                    <div className="text-[10px] text-ink-3">score</div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Badge tone={catTone(a.category)}>{a.category}</Badge>
                  <span className={cn("num text-xs", t.priceChange.h1 >= 0 ? "text-bull" : "text-bear")}>{pct(t.priceChange.h1, 1)} 1h</span>
                  <span className={cn("num text-xs", t.priceChange.h24 >= 0 ? "text-bull" : "text-bear")}>{pct(t.priceChange.h24, 0)} 24h</span>
                </div>
                <div className="num mt-2 grid grid-cols-4 gap-2 text-[11px]">
                  <div><div className="text-ink-3">Liq</div>${compact(t.liquidityUsd)}</div>
                  <div><div className="text-ink-3">Mcap</div>${compact(t.marketCap ?? t.fdv)}</div>
                  <div><div className="text-ink-3">Vol 1h</div>${compact(t.volume.h1)}</div>
                  <div><div className="text-ink-3">Accel</div><span className={accel >= 2 ? "text-bull" : ""}>{accel.toFixed(1)}×</span></div>
                </div>
                <p className="mt-2 line-clamp-2 text-[11px] leading-snug">
                  {a.critical[0] ? <span className="text-bear">{a.critical[0]}</span> : a.warnings[0] ? <span className="text-warn">{a.warnings[0]}</span> : <span className="text-ink-3">{a.reasons[0] ?? "—"}</span>}
                </p>
              </div>
            );
          })}
        </div>
        <Card pad={false} className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="border-b border-line bg-panel-2 text-left text-ink-3">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 font-medium">Token</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 text-right font-medium">Liquidity</th>
                  <th className="px-3 py-2 text-right font-medium">Mcap</th>
                  <th className="px-3 py-2 text-right font-medium">Vol 1h</th>
                  <th className="px-3 py-2 text-right font-medium">Accel</th>
                  <th className="px-3 py-2 text-right font-medium">5m / 1h / 24h</th>
                  <th className="px-3 py-2 text-right font-medium">Buys/Sells 1h</th>
                  <th className="px-3 py-2 text-right font-medium">Age</th>
                  <th className="px-3 py-2 font-medium">Why / risks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((a) => {
                  const t = a.token;
                  const accel = t.volume.h6 > 0 ? t.volume.h1 / (t.volume.h6 / 6) : 0;
                  return (
                    <tr key={t.mint} className="hover:bg-panel-2/50">
                      <td className="px-3 py-2">
                        <button onClick={() => toggleWatch(t.mint)} aria-label="Watchlist">
                          <Star className={cn("h-3.5 w-3.5", watchlist.includes(t.mint) ? "fill-warn text-warn" : "text-ink-3")} />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <Link href={`/scanner/${t.mint}`} className="flex items-center gap-2 hover:text-accent">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {t.imageUrl ? <img src={t.imageUrl} alt="" className="h-6 w-6 rounded-full" /> : <span className="h-6 w-6 rounded-full bg-panel-2" />}
                          <span>
                            <span className="block font-semibold text-ink">{t.symbol}</span>
                            <span className="block max-w-[120px] truncate text-[10px] text-ink-3">{t.name}</span>
                          </span>
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={catTone(a.category)}>{a.category}</Badge>
                      </td>
                      <td className="num px-3 py-2 text-right font-semibold">{a.score}</td>
                      <td className="num px-3 py-2 text-right">
                        ${compact(t.liquidityUsd)}
                        {a.liquidityChangePct != null && Math.abs(a.liquidityChangePct) > 5 && <span className={cn("block text-[10px]", a.liquidityChangePct > 0 ? "text-bull" : "text-bear")}>{pct(a.liquidityChangePct, 0)}</span>}
                      </td>
                      <td className="num px-3 py-2 text-right">${compact(t.marketCap ?? t.fdv)}</td>
                      <td className="num px-3 py-2 text-right">${compact(t.volume.h1)}</td>
                      <td className={cn("num px-3 py-2 text-right", accel >= 2 ? "text-bull" : "")}>{accel.toFixed(1)}×</td>
                      <td className="num px-3 py-2 text-right">
                        <span className={t.priceChange.m5 >= 0 ? "text-bull" : "text-bear"}>{pct(t.priceChange.m5, 1)}</span> / <span className={t.priceChange.h1 >= 0 ? "text-bull" : "text-bear"}>{pct(t.priceChange.h1, 1)}</span> / <span className={t.priceChange.h24 >= 0 ? "text-bull" : "text-bear"}>{pct(t.priceChange.h24, 0)}</span>
                      </td>
                      <td className="num px-3 py-2 text-right">
                        {t.txns.h1.buys}/{t.txns.h1.sells}
                      </td>
                      <td className="num px-3 py-2 text-right">{a.ageHours == null ? "—" : a.ageHours < 48 ? `${a.ageHours.toFixed(0)}h` : `${(a.ageHours / 24).toFixed(0)}d`}</td>
                      <td className="max-w-[260px] px-3 py-2">
                        {a.critical[0] ? <span className="line-clamp-2 text-bear">{a.critical[0]}</span> : a.warnings[0] ? <span className="line-clamp-2 text-warn">{a.warnings[0]}</span> : <span className="line-clamp-2 text-ink-3">{a.reasons[0] ?? "—"}</span>}
                        {!t.risk?.fetched && <span className="block text-[10px] text-ink-3">risk report not loaded</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
        </>
      )}
      <div className="mt-4">
        <Notice tone="warn">
          Scores use DexScreener market data and RugCheck contract reports (top 24 candidates by preliminary score get full risk checks). &quot;Whale activity&quot; is a proxy from trade sizes and insider flags, not wallet tracking. Social momentum is not measured because no reliable free source exists. Liquidity change compares with your previous scan (≥15 min ago).
        </Notice>
      </div>
    </div>
  );
}
