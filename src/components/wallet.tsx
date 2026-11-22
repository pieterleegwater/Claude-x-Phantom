"use client";
// Phantom / Solana wallet integration via the official Solana Wallet Adapter, which discovers
// Phantom (and other wallets) through the Wallet Standard. READ-ONLY by default:
//  • never asks for seed phrases or private keys (the wallet holds keys; we only see the public key)
//  • never signs automatically
//  • RPC goes through our server proxy that only allows read methods
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { LAMPORTS_PER_SOL, PublicKey, type AccountInfo, type ParsedAccountData, type RpcResponseAndContext } from "@solana/web3.js";
import { Wallet, LogOut, ExternalLink, Copy } from "lucide-react";
import { Button, Modal, Notice, cn, usd, compact } from "./ui";
import { apiGet } from "@/lib/client/useApi";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const GENESIS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "Mainnet-beta",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "Devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "Testnet",
};

export function SolanaProviders({ children }: { children: ReactNode }) {
  const [endpoint, setEndpoint] = useState("https://localhost/api/solana/rpc");
  useEffect(() => setEndpoint(`${window.location.origin}/api/solana/rpc`), []);
  const wallets = useMemo(() => [], []); // Wallet Standard auto-detects Phantom & others
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={false} onError={(e) => console.warn("Wallet error:", e.message)}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

export function shortAddr(a: string) {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export function WalletButton({ label }: { label?: string } = {}) {
  const { wallets, wallet, select, connect, disconnect, connected, connecting, publicKey } = useWallet();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string>();

  useEffect(() => {
    if (pending && wallet && !connected && !connecting) {
      connect()
        .then(() => setOpen(false))
        .catch((e: Error) => setErr(e.message || "Connection rejected"))
        .finally(() => setPending(false));
    }
  }, [pending, wallet, connected, connecting, connect]);

  if (connected && publicKey) {
    const addr = publicKey.toBase58();
    return (
      <>
        {/* Visible on every screen size: green dot + short address = connected */}
        <button onClick={() => setOpen(true)} className="num inline-flex h-8 items-center gap-1.5 rounded-lg border border-bull/40 bg-bull-soft/60 px-2 text-xs text-ink" aria-label={`Wallet connected: ${addr}`} title="Wallet connected">
          <span className="h-2 w-2 rounded-full bg-bull" />
          {addr.slice(0, 4)}…{addr.slice(-3)}
        </button>
        <Modal open={open} onClose={() => setOpen(false)} title="Wallet connected">
          <div className="space-y-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-bull" />
              <span className="text-ink">{wallet?.adapter.name ?? "Wallet"} is connected (read-only).</span>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3">Public address</div>
              <button className="num mt-1 inline-flex items-center gap-1 break-all text-left text-xs hover:text-accent" onClick={() => navigator.clipboard?.writeText(addr)} title="Copy address">
                {addr} <Copy className="h-3 w-3 shrink-0" />
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href="/portfolio" className="inline-flex h-9 items-center rounded-lg border border-line-2 bg-panel-2 px-3.5 text-sm font-medium" onClick={() => setOpen(false)}>
                View balances
              </a>
              <Button variant="danger" onClick={() => { disconnect(); setOpen(false); }}>
                <LogOut className="h-3.5 w-3.5" /> Disconnect
              </Button>
            </div>
          </div>
        </Modal>
      </>
    );
  }

  const detected = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const phantom = wallets.find((w) => w.adapter.name === "Phantom");
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} title="Connect wallet" ariaLabel="Connect wallet">
        <Wallet className="h-3.5 w-3.5" /> <span className={label ? "" : "hidden sm:inline"}>{connecting ? "Connecting…" : (label ?? "Connect")}</span>
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Connect a Solana wallet">
        <div className="space-y-3">
          <Notice>EdgePilot only reads your public address and balances. It will never ask for your seed phrase or private key, and never signs anything automatically.</Notice>
          {detected.length ? (
            <div className="space-y-2">
              {detected
                .sort((a) => (a.adapter.name === "Phantom" ? -1 : 1))
                .map((w) => (
                  <button
                    key={w.adapter.name}
                    onClick={() => {
                      setErr(undefined);
                      select(w.adapter.name);
                      setPending(true);
                    }}
                    className="flex w-full items-center gap-3 rounded-lg border border-line-2 bg-panel-2 px-3 py-2.5 text-left text-sm hover:border-accent/50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.adapter.icon} alt="" className="h-6 w-6 rounded" />
                    <span className="flex-1 font-medium">{w.adapter.name}</span>
                    <span className="text-xs text-ink-3">Detected</span>
                  </button>
                ))}
            </div>
          ) : (
            <NoWalletHelp />
          )}
          {!phantom && detected.length > 0 && <p className="text-xs text-ink-3">Phantom not detected — other Wallet Standard wallets are listed.</p>}
          {err && <p className="text-xs text-bear">{err}</p>}
        </div>
      </Modal>
    </>
  );
}

/** Phantom universal link that opens a URL inside the Phantom app's in-app browser. */
function phantomBrowseLink() {
  if (typeof window === "undefined") return "https://phantom.com/download";
  return `https://phantom.app/ul/browse/${encodeURIComponent(window.location.href)}?ref=${encodeURIComponent(window.location.origin)}`;
}

function NoWalletHelp() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => setMobile(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)), []);
  if (mobile)
    return (
      <div className="space-y-3 rounded-lg border border-line p-4 text-sm text-ink-2">
        <p>
          On a phone, wallets can&apos;t connect from Safari or Chrome. Open EdgePilot inside the <b className="text-ink">Phantom app&apos;s built-in browser</b> instead — your paper account and settings there are separate from this browser.
        </p>
        <a href={phantomBrowseLink()} className="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#ab9ff2] font-semibold text-[#1c1c2e]">
          Open in Phantom app
        </a>
        <p className="text-xs text-ink-3">
          No Phantom yet?{" "}
          <a className="text-accent underline" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
            Install it
          </a>{" "}
          first, create or import your wallet in the app, then come back and tap the button.
        </p>
      </div>
    );
  return (
    <div className="rounded-lg border border-line p-4 text-sm text-ink-2">
      No Solana wallet detected in this browser.{" "}
      <a className="inline-flex items-center gap-1 text-accent underline" href="https://phantom.com/download" target="_blank" rel="noopener noreferrer">
        Install the Phantom extension <ExternalLink className="h-3 w-3" />
      </a>{" "}
      (Chrome, Brave, Firefox or Edge), then reload this page.
    </div>
  );
}

export interface TokenBal {
  mint: string;
  amount: number;
  raw: string; // exact base units

  decimals: number;
  program: string;
  symbol?: string;
  priceUsd?: number;
  valueUsd?: number;
}

export function useWalletData(refreshMs = 0) {
  const { connection } = useConnection();
  const { publicKey, connected } = useWallet();
  const [sol, setSol] = useState<number | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBal[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    if (!connected || !publicKey) {
      setSol(null);
      setTokens([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(undefined);
      setComplete(false);
      let t22failed = false;
      try {
        const [bal, genesis, t1, t2] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getGenesisHash(),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM }),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_2022 }).catch(() => {
            t22failed = true;
            return { context: { slot: 0 }, value: [] } as RpcResponseAndContext<{ pubkey: PublicKey; account: AccountInfo<ParsedAccountData> }[]>;
          }),
        ]);
        if (cancelled) return;
        setSol(bal / LAMPORTS_PER_SOL);
        setNetwork(GENESIS[genesis] ?? `Unknown (${genesis.slice(0, 6)}…)`);
        const list: TokenBal[] = [];
        for (const [arr, prog] of [
          [t1.value, "SPL Token"],
          [t2.value, "Token-2022"],
        ] as const) {
          for (const a of arr) {
            const info = (a.account.data as { parsed?: { info?: { mint: string; tokenAmount: { uiAmount: number; decimals: number; amount: string } } } }).parsed?.info;
            if (info && info.tokenAmount.uiAmount > 0) list.push({ mint: info.mint, amount: info.tokenAmount.uiAmount, raw: info.tokenAmount.amount, decimals: info.tokenAmount.decimals, program: prog });
          }
        }
        if (list.length) {
          try {
            const mints = list.slice(0, 30).map((x) => x.mint).join(",");
            const r = await apiGet<Record<string, { priceUsd: number; symbol: string }>>(`/api/memecoins/prices?mints=${mints}`);
            for (const t of list) {
              const p = r.data[t.mint];
              if (p) {
                t.symbol = p.symbol;
                t.priceUsd = p.priceUsd;
                t.valueUsd = p.priceUsd * t.amount;
              }
            }
          } catch {
            /* prices optional */
          }
        }
        list.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
        if (!cancelled) {
          setTokens(list);
          setComplete(!t22failed);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, publicKey, connection, tick]);

  useEffect(() => {
    if (!refreshMs || !connected) return;
    const id = setInterval(() => document.visibilityState === "visible" && setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, connected]);

  // complete = every token program was read successfully (safe to treat "missing" as zero balance)
  return { publicKey, connected, sol, network, tokens, error, loading, complete, refresh: () => setTick((t) => t + 1) };
}

export function WalletPanel() {
  const w = useWalletData();
  const { wallet } = useWallet();
  if (!w.connected || !w.publicKey)
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-ink-2">
        <p>Connect Phantom to view your SOL and token balances (read-only).</p>
        <WalletButton label="Connect Phantom" />
      </div>
    );
  const addr = w.publicKey.toBase58();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3">Wallet</div>
          <div className="mt-1 text-sm font-medium">{wallet?.adapter.name}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-ink-3">Address</div>
          <button className="num mt-1 inline-flex items-center gap-1 text-sm hover:text-accent" onClick={() => navigator.clipboard?.writeText(addr)} title="Copy address">
            {shortAddr(addr)} <Copy className="h-3 w-3" />
          </button>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3">SOL balance</div>
          <div className="num mt-1 text-sm font-medium">{w.sol == null ? "…" : w.sol.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-ink-3">App RPC network</div>
          <div className={cn("mt-1 text-sm font-medium", w.network && w.network !== "Mainnet-beta" && "text-warn")}>{w.network ?? "…"}</div>
        </div>
      </div>
      <p className="text-[11px] text-ink-3">Network shown is the RPC this app reads from. Make sure Phantom is set to the same network. Balances are read via the server RPC proxy.</p>
      {w.error && <Notice tone="warn">Could not load balances: {w.error}. Public RPC endpoints are rate-limited — set SOLANA_RPC_URL (e.g. Helius) for reliable reads.</Notice>}
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-xs">
          <thead className="bg-panel-2 text-left text-ink-3">
            <tr>
              <th className="px-3 py-2 font-medium">Token</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {w.tokens.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-ink-3">
                  {w.loading ? "Loading…" : "No SPL tokens with a balance."}
                </td>
              </tr>
            )}
            {w.tokens.map((t) => (
              <tr key={t.mint}>
                <td className="px-3 py-2">
                  <div className="font-medium text-ink">{t.symbol ?? shortAddr(t.mint)}</div>
                  <div className="text-[10px] text-ink-3">{t.program}</div>
                </td>
                <td className="num px-3 py-2 text-right">{compact(t.amount)}</td>
                <td className="num px-3 py-2 text-right">{t.priceUsd ? `$${t.priceUsd.toPrecision(4)}` : "—"}</td>
                <td className="num px-3 py-2 text-right">{usd(t.valueUsd ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button size="sm" onClick={w.refresh}>
        Refresh balances
      </Button>
    </div>
  );
}
