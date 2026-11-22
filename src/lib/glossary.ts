// Beginner glossary used by <Term> tooltips and the Learn panel.
export const GLOSSARY: Record<string, { term: string; short: string; long: string }> = {
  leverage: {
    term: "Leverage",
    short: "Borrowed buying power. 10x means a $100 deposit controls a $1,000 position.",
    long: "Leverage multiplies both gains and losses relative to the margin you put up. It does NOT change how much you lose if your stop-loss is hit when you size by risk — but it moves your liquidation price closer. Beginners should stay at low leverage (1–3x).",
  },
  liquidation: {
    term: "Liquidation",
    short: "When the exchange force-closes a leveraged position because your margin is nearly gone.",
    long: "With 10x leverage, a ~10% move against you wipes the margin and the position is liquidated — you lose the margin. Your stop-loss must always sit well before the liquidation price.",
  },
  slippage: {
    term: "Slippage",
    short: "The difference between the price you expect and the price you actually get.",
    long: "Market orders in thin markets push the price as they fill. Memecoins with low liquidity can have several percent of slippage per trade — on the way in AND out.",
  },
  liquidity: {
    term: "Liquidity",
    short: "How much money is available to trade against. More liquidity = easier to buy/sell without moving price.",
    long: "For DEX tokens, liquidity is the value locked in the trading pool. If liquidity is removed (a 'rug pull'), the token becomes nearly impossible to sell.",
  },
  marketcap: {
    term: "Market cap",
    short: "Token price × circulating supply — the total market value.",
    long: "FDV (fully diluted value) uses the total supply including tokens not yet circulating. A small liquidity pool relative to market cap means price can move violently.",
  },
  stoploss: {
    term: "Stop-loss",
    short: "A pre-planned exit price that limits your loss if the trade goes wrong.",
    long: "The stop is placed where the trade idea is proven wrong. Position size is calculated so that hitting the stop loses only a small, fixed % of your account (e.g. 1%).",
  },
  takeprofit: {
    term: "Take-profit",
    short: "A pre-planned price where you sell part or all of a winning position.",
    long: "EdgePilot scales out at several targets (e.g. 40% / 35% / 25%) and moves the stop to break-even after the first target so a winner cannot become a loser.",
  },
  funding: {
    term: "Funding rate",
    short: "A periodic payment between long and short traders on perpetual futures.",
    long: "Positive funding: longs pay shorts (many people are long). Negative: shorts pay longs. Very high funding signals crowded positioning, which often precedes sharp reversals. Funding is a cost while you hold a position.",
  },
  riskreward: {
    term: "Risk/reward (R:R)",
    short: "How much you aim to make for every $1 you risk. 2:1 means target profit is twice the possible loss.",
    long: "With 2:1 R:R you can be wrong more than half the time and still be profitable. 'R' = your planned risk; a +2R trade made twice what you risked.",
  },
  rr: {
    term: "R multiple",
    short: "Profit or loss measured in units of the planned risk.",
    long: "If you risk $100 and make $250, that trade was +2.5R. Measuring in R makes trades of different sizes comparable.",
  },
  winrate: {
    term: "Win rate",
    short: "The % of trades that made money.",
    long: "Win rate alone means little — a 35% win rate can be very profitable with large winners, and a 70% win rate can lose money with large losers. Look at expectancy and profit factor too.",
  },
  profitfactor: {
    term: "Profit factor",
    short: "Gross profit ÷ gross loss. Above 1 = profitable; 1.5+ is good after costs.",
    long: "A profit factor of 1.3 means the strategy made $1.30 for every $1 it lost (after fees and slippage in our tests).",
  },
  drawdown: {
    term: "Max drawdown",
    short: "The largest peak-to-trough drop in account value.",
    long: "A 30% drawdown requires a 43% gain to recover. Lower drawdown means a smoother, more survivable strategy.",
  },
  expectancy: {
    term: "Expectancy",
    short: "Average result per trade, in R. Positive expectancy = edge.",
    long: "Expectancy = (win rate × avg win) − (loss rate × avg loss). EdgePilot reports it in R after costs.",
  },
  atr: {
    term: "ATR",
    short: "Average True Range — the typical size of a candle. Used to set stops that respect normal volatility.",
    long: "A stop of 2×ATR sits outside normal noise. When ATR rises, positions are sized smaller automatically.",
  },
  ema: {
    term: "EMA",
    short: "Exponential moving average — a smoothed price line that reacts faster to recent prices.",
    long: "EMA 20/50/200 are common trend references. Price above a rising 200 EMA is generally considered a long-term uptrend.",
  },
  rsi: {
    term: "RSI",
    short: "Relative Strength Index (0–100) — measures momentum. Above 70 = stretched up, below 30 = stretched down.",
    long: "RSI is used here for momentum confirmation, not as a stand-alone buy/sell signal.",
  },
  vwap: {
    term: "VWAP",
    short: "Volume-weighted average price — the average price paid today, weighted by volume.",
    long: "Institutions benchmark executions against VWAP. Price holding above VWAP suggests buyers are in control for the session.",
  },
  oi: {
    term: "Open interest",
    short: "The total value of open futures contracts.",
    long: "Rising open interest with rising price means new money is supporting the move. Rising OI with falling price means new shorts are piling in.",
  },
  walkforward: {
    term: "Walk-forward test",
    short: "Optimise on past data, then test on the NEXT unseen period — repeated over time.",
    long: "Only the unseen (out-of-sample) results are counted. This is the main defence against overfitting: a strategy that only works on the data it was tuned on is worthless.",
  },
  quality: {
    term: "Quality score",
    short: "A transparent 0–100 rule-based score of how many measurable conditions line up. It is NOT a probability.",
    long: "Each factor (trend, momentum, volume, structure, volatility, reward, positioning) is scored from measurable inputs and weighted. Hard rules can still reject a high-scoring setup.",
  },
  historical: {
    term: "Historical win rate",
    short: "How often this exact rule won on recent real data — a statistical estimate with an uncertainty range.",
    long: "Shown with a 95% confidence interval (Wilson). Small samples (<20 trades) give very wide ranges and should not be trusted.",
  },
  honeypot: {
    term: "Honeypot",
    short: "A scam token you can buy but cannot sell.",
    long: "Signs: freeze authority enabled, almost no sell transactions, or no sell route on aggregators. EdgePilot checks these, but no check is complete.",
  },
  rugpull: {
    term: "Rug pull",
    short: "When developers remove liquidity or dump their supply, crashing the price to ~zero.",
    long: "Risk signs: unlocked liquidity, concentrated holders, mint authority enabled, very new token, insider wallets.",
  },
  mintauthority: {
    term: "Mint authority",
    short: "Permission to create new tokens. If not revoked, supply can be inflated at any time.",
    long: "For memecoins, mint authority should be revoked (null). Enabled mint authority is treated as a critical red flag.",
  },
  perp: {
    term: "Perpetual futures",
    short: "Futures contracts with no expiry that track the spot price via funding payments. Allow shorting and leverage.",
    long: "Perps let you profit from falling prices (shorting) but carry liquidation and funding risk.",
  },
  spot: {
    term: "Spot",
    short: "Buying the actual coin. No leverage, no liquidation, no shorting.",
    long: "Spot is the safest way to hold crypto exposure: the worst case is the coin going to zero, not losing more than you put in.",
  },
};
