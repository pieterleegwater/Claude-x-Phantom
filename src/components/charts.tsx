"use client";
import { useEffect, useRef, useState } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  AreaSeries,
  createSeriesMarkers,
  LineStyle,
  ColorType,
  TickMarkType,
  type IChartApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import type { Candle } from "@/lib/types";

const theme = {
  layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#8a919e", fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 11 },
  grid: { vertLines: { color: "rgba(35,40,49,0.6)" }, horzLines: { color: "rgba(35,40,49,0.6)" } },
  rightPriceScale: { borderColor: "#232831" },
  // Show times in the viewer's LOCAL timezone (lightweight-charts defaults to UTC).
  timeScale: {
    borderColor: "#232831",
    timeVisible: true,
    secondsVisible: false,
    tickMarkFormatter: (t: Time, type: TickMarkType) => {
      const d = new Date((t as number) * 1000);
      if (type === TickMarkType.Year) return String(d.getFullYear());
      if (type === TickMarkType.Month) return d.toLocaleDateString(undefined, { month: "short" });
      if (type === TickMarkType.DayOfMonth) return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
      return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    },
  },
  localization: { timeFormatter: (t: Time) => new Date((t as number) * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }) },
  crosshair: { mode: 0 },
};

export interface Overlay {
  values: number[]; // aligned with candles
  color: string;
  title: string;
  width?: 1 | 2 | 3;
}

export interface PriceLineDef {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface MarkerDef {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle";
  text?: string;
}

function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const f = () => setPhone(mq.matches);
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return phone;
}

export function CandleChart({ candles, overlays = [], priceLines = [], markers = [], height: desktopHeight = 420, showVolume = true }: { candles: Candle[]; overlays?: Overlay[]; priceLines?: PriceLineDef[]; markers?: MarkerDef[]; height?: number; showVolume?: boolean }) {
  const phone = useIsPhone();
  const height = phone ? Math.min(desktopHeight, 300) : desktopHeight;
  const el = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, { ...theme, height, autoSize: true });
    chartRef.current = chart;
    fitted.current = false;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candles.length) return;
    const series = chart.addSeries(CandlestickSeries, { upColor: "#22c55e", downColor: "#ef4444", borderVisible: false, wickUpColor: "#22c55e", wickDownColor: "#ef4444", priceFormat: autoFormat(candles) });
    series.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close })));
    const extra: ReturnType<IChartApi["addSeries"]>[] = [series];
    if (showVolume) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)" })));
      extra.push(vol);
    }
    for (const o of overlays) {
      const ls = chart.addSeries(LineSeries, { color: o.color, lineWidth: o.width ?? 1, priceLineVisible: false, lastValueVisible: false, title: o.title, crosshairMarkerVisible: false });
      ls.setData(candles.map((k, i) => ({ time: k.time as UTCTimestamp, value: o.values[i] })).filter((p) => Number.isFinite(p.value)));
      extra.push(ls);
    }
    for (const p of priceLines) series.createPriceLine({ price: p.price, color: p.color, lineWidth: 1, lineStyle: p.dashed ? LineStyle.Dashed : LineStyle.Solid, axisLabelVisible: true, title: p.title });
    if (markers.length) createSeriesMarkers(series, markers.map((m) => ({ ...m, time: m.time as Time })) as SeriesMarker<Time>[]);
    if (!fitted.current) {
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - (phone ? 70 : 160)), to: candles.length + (phone ? 3 : 5) });
      fitted.current = true;
    }
    return () => {
      for (const s of extra) {
        try {
          chart.removeSeries(s);
        } catch {
          /* chart already removed */
        }
      }
    };
  }, [candles, overlays, priceLines, markers, showVolume, phone]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

function autoFormat(c: Candle[]) {
  const p = c[c.length - 1]?.close ?? 1;
  const precision = p >= 1000 ? 1 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return { type: "price" as const, precision, minMove: 1 / 10 ** precision };
}

export function LineChart({ points, height: desktopHeight = 220, color = "#8b9cff", baseline }: { points: { time: number; value: number }[]; height?: number; color?: string; baseline?: number }) {
  const phone = useIsPhone();
  const height = phone ? Math.min(desktopHeight, 200) : desktopHeight;
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !points.length) return;
    const chart = createChart(el.current, { ...theme, height, autoSize: true });
    const s = chart.addSeries(AreaSeries, { lineColor: color, topColor: color + "40", bottomColor: color + "00", lineWidth: 2, priceLineVisible: false });
    // dedupe & sort times (lightweight-charts requires strictly increasing time)
    const m = new Map<number, number>();
    for (const p of points) m.set(Math.floor(p.time), p.value);
    s.setData([...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    if (baseline != null) s.createPriceLine({ price: baseline, color: "#6b7380", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "start" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, height, color, baseline]);
  return <div ref={el} style={{ height }} className="w-full" />;
}
