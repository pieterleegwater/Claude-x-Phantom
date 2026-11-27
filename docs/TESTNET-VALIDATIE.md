# Hyperliquid testnet-validatie — stappenplan (optie B, lokaal)

Uitsluitend **testnet**. `LIVE_TRADING_ENABLED` blijft uit. Gebruik nooit je echte wallet-key, seed phrase of een mainnet API-sleutel.

## 1. Project lokaal installeren
Vereist: Node.js 22 (minimaal 20.9) en git.
```bash
git clone https://github.com/pieterleegwater/Claude-x-Phantom.git
cd Claude-x-Phantom
git checkout claude/edgepilot-ai-trading-g5k0d9
npm ci
npm test            # verwacht: alle tests geslaagd
```
De webapp hoef je hiervoor niet te starten (`npm run dev` is optioneel).

## 2. Benodigde testnetgegevens
| Variabele | Wat | Geheim? |
|---|---|---|
| `HL_TESTNET` | exact `true` | nee |
| `HL_ACCOUNT_ADDRESS` | publiek adres van je **testnet**-account (0x + 40 tekens) | nee |
| `HL_AGENT_PRIVATE_KEY` | private key van een **testnet API-wallet** (0x + 64 tekens) | **ja** |

Het account heeft minimaal ~$25 testnet-USDC nodig en geen open BTC-positie.

**Aanbevolen scheiding:** maak een nieuwe EVM-wallet (bijv. een nieuw account in MetaMask/Rabby) die je alléén voor testnet gebruikt. De testnet-faucet (app.hyperliquid-testnet.xyz → Drip/Faucet) vereist volgens Hyperliquid dat het adres eerder op mainnet heeft gestort. Als je nieuwe wallet dat niet heeft: claim de testnet-USDC met je bestaande adres op de testnet-site (dat vraagt alleen een handtekening voor testnet; je private key verlaat je wallet niet) en stuur de testnet-USDC daarna door naar de nieuwe wallet. Controleer de actuele faucet-voorwaarden in de Hyperliquid-docs.

## 3. API-wallet veilig aanmaken
1. Ga naar **app.hyperliquid-testnet.xyz** (let op: *-testnet*), verbind je testnet-wallet.
2. Menu **More → API**. Geef een naam (bijv. `edgepilot-testnet`), klik **Generate**.
3. Kopieer de getoonde private key (wordt maar één keer getoond) en klik **Authorize API Wallet**; teken met je testnet-wallet. Kies een korte geldigheid.
4. Een API-wallet kan handelen maar **niet opnemen**.
5. Zet de gegevens in een bestand, niet in je terminal:
   ```bash
   cp .env.testnet.example .env.testnet
   chmod 600 .env.testnet        # macOS/Linux
   ```
   Open `.env.testnet` in een editor en vul `HL_ACCOUNT_ADDRESS` en `HL_AGENT_PRIVATE_KEY` in. Het bestand staat in `.gitignore`; controleer met `git check-ignore -v .env.testnet`.
6. Plak de key nooit in een chat, screenshot of issue. Verwijder de API-wallet na de validatie (More → API → Remove).

## 4. Controleren dat testnet actief is (zonder orders)
```bash
npm run testnet:check
```
Verwacht:
```
Network : TESTNET (https://api.hyperliquid-testnet.xyz)
...
PASS Market data ...
PASS Account balance ... accountValue $…
PASS Agent-wallet authentication ...
Preflight OK — testnet confirmed, no orders were placed. Hosts contacted: api.hyperliquid-testnet.xyz
```
Het script **stopt direct** als: `HL_TESTNET` niet exact `true` is, `LIVE_TRADING_ENABLED=true` staat, de key van het account zelf is (geen API-wallet), of er een ander adres dan `api.hyperliquid-testnet.xyz` benaderd zou worden.
Extra controle: het getoonde `accountValue` moet gelijk zijn aan je saldo op app.hyperliquid-**testnet**.xyz.

## 5. Volledige validatie
Alleen als stap 4 volledig OK is:
```bash
npm run validate:testnet
```
Duur ±1–2 minuten. Het plaatst echte testnet-orders (~$11 BTC) en schrijft `testnet-report.md` en `testnet-report.json`. Na afloop sluit het alles wat het zelf geopend heeft.

## 6. Bevestiging door Hyperliquid controleren
1. In `testnet-report.md` moet elke regel **PASS** zijn, en bovenaan `Network: TESTNET` met alleen `api.hyperliquid-testnet.xyz` als host.
2. De sectie *All fills during this run* komt rechtstreeks van Hyperliquid (`userFillsByTime`). Vergelijk de order-ID's (oid) met app.hyperliquid-testnet.xyz → **Trade History** (fills) en **Order History** (stop-loss trigger, TP-limit, annuleringen).
3. Op de testnet-site: **Positions** en **Open Orders** moeten na afloop leeg zijn.
4. Stuur `testnet-report.md` terug ter controle. Het bevat geen geheimen (adressen zijn ingekort, de key wordt nergens geschreven).
