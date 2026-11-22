"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Radar, Coins, Bitcoin, FlaskConical, Gamepad2, ShieldHalf, History, Settings as Cog, Bell, GraduationCap, Menu, X, CheckCheck, MoreHorizontal } from "lucide-react";
import { hydrate, setState, useStore } from "@/lib/client/store";
import { useTicker } from "@/lib/client/hooks";
import { SolanaProviders, WalletButton } from "./wallet";
import { Watcher } from "./watcher";
import { Modal, Toggle, cn, pct, price, timeAgo } from "./ui";
import { GLOSSARY } from "@/lib/glossary";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/signals", label: "AI Signals", icon: Radar },
  { href: "/scanner", label: "Memecoin Scanner", icon: Coins },
  { href: "/bitcoin", label: "Bitcoin Terminal", icon: Bitcoin },
  { href: "/lab", label: "Strategy Lab", icon: FlaskConical },
  { href: "/paper", label: "Paper Trading", icon: Gamepad2 },
  { href: "/portfolio", label: "Portfolio & Risk", icon: ShieldHalf },
  { href: "/history", label: "Trade History", icon: History },
  { href: "/settings", label: "Settings", icon: Cog },
];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-bull/70 text-[#0b0d10]">
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 17l5-6 4 3 5-7 4 4" />
        </svg>
      </span>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight">EdgePilot AI</span>
        <span className="block text-[10px] uppercase tracking-widest text-ink-3">Trading terminal</span>
      </span>
    </Link>
  );
}

function NavLinks({ onClick }: { onClick?: () => void }) {
  const path = usePathname();
  return (
    <nav className="space-y-0.5">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? path === "/" : path.startsWith(href);
        return (
          <Link key={href} href={href} onClick={onClick} className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors", active ? "bg-panel-2 text-ink" : "text-ink-3 hover:bg-panel-2/60 hover:text-ink")}>
            <Icon className={cn("h-4 w-4", active && "text-accent")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

const TABS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/signals", label: "Signals", icon: Radar },
  { href: "/scanner", label: "Scanner", icon: Coins },
  { href: "/bitcoin", label: "BTC", icon: Bitcoin },
  { href: "/paper", label: "Paper", icon: Gamepad2 },
];

/** Bottom tab bar for phones (thumb-reachable), with a "More" sheet for the remaining pages. */
function MobileTabBar({ onMore }: { onMore: () => void }) {
  const path = usePathname();
  const inTabs = TABS.some((t) => (t.href === "/" ? path === "/" : path.startsWith(t.href)));
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-50 border-t border-line bg-[#0d1014]/95 backdrop-blur lg:hidden" aria-label="Main">
      <div className="grid grid-cols-6">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} className={cn("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", active ? "text-accent" : "text-ink-3")}>
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
        <button onClick={onMore} className={cn("flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium", !inTabs ? "text-accent" : "text-ink-3")}>
          <MoreHorizontal className="h-5 w-5" />
          More
        </button>
      </div>
    </nav>
  );
}

function TopTicker() {
  const t = useTicker("BTC", 10_000);
  if (!t.data) return <span className="text-xs text-ink-3">{t.error ? "BTC price unavailable" : "Loading BTC…"}</span>;
  const ch = t.data.change24hPct ?? 0;
  return (
    <span className="flex items-baseline gap-2" title={`Source: ${t.meta?.source} · ${timeAgo(t.meta?.fetchedAt)}`}>
      <span className="text-xs text-ink-3">BTC</span>
      <span className="num text-sm font-semibold">${price(t.data.price)}</span>
      <span className={cn("num text-xs", ch >= 0 ? "text-bull" : "text-bear")}>{pct(ch)}</span>
    </span>
  );
}

function Notifications() {
  const items = useStore((s) => s.notifications);
  const [open, setOpen] = useState(false);
  const unread = items.filter((n) => !n.read).length;
  const closeCenter = () => {
    setOpen(false);
    setState((s) => ({ notifications: s.notifications.map((n) => (n.read ? n : { ...n, read: true })) }));
  };
  return (
    <>
      <button onClick={() => setOpen(true)} className="relative rounded-lg p-2 text-ink-2 hover:bg-panel-2 hover:text-ink" aria-label="Notifications">
        <Bell className="h-4.5 w-4.5" />
        {unread > 0 && <span className="num absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-bear px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span>}
      </button>
      <Modal open={open} onClose={closeCenter} title="Notification center">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="min-w-0 text-xs text-ink-3">Thresholds: Settings → Notifications.</span>
          <div className="flex shrink-0 items-center gap-3">
            <button className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-accent" onClick={() => setState((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }))}>
              <CheckCheck className="h-3.5 w-3.5" /> Mark read
            </button>
            {items.length > 0 && (
              <button className="whitespace-nowrap text-xs text-ink-3 hover:text-bear" onClick={() => setState({ notifications: [] })}>
                Clear all
              </button>
            )}
          </div>
        </div>
        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-3">No notifications yet. Alerts appear here while EdgePilot is open.</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.slice(0, 80).map((n) => (
              <li key={n.id} className={cn("py-2.5", !n.read && "")}>
                <div className="flex items-start gap-2">
                  <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.type === "stop" || n.type === "risk" || n.type === "breakdown" ? "bg-bear" : n.type === "tp" || n.type === "breakout" || n.type === "setup" ? "bg-bull" : n.type === "meme" ? "bg-warn" : "bg-info", n.read && "opacity-30")} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      {n.href ? (
                        <Link href={n.href} onClick={closeCenter} className="text-sm font-medium hover:text-accent">
                          {n.title}
                        </Link>
                      ) : (
                        <span className="text-sm font-medium">{n.title}</span>
                      )}
                      <span className="shrink-0 text-[10px] text-ink-3">{timeAgo(n.time)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-2">{n.body}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

function LearnButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-ink-2 hover:bg-panel-2 hover:text-ink" aria-label="Glossary" title="Learn: beginner glossary">
        <GraduationCap className="h-4.5 w-4.5" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Beginner glossary" wide>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.values(GLOSSARY).map((g) => (
            <div key={g.term} className="rounded-lg border border-line p-3">
              <div className="text-sm font-semibold">{g.term}</div>
              <p className="mt-1 text-xs text-ink-2">{g.short}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-3">{g.long}</p>
            </div>
          ))}
        </div>
      </Modal>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const beginner = useStore((s) => s.settings.beginnerMode);
  useEffect(() => hydrate(), []);
  return (
    <SolanaProviders>
      <div className="flex min-h-screen">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-[#0d1014] px-3 py-4 lg:flex">
          <div className="px-2 pb-5">
            <Logo />
          </div>
          <NavLinks />
          <div className="mt-auto space-y-2 px-2 text-[10px] leading-relaxed text-ink-3">
            <p>Paper trading &amp; analysis only. Not financial advice. Crypto trading can lose all capital.</p>
          </div>
        </aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-[90] bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)}>
            <div className="h-full w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-panel p-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }} onClick={(e) => e.stopPropagation()}>
              <div className="mb-5 flex items-center justify-between">
                <Logo />
                <button onClick={() => setMobileOpen(false)} className="p-1 text-ink-3" aria-label="Close menu">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <NavLinks onClick={() => setMobileOpen(false)} />
              <div className="mt-6 border-t border-line pt-4">
                <Toggle checked={beginner} onChange={(v) => setState((s) => ({ settings: { ...s.settings, beginnerMode: v } }))} label={<span className="text-sm">Beginner mode</span>} />
              </div>
              <p className="mt-6 text-[10px] leading-relaxed text-ink-3">Paper trading &amp; analysis only. Not financial advice. Crypto trading can lose all capital.</p>
            </div>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur sm:gap-3 sm:px-4" style={{ paddingTop: "env(safe-area-inset-top)", height: "calc(3.5rem + env(safe-area-inset-top))" }}>
            <button className="rounded-lg p-1.5 text-ink-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <TopTicker />
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              <span className="hidden md:inline">
                <Toggle checked={beginner} onChange={(v) => setState((s) => ({ settings: { ...s.settings, beginnerMode: v } }))} label={<span className="text-xs">Beginner mode</span>} />
              </span>
              <LearnButton />
              <Notifications />
              <WalletButton />
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-3 pb-24 pt-4 sm:px-6 sm:py-5 lg:pb-5">{children}</main>
        </div>
      </div>
      <MobileTabBar onMore={() => setMobileOpen(true)} />
      <Watcher />
    </SolanaProviders>
  );
}
