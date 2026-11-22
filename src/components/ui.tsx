"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, AlertTriangle, Info } from "lucide-react";
import { GLOSSARY } from "@/lib/glossary";
import { useStore } from "@/lib/client/store";
import type { DataMeta, Direction } from "@/lib/types";

export function cn(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ children, className, title, subtitle, right, pad = true }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; pad?: boolean }) {
  return (
    <section className={cn("rounded-xl border border-line bg-panel animate-fade-in", className)}>
      {(title || right) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {right && <div className="flex min-w-0 max-w-full items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

type Tone = "bull" | "bear" | "warn" | "info" | "neutral";
const toneCls: Record<Tone, string> = {
  bull: "bg-bull-soft text-bull border-bull/30",
  bear: "bg-bear-soft text-bear border-bear/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  info: "bg-info-soft text-info border-info/30",
  neutral: "bg-panel-2 text-ink-2 border-line-2",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide", toneCls[tone], className)}>{children}</span>;
}

export function directionTone(d: Direction | string): Tone {
  if (d === "LONG" || d === "BUY") return "bull";
  if (d === "SHORT" || d === "SELL") return "bear";
  if (d === "WAIT") return "warn";
  return "neutral";
}

export function DirectionBadge({ d, large }: { d: Direction; large?: boolean }) {
  return <Badge tone={directionTone(d)} className={large ? "px-2.5 py-1 text-sm" : ""}>{d.replace("_", " ")}</Badge>;
}

export function Button({ children, onClick, variant = "default", size = "md", disabled, type = "button", className, title }: { children: ReactNode; onClick?: () => void; variant?: "default" | "primary" | "ghost" | "bull" | "bear" | "danger"; size?: "sm" | "md"; disabled?: boolean; type?: "button" | "submit"; className?: string; title?: string }) {
  const v = {
    default: "bg-panel-2 border-line-2 text-ink hover:bg-line",
    primary: "bg-accent/90 border-accent text-[#0b0d10] hover:bg-accent",
    ghost: "bg-transparent border-transparent text-ink-2 hover:bg-panel-2 hover:text-ink",
    bull: "bg-bull/90 border-bull text-[#04120a] hover:bg-bull",
    bear: "bg-bear/90 border-bear text-white hover:bg-bear",
    danger: "bg-bear-soft border-bear/40 text-bear hover:bg-bear/20",
  }[variant];
  return (
    <button type={type} title={title} disabled={disabled} onClick={onClick} className={cn("inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40", size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm", v, className)}>
      {children}
    </button>
  );
}

export function Stat({ label, value, sub, tone, hint }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "bull" | "bear" | "warn"; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-3">{label}</div>
      <div className={cn("num mt-1 truncate text-lg font-semibold", tone === "bull" && "text-bull", tone === "bear" && "text-bear", tone === "warn" && "text-warn")}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse-soft rounded-md bg-panel-2", className)} />;
}

export function ErrorBox({ title = "Data unavailable", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-bear/30 bg-bear-soft/40 p-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-bear" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink">{title}</div>
        <div className="mt-0.5 break-words text-xs text-ink-2">{message}</div>
        <div className="mt-1 text-xs text-ink-3">EdgePilot never substitutes fake data. Check Settings → Integrations or try again.</div>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" | "bear" }) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div className={cn("flex items-start gap-2 rounded-lg border p-3 text-xs leading-relaxed", tone === "info" && "border-info/25 bg-info-soft/40 text-ink-2", tone === "warn" && "border-warn/30 bg-warn-soft/40 text-ink-2", tone === "bear" && "border-bear/30 bg-bear-soft/40 text-ink-2")}>
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", tone === "info" ? "text-info" : tone === "warn" ? "text-warn" : "text-bear")} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line-2 p-6 text-center text-sm text-ink-3">{children}</div>;
}

export function ScoreBar({ score, className }: { score: number | null; className?: string }) {
  const s = score ?? 0;
  const color = score == null ? "bg-line-2" : s >= 70 ? "bg-bull" : s >= 50 ? "bg-warn" : "bg-bear";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-line", className)}>
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${score == null ? 100 : s}%`, opacity: score == null ? 0.3 : 1 }} />
    </div>
  );
}

export function ScoreRing({ score, size = 56, label }: { score: number; size?: number; label?: string }) {
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const color = score >= 70 ? "var(--color-bull)" : score >= 50 ? "var(--color-warn)" : "var(--color-bear)";
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title={label ?? "Quality score (rule-based, not a probability)"}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--color-line)" strokeWidth="4" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="4" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} strokeLinecap="round" />
      </svg>
      <div className="num absolute inset-0 flex items-center justify-center text-sm font-semibold">{score}</div>
    </div>
  );
}

/** Glossary-aware term: dotted underline + tooltip when Beginner Mode is on. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const beginner = useStore((s) => s.settings.beginnerMode);
  const g = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  if (!g || !beginner) return <>{children ?? g?.term ?? k}</>;
  return (
    <span ref={ref} className="relative inline">
      <span className="term" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onClick={() => setOpen((o) => !o)}>
        {children ?? g.term}
      </span>
      {open && (
        <span className="absolute left-0 top-full z-50 mt-1 block w-64 rounded-lg border border-line-2 bg-panel-2 p-2.5 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-ink-2 shadow-xl">
          <span className="block font-semibold text-ink">{g.term}</span>
          {g.short}
        </span>
      )}
    </span>
  );
}

export function timeAgo(ms: number | undefined) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Shows where data came from, when, and whether it is delayed. */
export function DataBadge({ meta, loading }: { meta?: DataMeta; loading?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, []);
  if (!meta) return <span className="text-[11px] text-ink-3">{loading ? "Loading…" : ""}</span>;
  const title = [`Source: ${meta.source}`, `Fetched: ${new Date(meta.fetchedAt).toLocaleString()}`, meta.dataTime ? `Newest datapoint: ${new Date(meta.dataTime).toLocaleString()}` : "", meta.note ?? "", meta.errors?.length ? `Fallbacks used after errors: ${meta.errors.join(" | ")}` : ""].filter(Boolean).join("\n");
  return (
    <span title={title} className="inline-flex max-w-full items-center gap-1.5 truncate text-[11px] text-ink-3">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.delayed ? "bg-warn" : "bg-bull", loading && "animate-pulse-soft")} />
      <span className="truncate">
        {meta.source.split("(")[0].trim()} · {timeAgo(meta.fetchedAt)}
        {meta.delayed ? " · DELAYED" : " · live"}
        {meta.errors?.length ? " · fallback" : ""}
      </span>
    </span>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={cn("animate-fade-in max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line-2 bg-panel sm:rounded-2xl", wide ? "sm:max-w-4xl" : "sm:max-w-2xl")}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-5 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-ink-3 hover:bg-panel-2 hover:text-ink" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputCls = "h-9 w-full rounded-lg border border-line-2 bg-bg px-3 text-sm text-ink outline-none transition focus:border-accent/60 num";

export function NumInput({ value, onChange, step, min, max, className }: { value: number | null; onChange: (v: number) => void; step?: number; min?: number; max?: number; className?: string }) {
  const [txt, setTxt] = useState(value == null || !Number.isFinite(value) ? "" : String(value));
  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    if (Number(txt) !== value) setTxt(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      inputMode="decimal"
      className={cn(inputCls, className)}
      value={txt}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        setTxt(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isFinite(n)) onChange(max != null ? Math.min(max, min != null ? Math.max(min, n) : n) : n);
      }}
    />
  );
}

export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <select className={cn(inputCls, "cursor-pointer font-sans", className)} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = "md" }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: "sm" | "md" }) {
  return (
    <div className="inline-flex rounded-lg border border-line-2 bg-bg p-0.5">
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={cn("rounded-md font-medium transition-colors", size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm", value === o.value ? "bg-panel-2 text-ink shadow" : "text-ink-3 hover:text-ink")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-sm text-ink-2">
      <span className={cn("relative h-5 w-9 rounded-full border transition-colors", checked ? "border-bull/50 bg-bull/30" : "border-line-2 bg-panel-2")}>
        <span className={cn("absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all", checked ? "left-[18px] bg-bull" : "left-0.5 bg-ink-3")} />
      </span>
      {label}
    </button>
  );
}

export function PageHeader({ title, subtitle, right, beginner }: { title: string; subtitle?: string; right?: ReactNode; beginner?: ReactNode }) {
  const isBeginner = useStore((s) => s.settings.beginnerMode);
  return (
    <div className="mb-5 space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-3">{subtitle}</p>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {isBeginner && beginner && <Notice>{beginner}</Notice>}
    </div>
  );
}

export function usd(n: number | null | undefined, digits = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function pct(n: number | null | undefined, digits = 2, sign = true) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${sign && n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function compact(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

export function price(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return n.toPrecision(4);
}
