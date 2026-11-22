// Solana memecoin scoring engine. Transparent factor model + hard red-flag rules.
// IMPORTANT: passing every check does NOT make a token safe. Risk checks are incomplete.
import type { FactorScore, HardRule, TradeSignal } from "../types";
import { clamp, scale } from "../indicators";
import { planPosition } from "../risk";
import type { Settings } from "../settings";

export interface Window<T> {
  m5: T;
  h1: T;
  h6: T;
  h24: T;
}

export interface TokenRisk {
  source: string;
  fetched: boolean;
  error?: string;
  rugged?: boolean;
  scoreRaw?: number | null;
  risks: { name: string; level: string; description: string; value?: string }[];
  mintAuthority?: string | null; // null = revoked; undefined = unknown
  freezeAuthority?: string | null;
  lpLockedPct?: number | null;
  topHolders: { address: string; pct: number; insider?: boolean }[]; // excluding known pools
  top10Pct?: number | null;
  totalHolders?: number | null;
  insidersDetected?: number | null;
  mutableMetadata?: boolean | null;
}

export interface MemeToken {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url: string;
  imageUrl?: string;
  priceUsd: number;
  priceChange: Window<number>;
  volume: Window<number>;
  txns: Window<{ buys: number; sells: number }>;
  liquidityUsd: number;
  fdv: number | null;
  marketCap: number | null;
  pairCreatedAt: number | null;
  socials: { type: string; url: string }[];
  websites: string[];
  boosts: number;
  risk?: TokenRisk;
  holderCount?: { value: number; source: string } | null;
}

export type MemeCategory = "EARLY MOMENTUM" | "BREAKOUT" | "TRENDING" | "HIGH RISK" | "POSSIBLE RUG" | "AVOID";

export interface MemeAnalysis {
  token: MemeToken;
  score: number;
  factors: FactorScore[];
  category: MemeCategory;
  critical: string[];
  warnings: string[];
  reasons: string[];
  slippagePct: number;
  liquidityChangePct: number | null;
  ageHours: number | null;
  signal: TradeSignal;
}

const W = { momentum: 0.2, liquidity: 0.2, volumeAccel: 0.15, buyPressure: 0.1, holders: 0.15, whales: 0.05, age: 0.05, risk: 0.1 };

function mScore(x: number, good: number, hot: number) {
  if (!Number.isFinite(x)) return NaN;
  if (x <= -good) return 0;
  if (x < 0) return 40 * (1 + x / good);
  if (x <= good) return 40 + 60 * (x / good);
  if (x <= hot) return 100;
  return Math.max(30, 100 - ((x - hot) / hot) * 70);
}

/** Constant-product price impact estimate for buying `sizeUsd` into a pool with total liquidity `liqUsd`. */
export function estimateSlippagePct(sizeUsd: number, liqUsd: number) {
  const q = liqUsd / 2;
  if (q <= 0) return 100;
  return (sizeUsd / (q + sizeUsd)) * 100;
}

export function analyzeMeme(t: MemeToken, settings: Settings, opts: { prevLiquidity?: number; now?: number } = {}): MemeAnalysis {
  const now = opts.now ?? Date.now();
  const pc = t.priceChange, v = t.volume, tx = t.txns;
  const ageHours = t.pairCreatedAt ? (now - t.pairCreatedAt) / 3_600_000 : null;
  const accel1 = v.h6 > 0 ? v.h1 / (v.h6 / 6) : NaN;
  const accel5 = v.h1 > 0 ? v.m5 / (v.h1 / 12) : NaN;
  const buyRatio1 = tx.h1.sells > 0 ? tx.h1.buys / tx.h1.sells : tx.h1.buys > 0 ? 5 : NaN;
  const buyRatio6 = tx.h6.sells > 0 ? tx.h6.buys / tx.h6.sells : tx.h6.buys > 0 ? 5 : NaN;
  const mcap = t.marketCap ?? t.fdv ?? null;
  const liqToMcap = mcap ? t.liquidityUsd / mcap : NaN;
  const trades1 = tx.h1.buys + tx.h1.sells;
  const avgTrade1 = trades1 > 0 ? v.h1 / trades1 : NaN;
  const turnover24 = t.liquidityUsd > 0 ? v.h24 / t.liquidityUsd : NaN;
  const liquidityChangePct = opts.prevLiquidity ? ((t.liquidityUsd - opts.prevLiquidity) / opts.prevLiquidity) * 100 : null;
  const slippagePct = estimateSlippagePct(settings.memeTradeSizeUsd, t.liquidityUsd);
  const r = t.risk;

  // ---- factors
  const momentum = 0.2 * mScore(pc.m5, 3, 15) + 0.4 * mScore(pc.h1, 10, 50) + 0.4 * mScore(pc.h6, 25, 150);
  const liqScore = 0.7 * scale(Math.log10(Math.max(t.liquidityUsd, 1)), 4, 5.7) + 0.3 * (Number.isFinite(liqToMcap) ? scale(liqToMcap, 0.02, 0.1) : 50);
  const volAccel = 0.6 * (Number.isFinite(accel1) ? scale(accel1, 0.8, 3) : 0) + 0.4 * (Number.isFinite(accel5) ? scale(accel5, 0.8, 3) : 0);
  const buyP = 0.6 * (Number.isFinite(buyRatio1) ? scale(buyRatio1, 0.8, 2) : 30) + 0.4 * (Number.isFinite(buyRatio6) ? scale(buyRatio6, 0.8, 1.8) : 30);
  let holders: number | null = null;
  if (r?.top10Pct != null) {
    const x = r.top10Pct;
    holders = x <= 15 ? 100 : x <= 30 ? 100 - ((x - 15) / 15) * 50 : x <= 50 ? 50 - ((x - 30) / 20) * 40 : 0;
  }
  let whales = 70;
  if (Number.isFinite(avgTrade1) && t.liquidityUsd > 0) whales -= clamp((avgTrade1 / t.liquidityUsd) * 100 * 30, 0, 50); // avg trade >1% of pool = whale-dominated
  if (r?.insidersDetected) whales -= clamp(r.insidersDetected * 5, 0, 40);
  whales = clamp(whales, 0, 100);
  const age = ageHours == null ? null : ageHours < 1 ? 20 : ageHours < 6 ? 50 : ageHours < 24 * 14 ? 100 : ageHours < 24 * 30 ? 85 : 70;
  let riskScore: number | null = null;
  if (r?.fetched) {
    const danger = r.risks.filter((x) => x.level === "danger").length;
    const warn = r.risks.filter((x) => x.level === "warn").length;
    riskScore = clamp(100 - danger * 35 - warn * 12 - (r.mintAuthority ? 30 : 0) - (r.freezeAuthority ? 40 : 0), 0, 100);
  }

  const raw: Omit<FactorScore, "weight">[] = [
    { key: "momentum", label: "Price momentum", score: momentum, detail: `5m ${pc.m5?.toFixed(1)}%, 1h ${pc.h1?.toFixed(1)}%, 6h ${pc.h6?.toFixed(1)}%. Rewards steady gains, penalises parabolic spikes.`, inputs: { m5: pc.m5, h1: pc.h1, h6: pc.h6 } },
    { key: "liquidity", label: "Liquidity quality", score: liqScore, detail: `$${Math.round(t.liquidityUsd).toLocaleString()} liquidity${Number.isFinite(liqToMcap) ? `, ${(liqToMcap * 100).toFixed(1)}% of market cap` : ""}.`, inputs: { liquidityUsd: t.liquidityUsd, liqToMcap } },
    { key: "volumeAccel", label: "Volume acceleration", score: volAccel, detail: `Last hour volume is ${Number.isFinite(accel1) ? accel1.toFixed(2) : "—"}× the 6h hourly average; last 5m is ${Number.isFinite(accel5) ? accel5.toFixed(2) : "—"}× the 1h pace.`, inputs: { accel1h: accel1, accel5m: accel5 } },
    { key: "buyPressure", label: "Buy/sell activity", score: buyP, detail: `Buys/sells: ${tx.h1.buys}/${tx.h1.sells} (1h), ${tx.h6.buys}/${tx.h6.sells} (6h).`, inputs: { buyRatio1h: buyRatio1, buyRatio6h: buyRatio6 } },
    { key: "holders", label: "Holder distribution", score: holders, detail: r?.top10Pct != null ? `Top 10 holders (excluding pools) own ${r.top10Pct.toFixed(1)}%${r.totalHolders ? ` of supply; ${r.totalHolders.toLocaleString()} holders` : ""}.` : "Holder data unavailable — factor excluded (this is itself a risk).", inputs: { top10Pct: r?.top10Pct ?? null, holders: r?.totalHolders ?? null } },
    { key: "whales", label: "Whale / insider activity (proxy)", score: whales, detail: `Average trade size $${Number.isFinite(avgTrade1) ? Math.round(avgTrade1).toLocaleString() : "—"} (1h)${r?.insidersDetected ? `; ${r.insidersDetected} insider wallets flagged by RugCheck` : ""}. Proxy only — not wallet-level tracking.`, inputs: { avgTrade1h: avgTrade1, insiders: r?.insidersDetected ?? null } },
    { key: "age", label: "Token age", score: age, detail: ageHours == null ? "Pair creation time unknown." : `Pair created ${ageHours < 48 ? `${ageHours.toFixed(1)} hours` : `${(ageHours / 24).toFixed(0)} days`} ago.`, inputs: { ageHours } },
    { key: "risk", label: "Contract & token risk", score: riskScore, detail: r?.fetched ? `${r.risks.length} risk items reported by ${r.source}; mint authority ${r.mintAuthority ? "ENABLED" : r.mintAuthority === null ? "revoked" : "unknown"}, freeze authority ${r.freezeAuthority ? "ENABLED" : r.freezeAuthority === null ? "revoked" : "unknown"}.` : `Risk report unavailable${r?.error ? ` (${r.error})` : ""} — factor excluded. Treat as high risk.`, inputs: { risks: r?.risks.length ?? null } },
  ];
  const avail = raw.filter((f) => f.score != null && Number.isFinite(f.score));
  const totalW = avail.reduce((s, f) => s + W[f.key as keyof typeof W], 0);
  const factors: FactorScore[] = raw.map((f) => {
    const okScore = f.score != null && Number.isFinite(f.score);
    return { ...f, score: okScore ? Math.round(f.score as number) : null, weight: okScore ? W[f.key as keyof typeof W] / totalW : 0 };
  });
  let score = Math.round(factors.reduce((s, f) => s + (f.score ?? 0) * f.weight, 0));
  if (!r?.fetched) score = Math.min(score, 60); // never rank unverified tokens at the top

  // ---- red flags
  const critical: string[] = [];
  const warnings: string[] = [];
  if (r?.rugged) critical.push("RugCheck marks this token as RUGGED.");
  if (r?.freezeAuthority) critical.push("Freeze authority is enabled — the issuer can freeze your tokens (honeypot risk).");
  if (r?.mintAuthority) critical.push("Mint authority is enabled — unlimited new tokens can be created, diluting holders.");
  for (const x of r?.risks ?? []) if (x.level === "danger") critical.push(`${x.name}: ${x.description}`);
  const topOne = r?.topHolders?.[0];
  if (topOne && topOne.pct > 20) critical.push(`A single wallet holds ${topOne.pct.toFixed(1)}% of supply.`);
  if (tx.h1.buys > 50 && tx.h1.sells / Math.max(tx.h1.buys, 1) < 0.08) critical.push(`Almost no sells (${tx.h1.sells}) vs ${tx.h1.buys} buys in 1h — possible honeypot (selling may be blocked).`);
  if (liquidityChangePct != null && liquidityChangePct < -30) critical.push(`Liquidity fell ${liquidityChangePct.toFixed(0)}% since your last scan — possible liquidity pull.`);

  if (!r?.fetched) warnings.push("Contract risk report unavailable — could not verify mint/freeze authority or holders.");
  if (r?.lpLockedPct != null && r.lpLockedPct < 80) warnings.push(`Only ${r.lpLockedPct.toFixed(0)}% of LP is locked/burned — liquidity can be withdrawn.`);
  if (r?.top10Pct != null && r.top10Pct > 35) warnings.push(`Top 10 holders own ${r.top10Pct.toFixed(0)}% — concentrated supply.`);
  if (r?.insidersDetected && r.insidersDetected > 0) warnings.push(`${r.insidersDetected} insider/linked wallets detected.`);
  if (r?.mutableMetadata) warnings.push("Token metadata is mutable (name/image can be changed).");
  if (ageHours != null && ageHours < 1) warnings.push("Less than 1 hour old — extremely high failure rate for new launches.");
  if (t.liquidityUsd < settings.memeMinLiquidityUsd) warnings.push(`Liquidity below your minimum ($${settings.memeMinLiquidityUsd.toLocaleString()}).`);
  if (Number.isFinite(turnover24) && turnover24 > 30) warnings.push(`24h volume is ${turnover24.toFixed(0)}× liquidity — possible wash trading or bot activity.`);
  if (!t.socials.length && !t.websites.length) warnings.push("No website or social links listed.");
  if (r?.totalHolders != null && r.totalHolders < 300) warnings.push(`Only ${r.totalHolders} holders.`);
  if (slippagePct > 3) warnings.push(`Estimated price impact ${slippagePct.toFixed(1)}% for a $${settings.memeTradeSizeUsd} buy.`);
  for (const x of r?.risks ?? []) if (x.level === "warn") warnings.push(`${x.name}: ${x.description}`);

  // ---- category
  let category: MemeCategory;
  if (critical.length) category = "POSSIBLE RUG";
  else if (t.liquidityUsd < 10_000 || pc.h1 < -30 || score < 35) category = "AVOID";
  else if (warnings.length >= 3 || t.liquidityUsd < settings.memeMinLiquidityUsd) category = "HIGH RISK";
  else if (pc.h1 > 10 && accel1 > 2 && buyRatio1 > 1.2) category = "BREAKOUT";
  else if (ageHours != null && ageHours < 24 && accel1 > 1.5 && pc.h1 > 0 && pc.m5 >= 0) category = "EARLY MOMENTUM";
  else if (pc.h6 > 0 && pc.h24 > 0 && pc.h1 > -5) category = "TRENDING";
  else category = "AVOID";

  const reasons: string[] = [];
  for (const f of [...factors].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) if ((f.score ?? 0) >= 65) reasons.push(`${f.label}: ${f.detail}`);
  if (category === "AVOID" && !reasons.length) reasons.push("No measurable edge — momentum, volume and liquidity do not line up.");

  // ---- signal / plan
  const rules: HardRule[] = [
    { id: "critical", label: "No critical red flags", passed: critical.length === 0, detail: critical.length ? critical.join(" ") : "None detected (this does not mean safe).", severity: "reject" },
    { id: "verified", label: "Contract risk report available", passed: !!r?.fetched, detail: r?.fetched ? `From ${r.source}.` : "Unverified token.", severity: "reject" },
    { id: "liq", label: `Liquidity ≥ $${settings.memeMinLiquidityUsd.toLocaleString()}`, passed: t.liquidityUsd >= settings.memeMinLiquidityUsd, detail: `$${Math.round(t.liquidityUsd).toLocaleString()}.`, severity: "reject" },
    { id: "slip", label: "Estimated price impact ≤ 3%", passed: slippagePct <= 3, detail: `${slippagePct.toFixed(2)}% for $${settings.memeTradeSizeUsd}.`, severity: "reject" },
    { id: "warn", label: "Fewer than 3 warnings", passed: warnings.length < 3, detail: `${warnings.length} warnings.`, severity: "reject" },
    { id: "score", label: `Quality score ≥ ${settings.minQualityScore}`, passed: score >= settings.minQualityScore, detail: `Score ${score}/100.`, severity: "reject" },
  ];
  const good = category === "EARLY MOMENTUM" || category === "BREAKOUT" || category === "TRENDING";
  const rejected = rules.filter((x) => !x.passed && x.severity === "reject");
  let direction: TradeSignal["direction"] = "NO_TRADE";
  if (good && rejected.length === 0) direction = "BUY";
  else if (good && rejected.length === 1 && rejected[0].id === "score" && score >= 50) direction = "WAIT";

  const volPct = clamp(Math.max(Math.abs(pc.m5) * 3, Math.abs(pc.h1) * 0.6, 12), 12, 35);
  const price = t.priceUsd;
  const stop = price * (1 - volPct / 100);
  const risk = price - stop;
  const tps = [
    { price: price + 1.5 * risk, r: 1.5, closePct: 40 },
    { price: price + 3 * risk, r: 3, closePct: 35 },
    { price: price + 5 * risk, r: 5, closePct: 25 },
  ];
  const blended = tps.reduce((s, x) => s + (x.r * x.closePct) / 100, 0);
  const maxPos = Math.min((settings.accountEquity * settings.memeMaxPositionPct) / 100, t.liquidityUsd * 0.01);
  const position =
    direction === "BUY" || direction === "WAIT"
      ? planPosition({ equity: settings.accountEquity, riskPct: settings.riskPerTradePct, entry: price, stop, side: "long", leverage: 1, takerFeeBps: 30, slippageBps: Math.round(slippagePct * 100), maxPositionUsd: maxPos })
      : null;

  const summary =
    direction === "BUY"
      ? `BUY (speculative) — ${category.toLowerCase()} with ${score}/100 quality; size is capped small because memecoins can go to zero.`
      : direction === "WAIT"
        ? `WAIT — ${category.toLowerCase()} but quality ${score}/100 is below your threshold. Watch for stronger volume and buy pressure.`
        : category === "POSSIBLE RUG"
          ? `NO TRADE — red flags: ${critical[0]}`
          : `NO TRADE — ${rejected.length ? rejected.map((x) => x.label.toLowerCase()).join("; ") : category.toLowerCase()}.`;

  const explanation = [
    `${t.symbol} is classified as ${category}.`,
    reasons.length ? `What looks good: ${reasons.slice(0, 3).join(" ")}` : "",
    critical.length ? `Critical red flags: ${critical.join(" ")}` : "",
    warnings.length ? `Warnings: ${warnings.slice(0, 5).join(" ")}` : "",
    direction === "BUY"
      ? `If you take it: buy near $${price.toPrecision(4)}, exit if price drops to $${stop.toPrecision(4)} (−${volPct.toFixed(0)}%, wide because memecoins swing hard), and sell in parts at +${(1.5 * volPct).toFixed(0)}%, +${(3 * volPct).toFixed(0)}% and +${(5 * volPct).toFixed(0)}%.`
      : "",
    "No check can prove a memecoin is safe. Never risk money you cannot afford to lose entirely.",
  ]
    .filter(Boolean)
    .join(" ");

  const signal: TradeSignal = {
    id: `MEME-${t.mint}-${Math.floor(now / 300_000)}`,
    asset: t.symbol,
    market: "SOL-MEME",
    direction,
    setupType: category,
    timeframe: "5m–6h",
    entry: direction === "BUY" || direction === "WAIT" ? { low: price * 0.97, high: price * 1.01 } : null,
    trigger: direction === "WAIT" ? "Quality score must rise above your threshold with volume acceleration and buys > sells." : null,
    stopLoss: direction === "BUY" || direction === "WAIT" ? stop : null,
    takeProfits: direction === "BUY" || direction === "WAIT" ? tps : [],
    riskReward: direction === "BUY" || direction === "WAIT" ? blended : null,
    riskRewardTp1: 1.5,
    qualityScore: score,
    factors,
    rules,
    historicalEdge: null,
    position,
    reasons,
    risks: [...critical, ...warnings],
    invalidation: [`Price closes below $${stop.toPrecision(4)}.`, "Liquidity drops sharply or sells dry up (honeypot sign).", "Volume acceleration fades below 1× the 6h average."],
    summary,
    explanation,
    createdAt: now,
    expiresAt: now + 30 * 60_000,
    price,
    dataSources: ["DexScreener", r?.source ?? "RugCheck (unavailable)"],
  };

  return { token: t, score, factors, category, critical, warnings, reasons, slippagePct, liquidityChangePct, ageHours, signal };
}
