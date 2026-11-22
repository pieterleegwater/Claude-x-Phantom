# EdgePilot AI

A personal AI crypto trading terminal for **Bitcoin (spot & perpetuals)** and **Solana memecoins**. It does the research, scoring, risk maths and trade planning, explains everything in plain English, and prefers **WAIT / NO TRADE** over forcing bad trades.

> ⚠️ **Not financial advice.** EdgePilot is an analysis and paper-trading tool. Crypto (especially leverage and memecoins) can lose 100% of capital. Live wallet execution is **disabled by default**.

---

## What it does

| Page | What you get |
|---|---|
| **Overview** | BTC/ETH/SOL prices, the BTC engine's current decision, memecoin radar, paper equity, alerts |
| **AI Signals** | BTC perp + BTC spot + memecoin signals, each with entry, stop, targets, R:R, quality score, measured history, position size, leverage, liquidation, reasons/risks/invalidation, expiry and a **Why this trade?** explainer |
| **Memecoin Scanner** | Ranked Solana tokens: EARLY MOMENTUM / BREAKOUT / TRENDING / HIGH RISK / POSSIBLE RUG / AVOID, with red-flag detection |
| **Token page** | Pool chart, RugCheck report (mint/freeze authority, LP lock, holders, insiders), score breakdown, swap **transaction preview** |
| **Bitcoin Terminal** | Chart (1m–1d) with EMA 20/50/200, VWAP, S/R, targets and est. liquidation; indicators; funding / OI / long-short; multi-timeframe table; long & short scenarios; leverage selector with mandatory risk calc; strategy status; modelled liquidation zones |
| **Strategy Lab** | 10 strategies, any of BTC/ETH/SOL, 15m–1d, date range, parameters, costs → equity curve, win rate, PF, drawdown, Sharpe, fees, slippage, funding, results by regime, **walk-forward out-of-sample**, compare-all ranking, research notes |
| **Paper Trading** | Simulated long/short, leverage, fees, slippage, funding, stop/TP, partial exits, break-even stops, liquidation, daily-loss and open-risk limits |
| **Portfolio & Risk** | Phantom wallet (read-only: address, SOL, SPL/Token-2022 balances, network) + portfolio risk rules |
| **Trade History** | Every simulated fill & closed position, CSV export |
| **Settings** | Risk limits, signal thresholds, notification thresholds, AI access code, integration status, backup/restore |

Beginner Mode (top bar) underlines jargon with definitions; the 🎓 button opens a full glossary.

---

## How decisions are made (no black box)

1. **Closed candles only.** The still-forming candle is discarded.
2. **Strategy rules** (`src/lib/strategies.ts`) are evaluated on the latest closed candle — *the same code the backtester uses*.
3. **Measured history.** Each strategy is backtested on the loaded data (fees + slippage + funding), giving trades, win rate with a 95% Wilson interval, profit factor and expectancy. This is the **statistical** evidence.
4. **Quality score** (0–100) = weighted measurable factors. This is **rule agreement, not a probability**.
   - BTC: Trend 20 · Momentum 15 · Volume 15 · Structure 15 · Volatility 10 · Location/Reward 15 · Derivatives positioning 10
   - Memecoins: Momentum 20 · Liquidity 20 · Volume acceleration 15 · Buy/sell 10 · Holders 15 · Whales/insiders 5 · Age 5 · Contract risk 10
   - Unavailable factors are excluded and weights renormalised (shown in the UI).
5. **Hard rules** reject regardless of score: stale data, extreme volatility, R:R below minimum, higher timeframe disagreement (trend setups), negative measured edge, liquidation closer than 2× the stop, quality below threshold; for memecoins: freeze/mint authority, honeypot pattern, liquidity pull, unverified contract, low liquidity, high price impact, ≥3 warnings.
6. **Decision:** LONG / SHORT (perp), BUY / SELL (spot — SELL means exit/stay in cash), WAIT (setup forming or score slightly low) or NO TRADE.
7. **Position size is risk-first:** `qty = (equity × risk%) ÷ (stop distance + round-trip costs)`. Leverage only changes margin and liquidation distance; it's **never** derived from confidence. Suggested leverage = lowest leverage that keeps margin ≤30% of equity with liquidation ≥2.5× farther than the stop, capped by your max.

### Backtest integrity
Signals at bar *i* close → fill at bar *i+1* **open** + slippage; stop assumed before target if both touched in one bar; gaps fill at the worse open; taker fees both sides; funding charged on perps; walk-forward uses 4 rolling folds (2:1 in-sample/out-of-sample) with small parameter grids, reports only stitched OOS results, IS-vs-OOS degradation ("overfit?") and parameter robustness. Sharpe is shown only with ≥30 trades.

---

## Data sources (all documented public APIs)

| Data | Provider (fallback order) | Key? |
|---|---|---|
| BTC/ETH/SOL candles & ticker | Binance public market data (`data-api.binance.vision`) → Coinbase Exchange → Kraken → Hyperliquid (perp, labelled) | No |
| Funding, open interest, OI change, long/short ratio, funding history | Binance USDⓈ-M Futures, OKX public/rubik, Hyperliquid info API (merged, venue shown) | No |
| BTC liquidation totals | CoinGlass | `COINGLASS_API_KEY` |
| Liquidation *zones* | Modelled from swing points × common leverage — **labelled as an estimate** | — |
| Memecoin discovery & metrics | DexScreener (boosts, profiles, takeovers, pairs) | No |
| Contract risk, holders, LP lock, insiders | RugCheck | No |
| Holder counts / trending (extra) | Birdeye | `BIRDEYE_API_KEY` |
| Swap quotes, price impact, sell-back check | Jupiter (lite API; pro with key) | Optional |
| Token pool candles | GeckoTerminal | No |
| Wallet balances | Solana RPC via read-only server proxy | `SOLANA_RPC_URL` recommended |
| AI explanations | Anthropic Claude | `ANTHROPIC_API_KEY` |

Every panel shows **source, fetch time, and LIVE/DELAYED** status; hover for fallbacks used. When data is unavailable the UI shows an error — it **never substitutes fake data**. Social momentum is intentionally *not* scored (no reliable free source); "whale activity" is a clearly-labelled proxy.

---

## Setup (local)

Requirements: Node.js ≥ 20.9 (22 recommended).

```bash
npm install
cp .env.example .env.local   # optional — everything works without keys
npm run dev                  # http://localhost:3000
npm test                     # 35 engine tests (indicators, risk, backtest, signals, paper)
npm run build                # production build
```

## Deploy to Netlify

1. Push this repo to GitHub.
2. Netlify → **Add new site → Import an existing project** → pick the repo.
3. Build settings are read from `netlify.toml` (`npm run build`, Next.js runtime via `@netlify/plugin-nextjs`, Node 22). Nothing to change.
4. (Optional) **Site configuration → Environment variables** → add keys from `.env.example`. Redeploy after changes.
5. Open the site → **Settings → Integrations** to confirm which keys are detected (booleans only — values never reach the browser).

CLI alternative: `npm i -g netlify-cli && netlify init && netlify deploy --build --prod`.

### API key setup
- **Anthropic (AI explanations):** console.anthropic.com → API Keys → set `ANTHROPIC_API_KEY`. Also set `AI_ACCESS_CODE` and type the same code in Settings → AI so only you can use the endpoint (it is also rate-limited to 20 requests/hour/IP). Uses `claude-opus-5-5` with low effort and server-side refusal fallback; override with `AI_MODEL`.
- **Helius (Solana RPC):** helius.dev → create key → `SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=…`.
- **Birdeye / CoinGlass / Jupiter:** create keys on their portals and set the matching variable.

### Supabase?
Not required. Settings, paper account, alerts and the strategy leaderboard are stored in your browser (localStorage) — use **Settings → Export backup** to move between devices. A persistence layer (e.g. Supabase) can be added behind `src/lib/client/store.ts` if you want multi-device sync.

---

## Security

- No seed phrases, private keys or wallet secrets are ever requested or stored. The wallet adapter only exposes your **public** key.
- All API keys live in server environment variables; browser code never sees them.
- Server routes validate every input with **zod**, rate-limit per IP (AI endpoint strictly), time out upstream calls and return sanitised errors.
- `/api/solana/rpc` forwards only an **allowlist of read methods** — `sendTransaction` is blocked.
- Security headers (HSTS, X-Frame-Options DENY, nosniff, referrer & permissions policy) are set in `next.config.ts`.
- Transactions: the preview shows token, amounts, minimum received, slippage, price impact, route, network fee, destination and a sell-back (honeypot) check. **Nothing is signed automatically.**

### Enabling execution (opt-in architecture)
Execution is off. If you deliberately set both `ENABLE_LIVE_EXECUTION=true` and `NEXT_PUBLIC_ENABLE_LIVE_EXECUTION=true`, the token page's preview gains a button that: requires a 4-item checklist + typing `CONFIRM` → asks the server to build an **unsigned** Jupiter swap for your public key (max $10k) → **simulates** it → hands it to Phantom, where you approve or reject. There is no autonomous trading. Understand the risks before enabling.

---

## Notifications
Alerts (new high-quality setup, BTC breakout/breakdown, memecoin volume acceleration, paper stop/TP/liquidation, high-risk flags on watchlist or held tokens) are generated **while a tab is open**, shown in the 🔔 center and optionally as browser pop-ups. Thresholds are in Settings. Background push when the app is closed would need a scheduled function + web push (not included).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Data unavailable — Binance … fetch failed" | Normal in regions Binance blocks; the app falls back to Coinbase/Kraken automatically. If *all* fail, the host has no outbound internet or providers are down. |
| Data marked **DELAYED** | Newest candle older than 2 intervals — provider lag or outage. Signals reject stale data automatically. |
| Derivatives panel empty | Binance Futures may be geo-blocked from your Netlify region; OKX/Hyperliquid are tried too. Funding-based strategy shows "n/a" without history. |
| Wallet balances fail | Public Solana RPC rate limits — set `SOLANA_RPC_URL`. |
| Phantom not detected | Install the extension and reload; on mobile open the site in Phantom's in-app browser. |
| AI button says "not configured" | Set `ANTHROPIC_API_KEY` and redeploy. "Invalid access code" → enter `AI_ACCESS_CODE` in Settings → AI. |
| Scanner slow / some tokens "risk report not loaded" | RugCheck is rate-limited; only the top 24 candidates are fully checked per scan (cached 5 min). Unverified tokens are capped at score 60 and never become BUY signals. |
| Backtest "too few candles" | Choose a longer range; max 10,000 candles per test. |
| Lost paper data | It's per-browser; use Settings → Export/Import backup. |

## Project structure

```
src/
  app/                    pages (9 + token detail) and API routes (app/api/*)
  components/             UI kit, charts (lightweight-charts), signal cards, wallet, tx preview, shell, watcher
  lib/
    indicators.ts         EMA/SMA/RSI/ATR/MACD/BB/VWAP/ADX/swings (causal)
    strategies.ts         10 strategies + research notes
    backtest.ts           engine, metrics, regimes, walk-forward
    risk.ts               sizing, liquidation, leverage suggestion
    paper.ts              simulation engine
    analysis/             btcEngine, memeEngine, structure (S/R, liquidation zones)
    providers/            market (CEX + derivatives), solana (DexScreener, RugCheck, Jupiter, GeckoTerminal)
    server/               fetch/fallback, cache, rate limit, responses
    client/               persisted store, data hooks
tests/                    vitest suites
```
