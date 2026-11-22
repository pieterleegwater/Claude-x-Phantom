// Market structure: support/resistance clustering and swing-based trend structure.
import type { Candle } from "../types";
import { swingPoints, type SwingPoint } from "../indicators";

export interface Level {
  price: number;
  touches: number;
  type: "support" | "resistance";
}

/** Cluster confirmed swing points into horizontal levels within `tol` (absolute price). */
export function supportResistance(c: Candle[], tol: number, lookback = 300): Level[] {
  const start = Math.max(0, c.length - lookback);
  const slice = c.slice(start);
  const swings = swingPoints(slice, 3, 3);
  const clusters: { price: number; touches: number }[] = [];
  for (const s of swings) {
    const cl = clusters.find((x) => Math.abs(x.price - s.price) <= tol);
    if (cl) {
      cl.price = (cl.price * cl.touches + s.price) / (cl.touches + 1);
      cl.touches++;
    } else clusters.push({ price: s.price, touches: 1 });
  }
  const last = c[c.length - 1].close;
  return clusters
    .map((x) => ({ ...x, type: (x.price >= last ? "resistance" : "support") as Level["type"] }))
    .sort((a, b) => a.price - b.price);
}

export function nearestLevels(levels: Level[], price: number) {
  const above = levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
  const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
  return { resistance: above[0] ?? null, support: below[0] ?? null, above, below };
}

export interface StructureRead {
  label: "Higher highs & higher lows" | "Lower highs & lower lows" | "Higher lows (compressing)" | "Lower highs (compressing)" | "Mixed / ranging" | "Insufficient data";
  bias: 1 | -1 | 0;
  lastHigh: SwingPoint | null;
  lastLow: SwingPoint | null;
  brokeAbove: boolean; // close above last confirmed swing high (bullish break of structure)
  brokeBelow: boolean;
}

export function readStructure(c: Candle[]): StructureRead {
  const swings = swingPoints(c.slice(-200), 3, 3);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2)
    return { label: "Insufficient data", bias: 0, lastHigh: highs.at(-1) ?? null, lastLow: lows.at(-1) ?? null, brokeAbove: false, brokeBelow: false };
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  const close = c[c.length - 1].close;
  const brokeAbove = close > h2.price;
  const brokeBelow = close < l2.price;
  let label: StructureRead["label"] = "Mixed / ranging";
  let bias: StructureRead["bias"] = 0;
  if (hh && hl) [label, bias] = ["Higher highs & higher lows", 1];
  else if (!hh && !hl) [label, bias] = ["Lower highs & lower lows", -1];
  else if (hl && !hh) label = "Higher lows (compressing)";
  else if (hh && !hl) label = "Lower highs (compressing)";
  if (label === "Lower highs (compressing)") label = "Mixed / ranging";
  return { label, bias, lastHigh: h2, lastLow: l2, brokeAbove, brokeBelow };
}

/**
 * Modelled liquidation zones: where traders who entered at recent swing points with common
 * leverage would be liquidated. This is an ESTIMATE derived from price structure — not
 * observed exchange liquidation data.
 */
export function modelledLiquidationZones(c: Candle[], leverages = [10, 25, 50, 100]) {
  const swings = swingPoints(c.slice(-150), 3, 3).slice(-6);
  const zones: { price: number; side: "long-liqs" | "short-liqs"; leverage: number; from: number }[] = [];
  for (const s of swings) {
    for (const L of leverages) {
      if (s.type === "low") zones.push({ price: s.price * (1 + 1 / L - 0.004), side: "short-liqs", leverage: L, from: s.price });
      else zones.push({ price: s.price * (1 - 1 / L + 0.004), side: "long-liqs", leverage: L, from: s.price });
    }
  }
  return zones;
}
