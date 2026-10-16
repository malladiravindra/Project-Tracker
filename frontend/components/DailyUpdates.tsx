"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { projectById, projects } from "@/lib/data";
import { errorMessage } from "@/lib/api";
import {
  addFeedback,
  FEEDBACK_TYPES,
  isoDay,
  markReviewed,
  REVIEW_LABEL,
  useDailyUpdates,
  type DailyUpdate,
  type FeedbackType,
  type OverallStatus,
  type ReviewStatus,
} from "@/lib/dailyUpdates";
import { loadMoreDailyUpdates, useStore } from "@/lib/store";
import LoadMoreFooter from "./LoadMoreFooter";
import { useNow } from "./hooks";
import { control } from "./TasksView";

/* ---------- Formatting ---------- */

const parseDay = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayLabel = (iso: string) =>
  parseDay(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const longDay = (iso: string) =>
  parseDay(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const stamp = (iso: string) =>
  `${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}, ${time(iso)}`;

const reviewBadge: Record<ReviewStatus, string> = {
  new: "border-st-blue/40 bg-st-blue/10 text-st-blue",
  reviewed: "border-line bg-track/60 text-muted",
  feedback: "border-st-green/40 bg-st-green/10 text-st-green",
};

const statusTone: Record<OverallStatus, string> = {
  "On track": "bg-st-green",
  "At risk": "bg-st-amber",
  Blocked: "bg-st-purple",
};

const feedbackTone: Record<FeedbackType, string> = {
  Suggestion: "text-st-blue border-st-blue/40",
  Appreciation: "text-st-green border-st-green/40",
  "Improvement required": "text-st-orange-strong border-st-orange/40",
  "Next steps": "text-st-purple border-st-purple/40",
};

function ReviewBadge({ status }: { status: ReviewStatus }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${reviewBadge[status]}`}>
      {REVIEW_LABEL[status]}
    </span>
  );
}

function StatusDot({ status }: { status: OverallStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <span className={`h-2 w-2 rounded-full ${statusTone[status]}`} aria-hidden />
      {status}
    </span>
  );
}

const preview = (u: DailyUpdate) => u.completed[0] ?? u.inProgress[0] ?? u.nextSteps[0] ?? "No details shared";

/* ---------- Side panel ---------- */

function Section({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="mt-5">
      <h4 className="text-[13px] font-semibold uppercase tracking-wide text-muted">{title}</h4>
      {items.length ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[15px] leading-snug">
          {items.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

function UpdatePanel({
  update,
  today,
  position,
  onOlder,
  onNewer,
  onClose,
  reviewError,
  onRetryReview,
}: {
  reviewError: string;
  onRetryReview: () => void;
  update: DailyUpdate;
  today: string;
  position: { index: number; total: number };
  onOlder?: () => void;
  onNewer?: () => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<FeedbackType>("Suggestion");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false); // blocks double submits from repeated clicks
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const project = projectById(update.projectId);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [update.id]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    setError("");
    try {
      await addFeedback(update, type, text.trim());
      setText("");
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(errorMessage(err)); // the text stays so nothing typed is lost
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <aside
      aria-label={`Daily update, ${longDay(update.date)}`}
      className="fixed inset-0 z-40 flex flex-col border-l border-line bg-surface shadow-[-12px_0_32px_-12px_rgb(15_31_61/0.25)] md:inset-y-0 md:left-auto md:right-0 md:w-[30%] md:min-w-[400px] md:max-w-[620px]"
    >
      <header className="border-b border-line px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold">{longDay(update.date)}</h2>
              {update.date === today && (
                <span className="rounded-full bg-header px-2 py-0.5 text-xs font-semibold text-white dark:bg-accent dark:text-header">
                  Today
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-muted">
              <span className="font-semibold text-ink">{project.name}</span> · {update.employeeName} ·{" "}
              {update.fromTasks ? `logged from tasks ${time(update.sharedAt)}` : `shared ${time(update.sharedAt)}`}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusDot status={update.status} />
              <ReviewBadge status={update.reviewStatus} />
              {update.taskCount > 0 && (
                <span className="inline-flex whitespace-nowrap rounded-full border border-st-blue/40 px-2 py-0.5 text-xs font-semibold text-st-blue">
                  From {update.taskCount} task{update.taskCount === 1 ? "" : "s"}
                </span>
              )}
            </div>
          </div>
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label="Close update"
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-track"
          >
            Close
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between text-sm">
          <button onClick={onOlder} disabled={!onOlder} className="rounded-md px-2 py-1 font-medium hover:bg-track disabled:opacity-40">
            ← Older
          </button>
          <span className="text-muted">
            {position.index + 1} of {position.total}
          </span>
          <button onClick={onNewer} disabled={!onNewer} className="rounded-md px-2 py-1 font-medium hover:bg-track disabled:opacity-40">
            Newer →
          </button>
        </div>
      </header>

      {reviewError && (
        <p role="alert" className="mx-5 mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          <span>Could not mark this update as reviewed. {reviewError}</span>
          <button onClick={onRetryReview} className="rounded-md border border-line bg-surface px-2.5 py-1 text-ink hover:bg-track">
            Retry
          </button>
        </p>
      )}

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-b-lg">
          <Section title={update.date === today ? "Work completed today" : "Work completed"} items={update.completed} empty="Nothing listed as completed." />
          <Section title="Work in progress" items={update.inProgress} empty="Nothing listed in progress." />
          <Section title="Next steps / pending work" items={update.nextSteps} empty="No next steps listed." />
          <Section title="Blockers or challenges" items={update.blockers} empty="No blockers reported." />
          <section className="mt-5">
            <h4 className="text-[13px] font-semibold uppercase tracking-wide text-muted">Additional notes</h4>
            <p className={`mt-1.5 text-[15px] ${update.notes ? "" : "text-sm text-muted"}`}>{update.notes ?? "No additional notes."}</p>
          </section>
        </div>

        <section className="mt-6 rounded-xl border border-accent/45 bg-accent/8 p-4" aria-label="Manager suggestions and feedback">
          <h3 className="font-bold">Manager suggestions &amp; feedback</h3>
          {update.feedback.length ? (
            <ol className="mt-3 space-y-2.5">
              {update.feedback.map((f) => (
                <li key={f.id} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${feedbackTone[f.type]}`}>{f.type}</span>
                    <span className="text-xs text-muted">
                      {f.managerName} · {stamp(f.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-[15px] leading-snug">{f.content}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-muted">No feedback yet.</p>
          )}

          <form onSubmit={save} className="mt-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="fb-type" className="text-sm font-semibold">
                Add feedback
              </label>
              <select
                id="fb-type"
                value={type}
                onChange={(e) => setType(e.target.value as FeedbackType)}
                className={`${control} h-9! w-52 text-sm!`}
              >
                {FEEDBACK_TYPES.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </div>
            <textarea
              aria-label="Feedback"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Suggestions, appreciation, changes needed or next steps…"
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20"
            />
            <div className="flex items-center justify-between gap-2">
              <span role="status" className={`text-sm ${error ? "font-medium text-st-red-strong" : "text-st-green"}`}>
                {error || (saved ? "✓ Feedback saved" : "")}
              </span>
              <button
                type="submit"
                disabled={!text.trim() || saving}
                className="rounded-lg bg-header px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-accent dark:text-header"
              >
                {saving ? "Saving..." : "Save feedback"}
              </button>
            </div>
          </form>
        </section>
      </div>
    </aside>
  );
}

/* ---------- Overview section ---------- */

type ReviewFilter = "all" | ReviewStatus;

export default function DailyUpdates({ initialSelected }: { initialSelected?: string }) {
  const now = useNow();
  const updates = useDailyUpdates(); // newest first, as served; loaded a page at a time
  const { updatesFeed: feed, newUpdates } = useStore();
  const [query, setQuery] = useState("");
  const [date, setDate] = useState("");
  const [project, setProject] = useState("all");
  const [review, setReview] = useState<ReviewFilter>("all");
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const sectionRef = useRef<HTMLElement>(null);

  // Opened from the navbar search: bring the list into view (the panel opens on its own).
  useEffect(() => {
    if (initialSelected) sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [initialSelected]);

  const filtering = Boolean(query.trim() || date || project !== "all" || review !== "all");
  const hasMore = updates.length < feed.count;
  // Filters and search run over the loaded rows, so while one is active the remaining pages are loaded too.
  useEffect(() => {
    if (filtering && hasMore && !feed.moreLoading && !feed.moreError) void loadMoreDailyUpdates();
  }, [filtering, hasMore, feed.moreLoading, feed.moreError, updates.length]);

  const close = () => setSelected(null);

  // Opening an update (from the list, the Older/Newer buttons or the navbar search) counts as reviewing it.
  // If the server refuses, the update stays "New" and the error is shown in the panel.
  const [reviewFailure, setReviewFailure] = useState<{ id: string; message: string } | null>(null);
  const selectedId = updates.some((u) => u.id === selected) ? selected : null;
  const selectedStatus = updates.find((u) => u.id === selectedId)?.reviewStatus;
  useEffect(() => {
    if (!selectedId || selectedStatus !== "new") return;
    const u = updates.find((x) => x.id === selectedId);
    if (u) markReviewed(u).catch((e) => setReviewFailure({ id: u.id, message: errorMessage(e) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run only when the open update or its status changes
  }, [selectedId, selectedStatus]);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  if (!now) return null;
  const today = isoDay(now);

  const q = query.trim().toLowerCase();
  const rows = updates.filter(
    (u) =>
      (!date || u.date === date) &&
      (project === "all" || u.projectId === project) &&
      (review === "all" || u.reviewStatus === review) &&
      (!q ||
        [projectById(u.projectId).name, u.employeeName, ...u.completed, ...u.inProgress, ...u.nextSteps, ...u.blockers, u.notes ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
  const newCount = newUpdates; // counted by the server over ALL updates, not just the loaded pages
  const dates = updates.map((u) => u.date); // newest first

  const open = (u: DailyUpdate) => setSelected(u.id);
  const current = updates.find((u) => u.id === selected);
  // Browse within what the list currently shows; fall back to all updates if the selection is filtered out.
  const browse = current && rows.some((r) => r.id === current.id) ? rows : updates;
  const index = current ? browse.findIndex((u) => u.id === current.id) : -1;

  // Step the date filter to the previous/next day that has an update.
  const stepDate = (dir: 1 | -1) => {
    if (!date) return setDate(dir === -1 ? dates[0] : dates[dates.length - 1]);
    const i = dates.indexOf(date);
    const next = dir === -1 ? dates[i + 1] : dates[i - 1];
    if (next) setDate(next);
  };

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-xl border border-line bg-surface p-5 shadow-sm transition-shadow duration-150 hover:shadow-md">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold">
            Daily work updates
            {newCount > 0 && (
              <span className="rounded-full bg-st-blue/12 px-2 py-0.5 text-xs font-semibold text-st-blue">{newCount} new</span>
            )}
          </h2>
          <p className="mt-0.5 text-sm text-muted">Review daily progress, completed work and manager feedback.</p>
        </div>
        <div className="text-right text-sm">
          <div className="font-semibold">{longDay(today)}</div>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search updates"
          aria-label="Search updates"
          className={`${control} min-w-[12rem] flex-1`}
        />
        <div className="flex items-center gap-1">
          <button onClick={() => stepDate(-1)} aria-label="Previous update date" className="h-10 rounded-lg border border-line px-2.5 hover:bg-track">
            ‹
          </button>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Filter by date"
            className={`${control} w-40`}
          />
          <button onClick={() => stepDate(1)} aria-label="Next update date" className="h-10 rounded-lg border border-line px-2.5 hover:bg-track">
            ›
          </button>
          {date && (
            <button onClick={() => setDate("")} className="px-2 text-sm font-medium text-st-blue hover:underline">
              All dates
            </button>
          )}
        </div>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={`${control} w-48`}>
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={review} onChange={(e) => setReview(e.target.value as ReviewFilter)} aria-label="Review status" className={`${control} w-40`}>
          <option value="all">All statuses</option>
          {(Object.keys(REVIEW_LABEL) as ReviewStatus[]).map((s) => (
            <option key={s} value={s}>
              {REVIEW_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {rows.length ? (
        <ul className="mt-3 max-h-[24rem] divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {rows.map((u) => {
            const active = u.id === selected;
            const isToday = u.date === today;
            return (
              <li key={u.id}>
                <button
                  onClick={() => open(u)}
                  aria-current={active ? "true" : undefined}
                  className={`grid w-full grid-cols-1 items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left transition-colors sm:grid-cols-[9.5rem_minmax(0,1fr)_auto] lg:grid-cols-[9.5rem_minmax(0,1fr)_7rem_4rem_8rem] ${
                    active ? "bg-st-blue/8 shadow-[inset_3px_0_0_var(--blue)]" : isToday ? "bg-accent/6 hover:bg-track/50" : "hover:bg-track/50"
                  }`}
                >
                  <span className="flex items-center gap-2 whitespace-nowrap text-sm">
                    <span className="font-semibold">{dayLabel(u.date)}</span>
                    {isToday && (
                      <span className="rounded bg-header px-1.5 text-[11px] font-semibold uppercase text-white dark:bg-accent dark:text-header">
                        Today
                      </span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold">{projectById(u.projectId).name}</span>
                    <span className="block truncate text-[13px] text-muted">{preview(u)}</span>
                  </span>
                  <span className="hidden lg:block">
                    <StatusDot status={u.status} />
                  </span>
                  <span className="hidden text-sm text-muted lg:block">{time(u.sharedAt)}</span>
                  <span className="flex items-center gap-2 sm:justify-end">
                    {u.feedback.length > 0 && (
                      <span className="text-xs text-muted" title="Feedback entries">
                        💬 {u.feedback.length}
                      </span>
                    )}
                    <ReviewBadge status={u.reviewStatus} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed border-line py-8 text-center text-sm text-muted">
          {filtering && hasMore && !feed.moreError
            ? "Searching all updates..."
            : updates.length
            ? "No updates match these filters. A missing update does not mean no work was done; it may not have been shared yet."
            : "No daily updates have been shared yet."}
        </p>
      )}

      <LoadMoreFooter
        noun="updates"
        loaded={updates.length}
        total={feed.count}
        loading={feed.moreLoading}
        error={feed.moreError}
        onMore={() => void loadMoreDailyUpdates()}
        filtering={filtering}
      />

      {current && (
        <UpdatePanel
          key={current.id}
          update={current}
          today={today}
          position={{ index, total: browse.length }}
          onOlder={index < browse.length - 1 ? () => open(browse[index + 1]) : undefined}
          onNewer={index > 0 ? () => open(browse[index - 1]) : undefined}
          onClose={close}
          reviewError={reviewFailure?.id === current.id && current.reviewStatus === "new" ? reviewFailure.message : ""}
          onRetryReview={() => markReviewed(current).then(() => setReviewFailure(null), (e) => setReviewFailure({ id: current.id, message: errorMessage(e) }))}
        />
      )}
    </section>
  );
}
