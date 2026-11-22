import "server-only";
// Solana token data providers.
//   DexScreener  — pairs, price, liquidity, volume, txns, boosts (public, no key)
//   RugCheck     — mint/freeze authority, holders, LP lock, risk list (public, no key)
//   Jupiter      — swap quotes for slippage / route / sellability checks (lite API; key optional)
//   GeckoTerminal— pool OHLCV candles (public, no key, ~30 req/min)
//   Birdeye      — holder counts (optional, requires BIRDEYE_API_KEY)
import type { Candle } from "../types";
import type { MemeToken, TokenRisk } from "../analysis/memeEngine";
import { analyzeMeme } from "../analysis/memeEngine";
import { DEFAULT_SETTINGS } from "../settings";
import { fetchJson, mapLimit } from "../server/http";
import { cached } from "../server/cache";

const DS = "https://api.dexscreener.com";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STABLES = new Set([SOL_MINT, USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

export function isMint(s: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

interface DsPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: { url: string }[]; socials?: { type?: string; platform?: string; url?: string; handle?: string }[] };
  boosts?: { active?: number };
}

const w = <T,>(o: Record<string, T> | undefined, d: T) => ({ m5: o?.m5 ?? d, h1: o?.h1 ?? d, h6: o?.h6 ?? d, h24: o?.h24 ?? d });

function toToken(p: DsPair): MemeToken {
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    url: p.url,
    imageUrl: p.info?.imageUrl,
    priceUsd: Number(p.priceUsd ?? NaN),
    priceChange: w(p.priceChange, 0),
    volume: w(p.volume, 0),
    txns: w(p.txns, { buys: 0, sells: 0 }),
    liquidityUsd: p.liquidity?.usd ?? 0,
    fdv: p.fdv ?? null,
    marketCap: p.marketCap ?? null,
    pairCreatedAt: p.pairCreatedAt ?? null,
    socials: (p.info?.socials ?? []).map((s) => ({ type: s.type ?? s.platform ?? "social", url: s.url ?? s.handle ?? "" })),
    websites: (p.info?.websites ?? []).map((x) => x.url),
    boosts: p.boosts?.active ?? 0,
  };
}

/** Fetch pairs for up to 30 mints per call and keep the most liquid pair per token. */
export async function tokensByMint(mints: string[]): Promise<MemeToken[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30));
  const res = await mapLimit(chunks, 3, (ch) => fetchJson<DsPair[]>("DexScreener", `${DS}/tokens/v1/solana/${ch.join(",")}`).catch(() => [] as DsPair[]));
  const best = new Map<string, DsPair>();
  for (const p of res.flat()) {
    if (p.chainId !== "solana" || STABLES.has(p.baseToken.address)) continue;
    const cur = best.get(p.baseToken.address);
    if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(p.baseToken.address, p);
  }
  return [...best.values()].map(toToken);
}

async function candidateMints(): Promise<{ mints: string[]; sources: string[]; errors: string[] }> {
  type Item = { chainId: string; tokenAddress: string };
  const lists: [string, string][] = [
    ["DexScreener latest boosts", `${DS}/token-boosts/latest/v1`],
    ["DexScreener top boosts", `${DS}/token-boosts/top/v1`],
    ["DexScreener latest profiles", `${DS}/token-profiles/latest/v1`],
    ["DexScreener community takeovers", `${DS}/community-takeovers/latest/v1`],
  ];
  const errors: string[] = [];
  const sources: string[] = [];
  const set = new Set<string>();
  const results = await Promise.allSettled(lists.map(([, u]) => fetchJson<Item[]>("DexScreener", u)));
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      sources.push(lists[i][0]);
      for (const x of r.value) if (x.chainId === "solana" && isMint(x.tokenAddress)) set.add(x.tokenAddress);
    } else if (r.status === "rejected") errors.push(String(r.reason?.message ?? r.reason));
  });
  // Optional: Birdeye trending list
  const key = process.env.BIRDEYE_API_KEY;
  if (key) {
    try {
      const j = await fetchJson<{ data?: { tokens?: { address: string }[] } }>("Birdeye", "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20", {
        headers: { "X-API-KEY": key, "x-chain": "solana" },
      });
      for (const t of j.data?.tokens ?? []) if (isMint(t.address)) set.add(t.address);
      sources.push("Birdeye trending");
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  return { mints: [...set].slice(0, 120), sources, errors };
}

// ---------------- RugCheck ----------------
interface RcReport {
  token?: { mintAuthority: string | null; freezeAuthority: string | null; decimals?: number };
  tokenMeta?: { mutable?: boolean };
  topHolders?: { address: string; owner?: string; pct: number; insider?: boolean }[];
  risks?: { name: string; value?: string; description: string; level: string }[];
  markets?: { pubkey: string; lp?: { lpLockedPct?: number } }[];
  knownAccounts?: Record<string, { name: string; type: string }>;
  totalHolders?: number;
  rugged?: boolean;
  score?: number;
  graphInsidersDetected?: number;
}

export async function rugcheck(mint: string): Promise<TokenRisk & { decimals?: number }> {
  return cached(`rc:${mint}`, 5 * 60_000, async () => {
    try {
      const r = await fetchJson<RcReport>("RugCheck", `https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { timeoutMs: 10_000 });
      const known = r.knownAccounts ?? {};
      const marketKeys = new Set((r.markets ?? []).map((m) => m.pubkey));
      const holders = (r.topHolders ?? [])
        .filter((h) => !(known[h.owner ?? ""]?.type === "AMM" || known[h.address]?.type === "AMM" || marketKeys.has(h.owner ?? "") || marketKeys.has(h.address)))
        .map((h) => ({ address: h.owner ?? h.address, pct: Number(h.pct) || 0, insider: !!h.insider }))
        .sort((a, b) => b.pct - a.pct);
      const lpPcts = (r.markets ?? []).map((m) => m.lp?.lpLockedPct).filter((x): x is number => typeof x === "number");
      return {
        source: "RugCheck",
        fetched: true,
        rugged: !!r.rugged,
        scoreRaw: r.score ?? null,
        risks: (r.risks ?? []).map((x) => ({ name: x.name, level: x.level, description: x.description, value: x.value })),
        mintAuthority: r.token ? r.token.mintAuthority : undefined,
        freezeAuthority: r.token ? r.token.freezeAuthority : undefined,
        lpLockedPct: lpPcts.length ? Math.max(...lpPcts) : null,
        topHolders: holders.slice(0, 20),
        top10Pct: holders.length ? holders.slice(0, 10).reduce((s, h) => s + h.pct, 0) : null,
        totalHolders: r.totalHolders ?? null,
        insidersDetected: r.graphInsidersDetected ?? null,
        mutableMetadata: r.tokenMeta?.mutable ?? null,
        decimals: r.token?.decimals,
      };
    } catch (e) {
      return { source: "RugCheck", fetched: false, error: e instanceof Error ? e.message : String(e), risks: [], topHolders: [] };
    }
  });
}

async function birdeyeHolders(mint: string): Promise<{ value: number; source: string } | null> {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) return null;
  try {
    const j = await fetchJson<{ data?: { holder?: number } }>("Birdeye", `https://public-api.birdeye.so/defi/token_overview?address=${mint}`, { headers: { "X-API-KEY": key, "x-chain": "solana" } });
    return j.data?.holder ? { value: j.data.holder, source: "Birdeye" } : null;
  } catch {
    return null;
  }
}

export async function scanMemecoins(): Promise<{ tokens: MemeToken[]; sources: string[]; errors: string[]; candidates: number }> {
  const { mints, sources, errors } = await candidateMints();
  if (!mints.length) throw new Error(`No candidate tokens (${errors.join(" | ") || "DexScreener returned nothing"})`);
  const tokens = (await tokensByMint(mints)).filter((t) => t.liquidityUsd >= 5_000 && t.volume.h24 >= 10_000 && Number.isFinite(t.priceUsd));
  // Preliminary ranking without risk data, then enrich the top candidates (RugCheck is rate-limited).
  const pre = tokens.map((t) => ({ t, s: analyzeMeme(t, DEFAULT_SETTINGS).score })).sort((a, b) => b.s - a.s);
  const top = pre.slice(0, 24).map((x) => x.t);
  await mapLimit(top, 4, async (t) => {
    t.risk = await rugcheck(t.mint);
    t.holderCount = await birdeyeHolders(t.mint);
  });
  return { tokens: [...top, ...pre.slice(24, 60).map((x) => x.t)], sources: [...sources, "DexScreener pairs", "RugCheck"], errors, candidates: mints.length };
}

// ---------------- Jupiter ----------------
const JUP = process.env.JUPITER_API_KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const jupHeaders = (): Record<string, string> => (process.env.JUPITER_API_KEY ? { "x-api-key": process.env.JUPITER_API_KEY } : {});

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { percent: number; swapInfo: { label?: string; ammKey: string; feeAmount?: string; feeMint?: string } }[];
  contextSlot?: number;
}

export async function jupQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number) {
  const q = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(slippageBps), restrictIntermediateTokens: "true" });
  return fetchJson<JupQuote>("Jupiter", `${JUP}/quote?${q}`, { headers: jupHeaders() });
}

export async function solPriceUsd(): Promise<{ price: number; source: string }> {
  return cached("solprice", 20_000, async () => {
    try {
      const j = await fetchJson<Record<string, { usdPrice?: number }>>("Jupiter Price", `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`);
      const p = j[SOL_MINT]?.usdPrice;
      if (p) return { price: p, source: "Jupiter Price API" };
    } catch {}
    const d = await fetchJson<DsPair[]>("DexScreener", `${DS}/tokens/v1/solana/${SOL_MINT}`);
    const best = d.filter((p) => p.baseToken.address === SOL_MINT).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best?.priceUsd) throw new Error("SOL price unavailable");
    return { price: Number(best.priceUsd), source: "DexScreener" };
  });
}

// ---------------- GeckoTerminal ----------------
export async function poolCandles(pool: string, tf: "1m" | "5m" | "15m" | "1h" | "4h"): Promise<Candle[]> {
  const map = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4] } as const;
  const [t, agg] = map[tf];
  const j = await fetchJson<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>("GeckoTerminal", `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/${t}?aggregate=${agg}&limit=300&currency=usd`, {
    headers: { accept: "application/json;version=20230302" },
  });
  return (j.data?.attributes?.ohlcv_list ?? []).map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] })).sort((a, b) => a.time - b.time);
}
