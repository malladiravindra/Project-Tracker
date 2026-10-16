"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import { Combobox, DateField, type ComboOption } from "./FormControls";
import {
  byDue,
  dateOffset,
  PRIORITIES,
  projectById,
  projects,
  tasks,
  team,
  type Priority,
  type Task,
  type TaskState,
} from "@/lib/data";
import { api, ApiError, errorMessage } from "@/lib/api";
import { mutate, numericId, SCOPES, serverToday } from "@/lib/store";
import { addDaysIso, isoToLocalDate, wallClockIso } from "@/lib/serverClock";
import { BLOCKED_NOTE_TOO_LONG, blockedNoteOrNull, blockedNoteProblem, NOTE_MAX_LENGTH } from "@/lib/blockedNote";
import { useNow } from "./hooks";
import type { OpenRef } from "./Overview";
import { Modal } from "./ui";

/* ---------- Groups ---------- */

export type Group = "overdue" | "today" | "next2" | "week" | "later" | "blocked" | "done";

const groupOrder: Group[] = ["overdue", "today", "next2", "week", "later", "blocked", "done"];

export const groupMeta: Record<
  Group,
  { label: string; sub: string; bar: string; text: string; dot: string; tint: string; edge: string }
> = {
  overdue: {
    label: "Overdue",
    sub: "Past due or work date",
    bar: "bg-(--g-overdue)",
    text: "text-(--g-overdue-strong)",
    dot: "bg-(--g-overdue)",
    tint: "bg-(--g-overdue)/6 border-(--g-overdue)/20",
    edge: "bg-(--g-overdue)",
  },
  today: {
    label: "Today",
    sub: "Due or worked on today",
    bar: "bg-(--g-today)",
    text: "text-(--g-today-strong)",
    dot: "bg-(--g-today)",
    tint: "bg-(--g-today)/6 border-(--g-today)/20",
    edge: "bg-(--g-today)",
  },
  next2: {
    label: "Next 2 days",
    sub: "Tomorrow or the day after",
    bar: "bg-(--g-next2)",
    text: "text-(--g-next2-strong)",
    dot: "bg-(--g-next2)",
    tint: "bg-(--g-next2)/6 border-(--g-next2)/25",
    edge: "bg-(--g-next2)",
  },
  week: {
    label: "This week",
    sub: "Due in 3 to 7 days",
    bar: "bg-(--g-week)",
    text: "text-(--g-week-strong)",
    dot: "bg-(--g-week)",
    tint: "bg-surface border-line",
    edge: "bg-(--g-week)",
  },
  later: {
    label: "Later",
    sub: "More than a week away",
    bar: "bg-(--g-later)",
    text: "text-(--g-later-strong)",
    dot: "bg-(--g-later)",
    tint: "bg-surface border-line",
    edge: "bg-(--g-later)",
  },
  blocked: {
    label: "Blocked",
    sub: "Waiting on something",
    bar: "bg-st-purple",
    text: "text-st-purple",
    dot: "bg-st-purple",
    tint: "bg-st-purple/6 border-st-purple/20",
    edge: "bg-st-purple",
  },
  done: {
    label: "Completed",
    sub: "Finished work",
    bar: "bg-st-green",
    text: "text-st-green",
    dot: "bg-st-green",
    tint: "bg-surface border-line",
    edge: "bg-st-green",
  },
};

export function taskGroup(t: Task): Group {
  if (t.state === "done") return "done";
  if (t.state === "blocked") return "blocked";
  const d = dateOffset(t); // the deadline, or the work date when there is none
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  if (d <= 2) return "next2";
  if (d <= 7) return "week";
  return "later";
}

/* ---------- Alert colours (user adjustable) ---------- */

type AlertGroup = "overdue" | "today" | "next2" | "week" | "later";
type AlertColors = Partial<Record<AlertGroup, string>>;

const ALERT_GROUPS: { group: AlertGroup; base: string; strong: string; hex: string }[] = [
  { group: "overdue", base: "--red", strong: "--red-strong", hex: "#d63a40" },
  { group: "today", base: "--orange", strong: "--orange-strong", hex: "#e8730c" },
  { group: "next2", base: "--amber", strong: "--amber-strong", hex: "#f5b01a" },
  { group: "week", base: "--blue", strong: "--blue", hex: "#2f6fd6" },
  { group: "later", base: "--slate", strong: "--slate", hex: "#5a6f80" },
];

const COLORS_KEY = "taskAlertColors";

function loadColors(): AlertColors {
  try {
    if (typeof window === "undefined") return {};
    return JSON.parse(localStorage.getItem(COLORS_KEY) ?? "{}") as AlertColors;
  } catch {
    return {};
  }
}

function saveColors(c: AlertColors) {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify(c));
  } catch {}
}

/* CSS variables the group classes read; custom picks get a darker/lighter text shade mixed with the ink colour. */
function colorVars(custom: AlertColors) {
  const vars: Record<string, string> = {};
  for (const { group, base, strong } of ALERT_GROUPS) {
    const c = custom[group];
    vars[`--g-${group}`] = c ?? `var(${base})`;
    vars[`--g-${group}-strong`] = c ? `color-mix(in srgb, ${c} 78%, var(--text))` : `var(${strong})`;
  }
  return vars as CSSProperties;
}

function AlertColorsPanel({
  colors,
  alerts,
  onChange,
  onReset,
  onAlerts,
}: {
  colors: AlertColors;
  alerts: boolean;
  onChange: (g: AlertGroup, hex: string) => void;
  onReset: () => void;
  onAlerts: (on: boolean) => void;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface p-6 shadow-sm" aria-label="Alert colors">
      <h3 className="text-lg font-bold">Alert colors</h3>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {ALERT_GROUPS.map(({ group, hex }) => (
          <label key={group} className="flex cursor-pointer items-center gap-3">
            <span className="flex rounded-lg border border-line bg-surface p-1.5 shadow-sm">
              <input
                type="color"
                value={colors[group] ?? hex}
                onChange={(e) => onChange(group, e.target.value)}
                className="color-swatch h-7 w-12 cursor-pointer"
              />
            </span>
            <span>{groupMeta[group].label}</span>
          </label>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <button onClick={onReset} className={`${control} hover:bg-track/50`}>
          Reset to default colors
        </button>
        <label className="flex cursor-pointer items-center gap-2 text-[15px]">
          <input
            type="checkbox"
            checked={alerts}
            onChange={(e) => onAlerts(e.target.checked)}
            className="h-4 w-4 accent-st-blue"
          />
          Tint overdue and urgent rows
        </label>
      </div>
    </section>
  );
}

export const STATES: { value: TaskState; label: string }[] = [
  { value: "not-started", label: "Not Started" },
  { value: "in-progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Completed" },
];

type StatusFilter = "open" | "all" | TaskState;

type DateRange = "any" | "today" | "7d" | "30d" | "month" | "prevMonth" | "custom";

const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: "any", label: "Any work date" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "month", label: "This month" },
  { value: "prevMonth", label: "Previous month" },
  { value: "custom", label: "Custom range" },
];

/** Inclusive [from, to] work-date bounds (YYYY-MM-DD, "" = open-ended) for a range, using the server's today. */
function rangeBounds(range: DateRange, from: string, to: string): [string, string] | null {
  const today = serverToday();
  const firstOfMonth = `${today.slice(0, 8)}01`;
  const lastOfPrev = addDaysIso(firstOfMonth, -1);
  switch (range) {
    case "any":
      return null;
    case "today":
      return [today, today];
    case "7d":
      return [addDaysIso(today, -6), today];
    case "30d":
      return [addDaysIso(today, -29), today];
    case "month":
      return [firstOfMonth, addDaysIso(`${addDaysIso(firstOfMonth, 31).slice(0, 8)}01`, -1)];
    case "prevMonth":
      return [`${lastOfPrev.slice(0, 8)}01`, lastOfPrev];
    case "custom":
      return from || to ? [from, to] : null;
  }
}

const shortIso = (iso: string) => isoToLocalDate(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "all", label: "All statuses" },
  ...STATES,
];

const priorityClass: Record<Priority, string> = {
  Critical: "w-fit rounded bg-st-red/10 px-1.5 text-st-red-strong",
  High: "text-st-red-strong",
  Medium: "text-st-orange-strong",
  Low: "text-muted",
};

/* ---------- Dates ---------- */

export const DAY_MS = 86_400_000;

export function addDays(base: Date, days: number) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function shortDate(d: Date) {
  const wd = d.toLocaleDateString("en-GB", { weekday: "short" });
  const m = d.toLocaleDateString("en-GB", { month: "short" });
  return `${wd}, ${d.getDate()} ${m}`;
}

export function dueText(t: Task) {
  const d = t.dueOffset;
  if (d === null) return `Work date ${isoToLocalDate(t.workDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} overdue`;
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return `In ${d} days`;
}

// Read on each render so newly added employees appear in owner pickers straight away.
const getOwners = () => Array.from(new Set([...team.map((m) => m.name), ...tasks.map((t) => t.owner)]));

/* ---------- Pieces ---------- */

export const control =
  "h-10 rounded-lg border border-line bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-st-blue focus:ring-2 focus:ring-st-blue/20";

function GroupCard({
  group,
  count,
  active,
  onClick,
}: {
  group: Group;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const m = groupMeta[group];
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col overflow-hidden rounded-xl border bg-surface text-left shadow-sm card-hover ${
        active ? "border-ink ring-2 ring-ink/15" : "border-line"
      }`}
    >
      <div className={`h-1 ${m.bar}`} />
      <div className="w-full px-3.5 pb-3.5 pt-3.5 xl:px-4">
        <div className={`text-[1.75rem] font-bold leading-none ${m.text}`}>{count}</div>
        <div className="mt-1.5 truncate text-[15px] font-semibold">{m.label}</div>
        <div className="truncate text-[13px] text-muted" title={m.sub}>
          {m.sub}
        </div>
      </div>
    </button>
  );
}

function TaskRow({
  task,
  now,
  alerts,
  onOpen,
  onState,
  saving,
}: {
  task: Task;
  now: Date | null;
  alerts: boolean;
  onOpen: () => void;
  onState: (s: TaskState) => void;
  saving: boolean;
}) {
  const g = taskGroup(task);
  const m = groupMeta[g];
  const urgent = g === "overdue" || g === "today";
  const dueColor = g === "done" ? "text-muted" : alerts && g !== "week" && g !== "later" ? m.text : "text-ink";

  return (
    <li
      onClick={onOpen}
      className={`relative card-hover grid grid-cols-1 items-center gap-x-4 gap-y-1.5 rounded-lg border py-2.5 pl-6 pr-4 lg:grid-cols-[minmax(0,1fr)_8.5rem_8.5rem_4.5rem_9.5rem] desk:grid-cols-[minmax(0,4.4fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(9rem,0.95fr)] ${
        alerts ? m.tint : "border-line bg-surface"
      }`}
    >
      <span className={`absolute bottom-2.5 left-0 top-2.5 w-1 rounded-r ${m.edge}`} aria-hidden />
      <div className="min-w-0">
        <div className="text-[15px] font-bold leading-snug">{projectById(task.projectId).name}</div>
        <div className={`text-[14px] leading-snug ${g === "done" ? "text-muted line-through" : "text-ink/85"}`}>{task.title}</div>
        {task.dueDate && (
          <div className="text-[12.5px] text-muted" suppressHydrationWarning>
            Work date {now ? shortIso(task.workDate) : task.workDate}
          </div>
        )}
      </div>
      <div className="truncate text-[15px]">{task.owner}</div>
      {task.dueDate ? (
        <div>
          <div className={`text-[15px] leading-snug ${urgent ? "font-bold" : "font-semibold"} ${dueColor}`}>
            {g === "done" ? "Completed" : dueText(task)}
          </div>
          <div className="text-[13px] text-muted" suppressHydrationWarning>
            {now ? shortDate(isoToLocalDate(task.dueDate)) : " "}
          </div>
        </div>
      ) : (
        // No deadline: show when the work was done instead.
        <div>
          <div className={`text-[15px] leading-snug ${urgent ? "font-bold" : "font-semibold"} ${dueColor}`} suppressHydrationWarning>
            {now ? shortDate(isoToLocalDate(task.workDate)) : task.workDate}
          </div>
          <div className="text-[13px] text-muted">{g === "done" ? "Completed · work date" : "Work date"}</div>
        </div>
      )}
      <div className={`text-sm font-semibold ${priorityClass[task.priority]}`}>{task.priority}</div>
      <select
        aria-label={`Status of ${task.title}`}
        value={task.state}
        disabled={saving}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onState(e.target.value as TaskState)}
        className={`${control} h-9! w-full rounded-md! px-3! text-sm! disabled:cursor-wait disabled:opacity-60`}
      >
        {STATES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </li>
  );
}

function CalendarView({
  rows,
  now,
  onOpen,
}: {
  rows: Task[];
  now: Date | null;
  onOpen: (id: string) => void;
}) {
  const [monthShift, setMonthShift] = useState(0);
  if (!now) return null;

  const first = new Date(now.getFullYear(), now.getMonth() + monthShift, 1);
  const lead = (first.getDay() + 6) % 7; // Monday-first grid
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const today = wallClockIso(now); // the server's calendar date

  const byDay = new Map<string, Task[]>();
  for (const t of rows) {
    const day = t.dueDate ?? t.workDate; // tasks without a deadline show on their work date
    byDay.set(day, [...(byDay.get(day) ?? []), t]);
  }

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-bold">
          {first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
        </h3>
        <div className="flex gap-2">
          <button onClick={() => setMonthShift((s) => s - 1)} className="rounded-lg border border-line px-3 py-1.5 hover:bg-track" aria-label="Previous month">
            ‹
          </button>
          <button onClick={() => setMonthShift(0)} className="rounded-lg border border-line px-3 py-1.5 hover:bg-track">
            Today
          </button>
          <button onClick={() => setMonthShift((s) => s + 1)} className="rounded-lg border border-line px-3 py-1.5 hover:bg-track" aria-label="Next month">
            ›
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7 overflow-hidden rounded-lg border border-line">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="border-b border-line bg-track/40 px-2 py-2 text-sm font-semibold text-muted">
              {d}
            </div>
          ))}
          {Array.from({ length: cells }, (_, i) => {
            const date = new Date(first.getFullYear(), first.getMonth(), i - lead + 1);
            const inMonth = date.getMonth() === first.getMonth();
            const iso = wallClockIso(date);
            const isToday = iso === today;
            const items = byDay.get(iso) ?? [];
            return (
              <div
                key={i}
                className={`min-h-28 border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0 ${inMonth ? "" : "bg-track/25 text-muted"}`}
              >
                <div
                  className={`mb-1 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm ${
                    isToday ? "bg-header font-bold text-white dark:bg-accent dark:text-header" : ""
                  }`}
                >
                  {date.getDate()}
                </div>
                <div className="space-y-1">
                  {items.map((t) => {
                    const m = groupMeta[taskGroup(t)];
                    return (
                      <button
                        key={t.id}
                        onClick={() => onOpen(t.id)}
                        title={`${t.title} · ${t.owner}`}
                        className={`flex w-full items-center gap-1.5 truncate rounded border px-1.5 py-0.5 text-left text-xs ${m.tint}`}
                      >
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.dot}`} />
                        <span className="truncate">{t.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

type TaskField = "title" | "project" | "owner" | "work" | "due" | "note";
// Server field names -> form fields, so API validation messages land next to the right input.
const TASK_SERVER_FIELDS: Record<string, TaskField> = {
  title: "title",
  project_id: "project",
  owner_id: "owner",
  work_date: "work",
  due_date: "due",
  note: "note",
};

/** Owner choices: the project's team first (with their role), then everyone else; inactive people are left out. */
export function ownerOptions(projectId: string, keep?: string): ComboOption[] {
  const project = projects.find((p) => p.id === projectId);
  const role = (name: string) => project?.members.find((x) => x.name === name)?.role;
  return team
    .filter((m) => m.id !== undefined && (m.status !== "inactive" || m.name === keep))
    .sort((a, b) => Number(!role(a.name)) - Number(!role(b.name)) || a.name.localeCompare(b.name))
    .map((m) => ({ value: String(m.id), label: m.name, hint: role(m.name) ?? (m.status === "on_leave" ? "On leave" : m.title) }));
}

/** Work date problems shared by the new-task form and the task editor. */
export function workDateProblem(iso: string, typed: boolean): string {
  if (typed) return "Enter the work date as dd-mm-yyyy.";
  if (!iso) return "Select the work date.";
  return "";
}

export function FieldNote({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[13px] font-medium text-st-red-strong">
      {message}
    </p>
  );
}

export function NewTaskForm({
  onCreated,
  onCancel,
  defaultProjectId = "",
}: {
  onCreated: () => void;
  onCancel?: () => void;
  defaultProjectId?: string;
}) {
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [owner, setOwner] = useState(""); // member id
  const [workDate, setWorkDate] = useState(serverToday);
  const [workTyped, setWorkTyped] = useState(false); // text entered but not a valid date
  const [due, setDue] = useState("");
  const [dueTyped, setDueTyped] = useState(false);
  const [priority, setPriority] = useState<Priority>("Medium");
  const [state, setState] = useState<TaskState>("not-started");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState<Partial<Record<TaskField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [serverFields, setServerFields] = useState<Partial<Record<TaskField, string>>>({});

  const projectOptions = [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, hint: p.client }));
  const owners = ownerOptions(projectId);

  const problems: Partial<Record<TaskField, string>> = {
    title: !title.trim() ? "Give the task a name." : "",
    project: !projectId ? "Choose a project." : "",
    owner: !owner ? "Select an employee for this task." : "",
    work: workDateProblem(workDate, workTyped),
    due: dueTyped ? "Enter the due date as dd-mm-yyyy, or leave it empty." : "",
    note: state === "blocked" ? blockedNoteProblem(note) : note.trim().length > NOTE_MAX_LENGTH ? BLOCKED_NOTE_TOO_LONG : "",
  };
  const order: TaskField[] = ["title", "project", "owner", "work", "due", "note"];
  const firstProblem = order.find((f) => problems[f]);
  const errorFor = (f: TaskField) => serverFields[f] || ((attempted || touched[f]) && problems[f]) || "";
  const touch = (f: TaskField) => setTouched((t) => ({ ...t, [f]: true }));
  const edited = (f: TaskField) => setServerFields((s) => (s[f] ? { ...s, [f]: "" } : s));
  const a11y = (f: TaskField) => ({
    invalid: !!errorFor(f),
    describedBy: errorFor(f) ? `nt-${f}-error` : undefined,
    onBlur: () => touch(f),
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (saving) return;
    if (firstProblem) {
      document.getElementById(`nt-${firstProblem}`)?.focus();
      return;
    }
    setSaving(true);
    setServerError("");
    setServerFields({});
    try {
      await mutate(
        () =>
          api.createTask({
            title: title.trim().replace(/\s+/g, " "),
            project_id: numericId(projectId),
            owner_id: Number(owner),
            work_date: workDate,
            due_date: due || null,
            priority,
            state,
            note: note.trim(),
          }),
        SCOPES.task,
      );
      onCreated();
    } catch (err) {
      const fields = err instanceof ApiError ? err.fields : {};
      const mapped: Partial<Record<TaskField, string>> = {};
      for (const [k, msgs] of Object.entries(fields)) if (TASK_SERVER_FIELDS[k]) mapped[TASK_SERVER_FIELDS[k]] = msgs[0];
      setServerFields(mapped);
      setServerError(Object.keys(mapped).length ? "Please fix the highlighted fields." : errorMessage(err));
      setSaving(false);
    }
  };

  const label = "mb-1.5 block text-sm font-semibold";
  const req = (
    <span className="text-st-red-strong" aria-hidden>
      {" "}
      *
    </span>
  );
  const invalidCls = (f: TaskField) => (errorFor(f) ? "border-st-red! focus:ring-st-red/20!" : "");
  const err = (f: TaskField) => <FieldNote id={`nt-${f}-error`} message={errorFor(f)} />;
  const when = workTyped || !workDate ? "" : workDate < serverToday() ? "past" : workDate > serverToday() ? "future" : "";

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <label htmlFor="nt-title" className={label}>
          Task Title{req}
        </label>
        <input
          id="nt-title"
          autoFocus
          autoComplete="off"
          maxLength={300}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            edited("title");
          }}
          onBlur={() => touch("title")}
          aria-required
          aria-invalid={!!errorFor("title")}
          aria-describedby={errorFor("title") ? "nt-title-error" : undefined}
          placeholder="e.g. Prepare monthly payroll report"
          className={`${control} w-full font-normal placeholder:text-muted ${invalidCls("title")}`}
        />
        {err("title")}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="nt-project" className={label}>
            Project{req}
          </label>
          <Combobox
            id="nt-project"
            value={projectId}
            onChange={(v) => {
              setProjectId(v);
              edited("project");
            }}
            options={projectOptions}
            placeholder="Select project"
            emptyText={projects.length ? "No matching project" : "Create a project first"}
            {...a11y("project")}
          />
          {err("project")}
        </div>
        <div>
          <label htmlFor="nt-owner" className={label}>
            Employee{req}
          </label>
          <Combobox
            id="nt-owner"
            value={owner}
            onChange={(v) => {
              setOwner(v);
              edited("owner");
            }}
            options={owners}
            placeholder="Select employee"
            emptyText={team.length ? "No matching employee" : "Add employees in the Team tab first"}
            {...a11y("owner")}
          />
          {err("owner")}
        </div>

        <div>
          <label htmlFor="nt-work" className={label}>
            Work Date{req}
          </label>
          <DateField
            id="nt-work"
            value={workDate}
            onChange={(iso, typed) => {
              setWorkDate(iso);
              setWorkTyped(typed);
              edited("work");
            }}
            {...a11y("work")}
          />
          {err("work") || (
            <p className="mt-1 text-[13px] text-muted">{when === "past" ? "Recording earlier work." : when === "future" ? "Planning work for a later day." : "The day the work is done. Past and future dates are fine."}</p>
          )}
        </div>
        <div>
          <label htmlFor="nt-due" className={label}>
            Due Date <span className="font-normal text-muted">(optional)</span>
          </label>
          <DateField
            id="nt-due"
            value={due}
            onChange={(iso, typed) => {
              setDue(iso);
              setDueTyped(typed);
              edited("due");
            }}
            {...a11y("due")}
          />
          {err("due")}
        </div>

        <div>
          <label htmlFor="nt-priority" className={label}>
            Priority
          </label>
          <select id="nt-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={`${control} w-full font-normal`}>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nt-status" className={label}>
            Status
          </label>
          <select id="nt-status" value={state} onChange={(e) => setState(e.target.value as TaskState)} className={`${control} w-full font-normal`}>
            {STATES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="nt-note" className={label}>
          {state === "blocked" ? (
            <>What is it waiting on?{req}</>
          ) : (
            <>
              Description / Work Notes <span className="font-normal text-muted">(optional)</span>
            </>
          )}
        </label>
        <textarea
          id="nt-note"
          rows={4}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            edited("note");
          }}
          onBlur={() => touch("note")}
          aria-invalid={!!errorFor("note")}
          aria-describedby={errorFor("note") ? "nt-note-error" : undefined}
          placeholder={
            state === "blocked" ? "e.g. Waiting for the vendor to resend the export file" : "Work performed, outcomes and any blockers..."
          }
          className={`w-full resize-y rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20 ${invalidCls("note")}`}
        />
        {err("note")}
      </div>

      {serverError && (
        <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2.5 pt-1">
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-line bg-surface px-4 py-2.5 font-medium hover:bg-track/60 disabled:opacity-60"
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-header px-5 py-2.5 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
        >
          {saving ? "Creating..." : "Create task"}
        </button>
      </div>
    </form>
  );
}

/* ---------- Blocked: a task can only be blocked together with a note ---------- */

function BlockedDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [note, setNote] = useState(task.note ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const problem = blockedNoteProblem(note);

  // One request: the new status and the note together. The task keeps its stored status until the server accepts it.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const text = blockedNoteOrNull(note);
    if (busy || problem || text === null) return;
    setBusy(true);
    setServerError("");
    try {
      await mutate(() => api.updateTask(numericId(task.id), { state: "blocked", note: text }), SCOPES.task);
      onClose();
    } catch (err) {
      setServerError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="What is it waiting on?" onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          Blocked: <b className="text-ink">{task.title}</b>. Say what it is waiting on, so others can help unblock it.
        </p>
        <textarea
          autoFocus
          rows={4}
          value={note}
          aria-label="What is the task waiting on?"
          onChange={(e) => {
            setNote(e.target.value);
            setTouched(true);
          }}
          placeholder="e.g. Waiting for the vendor to resend the export file"
          className="w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-[15px] outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20"
        />
        {problem && touched && <p className="-mt-2 text-sm font-medium text-st-red-strong">{problem}</p>}
        {serverError && (
          <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
            {serverError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-line bg-surface px-4 py-2 text-[15px] font-medium hover:bg-track disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !!problem}
            className="rounded-lg bg-header px-5 py-2 text-[15px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
          >
            {busy ? "Saving..." : "Mark as blocked"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- View ---------- */

export function TasksView({
  onOpen,
  initialFocus = null,
}: {
  onOpen: (ref: OpenRef) => void;
  initialFocus?: Group | null; // pre-select a summary card when arriving from the Overview
}) {
  const now = useNow();
  const [saving, setSaving] = useState<string | null>(null); // id of the task whose status is being saved
  const [rowError, setRowError] = useState("");
  const [mode, setMode] = useState<"list" | "calendar">("list");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("open");
  const [project, setProject] = useState("all");
  const [owner, setOwner] = useState("all");
  const [priority, setPriority] = useState<Priority | "all">("all");
  const [range, setRange] = useState<DateRange>("any");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [alerts, setAlerts] = useState(true);
  const [colorsOpen, setColorsOpen] = useState(false);
  const [colors, setColors] = useState<AlertColors>(loadColors);
  const updateColors = (next: AlertColors) => {
    setColors(next);
    saveColors(next);
  };
  const [focus, setFocus] = useState<Group | null>(initialFocus);
  const [creating, setCreating] = useState(false);
  const [blocking, setBlocking] = useState<Task | null>(null); // task waiting for its "blocked" note

  const owners = getOwners();
  const allCounts = Object.fromEntries(groupOrder.map((g) => [g, 0])) as Record<Group, number>;
  for (const t of tasks) allCounts[taskGroup(t)]++;

  const q = query.trim().toLowerCase();
  const bounds = rangeBounds(range, customFrom, customTo);
  // Every filter except status and the card focus: the cards count these, so they follow the date range too.
  const scoped = tasks
    .filter((t) => project === "all" || t.projectId === project)
    .filter((t) => owner === "all" || t.owner === owner)
    .filter((t) => priority === "all" || t.priority === priority)
    .filter((t) => !bounds || ((!bounds[0] || t.workDate >= bounds[0]) && (!bounds[1] || t.workDate <= bounds[1])))
    .filter(
      (t) =>
        !q ||
        t.title.toLowerCase().includes(q) ||
        t.owner.toLowerCase().includes(q) ||
        (t.note ?? "").toLowerCase().includes(q) ||
        projectById(t.projectId).name.toLowerCase().includes(q),
    );
  const counts = Object.fromEntries(groupOrder.map((g) => [g, 0])) as Record<Group, number>;
  for (const t of scoped) counts[taskGroup(t)]++;
  // Also without status, so we can tell how many completed tasks the "Open" status is hiding.
  const matching = scoped.filter((t) => !focus || taskGroup(t) === focus);
  const rows = matching
    .filter((t) => (status === "open" ? t.state !== "done" : status === "all" || t.state === status))
    .sort(byDue);
  const hiddenDone = status === "open" ? matching.filter((t) => t.state === "done").length : 0;
  const filtered = !!q || status !== "open" || project !== "all" || owner !== "all" || priority !== "all" || range !== "any";
  const clearFilters = () => {
    setQuery("");
    setStatus("open");
    setProject("all");
    setOwner("all");
    setPriority("all");
    setRange("any");
    setCustomFrom("");
    setCustomTo("");
  };
  const customProblem = range === "custom" && customFrom && customTo && customTo < customFrom ? "The end date is before the start date." : "";

  const grouped = groupOrder
    .map((g) => ({ group: g, items: rows.filter((t) => taskGroup(t) === g) }))
    .filter((x) => x.items.length > 0);

  const action = allCounts.overdue + allCounts.today; // the header is always about today, whatever the filters

  // The select shows the stored status; it only changes once the server has accepted the new one and the data is refetched.
  const setState = async (t: Task, s: TaskState) => {
    setRowError("");
    setSaving(t.id);
    try {
      await mutate(() => api.updateTask(numericId(t.id), { state: s }), SCOPES.task);
    } catch (e) {
      setRowError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const toggleBtn = (m: "list" | "calendar", label: string) => (
    <button
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={`px-4 py-2 text-[15px] ${
        mode === m ? "bg-header font-medium text-white dark:bg-accent dark:text-header" : "bg-surface text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6" style={colorVars(colors)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight">Tasks &amp; Deadlines</h2>
          <p className="mt-1 text-muted">
            {action} item{action === 1 ? "" : "s"} need{action === 1 ? "s" : ""} action today: {allCounts.overdue} overdue, {allCounts.today} for
            today.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="View">
            {toggleBtn("list", "List")}
            {toggleBtn("calendar", "Calendar")}
          </div>
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-header px-5 py-2 text-[15px] font-semibold text-white hover:opacity-90 dark:bg-accent dark:text-header"
          >
            New task
          </button>
        </div>
      </div>

      {colorsOpen && (
        <AlertColorsPanel
          colors={colors}
          alerts={alerts}
          onChange={(g, hex) => updateColors({ ...colors, [g]: hex })}
          onReset={() => updateColors({})}
          onAlerts={setAlerts}
        />
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 desk:grid-cols-6 xl:gap-4">
        {groupOrder
          .filter((g) => g !== "done")
          .map((g) => (
            <GroupCard key={g} group={g} count={counts[g]} active={focus === g} onClick={() => setFocus(focus === g ? null : g)} />
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tasks, projects or people"
          aria-label="Search tasks"
          className={`${control} h-11! w-full placeholder:text-muted desk:w-auto desk:min-w-[14rem] desk:flex-1`}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status" className={`${control} w-36`}>
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={`${control} w-56`}>
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Employee" className={`${control} w-40`}>
          <option value="all">Everyone</option>
          {owners.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | "all")} aria-label="Priority" className={`${control} w-36`}>
          <option value="all">Any priority</option>
          {[...PRIORITIES].reverse().map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value as DateRange)} aria-label="Work date" className={`${control} w-44`}>
          {DATE_RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setColorsOpen((o) => !o)}
          aria-expanded={colorsOpen}
          className={`${control} hover:bg-track/50`}
        >
          {colorsOpen ? "Close colors" : "Alert colors"}
        </button>
      </div>

      {range === "custom" && (
        <div className="-mt-3 flex flex-wrap items-end gap-3">
          <div className="w-44">
            <label htmlFor="tf-from" className="mb-1 block text-sm font-semibold text-muted">
              Work date from
            </label>
            <DateField id="tf-from" value={customFrom} onChange={(iso) => setCustomFrom(iso)} invalid={!!customProblem} />
          </div>
          <div className="w-44">
            <label htmlFor="tf-to" className="mb-1 block text-sm font-semibold text-muted">
              to
            </label>
            <DateField id="tf-to" value={customTo} onChange={(iso) => setCustomTo(iso)} invalid={!!customProblem} />
          </div>
          {customProblem && <p className="pb-2.5 text-sm font-medium text-st-red-strong">{customProblem}</p>}
        </div>
      )}

      {(bounds || filtered) && (
        <div className="-mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {bounds && (
            <span suppressHydrationWarning>
              Work date{" "}
              <b className="text-ink">
                {bounds[0] && bounds[1] && bounds[0] === bounds[1]
                  ? shortIso(bounds[0])
                  : `${bounds[0] ? shortIso(bounds[0]) : "the start"} to ${bounds[1] ? shortIso(bounds[1]) : "today"}`}
              </b>
              {" · "}
              {rows.length} task{rows.length === 1 ? "" : "s"}
            </span>
          )}
          {hiddenDone > 0 && (
            <button onClick={() => setStatus("all")} className="rounded px-1 text-st-blue underline-offset-2 hover:underline">
              Show {hiddenDone} completed
            </button>
          )}
          {filtered && (
            <button onClick={clearFilters} className="rounded px-1 underline underline-offset-2 hover:text-ink">
              Clear filters
            </button>
          )}
        </div>
      )}

      {focus && (
        <div className="-mt-3 flex items-center gap-2 text-muted">
          Showing only <b className="text-ink">{groupMeta[focus].label}</b>
          <button onClick={() => setFocus(null)} className="rounded px-1.5 underline hover:text-ink">
            Clear
          </button>
        </div>
      )}

      {rowError && (
        <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {rowError}
        </p>
      )}

      {mode === "calendar" ? (
        <CalendarView rows={rows} now={now} onOpen={(id) => onOpen({ kind: "task", id })} />
      ) : grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-surface py-12 text-center text-muted">
          {tasks.length === 0 ? "No tasks yet. Use New task to add the first one." : "No tasks match these filters."}
        </p>
      ) : (
        grouped.map(({ group, items }) => {
          const m = groupMeta[group];
          return (
            <section key={group}>
              <h3 className="mb-2.5 flex items-center gap-2.5 text-base">
                <span className={`h-3 w-3 rounded-full ${m.dot}`} aria-hidden />
                <span className="font-semibold">
                  {m.label} ({items.length})
                </span>
                <span className="text-muted">{m.sub}</span>
              </h3>
              <ul className="space-y-2">
                {items.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    now={now}
                    alerts={alerts}
                    onOpen={() => onOpen({ kind: "task", id: t.id })}
                    onState={(s) => (s === "blocked" ? setBlocking(t) : void setState(t, s))}
                    saving={saving === t.id}
                  />
                ))}
              </ul>
            </section>
          );
        })
      )}

      {blocking && <BlockedDialog key={blocking.id} task={blocking} onClose={() => setBlocking(null)} />}

      {creating && (
        <Modal title="New task" onClose={() => setCreating(false)} wide>
          <NewTaskForm onCreated={() => setCreating(false)} onCancel={() => setCreating(false)} />
        </Modal>
      )}
    </div>
  );
}
