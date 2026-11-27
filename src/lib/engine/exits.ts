// Active position management (pure). Evaluated every tick for each open position on the latest
// CLOSED candle of its execution timeframe. Take-profit and stop FILLS are handled by the broker
// (resting reduce-only orders live, simulated in paper); this module decides stop moves and
// discretionary exits.
import type { Candle } from "../types";
import { Indicators, getStrategy } from "../strategies";
import { structureEvents } from "./features";
import type { MarketRegime } from "./regime";
import type { EnginePosition, ExitProfile } from "./types";

export type ExitAction = { type: "move_stop"; stop: number; why: string } | { type: "close"; why: string };

export function manageExit(p: EnginePosition, c: Candle[], exit: ExitProfile, regime: MarketRegime | null, params: Record<string, number>, feeBps: number): ExitAction[] {
  const out: ExitAction[] = [];
  const s = p.side === "long" ? 1 : -1;
  const i = c.length - 1;
  if (i < 30) return out;
  const ind = new Indicators(c);
  const k = c[i];
  const fav = (s * ((s === 1 ? k.high : k.low) - p.entry)) / p.risk;
  const maxFav = Math.max(p.maxFavorableR, fav);
  let stop = p.stop;
  // 1) break-even after a validated profit threshold (covers round-trip fees)
  if (exit.beAfterR != null && maxFav >= exit.beAfterR && s * (stop - p.entry) < 0) {
    stop = p.entry * (1 + s * (feeBps * 2) / 10_000);
    out.push({ type: "move_stop", stop, why: `Price reached ${exit.beAfterR}R — stop to break-even (+fees).` });
  }
  // 2) ATR trailing stop once the first target has filled
  const a = ind.atr(14)[i];
  if (exit.trailAtr && p.tps.some((t) => t.filled) && Number.isFinite(a)) {
    const t = k.close - s * exit.trailAtr * a;
    if (s * (t - stop) > 0) { stop = t; out.push({ type: "move_stop", stop: t, why: `ATR trailing stop (${exit.trailAtr}× ATR).` }); }
  }
  // 3) thesis invalidation
  const st = getStrategy(p.strategyId);
  if (st?.exit?.(i, { c, ind, p: params }, { side: p.side, entry: p.entry, stop, entryIndex: Math.max(0, i - p.barsHeld) })) out.push({ type: "close", why: "Strategy exit rule: the original thesis is no longer valid." });
  const ev = structureEvents(c).events[i];
  if ((s === 1 && ev === "CHOCH_DOWN") || (s === -1 && ev === "CHOCH_UP")) out.push({ type: "close", why: `Change of character against the position (${ev}).` });
  if (regime && ((s === 1 && regime === "bear_trend") || (s === -1 && regime === "bull_trend"))) out.push({ type: "close", why: `Market regime flipped to ${regime}.` });
  // 4) time stop: trade never developed
  if (exit.timeStopBars && p.barsHeld >= exit.timeStopBars && maxFav < 0.5) out.push({ type: "close", why: `Time stop: no 0.5R progress after ${p.barsHeld} bars.` });
  return out;
}
