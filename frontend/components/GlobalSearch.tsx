"use client";

import { useDeferredValue, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { decisions, projectById, projects, projectStatus, tasks, team } from "@/lib/data";
import { useDailyUpdates, type DailyUpdate } from "@/lib/dailyUpdates";
import { useDecisionHistory } from "@/lib/decisions";
import { loadMoreDailyUpdates, loadMoreDecisionRecords, useStore } from "@/lib/store";
import { dueText } from "./TasksView";

/** Where a search result takes you. Handled by the Dashboard. */
export type SearchTarget =
  | { kind: "project"; id: string }
  | { kind: "task"; id: string }
  | { kind: "person"; name: string }
  | { kind: "update"; update: DailyUpdate }
  | { kind: "pending"; projectId: string }
  | { kind: "decision"; id: string };

type Category = "Projects" | "Tasks" | "Team" | "Daily updates" | "Pending decisions" | "Decision history";

interface Result {
  key: string;
  category: Category;
  label: string;
  sub: string;
  target: SearchTarget;
}

const PER_CATEGORY = 5;
const statusText = { "off-track": "Off track", watch: "Needs watching", "on-track": "On track", "not-started": "Not started" };

const dayLabel = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

/** Highlights each occurrence of the query in the text. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  let at = lower.indexOf(q);
  while (at !== -1) {
    if (at > i) parts.push(text.slice(i, at));
    parts.push(
      <mark key={at} className="rounded-sm bg-accent/35 px-px text-inherit">
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
    at = lower.indexOf(q, i);
  }
  parts.push(text.slice(i));
  return <>{parts}</>;
}

/** Short excerpt around the first match, so long update text stays on one line. */
function snippet(text: string, q: string, len = 90) {
  const at = text.toLowerCase().indexOf(q);
  if (at < 0 || text.length <= len) return text;
  const start = Math.max(0, at - 30);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + len)}${start + len < text.length ? "…" : ""}`;
}

function useResults(query: string): Result[] {
  const updates = useDailyUpdates();
  const history = useDecisionHistory();
  const q = query.trim().toLowerCase();

  // Updates and decisions are loaded a page at a time; while searching, load the rest so results cover everything.
  const { updatesFeed, decisionsFeed } = useStore();
  const searching = q.length >= 2;
  useEffect(() => {
    if (searching && updates.length < updatesFeed.count && !updatesFeed.moreLoading && !updatesFeed.moreError) void loadMoreDailyUpdates();
  }, [searching, updates.length, updatesFeed.count, updatesFeed.moreLoading, updatesFeed.moreError]);
  useEffect(() => {
    if (searching && history.length < decisionsFeed.count && !decisionsFeed.moreLoading && !decisionsFeed.moreError) void loadMoreDecisionRecords();
  }, [searching, history.length, decisionsFeed.count, decisionsFeed.moreLoading, decisionsFeed.moreError]);

  if (q.length < 2) return [];
  const has = (...fields: (string | undefined)[]) => fields.some((f) => f?.toLowerCase().includes(q));
  const out: Result[] = [];
  const push = (r: Result) => {
    if (out.filter((x) => x.category === r.category).length < PER_CATEGORY) out.push(r);
  };

  for (const p of projects)
    if (has(p.name, p.client, p.department, p.lead, p.description))
      push({
        key: `p-${p.id}`,
        category: "Projects",
        label: p.name,
        sub: `${p.department} · ${p.lead ? `Lead ${p.lead}` : "No lead"} · ${statusText[projectStatus(p)]}`,
        target: { kind: "project", id: p.id },
      });

  for (const t of tasks) {
    const project = projectById(t.projectId).name;
    if (has(t.title, t.owner, project, t.note))
      push({
        key: `t-${t.id}`,
        category: "Tasks",
        label: t.title,
        sub: `${project} · ${t.owner} · ${t.state === "done" ? "Completed" : t.state === "blocked" ? "Blocked" : dueText(t)}`,
        target: { kind: "task", id: t.id },
      });
  }

  for (const m of team)
    if (has(m.name, m.title, m.role))
      push({ key: `m-${m.name}`, category: "Team", label: m.name, sub: `${m.title} · ${m.role}`, target: { kind: "person", name: m.name } });

  for (const u of updates) {
    const project = projectById(u.projectId).name;
    const text = [...u.completed, ...u.inProgress, ...u.nextSteps, ...u.blockers, u.notes ?? ""];
    if (has(project, u.employeeName, ...text)) {
      const hit = text.find((s) => s.toLowerCase().includes(q)) ?? u.completed[0] ?? "";
      push({
        key: `u-${u.id}`,
        category: "Daily updates",
        label: `${dayLabel(u.date)} · ${project}`,
        sub: snippet(hit, q),
        target: { kind: "update", update: u },
      });
    }
  }

  for (const d of decisions())
    if (has(d.decision, d.name, d.lead))
      push({
        key: `d-${d.projectId}`,
        category: "Pending decisions",
        label: d.decision,
        sub: `Waiting on you · ${d.name} · ${d.lead ? `Lead ${d.lead}` : "No lead"}`,
        target: { kind: "pending", projectId: d.projectId },
      });

  for (const r of history)
    if (has(r.title, r.projectName, r.notes, r.outcome, r.lead))
      push({
        key: `h-${r.id}`,
        category: "Decision history",
        label: r.title,
        sub: `${r.outcome} · ${r.projectName}${r.notes ? ` · ${snippet(r.notes, q, 60)}` : ""}`,
        target: { kind: "decision", id: r.id },
      });

  return out;
}

const SearchIcon = ({ className = "h-4 w-4" }: { className?: string }) => (
  <svg viewBox="0 0 20 20" className={className} aria-hidden>
    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
    <path d="m13 13 4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

function SearchBox({
  onSelect,
  autoFocus = false,
  onDone,
  dropdownClass,
  inputClass,
}: {
  onSelect: (t: SearchTarget) => void;
  autoFocus?: boolean;
  onDone?: () => void;
  dropdownClass: string;
  inputClass: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const deferred = useDeferredValue(query); // keeps typing smooth while results recompute
  const results = useResults(deferred);
  const q = deferred.trim().toLowerCase();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Close when clicking outside.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const choose = (r: Result) => {
    onSelect(r.target);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
    onDone?.();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (open && query) setOpen(false);
      else {
        setQuery("");
        inputRef.current?.blur();
        onDone?.();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      choose(results[active]);
    }
  };

  const showDropdown = open && query.trim().length >= 1;
  const activeId = results[active] ? `${listId}-${active}` : undefined;

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/70">
          <SearchIcon />
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showDropdown}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search the dashboard"
          value={query}
          placeholder="Search projects, tasks, people…"
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className={inputClass}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-lg leading-none text-white/70 hover:text-white"
          >
            ×
          </button>
        )}
      </div>

      {showDropdown && (
        <div className={`${dropdownClass} overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-xl`}>
          <ul id={listId} role="listbox" aria-label="Search results" className="max-h-[min(70vh,32rem)] overflow-y-auto py-1.5">
            {q.length < 2 && <li className="px-4 py-3 text-sm text-muted">Type at least 2 characters.</li>}
            {q.length >= 2 && results.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-muted">No results found for “{deferred.trim()}”.</li>
            )}
            {results.map((r, i) => {
              const header = i === 0 || results[i - 1].category !== r.category;
              return (
                <li key={r.key} role="presentation">
                  {header && (
                    <div className="px-4 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{r.category}</div>
                  )}
                  <div
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(r)}
                    className={`mx-1.5 cursor-pointer rounded-lg px-2.5 py-1.5 ${i === active ? "bg-st-blue/10" : ""}`}
                  >
                    <div className="truncate text-sm font-semibold">
                      <Highlight text={r.label} q={q} />
                    </div>
                    <div className="truncate text-xs text-muted">
                      <Highlight text={r.sub} q={q} />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {results.length > 0 && (
            <div className="border-t border-line px-4 py-1.5 text-[11px] text-muted">↑ ↓ to move · Enter to open · Esc to close</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function GlobalSearch({ onSelect }: { onSelect: (t: SearchTarget) => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const input =
    "h-9 w-full rounded-lg border border-white/25 bg-white/10 pl-9 pr-8 text-sm text-white outline-none placeholder:text-white/60 focus:border-white/50 focus:bg-white/15";

  return (
    <>
      {/* Desktop/tablet: compact field that widens on focus */}
      <div className="hidden min-w-[9rem] max-w-[14rem] flex-1 transition-[max-width] duration-200 focus-within:max-w-[22rem] md:block">
        <SearchBox onSelect={onSelect} inputClass={input} dropdownClass="absolute right-0 top-full z-50 mt-2 w-[26rem] max-w-[calc(100vw-2rem)]" />
      </div>

      {/* Phones: icon that opens a full-width search bar */}
      <button
        onClick={() => setMobileOpen(true)}
        aria-label="Search the dashboard"
        className="shrink-0 rounded-lg border border-white/25 p-2 text-white/85 hover:bg-white/10 md:hidden"
      >
        <SearchIcon />
      </button>
      {mobileOpen && (
        <div className="fixed inset-x-0 top-0 z-50 bg-header p-3 shadow-xl md:hidden">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SearchBox
                onSelect={onSelect}
                autoFocus
                onDone={() => setMobileOpen(false)}
                inputClass={input}
                dropdownClass="absolute inset-x-0 top-full z-50 mt-2"
              />
            </div>
            <button onClick={() => setMobileOpen(false)} className="px-2 text-sm font-medium text-white/85">
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
