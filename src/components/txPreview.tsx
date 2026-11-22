"use client";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { simulateAndSend, waitForConfirmation } from "@/lib/client/solanaTx";
import { setState, useStore } from "@/lib/client/store";
import { recordBuy } from "@/lib/live";
import { ShieldCheck, Lock } from "lucide-react";
import { Button, Field, NumInput, Notice, cn, usd, DataBadge } from "./ui";
import { apiGet } from "@/lib/client/useApi";
import { shortAddr, WalletButton } from "./wallet";
import type { DataMeta } from "@/lib/types";

interface Quote {
  inSol: number;
  inUsd: number;
  solPriceUsd: number;
  outAmountRaw: string;
  minOutRaw: string;
  decimals: number | null;
  priceImpactPct: number;
  slippageBps: number;
  route: { label: string; percent: number }[];
  networkFeeSolEstimate: number;
  roundTrip: { ok: boolean; priceImpactPct: number | null; outSol: number | null; error?: string };
  roundTripLossPct: number | null;
}

const LIVE = process.env.NEXT_PUBLIC_ENABLE_LIVE_EXECUTION === "true";

/**
 * Swap preview: shows exactly what a transaction would do BEFORE anything is signed.
 * Execution is disabled by default. When enabled by the operator, it still requires a
 * checklist + typed confirmation + simulation + the wallet's own approval prompt.
 */
export function TxPreview({ mint, symbol, defaultUsd = 50 }: { mint: string; symbol: string; defaultUsd?: number }) {
  const wallet = useWallet();
  const { publicKey, connected } = wallet;
  const maxTrade = useStore((st) => st.settings.liveMaxTradeUsd);
  const [boughtOk, setBoughtOk] = useState(false);
  const { connection } = useConnection();
  const [amountUsd, setAmountUsd] = useState(defaultUsd);
  const [slippageBps, setSlippageBps] = useState(100);
  const [q, setQ] = useState<Quote>();
  const [meta, setMeta] = useState<DataMeta>();
  const [err, setErr] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState([false, false, false, false]);
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<string>();

  const preview = async () => {
    setLoading(true);
    setErr(undefined);
    setStatus(undefined);
    try {
      const r = await apiGet<Quote>(`/api/swap/quote?outputMint=${mint}&amountUsd=${amountUsd}&slippageBps=${slippageBps}`);
      setQ(r.data);
      setMeta(r.meta);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const ui = (raw: string) => (q?.decimals != null ? Number(raw) / 10 ** q.decimals : null);
  const out = q ? ui(q.outAmountRaw) : null;
  const minOut = q ? ui(q.minOutRaw) : null;
  const allChecked = checks.every(Boolean) && typed.trim().toUpperCase() === "CONFIRM";

  const execute = async () => {
    if (!LIVE || !publicKey || !allChecked) return;
    if (amountUsd > maxTrade) {
      setStatus(`Amount exceeds your real-money limit of ${usd(maxTrade, 0)} per trade (Settings → Memecoins).`);
      return;
    }
    setBoughtOk(false);
    setStatus("Building unsigned transaction…");
    try {
      const res = await fetch("/api/swap/build", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ side: "buy", outputMint: mint, amountUsd, slippageBps, userPublicKey: publicKey.toBase58() }) });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error);
      const sig = await simulateAndSend(j.swapTransaction, connection, wallet, setStatus);
      setStatus("Submitted — waiting for confirmation…");
      const conf = await waitForConfirmation(connection, sig);
      if (conf === "failed") throw new Error(`Transaction failed on-chain (${sig.slice(0, 8)}…). Your SOL was not spent except the network fee.`);
      const decimals = q?.decimals ?? null;
      const tokens = decimals != null ? Number(j.quote.outAmount) / 10 ** decimals : NaN;
      const spentUsd = (Number(j.quote.inAmount) / 1e9) * j.solPriceUsd;
      if (Number.isFinite(tokens)) {
        setState((st) => ({ live: recordBuy(st.live, { mint, symbol, decimals, tokens, usd: spentUsd, sig, status: conf === "confirmed" ? "confirmed" : "unconfirmed", owner: publicKey.toBase58() }) }));
      }
      setBoughtOk(true);
      setChecks([false, false, false, false]);
      setTyped("");
      setStatus(conf === "confirmed" ? `Bought ✔ (${sig.slice(0, 8)}…). Set a stop-loss and targets in Live Trades.` : `Submitted ${sig.slice(0, 8)}… — not confirmed yet; check Phantom. Recorded as unconfirmed.`);
    } catch (e) {
      setStatus(`Cancelled / failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (USD of SOL)">
          <NumInput value={amountUsd} onChange={setAmountUsd} min={1} max={10000} />
        </Field>
        <Field label="Max slippage (bps)" hint="100 bps = 1%">
          <NumInput value={slippageBps} onChange={(v) => setSlippageBps(Math.round(v))} min={10} max={3000} />
        </Field>
      </div>
      <Button onClick={preview} disabled={loading}>
        {loading ? "Fetching quote…" : "Preview transaction"}
      </Button>
      {err && <Notice tone="bear">{err}</Notice>}
      {q && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <DataBadge meta={meta} />
          </div>
          <div className="divide-y divide-line rounded-lg border border-line text-xs">
            {[
              ["Action", `Swap SOL → ${symbol}`],
              ["You pay", `${q.inSol.toFixed(5)} SOL (≈ ${usd(q.inUsd)})`],
              ["You receive (quoted)", out != null ? `${out.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol}` : `${q.outAmountRaw} base units`],
              ["Minimum received", minOut != null ? `${minOut.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${symbol} (at ${q.slippageBps / 100}% slippage)` : `${q.minOutRaw} base units`],
              ["Price impact", `${q.priceImpactPct.toFixed(3)}%`],
              ["Route", q.route.map((r) => `${r.label} ${r.percent}%`).join(" → ") || "—"],
              ["Network fee (est.)", `~${q.networkFeeSolEstimate.toFixed(6)} SOL incl. priority fee estimate`],
              ["Destination", publicKey ? `Your wallet ${shortAddr(publicKey.toBase58())} (token account)` : "Your connected wallet"],
              ["Sell-back check", q.roundTrip.ok ? `Route back to SOL exists · round-trip cost ≈ ${q.roundTripLossPct?.toFixed(2)}%` : `NO sell route found — possible honeypot (${q.roundTrip.error ?? "unknown"})`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-3 py-2">
                <span className="text-ink-3">{k}</span>
                <span className={cn("num text-right", k === "Sell-back check" && !q.roundTrip.ok && "text-bear", k === "Price impact" && q.priceImpactPct > 3 && "text-warn")}>{v}</span>
              </div>
            ))}
          </div>
          {q.priceImpactPct > 3 && <Notice tone="warn">Price impact above 3% — you would lose a meaningful amount just entering. Use a smaller size.</Notice>}

          <div className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink">
              <ShieldCheck className="h-3.5 w-3.5 text-bull" /> Manual approval checklist
            </div>
            {["I understand memecoins can go to zero and no check guarantees safety.", "I verified the token address and amount above.", "I accept the slippage and fees shown.", "I am using money I can afford to lose."].map((t, i) => (
              <label key={i} className="flex items-start gap-2 text-xs text-ink-2">
                <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks((c) => c.map((x, j) => (j === i ? e.target.checked : x)))} className="mt-0.5" />
                {t}
              </label>
            ))}
            <input className="mt-1 h-8 w-full rounded-md border border-line-2 bg-bg px-2 text-xs outline-none" placeholder='Type "CONFIRM"' value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          {!connected ? (
            <WalletButton label="Connect Phantom" />
          ) : LIVE ? (
            <Button variant="primary" disabled={!allChecked} onClick={execute}>
              Simulate &amp; send to wallet for approval
            </Button>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-line-2 bg-panel-2 p-3 text-xs text-ink-2">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />
              <span>
                Live execution is <b>disabled</b> in this version (read-only mode). This preview is for planning only. To execute, place the trade yourself in Phantom/Jupiter — or see README → &quot;Enabling execution&quot; for the opt-in architecture.
              </span>
            </div>
          )}
          {status && <p className="text-xs text-ink-2">{status}</p>}
          {boughtOk && (
            <Link href="/live" className="inline-flex h-9 items-center rounded-lg bg-accent/90 px-3.5 text-sm font-medium text-[#0b0d10]">
              Set stop-loss &amp; targets →
            </Link>
          )}
          {LIVE && <p className="text-[11px] text-ink-3">Real-money limit: {usd(maxTrade, 0)} per trade (Settings → Memecoins).</p>}
        </div>
      )}
    </div>
  );
}
