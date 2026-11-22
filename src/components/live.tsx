"use client";
// Real-money trade management UI. Every action builds an UNSIGNED transaction that the user
// approves in their wallet. Nothing here signs or sells automatically.
import { useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { apiGet } from "@/lib/client/useApi";
import { getState, setState, useStore } from "@/lib/client/store";
import { simulateAndSend, waitForConfirmation } from "@/lib/client/solanaTx";
import { recordSell, setLevels, removePosition, type LivePosition, type LiveTP } from "@/lib/live";
import { Button, Field, Modal, NumInput, Notice, cn, price, usd } from "./ui";
import { WalletButton } from "./wallet";

export const LIVE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LIVE_EXECUTION === "true";

interface SellQuote {
  outSol: number;
  outUsd: number;
  minOutSol: number;
  priceImpactPct: number;
  slippageBps: number;
  route: { label: string; percent: number }[];
}

function pctOfRaw(raw: string, pct: number): string {
  if (pct >= 100) return raw;
  const v = (BigInt(raw) * BigInt(Math.round(pct * 100))) / BigInt(10_000);
  return v.toString();
}

/** Sell a percentage of a token held in the wallet (token → SOL via Jupiter). */
export function SellPanel({ mint, symbol, balanceRaw, decimals, defaultPct = 100, onDone }: { mint: string; symbol: string; balanceRaw: string | null; decimals: number | null; defaultPct?: number; onDone?: () => void }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [pct, setPct] = useState(defaultPct);
  const [slip, setSlip] = useState(150);
  const [q, setQ] = useState<SellQuote>();
  const [err, setErr] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  if (!wallet.connected)
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-line p-3 text-sm text-ink-2">
        <span>Connect Phantom to sell (on iPhone: open EdgePilot inside the Phantom app).</span>
        <WalletButton label="Connect" />
      </div>
    );
  if (!balanceRaw || balanceRaw === "0" || decimals == null) return <p className="text-sm text-ink-3">No {symbol} balance found in the connected wallet.</p>;
  const amountRaw = pctOfRaw(balanceRaw, pct);
  const tokens = Number(amountRaw) / 10 ** decimals;

  const preview = async () => {
    setErr(undefined);
    setStatus(undefined);
    setBusy(true);
    try {
      const r = await apiGet<SellQuote>(`/api/swap/sell-quote?inputMint=${mint}&amountRaw=${amountRaw}&slippageBps=${slip}`);
      setQ(r.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!wallet.publicKey || !q) return;
    setBusy(true);
    setErr(undefined);
    try {
      setStatus("Building unsigned sell transaction…");
      const res = await fetch("/api/swap/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ side: "sell", inputMint: mint, amountRaw, slippageBps: slip, userPublicKey: wallet.publicKey.toBase58() }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const sig = await simulateAndSend(j.swapTransaction, connection, wallet, setStatus);
      setStatus("Submitted — waiting for confirmation…");
      const conf = await waitForConfirmation(connection, sig);
      if (conf === "failed") throw new Error(`Transaction failed on-chain (${sig.slice(0, 8)}…). Nothing was sold.`);
      const outUsd = (Number(j.quote.outAmount) / 1e9) * j.solPriceUsd;
      setState((s) => ({ live: recordSell(s.live, { mint, tokens, usd: outUsd, sig, status: conf === "confirmed" ? "confirmed" : "unconfirmed" }), liveAlert: s.liveAlert?.mint === mint ? null : s.liveAlert }));
      setStatus(conf === "confirmed" ? `Sold ✔ ${sig.slice(0, 8)}…` : `Submitted ${sig.slice(0, 8)}… — not confirmed yet, check Phantom.`);
      setQ(undefined);
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {[25, 50, 75, 100].map((p) => (
          <button key={p} onClick={() => { setPct(p); setQ(undefined); }} className={cn("num rounded-md border px-3 py-1.5 text-sm", pct === p ? "border-accent text-accent" : "border-line-2 text-ink-3")}>
            {p}%
          </button>
        ))}
      </div>
      <p className="num text-xs text-ink-2">
        Sell {tokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} {symbol} → SOL · max slippage{" "}
        <select className="bg-transparent text-ink" value={slip} onChange={(e) => { setSlip(Number(e.target.value)); setQ(undefined); }}>
          {[50, 100, 150, 300, 500].map((b) => (
            <option key={b} value={b}>{b / 100}%</option>
          ))}
        </select>
      </p>
      <Button onClick={preview} disabled={busy || !LIVE_ENABLED}>Preview sell</Button>
      {!LIVE_ENABLED && <p className="text-xs text-ink-3">Live execution is disabled on this deployment.</p>}
      {q && (
        <div className="space-y-2">
          <div className="divide-y divide-line rounded-lg border border-line text-xs">
            {[
              ["You sell", `${tokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}`],
              ["You receive (quoted)", `${q.outSol.toFixed(5)} SOL ≈ ${usd(q.outUsd)}`],
              ["Minimum received", `${q.minOutSol.toFixed(5)} SOL`],
              ["Price impact", `${q.priceImpactPct.toFixed(2)}%`],
              ["Route", q.route.map((r) => `${r.label} ${r.percent}%`).join(" → ")],
              ["Destination", "Your connected wallet"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 px-3 py-1.5">
                <span className="text-ink-3">{k}</span>
                <span className={cn("num text-right", k === "Price impact" && q.priceImpactPct > 3 && "text-warn")}>{v}</span>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-xs text-ink-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" /> I checked the amount and accept the price impact and slippage.
          </label>
          <Button variant="bear" className="w-full" disabled={!ack || busy} onClick={execute}>
            Sell — approve in Phantom
          </Button>
        </div>
      )}
      {status && <p className="text-xs text-ink-2">{status}</p>}
      {err && <p className="text-xs text-bear">{err}</p>}
    </div>
  );
}

/** Edit stop-loss and take-profit levels; optionally place a TP as an on-chain Jupiter limit order. */
export function LevelsEditor({ p, balanceRaw, currentPrice }: { p: LivePosition; balanceRaw: string | null; currentPrice: number | null }) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const [stop, setStop] = useState<number | null>(p.stop);
  const [tps, setTps] = useState<LiveTP[]>(p.tps.length ? p.tps : [{ price: p.entryPrice * 2, pct: 50, status: "planned" }]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState<number | null>(null);

  const save = (nextTps = tps, nextStop = stop) => {
    if (nextStop != null && currentPrice != null && nextStop >= currentPrice) return setMsg({ ok: false, text: "Stop must be below the current price." });
    setState((s) => ({ live: setLevels(s.live, p.mint, { stop: nextStop, tps: nextTps }) }));
    setMsg({ ok: true, text: "Saved. EdgePilot will alert you (while open) when a level is hit." });
  };

  const placeOrder = async (i: number) => {
    const tp = tps[i];
    if (!wallet.publicKey || !balanceRaw || p.decimals == null) return;
    setBusy(i);
    setMsg(undefined);
    try {
      const amountRaw = pctOfRaw(balanceRaw, tp.pct);
      const res = await fetch("/api/trigger/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: p.mint, amountRaw, decimals: p.decimals, targetPriceUsd: tp.price, maker: wallet.publicKey.toBase58(), expiresInDays: 30 }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const sig = await simulateAndSend(j.transaction, connection, wallet, (t) => setMsg({ ok: true, text: t }));
      const conf = await waitForConfirmation(connection, sig);
      if (conf === "failed") throw new Error("Order transaction failed on-chain — no order was placed.");
      const next = tps.map((t, k) => (k === i ? { ...t, status: "order" as const, order: j.order } : t));
      setTps(next);
      setState((s) => ({ live: setLevels(s.live, p.mint, { tps: next }) }));
      setMsg({ ok: true, text: `Take-profit order placed on Jupiter: sells for ≥ ${usd(j.usdcOut)} USDC. It executes even when EdgePilot is closed. Expires in 30 days.` });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const cancelOrder = async (i: number) => {
    const tp = tps[i];
    if (!wallet.publicKey || !tp.order) return;
    setBusy(i);
    try {
      const res = await fetch("/api/trigger/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ maker: wallet.publicKey.toBase58(), order: tp.order }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const sig = await simulateAndSend(j.transaction, connection, wallet, (t) => setMsg({ ok: true, text: t }));
      await waitForConfirmation(connection, sig);
      const next = tps.map((t, k) => (k === i ? { ...t, status: "planned" as const, order: undefined } : t));
      setTps(next);
      setState((s) => ({ live: setLevels(s.live, p.mint, { tps: next }) }));
      setMsg({ ok: true, text: "Order cancelled; tokens return to your wallet." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const orderValue = (tp: LiveTP) => (balanceRaw && p.decimals != null ? (Number(pctOfRaw(balanceRaw, tp.pct)) / 10 ** p.decimals) * tp.price : null);

  return (
    <div className="space-y-4">
      <Field label="Stop-loss price (USD)" hint={`Entry ${price(p.entryPrice)}${currentPrice ? ` · now ${price(currentPrice)}` : ""}. Alert + one-tap sell when hit (app must be open).`}>
        <div className="flex gap-2">
          <NumInput value={stop} onChange={setStop} />
          <Button size="sm" variant="ghost" onClick={() => setStop(p.entryPrice * 0.8)}>−20%</Button>
          <Button size="sm" variant="ghost" onClick={() => { setStop(null); save(tps, null); }}>None</Button>
        </div>
      </Field>
      <div className="space-y-2">
        <div className="text-xs font-medium text-ink-2">Take-profit targets</div>
        {tps.map((t, i) => {
          const val = orderValue(t);
          return (
            <div key={i} className="rounded-lg border border-line p-2.5">
              <div className="flex items-end gap-2">
                <Field label="Price (USD)"><NumInput value={t.price} onChange={(v) => setTps(tps.map((x, k) => (k === i ? { ...x, price: v } : x)))} /></Field>
                <Field label="Sell %"><NumInput className="w-20" value={t.pct} min={1} max={100} onChange={(v) => setTps(tps.map((x, k) => (k === i ? { ...x, pct: v } : x)))} /></Field>
                {t.status !== "order" && (
                  <button className="mb-2 text-ink-3 hover:text-bear" onClick={() => setTps(tps.filter((_, k) => k !== i))} aria-label="Remove target"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                <span className={cn("rounded px-1.5 py-0.5", t.status === "order" ? "bg-bull-soft text-bull" : t.status === "done" ? "bg-panel-2 text-ink-3" : "bg-warn-soft text-warn")}>
                  {t.status === "order" ? "Order live on Jupiter (automatic)" : t.status === "done" ? "Done" : "Alert only"}
                </span>
                {val != null && <span className="num text-ink-3">≈ {usd(val)} at target</span>}
                {LIVE_ENABLED && t.status === "planned" && (
                  <Button size="sm" onClick={() => placeOrder(i)} disabled={busy !== null || val == null || val < 5} title={val != null && val < 5 ? "Jupiter needs ≈$5 minimum per order" : undefined}>
                    {busy === i ? "…" : "Make automatic (Jupiter order)"}
                  </Button>
                )}
                {t.status === "order" && <Button size="sm" variant="danger" onClick={() => cancelOrder(i)} disabled={busy !== null}>{busy === i ? "…" : "Cancel order"}</Button>}
              </div>
              {val != null && val < 5 && t.status === "planned" && <p className="mt-1 text-[11px] text-ink-3">Too small for an automatic Jupiter order (≈$5 minimum) — EdgePilot will alert you instead.</p>}
            </div>
          );
        })}
        {tps.length < 3 && <button className="text-xs text-accent" onClick={() => setTps([...tps, { price: (tps[tps.length - 1]?.price ?? p.entryPrice) * 1.5, pct: 50, status: "planned" }])}>+ add target</button>}
      </div>
      <Button variant="primary" onClick={() => save()}>Save levels</Button>
      {msg && <p className={cn("text-xs", msg.ok ? "text-ink-2" : "text-bear")}>{msg.text}</p>}
      <Notice tone="warn">
        <b>Stop-losses are not automatic.</b> Executing a sell requires your approval in Phantom — EdgePilot never holds your keys. When the stop is hit while EdgePilot is open, you get an alert with a one-tap sell. On iPhone, apps in the background are paused, so check regularly. Take-profits placed as Jupiter orders <i>do</i> execute automatically.
      </Notice>
    </div>
  );
}

/** Global pop-up when a stop or planned take-profit is hit (raised by the background watcher). */
export function LiveAlertModal({ balances }: { balances: Record<string, { raw: string; decimals: number }> }) {
  const alert = useStore((s) => s.liveAlert);
  const pos = useStore((s) => s.live.positions.find((p) => p.mint === alert?.mint && !p.closedAt));
  if (!alert || !pos) return null;
  const close = () => {
    // snooze: dismiss this alert; the watcher re-alerts after 10 minutes if still breached
    setState({ liveAlert: null });
  };
  const b = balances[pos.mint];
  return (
    <Modal open onClose={close} title={alert.kind === "stop" ? `Stop-loss hit: ${pos.symbol}` : `Take-profit reached: ${pos.symbol}`}>
      <div className="space-y-4">
        <div className="flex items-start gap-2 text-sm">
          <AlertTriangle className={cn("mt-0.5 h-4 w-4 shrink-0", alert.kind === "stop" ? "text-bear" : "text-bull")} />
          <p>
            Price reached your {alert.kind === "stop" ? "stop-loss" : "target"} of <b className="num">{price(alert.price)}</b>. Your plan says: sell <b>{alert.pct}%</b>. This is real money — you approve the sale in Phantom.
          </p>
        </div>
        <SellPanel
          mint={pos.mint}
          symbol={pos.symbol}
          balanceRaw={b?.raw ?? null}
          decimals={b?.decimals ?? pos.decimals}
          defaultPct={alert.pct}
          onDone={() => {
            if (alert.kind === "tp" && alert.index != null) {
              const tps = pos.tps.map((t, i) => (i === alert.index ? { ...t, status: "done" as const } : t));
              setState((s) => ({ live: setLevels(s.live, pos.mint, { tps }) }));
            }
          }}
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={close}>Not now</Button>
          <Link href="/live" onClick={close} className="inline-flex h-9 items-center px-3 text-sm text-accent">Open Live trades</Link>
        </div>
      </div>
    </Modal>
  );
}

export function StopTracking({ mint }: { mint: string }) {
  return (
    <button className="text-xs text-ink-3 hover:text-bear" onClick={() => confirm("Stop tracking this position? (Your tokens are not affected.)") && setState({ live: removePosition(getState().live, mint) })}>
      Stop tracking
    </button>
  );
}
