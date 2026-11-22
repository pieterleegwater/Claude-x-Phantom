"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { getState, setState, useStore } from "@/lib/client/store";
import { useApi } from "@/lib/client/useApi";
import { liveStats, openPositions, reconcile, recordBuy, type LivePosition } from "@/lib/live";
import { useWalletData, WalletButton, shortAddr } from "@/components/wallet";
import { LevelsEditor, SellPanel, StopTracking, LIVE_ENABLED } from "@/components/live";
import { Badge, Button, Card, Empty, Field, Modal, NumInput, Notice, PageHeader, Stat, cn, pct, price, usd } from "@/components/ui";

export default function LivePage() {
  const live = useStore((s) => s.live);
  const w = useWalletData(30_000);
  const open = useMemo(() => openPositions(live), [live]);
  const owner = w.publicKey?.toBase58();
  const mints = useMemo(() => [...new Set([...open.map((p) => p.mint), ...w.tokens.slice(0, 20).map((t) => t.mint)])].slice(0, 30), [open, w.tokens]);
  const px = useApi<Record<string, { priceUsd: number; symbol: string }>>(mints.length ? `/api/memecoins/prices?mints=${mints.join(",")}` : null, 15_000);
  const prices = useMemo(() => Object.fromEntries(Object.entries(px.data ?? {}).map(([k, v]) => [k, v.priceUsd])), [px.data]);
  // only positions held by THIS wallet, and only when every token program loaded
  const balances = useMemo(() => (w.connected && w.complete && !w.loading && !w.error ? Object.fromEntries(open.filter((p) => !p.owner || p.owner === owner).map((p) => [p.mint, w.tokens.find((t) => t.mint === p.mint)?.amount ?? 0])) : {}), [w.connected, w.complete, w.loading, w.error, w.tokens, open, owner]);
  const stats = liveStats(live, prices, balances);
  const [sellFor, setSellFor] = useState<LivePosition | null>(null);
  const [levelsFor, setLevelsFor] = useState<LivePosition | null>(null);
  const [trackFor, setTrackFor] = useState<{ mint: string; symbol: string; amount: number; decimals: number } | null>(null);
  const [synced, setSynced] = useState<string[]>([]);

  // Wallet is the source of truth: record sells done in Phantom / filled Jupiter orders.
  useEffect(() => {
    if (!Object.keys(balances).length || !Object.keys(prices).length) return;
    const r = reconcile(getState().live, balances, prices, Date.now(), owner);
    if (r.changed.length) {
      setState({ live: r.state });
      setSynced(r.changed);
    }
  }, [balances, prices, owner]);

  const untracked = w.tokens.filter((t) => !open.some((p) => p.mint === t.mint) && (t.valueUsd ?? 0) > 0.5);

  return (
    <div>
      <PageHeader
        title="Live Trades"
        subtitle="Your REAL Phantom trades: positions, profit/loss and statistics. Separate from paper trading."
        beginner={<>This page tracks real money. Buys made through EdgePilot are added automatically. Tokens you bought elsewhere (for example in the Phantom app) can be added with <b>Track</b>. Sells you do in Phantom are detected from your wallet balance and recorded at an estimated price.</>}
        right={!w.connected ? <WalletButton label="Connect Phantom" /> : <span className="num text-xs text-ink-3">{w.publicKey ? shortAddr(w.publicKey.toBase58()) : ""}</span>}
      />
      {!LIVE_ENABLED && <div className="mb-3"><Notice tone="info">Live execution is disabled on this deployment — you can track positions but not buy or sell from EdgePilot.</Notice></div>}
      {synced.length > 0 && <div className="mb-3"><Notice tone="info">Updated from your wallet: {synced.join(", ")} (sold outside EdgePilot or a Jupiter order filled — price estimated).</Notice></div>}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-6">
        <Card><Stat label="Open value" value={usd(stats.valueOpen)} sub={`${stats.openCount} open · cost ${usd(stats.investedOpen)}`} /></Card>
        <Card><Stat label="Unrealised" value={usd(stats.unrealized)} tone={stats.unrealized >= 0 ? "bull" : "bear"} sub={stats.investedOpen ? pct((stats.unrealized / stats.investedOpen) * 100) : undefined} /></Card>
        <Card><Stat label="Realised" value={usd(stats.realized)} tone={stats.realized >= 0 ? "bull" : "bear"} /></Card>
        <Card><Stat label="Total PnL" value={usd(stats.totalPnl)} tone={stats.totalPnl >= 0 ? "bull" : "bear"} /></Card>
        <Card><Stat label="Win rate" value={stats.winRate == null ? "—" : `${(stats.winRate * 100).toFixed(0)}%`} sub={`${stats.wins}/${stats.closedCount} closed positions`} /></Card>
        <Card><Stat label="Best / worst" value={<span className="text-sm">{stats.best ? `${stats.best.symbol} ${usd(stats.best.pnl)}` : "—"}</span>} sub={stats.worst ? `${stats.worst.symbol} ${usd(stats.worst.pnl)}` : undefined} /></Card>
      </div>

      <Card className="mt-4" title="Open positions" subtitle="Value uses your wallet balance × live DexScreener price.">
        {open.length === 0 ? (
          <Empty>No tracked positions yet. Buy a token from its Scanner page, or press <b>Track</b> on a token below.</Empty>
        ) : (
          <div className="space-y-3">
            {open.map((p) => {
              const cur = prices[p.mint];
              const qty = balances[p.mint] ?? p.tokens;
              const value = cur != null ? qty * cur : null;
              const pnl = value != null ? value - p.investedUsd : null;
              const tok = w.tokens.find((t) => t.mint === p.mint);
              return (
                <div key={p.mint} className="rounded-lg border border-line p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={`/scanner/${p.mint}`} className="text-sm font-semibold hover:text-accent">{p.symbol}</Link>
                      <div className="text-[11px] text-ink-3">{p.source === "manual" ? "tracked manually" : "bought via EdgePilot"} · since {new Date(p.openedAt).toLocaleDateString()}</div>
                    </div>
                    <div className="text-right">
                      <div className={cn("num text-sm font-semibold", (pnl ?? 0) >= 0 ? "text-bull" : "text-bear")}>{pnl == null ? "—" : usd(pnl)}</div>
                      <div className="num text-[11px] text-ink-3">{pnl != null && p.investedUsd ? pct((pnl / p.investedUsd) * 100) : ""}</div>
                    </div>
                  </div>
                  <div className="num mt-2 grid grid-cols-3 gap-2 text-[11px] sm:grid-cols-6">
                    <div><div className="text-ink-3">Value</div>{usd(value)}</div>
                    <div><div className="text-ink-3">Invested</div>{usd(p.investedUsd)}</div>
                    <div><div className="text-ink-3">Avg entry</div>{price(p.entryPrice)}</div>
                    <div><div className="text-ink-3">Price</div>{price(cur ?? null)}</div>
                    <div><div className="text-ink-3">Stop</div><span className="text-bear">{p.stop ? price(p.stop) : "none"}</span></div>
                    <div><div className="text-ink-3">Targets</div><span className="text-bull">{p.tps.filter((t) => t.status !== "done").map((t) => `${price(t.price)}${t.status === "order" ? "⚡" : ""}`).join(", ") || "none"}</span></div>
                  </div>
                  {!p.stop && <p className="mt-2 text-[11px] text-warn">No stop-loss set — set one so EdgePilot can warn you.</p>}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="bear" onClick={() => setSellFor(p)} disabled={!LIVE_ENABLED}>Sell</Button>
                    <Button size="sm" onClick={() => setLevelsFor(p)}>Stop &amp; targets</Button>
                    <span className="ml-auto"><StopTracking mint={p.mint} /></span>
                  </div>
                  {sellFor?.mint === p.mint && (
                    <Modal open onClose={() => setSellFor(null)} title={`Sell ${p.symbol}`}>
                      <SellPanel mint={p.mint} symbol={p.symbol} balanceRaw={tok?.raw ?? null} decimals={tok?.decimals ?? p.decimals} onDone={() => w.refresh()} />
                    </Modal>
                  )}
                  {levelsFor?.mint === p.mint && (
                    <Modal open onClose={() => setLevelsFor(null)} title={`${p.symbol} — stop-loss & take-profit`}>
                      <LevelsEditor p={p} balanceRaw={tok?.raw ?? null} currentPrice={cur ?? null} />
                    </Modal>
                  )}
                </div>
              );
            })}
            <p className="text-[11px] text-ink-3">⚡ = take-profit order live on Jupiter (executes automatically, even when EdgePilot is closed).</p>
          </div>
        )}
      </Card>

      {w.connected && (
        <Card className="mt-4" title="Wallet tokens not tracked" subtitle="Add tokens you already hold (e.g. bought in Phantom) to track profit/loss and set alerts.">
          {w.loading && !w.tokens.length ? (
            <p className="text-sm text-ink-3">Loading wallet…</p>
          ) : untracked.length === 0 ? (
            <p className="text-sm text-ink-3">{w.error ? `Could not load balances: ${w.error}` : "Nothing else to track."}</p>
          ) : (
            <ul className="divide-y divide-line">
              {untracked.map((t) => (
                <li key={t.mint} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{t.symbol ?? shortAddr(t.mint)} <span className="num text-xs text-ink-3">{usd(t.valueUsd ?? null)}</span></span>
                  <Button size="sm" onClick={() => setTrackFor({ mint: t.mint, symbol: t.symbol ?? shortAddr(t.mint), amount: t.amount, decimals: t.decimals })}>Track</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card className="mt-4" title="Real trade history" subtitle="Buys/sells through EdgePilot, plus sells detected from your wallet (estimated).">
        {live.trades.length === 0 ? (
          <p className="text-sm text-ink-3">No real trades recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {live.trades.slice(0, 100).map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    <Badge tone={t.side === "buy" ? "bull" : "bear"}>{t.side}</Badge>
                    <span className="font-medium">{t.symbol}</span>
                    {t.status === "unconfirmed" && <Badge tone="warn">unconfirmed</Badge>}
                  </div>
                  <div className="num mt-0.5 truncate text-[11px] text-ink-3">
                    {t.tokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} @ {price(t.price)} · {new Date(t.time).toLocaleString()}
                    {t.note ? ` · ${t.note}` : ""}
                  </div>
                  {t.sig && (
                    <a href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent">
                      Solscan <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                <div className="text-right">
                  <div className="num text-sm">{usd(t.usd)}</div>
                  {t.pnlUsd != null && <div className={cn("num text-[11px]", t.pnlUsd >= 0 ? "text-bull" : "text-bear")}>{usd(t.pnlUsd)}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {trackFor && <TrackModal t={trackFor} price={prices[trackFor.mint] ?? null} owner={owner} onClose={() => setTrackFor(null)} />}
    </div>
  );
}

function TrackModal({ t, price: cur, owner, onClose }: { t: { mint: string; symbol: string; amount: number; decimals: number }; price: number | null; owner?: string; onClose: () => void }) {
  const [invested, setInvested] = useState<number | null>(cur ? Math.round(cur * t.amount * 100) / 100 : null);
  return (
    <Modal open onClose={onClose} title={`Track ${t.symbol}`}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">You hold {t.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })} {t.symbol}. How much did you pay in total (USD)? This sets your average entry for profit/loss.</p>
        <Field label="Total invested (USD)" hint={cur ? `Current value ≈ ${usd(cur * t.amount)}. Phantom shows "Geïnvesteerd bedrag" on the token page.` : undefined}>
          <NumInput value={invested} onChange={setInvested} min={0} />
        </Field>
        <Button
          variant="primary"
          disabled={invested == null || invested <= 0}
          onClick={() => {
            setState((s) => ({ live: recordBuy(s.live, { mint: t.mint, symbol: t.symbol, decimals: t.decimals, tokens: t.amount, usd: invested!, sig: null, source: "manual", note: "added manually", owner }) }));
            onClose();
          }}
        >
          Start tracking
        </Button>
      </div>
    </Modal>
  );
}
