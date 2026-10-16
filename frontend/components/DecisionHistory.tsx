"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DecisionItem } from "@/lib/data";
import { errorMessage } from "@/lib/api";
import { OUTCOMES, recordDecision, useDecisionHistory, type DecisionRecord, type Outcome } from "@/lib/decisions";
import { loadMoreDecisionRecords, useStore } from "@/lib/store";
import LoadMoreFooter from "./LoadMoreFooter";
import { useNow } from "./hooks";
import type { OpenRef } from "./Overview";
import { control } from "./TasksView";
import { StatusBadge } from "./ui";

/* ---------- Shared bits ---------- */

const pad = (n: number) => String(n).padStart(2, "0");
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const fmtDay = (iso: string) => parseDay(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

const outcomeStyle: Record<Outcome, { badge: string; icon: string; hint: string }> = {
  Approved: { badge: "border-st-green/45 bg-st-green/10 text-st-green", icon: "✓", hint: "Go ahead as proposed" },
  Rejected: { badge: "border-st-red/45 bg-st-red/10 text-st-red-strong", icon: "✕", hint: "Do not proceed" },
  Deferred: { badge: "border-st-amber/50 bg-st-amber/12 text-st-amber-strong", icon: "⏸", hint: "Revisit later" },
  Resolved: { badge: "border-st-blue/45 bg-st-blue/10 text-st-blue", icon: "●", hint: "Settled another way" },
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const s = outcomeStyle[outcome];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${s.badge}`}>
      <span aria-hidden>{s.icon}</span>
      {outcome}
    </span>
  );
}


/* ---------- Mark as decided: confirmation form ---------- */

export function DecideForm({
  pending,
  onDone,
  onCancel,
}: {
  pending: DecisionItem;
  onDone: (rec: DecisionRecord) => void;
  onCancel: () => void;
}) {
  const now = useNow();
  const today = now ? isoDay(now) : "";
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(today);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false); // blocks double submits from repeated clicks (state updates lag a render)

  const problem = !outcome ? "Choose an outcome." : !date ? "Pick the decision date." : date > today ? "The decision date can't be in the future." : "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (problem || !outcome || !now || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      // The server validates the date, snapshots the project (health, progress, deadline) and clears the pending decision.
      const rec = await recordDecision({ projectId: pending.projectId, outcome, notes: notes.trim() || undefined, decisionDate: date });
      onDone(rec);
    } catch (err) {
      setError(errorMessage(err));
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="rounded-lg bg-track/50 px-4 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Decision</div>
        <div className="mt-0.5 text-[15px] font-semibold">{pending.decision}</div>
        <div className="mt-1 text-sm text-muted">
          {pending.name} · {pending.lead ? `Lead ${pending.lead}` : "No lead"}
        </div>
      </div>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">
          Outcome <span className="text-st-red-strong">*</span>
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {OUTCOMES.map((o) => (
            <label
              key={o}
              className={`flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${
                outcome === o ? "border-st-blue bg-st-blue/8" : "border-line hover:bg-track/50"
              }`}
            >
              <input type="radio" name="outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} className="mt-1 accent-st-blue" />
              <span>
                <span className="block text-[15px] font-semibold">{o}</span>
                <span className="block text-xs text-muted">{outcomeStyle[o].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex flex-col gap-1.5 text-sm font-semibold">
        Notes (optional)
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was decided and why, conditions, who to inform…"
          className="rounded-lg border border-line bg-surface px-3 py-2 text-[15px] font-normal outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm font-semibold sm:w-56">
        Decision date
        <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className={`${control} font-normal`} />
      </label>

      {(error || (attempted && problem)) && (
        <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {error || problem}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-lg border border-line bg-surface px-4 py-2 font-medium hover:bg-track disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-header px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
        >
          {saving ? "Saving..." : "Confirm decision"}
        </button>
      </div>
    </form>
  );
}

/* ---------- Details panel ---------- */

function DecisionPanel({ rec, onClose, onOpen }: { rec: DecisionRecord; onClose: () => void; onOpen: (ref: OpenRef) => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const row = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3 py-2">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-[15px]">{value}</dd>
    </div>
  );

  return (
    <aside
      aria-label={`Decision: ${rec.title}`}
      className="fixed inset-0 z-40 flex flex-col border-l border-line bg-surface shadow-[-12px_0_32px_-12px_rgb(15_31_61/0.25)] md:inset-y-0 md:left-auto md:right-0 md:w-[30%] md:min-w-[400px] md:max-w-[620px]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Decision</div>
          <h2 className="mt-0.5 text-lg font-bold leading-snug">{rec.title}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
            <OutcomeBadge outcome={rec.outcome} />
            <span>decided {fmtDay(rec.decisionDate)}</span>
          </div>
        </div>
        <button ref={closeRef} onClick={onClose} className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-track">
          Close
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <section className="mt-4">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Manager notes</h3>
          <p className={`mt-1.5 text-[15px] leading-relaxed ${rec.notes ? "" : "text-sm text-muted"}`}>{rec.notes ?? "No notes were added."}</p>
        </section>

        <section className="mt-5">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Outcome</h3>
          <dl className="mt-1 divide-y divide-line">
            {row("Final outcome", <OutcomeBadge outcome={rec.outcome} />)}
            {row("Decision date", fmtDay(rec.decisionDate))}
            {row("Recorded", fmtStamp(rec.recordedAt))}
          </dl>
        </section>

        <section className="mt-5">
          <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Project at the time</h3>
          <dl className="mt-1 divide-y divide-line">
            {row("Project", rec.projectName)}
            {row("Project lead", rec.lead || "No lead")}
            {row("Health", <StatusBadge status={rec.health} />)}
            {row("Progress", rec.context)}
            {row("Deadline", rec.deadline ? fmtDay(rec.deadline) : "No deadline")}
          </dl>
          {rec.projectId !== null ? (
            <button
              onClick={() => onOpen({ kind: "project", id: rec.projectId as string })}
              className="mt-3 text-sm font-semibold text-st-blue underline-offset-2 hover:underline"
            >
              Open {rec.projectName} →
            </button>
          ) : (
            <p className="mt-3 text-sm text-muted">This project has since been deleted.</p>
          )}
        </section>
      </div>
    </aside>
  );
}

/* ---------- History section ---------- */

export default function DecisionHistory({ onOpen, initialSelected }: { onOpen: (ref: OpenRef) => void; initialSelected?: string }) {
  const history = useDecisionHistory(); // newest decision first, as served; loaded a page at a time
  const feed = useStore().decisionsFeed;
  const now = useNow();
  const [query, setQuery] = useState("");
  const [outcome, setOutcome] = useState<"all" | Outcome>("all");
  const [project, setProject] = useState("all");
  const [lead, setLead] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const sectionRef = useRef<HTMLElement>(null);

  // Opened from the navbar search: bring the history into view (the panel opens on its own).
  useEffect(() => {
    if (initialSelected) sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [initialSelected]);
  const closePanel = useCallback(() => setSelected(null), []);

  const filtering = Boolean(query.trim() || outcome !== "all" || project !== "all" || lead !== "all" || from || to);
  const hasMore = history.length < feed.count;
  // Filters and search run over the loaded rows, so while one is active the remaining pages are loaded too.
  useEffect(() => {
    if (filtering && hasMore && !feed.moreLoading && !feed.moreError) void loadMoreDecisionRecords();
  }, [filtering, hasMore, feed.moreLoading, feed.moreError, history.length]);

  if (!now) return null;

  const projectsInHistory = Array.from(new Map(history.filter((r) => r.projectId !== null).map((r) => [r.projectId as string, r.projectName])).entries());
  const leads = Array.from(new Set(history.map((r) => r.lead).filter(Boolean))).sort();
  const q = query.trim().toLowerCase();
  const rows = history.filter(
    (r) =>
      (outcome === "all" || r.outcome === outcome) &&
      (project === "all" || r.projectId === project) &&
      (lead === "all" || r.lead === lead) &&
      (!from || r.decisionDate >= from) &&
      (!to || r.decisionDate <= to) &&
      (!q || [r.title, r.projectName, r.notes ?? ""].join(" ").toLowerCase().includes(q)),
  );
  const reset = () => {
    setQuery("");
    setOutcome("all");
    setProject("all");
    setLead("all");
    setFrom("");
    setTo("");
  };
  const current = history.find((r) => r.id === selected);
  const select = control.replace("h-10", "h-9");

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-xl border border-line bg-surface p-5 shadow-sm" aria-label="Decision history">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          Decision history
          <span className="rounded-full bg-track px-2 py-0.5 text-xs font-semibold text-muted">{feed.count} recorded</span>
        </h2>
        <p className="text-sm text-muted">Decisions you have made, newest first.</p>
      </header>

      {history.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line py-6 text-center text-sm text-muted">
          No decisions recorded yet. Completed decisions will appear here.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search decisions, projects or notes"
              aria-label="Search decisions"
              className={`${select} min-w-[12rem] flex-1 text-sm!`}
            />
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as "all" | Outcome)} aria-label="Outcome" className={`${select} w-36 text-sm!`}>
              <option value="all">All outcomes</option>
              {OUTCOMES.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={`${select} w-44 text-sm!`}>
              <option value="all">All projects</option>
              {projectsInHistory.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select value={lead} onChange={(e) => setLead(e.target.value)} aria-label="Project lead" className={`${select} w-40 text-sm!`}>
              <option value="all">All leads</option>
              {leads.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <span className="flex items-center gap-1.5 text-sm text-muted">
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Decided from" className={`${select} w-36 text-sm!`} />
              to
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Decided to" className={`${select} w-36 text-sm!`} />
            </span>
            {filtering && (
              <button onClick={reset} className="px-1.5 text-sm font-semibold text-st-blue hover:underline">
                Reset filters
              </button>
            )}
          </div>

          {rows.length ? (
            <ul className="mt-3 max-h-[20rem] divide-y divide-line overflow-y-auto rounded-lg border border-line">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelected(r.id)}
                    aria-current={r.id === selected ? "true" : undefined}
                    className={`grid w-full grid-cols-1 items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left sm:grid-cols-[6.5rem_minmax(0,1fr)_auto] lg:grid-cols-[6.5rem_minmax(0,1fr)_9rem_7.5rem] ${
                      r.id === selected ? "bg-st-blue/8 shadow-[inset_3px_0_0_var(--blue)]" : "hover:bg-track/50"
                    }`}
                  >
                    <span className="whitespace-nowrap text-sm font-semibold">{fmtDay(r.decisionDate)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold">{r.title}</span>
                      <span className="block truncate text-[13px] text-muted">
                        {r.projectName}
                        {r.notes ? ` · ${r.notes}` : ""}
                      </span>
                    </span>
                    <span className="hidden truncate text-sm text-muted lg:block">{r.lead ? `Lead ${r.lead}` : "No lead"}</span>
                    <span className="sm:justify-self-end">
                      <OutcomeBadge outcome={r.outcome} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-lg border border-dashed border-line py-6 text-center text-sm text-muted">
              No decisions match these filters.{" "}
              <button onClick={reset} className="font-semibold text-st-blue hover:underline">
                Reset filters
              </button>
            </p>
          )}
        </>
      )}

      {history.length > 0 && (
        <LoadMoreFooter
          noun="decisions"
          loaded={history.length}
          total={feed.count}
          loading={feed.moreLoading}
          error={feed.moreError}
          onMore={() => void loadMoreDecisionRecords()}
          filtering={filtering}
        />
      )}

      {current && <DecisionPanel key={current.id} rec={current} onClose={closePanel} onOpen={onOpen} />}
    </section>
  );
}

