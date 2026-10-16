"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTheme, useToday, type ThemePref } from "./hooks";

export const TABS = ["Overview", "Tasks & Deadlines", "Projects", "Team"] as const;
export type Tab = (typeof TABS)[number];

const themeOptions: { value: ThemePref; label: string; icon: React.ReactNode }[] = [
  {
    value: "auto",
    label: "Auto",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.5a6.5 6.5 0 0 0 0 13Z" fill="currentColor" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
        <path
          d="M8 1v14M1 8h14M3 3l10 10M13 3 3 13"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
        <path d="M10 1.5A6.5 6.5 0 1 0 14.5 10 5 5 0 0 1 10 1.5Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
];

export default function Header({
  tab,
  onTab,
  actions,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  actions?: ReactNode; // search and refresh controls
}) {
  const today = useToday();
  const [theme, setTheme] = useTheme();
  const date = today ? new Date(`${today}T00:00:00`) : null;
  const part = (o: Intl.DateTimeFormatOptions) => date?.toLocaleDateString("en-GB", o) ?? "";
  const compactDate = date ? `${part({ weekday: "short" })}, ${part({ day: "numeric", month: "short", year: "numeric" })}` : "";
  const shortDate = part({ day: "numeric", month: "short" });
  const fullDate = part({ weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // The header stays pinned while the page scrolls. Its height is published as --header-h so
  // scrollIntoView / anchor jumps stop below it instead of underneath it.
  const ref = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const [navEdge, setNavEdge] = useState({ left: false, right: false }); // more tabs hidden off either side

  // Phones: keep the active tab in view inside the scrolling tab row (without scrolling the page),
  // and show a fade on the side where more tabs are hidden.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = () =>
      setNavEdge({ left: nav.scrollLeft > 2, right: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2 });
    const active = nav.querySelector<HTMLElement>("[aria-current=page]");
    if (active && nav.scrollWidth > nav.clientWidth) {
      const target = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
      nav.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    }
    update();
    nav.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(nav);
    return () => {
      nav.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [tab]);

  const themeIndex = Math.max(0, themeOptions.findIndex((o) => o.value === theme));
  const currentTheme = themeOptions[themeIndex];
  const nextTheme = themeOptions[(themeIndex + 1) % themeOptions.length];
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--header-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", onScroll);
      root.style.removeProperty("--header-h");
    };
  }, []);

  return (
    <header
      ref={ref}
      className={`sticky top-0 z-30 bg-header text-white transition-shadow duration-200 print:static ${
        scrolled ? "shadow-[0_4px_16px_rgba(0,0,0,0.25)]" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 px-4 sm:gap-x-6 sm:gap-y-1 sm:px-8 lg:flex-nowrap lg:px-12">
        <div className="min-w-0 py-2 sm:shrink-0 sm:py-2.5">
          <h1 className="truncate text-lg font-bold leading-tight sm:text-xl">Executive Dashboard</h1>
          <p className="hidden text-sm text-white/80 sm:block">Company overview</p>
        </div>

        <div className="relative order-last -mx-4 w-[calc(100%+2rem)] sm:-mx-8 sm:w-[calc(100%+4rem)] lg:order-none lg:mx-0 lg:w-auto lg:shrink-0">
          <nav
            ref={navRef}
            className="flex overflow-x-auto px-4 [scrollbar-width:none] sm:px-8 lg:px-0 [&::-webkit-scrollbar]:hidden"
            aria-label="Sections"
          >
            {TABS.map((t) => {
              const active = t === tab;
              return (
                <button
                  key={t}
                  onClick={() => onTab(t)}
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 whitespace-nowrap border-b-4 px-3 pb-2.5 pt-2.5 text-[15px] transition-colors sm:px-4 sm:pb-3 sm:pt-3.5 sm:text-base lg:px-3 xl:px-4 ${
                    active ? "border-accent text-white" : "border-transparent text-white/75 hover:text-white"
                  }`}
                >
                  {t}
                </button>
              );
            })}
          </nav>
          {/* Fades that hint at tabs scrolled out of view (phones and narrow tablets only). */}
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-header to-transparent transition-opacity lg:hidden ${
              navEdge.left ? "opacity-100" : "opacity-0"
            }`}
          />
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-header to-transparent transition-opacity lg:hidden ${
              navEdge.right ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center justify-end gap-2 py-2 sm:min-w-0 sm:flex-1 sm:gap-3 sm:py-2.5 xl:gap-4">
          {actions}
          {/* Phones: one button that cycles through the three theme settings. */}
          <button
            type="button"
            onClick={() => setTheme(nextTheme.value)}
            aria-label={`Theme: ${currentTheme.label}. Switch to ${nextTheme.label}`}
            title={`Theme: ${currentTheme.label} (tap for ${nextTheme.label})`}
            className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-lg border border-white/25 text-white/85 hover:bg-white/10 hover:text-white sm:hidden [&_svg]:h-4 [&_svg]:w-4"
          >
            {currentTheme.icon}
          </button>
          <div className="hidden shrink-0 overflow-hidden rounded-lg border border-white/25 sm:flex" role="group" aria-label="Theme">
            {themeOptions.map((o) => {
              const active = o.value === theme;
              return (
                <button
                  key={o.value}
                  onClick={() => setTheme(o.value)}
                  aria-pressed={active}
                  aria-label={o.label}
                  title={o.label}
                  className={`flex items-center gap-1.5 border-l border-white/25 px-3 py-1.5 text-sm first:border-l-0 lg:py-2 xl:py-1.5 ${
                    active ? "bg-white/10 font-bold text-white" : "text-white/80 hover:bg-white/5"
                  }`}
                >
                  {o.icon}
                  {/* Laptops between lg and xl: icons only, so the tabs and search keep their room. */}
                  <span className="lg:hidden xl:inline">{o.label}</span>
                </button>
              );
            })}
          </div>
          {today && (
            <time
              dateTime={today}
              title={fullDate}
              className="hidden shrink-0 whitespace-nowrap text-[13px] tabular-nums text-white/80 lg:inline"
            >
              <span className="min-[1240px]:hidden">{shortDate}</span>
              <span className="hidden min-[1240px]:inline">{compactDate}</span>
            </time>
          )}
        </div>
      </div>
    </header>
  );
}
