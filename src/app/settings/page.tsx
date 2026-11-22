"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed } from "lucide-react";
import { setState, useStore, exportData, importData, resetAll } from "@/lib/client/store";
import type { Settings } from "@/lib/settings";
import { Button, Card, Field, NumInput, Notice, PageHeader, Select, Term, Toggle, inputCls } from "@/components/ui";

interface Health {
  integrations: { ai: boolean; aiModel: string; privateSolanaRpc: boolean; birdeye: boolean; coinglass: boolean; jupiterKey: boolean; liveExecution: boolean };
}

const LIVE_CLIENT = process.env.NEXT_PUBLIC_ENABLE_LIVE_EXECUTION === "true";

export default function SettingsPage() {
  const s = useStore((st) => st.settings);
  const code = useStore((st) => st.aiAccessCode);
  const set = (patch: Partial<Settings>) => setState((st) => ({ settings: { ...st.settings, ...patch } }));
  const setN = (patch: Partial<Settings["notifications"]>) => setState((st) => ({ settings: { ...st.settings, notifications: { ...st.settings.notifications, ...patch } } }));
  const h = useHealth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string>();

  const download = () => {
    const url = URL.createObjectURL(new Blob([exportData()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgepilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Risk limits, signal thresholds, notifications and integrations. Stored only in this browser." />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Account & risk" subtitle="These limits drive every position size and rejection rule.">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account size (USD)" hint="Used for sizing; your real or paper account."><NumInput value={s.accountEquity} onChange={(v) => set({ accountEquity: v })} min={10} /></Field>
            <Field label="Risk per trade (%)" hint="Pros typically use 0.5–2%."><NumInput value={s.riskPerTradePct} onChange={(v) => set({ riskPerTradePct: v })} min={0.1} max={5} /></Field>
            <Field label="Max open risk (%)"><NumInput value={s.maxOpenRiskPct} onChange={(v) => set({ maxOpenRiskPct: v })} min={0.5} max={30} /></Field>
            <Field label="Daily loss limit (%)"><NumInput value={s.dailyLossLimitPct} onChange={(v) => set({ dailyLossLimitPct: v })} min={0.5} max={30} /></Field>
            <Field label={<><Term k="leverage">Max leverage</Term> (hard cap)</>} hint="The engine never suggests more."><NumInput value={s.maxLeverage} onChange={(v) => set({ maxLeverage: Math.round(v), defaultLeverage: Math.min(s.defaultLeverage, Math.round(v)) })} min={1} max={125} /></Field>
            <Field label="Default leverage"><NumInput value={s.defaultLeverage} onChange={(v) => set({ defaultLeverage: Math.min(Math.round(v), s.maxLeverage) })} min={1} max={s.maxLeverage} /></Field>
            <Field label="Taker fee (bps per side)" hint="5 bps = 0.05%"><NumInput value={s.takerFeeBps} onChange={(v) => set({ takerFeeBps: v })} min={0} max={100} /></Field>
            <Field label="Slippage (bps per side)"><NumInput value={s.slippageBps} onChange={(v) => set({ slippageBps: v })} min={0} max={200} /></Field>
            <Field label="Maintenance margin rate" hint="BTC tier-1 on major venues ≈ 0.004"><NumInput value={s.maintenanceMarginRate} onChange={(v) => set({ maintenanceMarginRate: v })} min={0.001} max={0.05} /></Field>
          </div>
          {s.maxLeverage > 20 && <div className="mt-3"><Notice tone="bear">Max leverage above 20x allows liquidation from ordinary price wicks. The engine will still warn on every trade.</Notice></div>}
        </Card>
        <Card title="Signal engine">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Primary timeframe"><Select value={s.primaryTimeframe} onChange={(v) => set({ primaryTimeframe: v })} options={[{ value: "15m", label: "15 minutes" }, { value: "1h", label: "1 hour" }, { value: "4h", label: "4 hours" }]} /></Field>
            <Field label={<Term k="riskreward">Min reward:risk</Term>}><NumInput value={s.minRiskReward} onChange={(v) => set({ minRiskReward: v })} min={1} max={10} /></Field>
            <Field label={<Term k="quality">Min quality score</Term>} hint="Below → WAIT / NO TRADE"><NumInput value={s.minQualityScore} onChange={(v) => set({ minQualityScore: v })} min={30} max={95} /></Field>
            <Field label="Beginner mode"><Toggle checked={s.beginnerMode} onChange={(v) => set({ beginnerMode: v })} label="Show explanations & definitions" /></Field>
          </div>
        </Card>
        <Card title="Memecoins">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max position (% equity)"><NumInput value={s.memeMaxPositionPct} onChange={(v) => set({ memeMaxPositionPct: v })} min={0.1} max={20} /></Field>
            <Field label="Trade size for slippage checks ($)"><NumInput value={s.memeTradeSizeUsd} onChange={(v) => set({ memeTradeSizeUsd: v })} min={10} max={100000} /></Field>
            <Field label="Min liquidity ($)"><NumInput value={s.memeMinLiquidityUsd} onChange={(v) => set({ memeMinLiquidityUsd: v })} min={1000} /></Field>
            <Field label="Real-money limit per buy ($)" hint="Hard cap for live Phantom buys."><NumInput value={s.liveMaxTradeUsd} onChange={(v) => set({ liveMaxTradeUsd: v })} min={1} max={10000} /></Field>
          </div>
        </Card>
        <Card title="Notifications" subtitle="Alerts fire while EdgePilot is open in a tab.">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Toggle
                checked={s.notifications.browser}
                onChange={async (v) => {
                  if (v && typeof Notification !== "undefined" && Notification.permission !== "granted") {
                    const p = await Notification.requestPermission();
                    if (p !== "granted") return setMsg("Browser notifications were blocked.");
                  }
                  setN({ browser: v });
                }}
                label="Browser pop-up notifications"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="New setup: min quality score"><NumInput value={s.notifications.newSetupMinScore} onChange={(v) => setN({ newSetupMinScore: v })} min={40} max={100} /></Field>
              <Field label="Meme volume acceleration (×)"><NumInput value={s.notifications.memeVolumeAccel} onChange={(v) => setN({ memeVolumeAccel: v })} min={1.2} max={20} /></Field>
              <Field label="Poll interval (seconds)" hint="Min 60. BTC & scan run every 5 polls."><NumInput value={s.notifications.pollSeconds} onChange={(v) => setN({ pollSeconds: Math.max(60, Math.round(v)) })} min={60} max={3600} /></Field>
            </div>
            <div className="flex flex-col gap-2">
              <Toggle checked={s.notifications.btcBreakouts} onChange={(v) => setN({ btcBreakouts: v })} label="BTC breakouts / breakdowns" />
              <Toggle checked={s.notifications.paperFills} onChange={(v) => setN({ paperFills: v })} label="Paper stop-loss / take-profit hits" />
              <Toggle checked={s.notifications.highRiskTokens} onChange={(v) => setN({ highRiskTokens: v })} label="High-risk alerts for watchlist & held tokens" />
            </div>
          </div>
        </Card>
        <Card title="AI analyst" subtitle="Optional narrative explanations via the Anthropic API (server-side key).">
          <div className="space-y-3">
            <p className="text-xs text-ink-2">All trade decisions are computed by the transparent rule engine. The AI only explains them. If your deployment sets <code className="text-ink">AI_ACCESS_CODE</code>, enter it here so only you can use the paid endpoint.</p>
            <Field label="Access code (stored in this browser only)"><input type="password" className={inputCls} value={code} onChange={(e) => setState({ aiAccessCode: e.target.value })} autoComplete="off" /></Field>
          </div>
        </Card>
        <Card title="Integrations" subtitle="Which optional server-side keys are configured (values are never sent to the browser).">
          {!h.data ? (
            <p className="text-sm text-ink-3">{h.error ?? "Checking…"}</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {[
                ["Market data (Binance / Coinbase / Kraken / Hyperliquid / OKX)", true, "Public — no key needed"],
                ["Solana token data (DexScreener, RugCheck, Jupiter, GeckoTerminal)", true, "Public — no key needed"],
                ["AI explanations (ANTHROPIC_API_KEY)", h.data.integrations.ai, h.data.integrations.ai ? `Model: ${h.data.integrations.aiModel}` : "Optional"],
                ["Private Solana RPC (SOLANA_RPC_URL)", h.data.integrations.privateSolanaRpc, "Recommended for reliable wallet reads"],
                ["Birdeye holders & trending (BIRDEYE_API_KEY)", h.data.integrations.birdeye, "Optional"],
                ["CoinGlass liquidations (COINGLASS_API_KEY)", h.data.integrations.coinglass, "Optional"],
                ["Jupiter API key (JUPITER_API_KEY)", h.data.integrations.jupiterKey, "Optional (higher limits)"],
                ["Live execution — server (ENABLE_LIVE_EXECUTION)", h.data.integrations.liveExecution, h.data.integrations.liveExecution ? "ON: unsigned swaps can be built for wallet approval" : "Off (default)"],
                ["Live execution — browser (NEXT_PUBLIC_ENABLE_LIVE_EXECUTION)", LIVE_CLIENT, LIVE_CLIENT ? "ON in this build" : "Off in this build (needs a redeploy after changing)"],
              ].map(([label, on, note]) => (
                <li key={label as string} className="flex items-start gap-2">
                  {on ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-bull" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" />}
                  <span className="flex-1">{label}<span className="block text-[11px] text-ink-3">{note}</span></span>
                </li>
              ))}
            </ul>
          )}
          {h.data && h.data.integrations.liveExecution !== LIVE_CLIENT && (
            <div className="mt-3">
              <Notice tone="warn">
                Live execution is only half enabled. Set BOTH <code>ENABLE_LIVE_EXECUTION</code> and <code>NEXT_PUBLIC_ENABLE_LIVE_EXECUTION</code> to <code>true</code> (or both to false) in Netlify, then redeploy.
              </Notice>
            </div>
          )}
          {h.data?.integrations.liveExecution && LIVE_CLIENT && (
            <div className="mt-3">
              <Notice tone="bear">
                Real-money buying is ON. Every swap still needs the checklist, typed CONFIRM, a simulation and approval in Phantom. Selling, stop-losses and tracking of real trades are not built yet — start with a few dollars.
              </Notice>
            </div>
          )}
        </Card>
        <Card title="Data" subtitle="Settings, paper account, notifications and leaderboard live in localStorage.">
          <div className="flex flex-wrap gap-2">
            <Button onClick={download}>Export backup</Button>
            <Button onClick={() => fileRef.current?.click()}>Import backup</Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  importData(await f.text());
                  setMsg("Backup imported.");
                } catch (er) {
                  setMsg(`Import failed: ${er instanceof Error ? er.message : er}`);
                }
              }}
            />
            <Button variant="danger" onClick={() => confirm("Reset ALL EdgePilot data in this browser?") && resetAll()}>
              Reset everything
            </Button>
          </div>
          {msg && <p className="mt-2 text-xs text-ink-2">{msg}</p>}
        </Card>
      </div>
    </div>
  );
}

function useHealth() {
  const [state, setLocal] = useState<{ data?: Health; error?: string }>({});
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j: Health) => setLocal({ data: j }))
      .catch((e) => setLocal({ error: e instanceof Error ? e.message : String(e) }));
  }, []);
  return state;
}
