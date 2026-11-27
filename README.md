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
Execution is off. If you deliberately set both `ENABLE_LIVE_EXECUTION=true` and `NEXT_PUBLIC_ENABLE_LIVE_EXECUTION=true`, the token page's preview gains a button that: requires a 4-item checklist + typing `CONFIRM` → asks the server to build an **unsigned** Jupiter swap for your public key (max $10k) → **simulates** it → hands it to Phantom, where you approve or reject. This Phantom flow never trades autonomously; autonomous trading exists only for Hyperliquid perps in the separate Autopilot engine below. Understand the risks before enabling.

---

## Autopilot — autonomous perps engine (Hyperliquid)

Phantom cannot trade perpetual futures, so the autonomous engine executes on **Hyperliquid** through its official API (SDK `@nktkas/hyperliquid`). Solana memecoins are **not** traded autonomously (that would require a server-held Solana key and has uncontrollable rug/gap risk); the scanner only analyses them.

**How it runs.** `netlify/functions/engine-tick.mts` is a Netlify Scheduled Function that runs **every minute**, 24/7, also when the browser is closed. State (positions, trades, validation, alerts) lives in **Netlify Blobs** (`.data/engine.json` locally). The dashboard is at **/autopilot**.

**Each cycle** (`src/lib/engine/engine.ts`):
1. Sync positions with the broker: stop/TP fills, funding, liquidation, venue truth.
2. STOP ALL active → close every position, block everything.
3. Roll daily/weekly bookkeeping → automatic shutdown at −1.5 % day (until next UTC day) or −5 % from the weekly peak (manual review).
4. Manage open positions: break-even after 1R (+fees), ATR trailing after TP1, exit when the strategy's thesis is invalidated, on an opposite CHOCH, regime flip or time stop.
5. Walk-forward validation (time-budgeted): every strategy × coin × timeframe is re-tested every 12 h on up to 3000 closed candles: 4 folds, parameters + exit profile chosen in-sample, judged **out-of-sample only** with fees, slippage, funding and liquidation. Validated = ≥ 30 OOS trades, expectancy ≥ 0.05R, PF ≥ 1.1, beats a plain EMA-cross benchmark and stays positive across folds.
6. Scan: regime (bull/bear trend, range, high/low volatility, breakout) → only strategies **validated for that regime** → entry signal on the last closed candle → venue-aware sizing → 0–100 score (trend, momentum, volume, structure BOS/CHOCH/FVG, HTF alignment, entry quality, R:R, volatility, order-book liquidity, proven edge, funding) with critical flags that override the score.
7. Decision: live needs ≥ 80, paper ≥ 70, a validated edge and zero flags. Otherwise **WAIT / NO TRADE** with the reason. At most one new entry per cycle; no duplicate positions per coin.

**Risk governor** (`riskGovernor.ts`): 0.5 % risk per trade including fees and slippage; size is rounded **down** and a trade that cannot fit the risk budget (Hyperliquid's $10 minimum) is **skipped, never oversized**; risk halves after 3 consecutive losses (never increased to recover losses — no martingale, no averaging down); cooldown after a loss; max positions and trades per day; leverage is the lowest that fits, capped at 5x live (hard max 10x) and up to 40x in paper, and walked down until the liquidation price is ≥ 1.5× further than the stop.

**Exits.** Default profile TP1 1R 40 % / TP2 2R 35 % / TP3 3R 25 %, BE after 1R, 2×ATR trail; alternatives (runner, fixed 2R) are selected per market by validation.

**Live execution guarantees** (`hlBroker.ts`): isolated margin; IOC entry with a 0.3 % slippage cap; the fill is **read back** from the exchange (never assumed); a reduce-only stop-market is placed immediately and **verified on the order book** — if that fails twice the position is closed at market (emergency protection); TPs are reduce-only limits; stop moves place the new stop before cancelling the old one; every cycle reconciles with the venue and books realized PnL, fees and funding from actual fills.

**A $10 account, honestly.** With 0.5 % risk the budget is $0.05 per trade. Hyperliquid's minimum order is $10 notional, so only stops of ≈ 0.35 % or tighter (after costs) can be traded; wider setups are skipped. Expect few live trades at this size. 40x leverage is available in paper mode only; leverage does not change the risk per trade, only margin and liquidation distance.

### Enabling (paper first)
1. Set `ENGINE_ADMIN_TOKEN` in Netlify → redeploy → open **/autopilot**, enter the token, turn **Auto trading ON** (paper mode). Let it run; validation fills in during the first cycles.
2. Live (only after paper results convince you): on app.hyperliquid.xyz create an **API wallet** (More → API; it can trade but cannot withdraw), deposit USDC to your main account. Set `HL_ACCOUNT_ADDRESS` (main address), `HL_AGENT_PRIVATE_KEY` (API wallet key), optionally `HL_TESTNET=true`, and `LIVE_TRADING_ENABLED=true`. Redeploy, switch mode to Live and **arm** it with the typed confirmation.
3. **STOP ALL** (dashboard) turns auto off and closes all positions at market. Stops remain resting on the exchange even if the server is down.

### Testnet validation (required before live)
`npm run validate:testnet` with `HL_TESTNET=true`, `HL_ACCOUNT_ADDRESS` and `HL_AGENT_PRIVATE_KEY` of a **testnet** account (≥ $25 from the testnet faucet, API wallet approved). It refuses to run without `HL_TESTNET=true`, places real testnet orders (~$11 BTC) and writes `testnet-report.md` with the exchange evidence. It checks market data, balance, agent authentication, min-size and no-fill rejections, timeouts, an entry with a verified fill, a verified stop and TP orders, duplicate prevention, stop modification, size reconciliation, restart recovery, a verified close with PnL from fills, closing an untracked position that has no stop, and STOP ALL confirmed by the exchange. Failure modes that cannot be forced on a real exchange (a stop rejected after a fill, a timeout after acceptance, a failed emergency close, partial fills, margin rejections) are covered by `tests/hlBroker.test.ts` against a scripted exchange.

Live also requires `ENGINE_ADMIN_TOKEN`. Use a dedicated Hyperliquid account or sub-account: the engine closes any position in its coins that has **no stop-loss** and that it does not track.

No strategy is presumed profitable: if nothing passes out-of-sample validation the engine simply waits. Results shown are from real fills (live) or simulation (paper), never invented.

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
