"use client";

import { useCallback, useState } from "react";
import {
  activity,
  agoLabel,
  attentionItems,
  decisions,
  keyDates,
  projects,
  projectStatus,
  startsInLabel,
  summary,
  teamWorkload,
  timeUsed,
  type AttentionItem,
  type DecisionItem,
  type Summary,
  type WorkloadKind,
} from "@/lib/data";
import { ApiError, errorMessage } from "@/lib/api";
import { removeDecision, type DecisionRecord } from "@/lib/decisions";
import { loadMoreActivity, nowMs, useStore } from "@/lib/store";
import { minutesBetween } from "@/lib/serverClock";
import DailyUpdates from "./DailyUpdates";
import DecisionHistory, { DecideForm, OutcomeBadge } from "./DecisionHistory";
import { useNow } from "./hooks";
import { Card, CardHeader, MarkerIcon, Modal, ProgressBar, StatusBadge } from "./ui";

export type OpenRef = AttentionItem["ref"];

/** A search result to show on the Overview: opens that daily update or recorded decision. */
export type OverviewFocus = { update?: string; decision?: string; nonce: number };

/** Where a summary card takes you: a tab, optionally pre-filtered. */
export type NavTarget =
  | { tab: "Projects" }
  | { tab: "Tasks & Deadlines"; focus: "overdue" | "blocked" }
  | { tab: "Team"; show: "stretched" };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function summarySentence(s: Summary = summary()) {
  const action = s.overdue + s.dueToday;
  return [
    `${s.offTrack} ${plural(s.offTrack, "project is", "projects are")} off track and ${s.watch} ${plural(s.watch, "needs", "need")} watching.`,
    `${action} ${plural(action, "task needs", "tasks need")} action today (${s.overdue} overdue, ${s.dueToday} due today).`,
    `${s.blocked} ${plural(s.blocked, "task is", "tasks are")} blocked.`,
  ].join(" ");
}

function greeting(now: Date | null) {
  if (!now) return "Hello";
  const h = now.getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function KpiCard({
  value,
  title,
  sub,
  bar,
  text,
  onClick,
}: {
  value: number;
  title: string;
  sub: string;
  bar: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="card-hover flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-left shadow-sm"
    >
      <div className={`h-1 w-full ${bar}`} />
      <div className="w-full px-4 pb-3.5 pt-3.5">
        <div className={`text-[1.75rem] font-bold leading-none ${text}`}>{value}</div>
        <div className="mt-1.5 truncate text-[15px] font-semibold">{title}</div>
        <div className="truncate text-[13px] text-muted">{sub}</div>
      </div>
    </button>
  );
}

function HealthLegend() {
  return (
    <ul className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4 text-sm text-muted">
      <li className="flex items-center gap-2">
        <span className="flex h-2 w-4 overflow-hidden rounded-full bg-track" aria-hidden>
          <span className="w-3/5 bg-ink" />
        </span>
        Filled part: work completed
      </li>
      <li className="flex items-center gap-2">
        <span className="h-4 w-0.5 rounded bg-ink" aria-hidden />
        Where it should be today
      </li>
      <li className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-st-green" aria-hidden />
        On track
      </li>
      <li className="flex items-center gap-2">
        <MarkerIcon marker="triangle-amber" />
        Needs watching
      </li>
      <li className="flex items-center gap-2">
        <MarkerIcon marker="square-red" />
        Off track
      </li>
    </ul>
  );
}

const workloadMeta: Record<WorkloadKind, { label: string; bg: string }> = {
  overdue: { label: "Overdue", bg: "bg-st-red" },
  blocked: { label: "Blocked", bg: "bg-st-purple" },
  soon: { label: "Due within 7 days", bg: "bg-st-blue" },
  later: { label: "Later", bg: "bg-[#637d8a] dark:bg-[#8ea3ae]" },
};

function TeamWorkload() {
  const people = teamWorkload();
  const slots = Math.max(4, ...people.map((m) => m.open.length));
  return (
    <Card>
      <CardHeader title="Team workload" subtitle="Open tasks per person, split by urgency." />
      <ul>
        {people.length === 0 && <li className="py-6 text-center text-muted">No open tasks are assigned yet.</li>}
        {people.map((m) => (
          <li
            key={m.name}
            className="grid grid-cols-1 items-center gap-2 py-2 sm:grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_4.5rem] sm:gap-5"
          >
            <div>
              <div className="text-[15px] font-medium">{m.name}</div>
              {m.stretched ? (
                <div className="flex items-center gap-1.5 text-sm font-bold text-muted">
                  <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 fill-current" aria-hidden>
                    <path d="M6 1 11.5 11H.5Z" />
                  </svg>
                  Stretched
                </div>
              ) : (
                <div className="text-sm text-muted">{m.role}</div>
              )}
            </div>
            <div
              className="flex gap-[3px]"
              role="img"
              aria-label={m.open.map((k) => workloadMeta[k].label).join(", ")}
            >
              {m.open.map((k, i) => (
                <span
                  key={i}
                  className={`h-3 rounded-[3px] ${workloadMeta[k].bg}`}
                  style={{ width: `calc(${100 / slots}% - 3px)` }}
                />
              ))}
            </div>
            <div className="sm:text-right">
              <span className="font-bold">{m.open.length}</span> open
            </div>
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted">
        {Object.values(workloadMeta).map((w) => (
          <li key={w.label} className="flex items-center gap-2">
            <span className={`h-2.5 w-5 rounded-[3px] ${w.bg}`} aria-hidden />
            {w.label}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function KeyDates({ now, onOpen }: { now: Date | null; onOpen: (ref: OpenRef) => void }) {
  const dates = keyDates(30);
  const fmt = (offset: number) => {
    if (!now) return "";
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const inDays = (n: number) => (n === 0 ? "Today" : n === 1 ? "Tomorrow" : `In ${n} days`);
  return (
    <Card>
      <CardHeader title="Key dates, next 30 days" subtitle="Project deadlines and start dates." />
      <ul className="divide-y divide-line">
        {dates.map((k) => (
          <li key={k.key}>
            <button
              onClick={() => onOpen({ kind: "project", id: k.projectId })}
              className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[4rem_minmax(0,1fr)_auto] items-baseline gap-4 rounded-lg px-2 py-3 text-left hover:bg-track/50 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]"
            >
              <span className="text-sm text-muted" suppressHydrationWarning>
                {fmt(k.offset)}
              </span>
              <span>
                <span className="block text-[15px] font-medium">{k.title}</span>
                <span className="block text-sm text-muted">{k.lead ? `Lead: ${k.lead}` : "No lead"}</span>
              </span>
              <span className="whitespace-nowrap text-sm font-semibold">{inDays(k.offset)}</span>
            </button>
          </li>
        ))}
        {dates.length === 0 && <li className="py-6 text-center text-muted">Nothing in the next 30 days.</li>}
      </ul>
    </Card>
  );
}

function ActivityList({ items }: { items: typeof activity }) {
  const now = useNow(); // re-renders every minute so "5 min ago" labels stay current
  return (
    <ul className="divide-y divide-line">
      {items.length === 0 && <li className="py-6 text-center text-muted">No activity yet.</li>}
      {items.map((a) => (
        <li key={a.id} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <span className="text-sm text-muted sm:pt-0.5" suppressHydrationWarning>
            {now ? agoLabel(minutesBetween(a.createdAt, nowMs())) : ""}
          </span>
          <span className="text-[15px]">{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

function RecentActivity() {
  const [showAll, setShowAll] = useState(false);
  const feed = useStore().activityFeed;
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-lg font-bold">Recent activity</h2>
        <button
          onClick={() => setShowAll(true)}
          className="rounded-lg border border-line bg-surface px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-track"
        >
          View full history
        </button>
      </div>
      <ActivityList items={activity.slice(0, 6)} />
      {showAll && (
        <Modal title="Activity history" onClose={() => setShowAll(false)}>
          <ActivityList items={activity} />
          {activity.length < feed.count && (
            <div className="mt-3">
              {feed.moreError && (
                <p role="alert" className="mb-2 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
                  {feed.moreError}
                </p>
              )}
              <button
                onClick={() => void loadMoreActivity()}
                disabled={feed.moreLoading}
                className="rounded-lg border border-line bg-surface px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-track disabled:cursor-wait disabled:opacity-60"
              >
                {feed.moreLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          )}
        </Modal>
      )}
    </Card>
  );
}

function deadlinePhrase(now: Date | null, days: number) {
  const rel = days === 0 ? "today" : days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : `${-days} day${days === -1 ? "" : "s"} ago`;
  if (!now) return rel;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (${rel})`;
}

interface Decided {
  name: string;
  record: DecisionRecord;
}

function DecisionsCard({ now, onOpen }: { now: Date | null; onOpen: (ref: OpenRef) => void }) {
  const [deciding, setDeciding] = useState<DecisionItem | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeForm = useCallback(() => setDeciding(null), []);
  // Pending decisions come from the server already ordered by project health, then deadline. Recording an
  // outcome clears the pending decision on the server, so an item is never pending and decided at once.
  const pending = decisions();

  // Runs only after the server has saved the record: the item then leaves the pending list.
  const onRecorded = (p: DecisionItem, rec: DecisionRecord) => {
    setDeciding(null);
    setError("");
    setDecided({ name: p.name, record: rec });
  };

  const undo = async () => {
    if (!decided) return;
    setBusy(true);
    setError("");
    try {
      await removeDecision(decided.record);
      setDecided(null);
    } catch (e) {
      setError(errorMessage(e));
      // The server says this decision can no longer be restored (404 or 409), so stop offering Undo.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) setDecided(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl border border-accent/45 bg-accent/8 p-5 shadow-sm" aria-label="Waiting on your decision">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold">Waiting on your decision</h2>
        <span className="rounded-full bg-accent/25 px-2.5 py-0.5 text-sm font-semibold">{pending.length} pending</span>
      </header>

      {pending.length === 0 && <p className="mt-3 text-muted">You are all caught up. No decisions are waiting on you.</p>}

      <ul className="mt-2 divide-y divide-accent/30">
        {pending.map((p) => {
          const status = p.status;
          return (
            <li
              key={p.projectId}
              id={`decision-${p.projectId}`}
              className="-mx-2 flex scroll-mt-24 flex-col gap-3 rounded-lg px-2 py-3 lg:flex-row lg:items-center lg:justify-between"
            >
              <div className="min-w-0">
                <h3 className="font-bold">{p.name}</h3>
                <p className="mt-0.5 text-[15px]">{p.decision}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted">
                  <span className="rounded-full bg-surface">
                    <StatusBadge status={status} />
                  </span>
                  <span suppressHydrationWarning>
                    {p.lead ? `Lead ${p.lead}` : "No lead"} · {p.endOffset === null ? "no deadline" : `deadline ${deadlinePhrase(now, p.endOffset)}`}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 gap-3">
                <button
                  onClick={() => onOpen({ kind: "project", id: p.projectId })}
                  className="rounded-lg border border-line bg-surface px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-track"
                >
                  Open project
                </button>
                <button
                  onClick={() => setDeciding(p)}
                  disabled={busy}
                  className="rounded-lg bg-header px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
                >
                  Mark as decided
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {decided && (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 border-t border-accent/30 pt-3 text-sm text-muted">
          <span className="font-semibold text-st-green">✓</span>
          Decision on <b className="text-ink">{decided.name}</b> recorded as <OutcomeBadge outcome={decided.record.outcome} /> and moved
          to Decision history.
          <button
            onClick={() => void undo()}
            disabled={busy}
            className="font-semibold text-ink underline underline-offset-2 hover:no-underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            Undo
          </button>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {error}
        </p>
      )}

      {deciding && (
        <Modal title="Record decision" onClose={closeForm}>
          <DecideForm pending={deciding} onDone={(rec) => onRecorded(deciding, rec)} onCancel={closeForm} />
        </Modal>
      )}
    </section>
  );
}

export default function Overview({
  onOpen,
  onBrief,
  onNavigate,
  focus = null,
}: {
  onOpen: (ref: OpenRef) => void;
  onBrief: () => void;
  onNavigate: (to: NavTarget) => void;
  focus?: OverviewFocus | null;
}) {
  const now = useNow();
  const s = summary();
  const items = attentionItems();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight" suppressHydrationWarning>
            {greeting(now)}
          </h2>
          <p className="mt-1 text-muted">{summarySentence()}</p>
        </div>
        <button
          onClick={onBrief}
          className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold shadow-sm hover:bg-track"
        >
          Weekly brief
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 desk:grid-cols-5 xl:gap-4">
        <KpiCard
          value={s.inFlight}
          title="Projects in dev"
          sub={`${s.total} in total, ${s.notStarted} not started`}
          bar="bg-st-blue"
          text="text-st-blue"
          onClick={() => onNavigate({ tab: "Projects" })}
        />
        <KpiCard
          value={s.offTrack + s.watch}
          title="Off track or watch"
          sub={`${s.offTrack} off track, ${s.watch} watch`}
          bar="bg-st-red"
          text="text-st-red-strong"
          onClick={() => onNavigate({ tab: "Projects" })}
        />
        <KpiCard
          value={s.overdue}
          title="Overdue tasks"
          sub="Past the due date"
          bar="bg-st-red"
          text="text-st-red-strong"
          onClick={() => onNavigate({ tab: "Tasks & Deadlines", focus: "overdue" })}
        />
        <KpiCard
          value={s.blocked}
          title="Blocked tasks"
          sub="Waiting on something"
          bar="bg-st-purple"
          text="text-st-purple"
          onClick={() => onNavigate({ tab: "Tasks & Deadlines", focus: "blocked" })}
        />
        <KpiCard
          value={s.stretched}
          title="Stretched people"
          sub="Overloaded or at risk"
          bar="bg-st-orange"
          text="text-st-orange-strong"
          onClick={() => onNavigate({ tab: "Team", show: "stretched" })}
        />
      </div>

      <DecisionsCard now={now} onOpen={onOpen} />

      <DecisionHistory key={focus?.decision ? `h${focus.nonce}` : "history"} onOpen={onOpen} initialSelected={focus?.decision} />

      <DailyUpdates key={focus?.update ? `u${focus.nonce}` : "updates"} initialSelected={focus?.update} />

      <div className="grid grid-cols-1 gap-5 desk:grid-cols-2">
        <Card>
          <CardHeader
            title="Project health"
            subtitle="Work completed against time used. The tick marks where each project should be today."
          />
          <ul className="divide-y divide-line">
            {projects.length === 0 && <li className="py-6 text-center text-muted">No projects yet. Create one on the Projects tab.</li>}
            {projects.map((p) => {
              const status = projectStatus(p);
              const time = timeUsed(p);
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onOpen({ kind: "project", id: p.id })}
                    className="grid w-full grid-cols-1 items-center gap-3 py-3 text-left sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_8rem] sm:gap-6"
                  >
                    <div>
                      <div className="text-[15px] font-medium">{p.name}</div>
                      <div className="mt-1.5">
                        <StatusBadge status={status} />
                      </div>
                    </div>
                    <ProgressBar done={p.done} time={time} status={status} />
                    <div className="sm:text-right">
                      <div className="text-[15px]">
                        <span className="font-bold">{p.done}%</span> done
                      </div>
                      <div className="text-sm text-muted">{status === "not-started" ? startsInLabel(p) : `${time}% of time used`}</div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <HealthLegend />
        </Card>

        <Card>
          <CardHeader title="Needs your attention" subtitle="Most serious first. Select an item to open it." />
          <ul className="divide-y divide-line">
            {items.length === 0 && <li className="py-6 text-center text-muted">Nothing needs your attention right now.</li>}
            {items.map((it) => (
              <li key={it.key}>
                <button
                  onClick={() => onOpen(it.ref)}
                  className="-mx-2 flex w-[calc(100%+1rem)] gap-4 rounded-lg px-2 py-3 text-left hover:bg-track/50"
                >
                  <span className="mt-1.5 flex w-4 justify-center">
                    <MarkerIcon marker={it.marker} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="text-[15px] font-bold">{it.title}</span>
                      <span className="whitespace-nowrap text-sm font-medium">{it.label}</span>
                    </span>
                    <span className="mt-0.5 block text-sm text-muted">{it.subtitle}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 desk:grid-cols-2">
        <TeamWorkload />
        <KeyDates now={now} onOpen={onOpen} />
      </div>

      <RecentActivity />
    </div>
  );
}
