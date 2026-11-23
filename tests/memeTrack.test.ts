import { describe, it, expect } from "vitest";
import { evaluateSignal, trackStats, trackableSignals } from "@/lib/memeTrack";
import type { Candle, TradeSignal } from "@/lib/types";

const T0 = 1_800_000_000_000;
const k = (min: number, o: number, h: number, l: number, c: number): Candle => ({ time: Math.floor((T0 + min * 60_000) / 1000), open: o, high: h, low: l, close: c, volume: 1 });
const sig = { id: "MEME-mint-1", mint: "mint", symbol: "MINELIUS", time: T0, entry: 0.0205, stop: 0.01631, tp1: 0.0267, score: 81 };

describe("scanner forward test", () => {
  it("MINELIUS case: one-candle crash through the stop exits at the candle close, flagged as crash", () => {
    const o = evaluateSignal(sig, [k(0, 0.0205, 0.021, 0.0200, 0.0208), k(5, 0.0208, 0.0212, 0.0172, 0.0175), k(10, 0.0175, 0.0176, 0.0021, 0.0030)], T0 + 3600_000);
    expect(o.status).toBe("stop");
    expect(o.gapCrash).toBe(true);
    expect(o.exitPct!).toBeLessThan(-80);
  });
  it("TP1 before stop", () => {
    const o = evaluateSignal(sig, [k(0, 0.0205, 0.024, 0.0199, 0.023), k(5, 0.023, 0.0270, 0.0225, 0.026)], T0 + 3600_000);
    expect(o.status).toBe("tp1");
    expect(o.exitPct!).toBeCloseTo((0.0267 / 0.0205 - 1) * 100, 6);
  });
  it("stop is assumed first when a candle touches both", () => {
    const o = evaluateSignal(sig, [k(0, 0.0205, 0.03, 0.016, 0.02)], T0 + 3600_000);
    expect(o.status).toBe("stop");
  });
  it("ignores candles before the signal and expires after 24h", () => {
    const pre = k(-30, 0.01, 0.01, 0.001, 0.01); // would hit the stop, but before the signal
    const o = evaluateSignal(sig, [pre, k(0, 0.0205, 0.022, 0.019, 0.021)], T0 + 25 * 3600_000);
    expect(o.status).toBe("expired");
    expect(o.exitPct!).toBeCloseTo((0.021 / 0.0205 - 1) * 100, 6);
  });
  it("dedupes repeated logs of the same token within 12h and computes stats", () => {
    const mk = (id: string, mint: string, t: number) => ({ id: `MEME-${mint}-${id}`, market: "SOL-MEME", direction: "BUY", stopLoss: 1, takeProfits: [{ price: 2, r: 1, closePct: 100 }], createdAt: t }) as unknown as TradeSignal;
    const list = trackableSignals([mk("a", "A", T0), mk("b", "A", T0 + 3600_000), mk("c", "A", T0 + 13 * 3600_000), mk("d", "B", T0)]);
    expect(list.map((s) => s.id)).toEqual(["MEME-A-a", "MEME-B-d", "MEME-A-c"]);
    const st = trackStats([
      { ...evaluateSignal(sig, [k(0, 0.0205, 0.0270, 0.02, 0.026)], T0 + 1), signalId: "1" },
      { ...evaluateSignal(sig, [k(0, 0.0205, 0.021, 0.01, 0.011)], T0 + 1), signalId: "2" },
    ]);
    expect(st.resolved).toBe(2);
    expect(st.hitRate).toBe(0.5);
    expect(st.gapCrashes).toBe(1);
  });
});
