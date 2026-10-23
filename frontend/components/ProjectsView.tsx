"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  byDue,
  departments,
  PROJECT_PRIORITIES,
  projectStatus,
  projects,
  startsInLabel,
  tasks,
  team,
  timeUsed,
  type Project,
  type ProjectPhase,
  type ProjectPriority,
  type ProjectStatus,
  agoLabel,
} from "@/lib/data";
import { api, ApiError, errorMessage, type ProjectPatch } from "@/lib/api";
import { loadMoreProjectHistory, loadProjectHistory, memberId, mutate, nowMs, numericId, SCOPES, useStore, type Scope } from "@/lib/store";
import { addDaysIso, isoToLocalDate, minutesBetween } from "@/lib/serverClock";
import { Combobox, DateField } from "./FormControls";
import { useNow } from "./hooks";
import type { OpenRef } from "./Overview";
import { addDays, control, dueText, NewTaskForm, taskGroup } from "./TasksView";
import { barColor, ConfirmDialog, Modal, ProgressBar, StatusBadge } from "./ui";

/* ---------- Helpers ---------- */

const PHASES: ProjectPhase[] = ["Planning", "Not Started", "In Progress", "Under Testing", "At Risk", "On Hold", "No Updates", "Completed", "Cancelled"];

const PRIORITY_TONE: Record<ProjectPriority, string> = {
  Low: "border-line text-muted",
  Medium: "border-st-blue/50 text-st-blue",
  High: "border-st-orange text-st-orange-strong",
  Critical: "border-st-red bg-st-red/8 text-st-red-strong",
};

function PriorityPill({ priority }: { priority: ProjectPriority }) {
  return (
    <span className={`inline-block rounded-full border px-2 text-[12px] font-semibold leading-5 ${PRIORITY_TONE[priority]}`}>
      {priority}
    </span>
  );
}

// Status cards above the list (same look as the Tasks & Deadlines cards); clicking one shows only those projects.
const PHASE_CARDS: { value: ProjectPhase | "all"; label: string; sub: string; bar: string; text: string }[] = [
  { value: "all", label: "All projects", sub: "Every status", bar: "bg-st-slate", text: "text-ink" },
  { value: "In Progress", label: "In Progress", sub: "Work under way", bar: "bg-st-blue", text: "text-st-blue" },
  { value: "Under Testing", label: "Under Testing", sub: "Being tested", bar: "bg-st-purple", text: "text-st-purple" },
  { value: "On Hold", label: "On Hold", sub: "Paused for now", bar: "bg-st-amber", text: "text-st-amber-strong" },
  { value: "No Updates", label: "No Updates", sub: "Waiting on news", bar: "bg-st-red", text: "text-st-red-strong" },
  { value: "Completed", label: "Completed", sub: "Delivered", bar: "bg-st-green", text: "text-st-green" },
];

function PhaseCard({
  card,
  count,
  active,
  onClick,
}: {
  card: (typeof PHASE_CARDS)[number];
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-col overflow-hidden rounded-xl border bg-surface text-left shadow-sm card-hover ${
        active ? "border-ink ring-2 ring-ink/15" : "border-line"
      }`}
    >
      <div className={`h-1 ${card.bar}`} />
      <div className="w-full px-3.5 pb-3.5 pt-3.5 xl:px-4">
        <div className={`text-[1.75rem] font-bold leading-none ${card.text}`}>{count}</div>
        <div className="mt-1.5 truncate text-[15px] font-semibold">{card.label}</div>
        <div className="truncate text-[13px] text-muted">{card.sub}</div>
      </div>
    </button>
  );
}

const STATUS_FILTERS: { value: ProjectStatus | "all"; label: string }[] = [
  { value: "all", label: "All health" },
  { value: "off-track", label: "Off track" },
  { value: "watch", label: "Needs watching" },
  { value: "on-track", label: "On track" },
  { value: "not-started", label: "Not started" },
];

type Sort = "attention" | "deadline" | "progress" | "name";

const SORTS: { value: Sort; label: string }[] = [
  { value: "attention", label: "Needs attention first" },
  { value: "deadline", label: "Deadline soonest" },
  { value: "progress", label: "Most progress" },
  { value: "name", label: "Name A to Z" },
];

const attentionRank: ProjectStatus[] = ["off-track", "watch", "on-track", "not-started"];

// Soonest deadline first; projects without one go last.
const byDeadline = (a: Project, b: Project) => (a.endOffset ?? Infinity) - (b.endOffset ?? Infinity) || 0;

const sorters: Record<Sort, (a: Project, b: Project) => number> = {
  attention: (a, b) =>
    attentionRank.indexOf(projectStatus(a)) - attentionRank.indexOf(projectStatus(b)) || byDeadline(a, b),
  deadline: (a, b) => byDeadline(a, b),
  progress: (a, b) => b.done - a.done,
  name: (a, b) => a.name.localeCompare(b.name),
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function healthPoints(p: Project): string[] {
  const status = projectStatus(p);
  const used = timeUsed(p);
  const open = tasks.filter((t) => t.projectId === p.id);
  const overdue = open.filter((t) => taskGroup(t) === "overdue").length;
  const blocked = open.filter((t) => t.state === "blocked").length;
  const points = [
    {
      "off-track": `Behind schedule: ${p.done}% done with ${used}% of the time used`,
      watch: `Slightly behind: ${p.done}% done with ${used}% of the time used`,
      "on-track": `On schedule: ${p.done}% done with ${used}% of the time used`,
      "not-started": startsInLabel(p),
    }[status],
  ];
  if (overdue) points.push(`${plural(overdue, "task")} overdue`);
  if (blocked) points.push(`${plural(blocked, "task")} blocked`);
  if (p.phase === "At Risk") points.push("Marked at risk by the project lead");
  if (p.phase === "On Hold") points.push("Put on hold by the project lead");
  if (p.phase === "Planning") points.push("Still in planning");
  if (p.phase === "Cancelled") points.push("Cancelled");
  return points;
}

function timeLeft(p: Project) {
  if (p.phase === "Completed" || p.phase === "Cancelled") return p.phase;
  const d = p.endOffset;
  if (d === null) return "No deadline";
  if (d < 0) return `${plural(-d, "day")} past deadline`;
  if (d === 0) return "Due today";
  return plural(d, "day");
}

/* ---------- Pieces ---------- */

const sectionTitle = "text-sm font-semibold uppercase tracking-wider text-muted";
const tile = "rounded-lg bg-track/50 px-3.5 py-2.5";
const outlineBtn = "rounded-lg border border-line bg-surface px-4 text-[15px] hover:bg-track/50";

function Tile({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={tile}>
      <div className="mb-1 text-sm text-muted">{label}</div>
      {children}
    </div>
  );
}

function ProjectCard({
  p,
  now,
  active,
  onSelect,
}: {
  p: Project;
  now: Date | null;
  active: boolean;
  onSelect: () => void;
}) {
  const status = projectStatus(p);
  const used = timeUsed(p);
  return (
    <button
      onClick={onSelect}
      aria-pressed={active}
      className={`w-full rounded-xl border px-4 py-3 text-left shadow-sm card-hover ${
        active ? "border-ink bg-accent/10" : "border-line bg-surface"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="pt-0.5 text-base font-bold">{p.name}</h3>
        <StatusBadge status={status} />
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-muted">
        <span className="inline-block rounded-full border border-line px-2 text-[12px] font-semibold leading-5 text-ink">{p.phase}</span>
        {p.priority !== "Medium" && <PriorityPill priority={p.priority} />}
        <span>
          {p.client && `${p.client} · `}
          {p.department} · {p.lead ? `Lead ${p.lead}` : "No lead"}
        </span>
      </p>
      <div className="mt-2.5">
        <ProgressBar done={p.done} time={used} status={status} />
      </div>
      <div className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-[13px] text-muted">
        <span>
          {p.done}% done{status !== "not-started" && ` · ${used}% of time used`}
        </span>
        <span suppressHydrationWarning>{now && (p.endDate ? `Due ${longDate(isoToLocalDate(p.endDate))}` : "No deadline")}</span>
      </div>
    </button>
  );
}

function Timeline({ list, now, onSelect }: { list: Project[]; now: Date | null; onSelect: (id: string) => void }) {
  if (!now) return null;
  // Projects without both dates have no bar; they are listed with a note instead.
  const from = Math.min(0, ...list.flatMap((p) => (p.startOffset === null ? [] : [p.startOffset])));
  const to = Math.max(0, ...list.flatMap((p) => (p.endOffset === null ? [] : [p.endOffset])));
  const first = addDays(now, from);
  const start = new Date(first.getFullYear(), first.getMonth(), 1);
  const lastDay = addDays(now, to);
  const end = new Date(lastDay.getFullYear(), lastDay.getMonth() + 1, 1);
  const span = end.getTime() - start.getTime();
  const pos = (d: Date) => ((d.getTime() - start.getTime()) / span) * 100;

  const months: Date[] = [];
  for (let m = new Date(start); m < end; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(m);
  const todayPos = pos(addDays(now, 0));

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      <div className="overflow-x-auto">
        <div className="min-w-[760px]">
          <div className="grid grid-cols-[15rem_minmax(0,1fr)] border-b border-line pb-2 text-sm text-muted">
            <span>Project</span>
            <div className="relative h-5">
              {months.map((m) => (
                <span key={m.getTime()} className="absolute top-0 border-l border-line pl-1.5" style={{ left: `${pos(m)}%` }}>
                  {m.toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}
                </span>
              ))}
            </div>
          </div>
          <ul>
            {list.map((p) => {
              const status = projectStatus(p);
              const dated = p.startOffset !== null && p.endOffset !== null;
              const left = dated ? pos(addDays(now, p.startOffset!)) : 0;
              const width = dated ? pos(addDays(now, p.endOffset!)) - left : 0;
              return (
                <li key={p.id}>
                  <button
                    onClick={() => onSelect(p.id)}
                    className="grid w-full grid-cols-[15rem_minmax(0,1fr)] items-center border-b border-line py-4 text-left hover:bg-track/30"
                  >
                    <span className="pr-4">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="text-sm text-muted">{p.lead || "No lead"}</span>
                    </span>
                    <span className="relative block h-8">
                      {months.map((m) => (
                        <span key={m.getTime()} className="absolute inset-y-0 border-l border-line/60" style={{ left: `${pos(m)}%` }} />
                      ))}
                      {dated ? (
                        <span
                          className="absolute top-1 h-6 overflow-hidden rounded-md bg-track"
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`${p.done}% done`}
                        >
                          <span className={`block h-full ${barColor(status)}`} style={{ width: `${p.done}%` }} />
                        </span>
                      ) : (
                        <span className="absolute left-2 top-1.5 text-sm text-muted">No dates set</span>
                      )}
                      <span className="absolute -top-1 bottom-[-0.25rem] w-0.5 bg-ink" style={{ left: `${todayPos}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-muted">Filled part: work completed. Dark line: today.</p>
        </div>
      </div>
    </section>
  );
}

const NEW_PROJECT_STATUSES: ProjectPhase[] = ["Planning", "Not Started", "In Progress", "Under Testing", "On Hold", "No Updates", "Completed", "Cancelled"];
const DESCRIPTION_MAX = 5000; // matches the backend's PROJECT_DESCRIPTION_MAX

type NewProjectField = "name" | "client" | "department" | "lead" | "start" | "end" | "description";
// Server field names -> form fields, so API validation messages land next to the right input.
const SERVER_FIELDS: Record<string, NewProjectField> = {
  name: "name",
  client: "client",
  department: "department",
  lead_id: "lead",
  start_date: "start",
  end_date: "end",
  description: "description",
};

const leadIdOf = (p: Project) => {
  const id = team.find((m) => m.name === p.lead)?.id;
  return id === undefined ? "" : String(id);
};

/** Creates a project, or edits `project` when given (then only the changed fields are sent, in one request). */
function ProjectDialog({
  project,
  onSaved,
  onDeleted,
  onClose,
}: {
  project?: Project;
  onSaved: (id: string) => void;
  onDeleted?: () => void;
  onClose: () => void;
}) {
  const editing = !!project;
  const [name, setName] = useState(project?.name ?? "");
  const [client, setClient] = useState(project?.client ?? "");
  const [department, setDepartment] = useState(project?.department ?? "");
  const [lead, setLead] = useState(project ? leadIdOf(project) : ""); // member id
  const [start, setStart] = useState(project?.startDate ?? "");
  const [startTyped, setStartTyped] = useState(false); // text entered but not a valid date
  const [end, setEnd] = useState(project?.endDate ?? "");
  const [endTyped, setEndTyped] = useState(false);
  const [status, setStatus] = useState<ProjectPhase>(project?.phase ?? "Planning");
  const [priority, setPriority] = useState<ProjectPriority>(project?.priority ?? "Medium");
  const [description, setDescription] = useState(project?.description ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<NewProjectField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [serverFields, setServerFields] = useState<Partial<Record<NewProjectField, string>>>({});

  const clean = (s: string) => s.trim().replace(/\s+/g, " ");
  const departmentOptions = departments.map((d) => ({ value: d, label: d }));
  // Inactive people are not offered as leads; people on leave are, but marked.
  const leadOptions = team
    .filter((m) => m.id !== undefined && (m.status !== "inactive" || (project && m.name === project.lead)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => ({ value: String(m.id), label: m.name, hint: m.status === "on_leave" ? "On leave" : m.title }));
  const duplicate = projects.find((p) => p.id !== project?.id && p.name.toLowerCase() === clean(name).toLowerCase());
  // Every status is offered when editing (At Risk is set on running projects); new projects start from the short list.
  const statusOptions = editing ? PHASES : NEW_PROJECT_STATUSES;

  const problems: Partial<Record<NewProjectField, string>> = {
    name: !clean(name) ? "Enter a project name." : "",
    client: "", // optional
    department: !clean(department) ? "Select a domain." : "",
    lead: "", // optional
    start: startTyped ? "Enter the start date as dd-mm-yyyy." : "", // optional
    end: endTyped
      ? "Enter the deadline as dd-mm-yyyy."
      : start && end && end <= start
          ? "The deadline must be after the start date."
          : "",
    description: description.length > DESCRIPTION_MAX ? `Keep the description under ${DESCRIPTION_MAX} characters.` : "",
  };
  const order: NewProjectField[] = ["name", "client", "department", "lead", "start", "end", "description"];
  const firstProblem = order.find((f) => problems[f]);
  const errorFor = (f: NewProjectField) => serverFields[f] || ((attempted || touched[f]) && problems[f]) || "";
  const touch = (f: NewProjectField) => setTouched((t) => ({ ...t, [f]: true }));
  const edited = (f: NewProjectField) => setServerFields((s) => (s[f] ? { ...s, [f]: "" } : s));
  // What the form would save, compared with the stored project when editing.
  const values = {
    name: clean(name),
    client: clean(client),
    department: clean(department),
    lead_id: lead,
    start_date: start,
    end_date: end,
    phase: status,
    priority,
    description: description.trim(),
  };
  const stored: Partial<typeof values> = project
    ? {
        name: project.name,
        client: project.client,
        department: project.department,
        lead_id: leadIdOf(project),
        start_date: project.startDate ?? "",
        end_date: project.endDate ?? "",
        phase: project.phase,
        priority: project.priority,
        description: project.description,
      }
    : {};
  const changed = (Object.keys(values) as (keyof typeof values)[]).filter((k) => values[k] !== stored[k]);
  const dirty = editing ? changed.length > 0 || startTyped || endTyped : !!(name || client || department || lead || start || end || description);
  const openTasks = project ? tasks.filter((t) => t.projectId === project.id && t.state !== "done").length : 0;

  const close = () => {
    if (saving || deleting) return;
    if (dirty && !window.confirm(editing ? "Discard your unsaved changes?" : "Discard this new project?")) return;
    onClose();
  };

  const closeConfirm = useCallback(() => setConfirmDelete(false), []);

  const remove = async () => {
    if (!project || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await mutate(() => api.deleteProject(numericId(project.id)), SCOPES.newProject);
      onDeleted?.();
    } catch (err) {
      setDeleteError(errorMessage(err)); // a 409 says how many tasks still need to go first
      setDeleting(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (saving || deleting || (editing && !dirty)) return;
    if (firstProblem) {
      document.getElementById(`np-${firstProblem}`)?.focus();
      return;
    }
    setSaving(true);
    setServerError("");
    setServerFields({});
    try {
      if (project) {
        // Only what changed is sent; the server applies it in one step and logs each change in the history.
        const patch = Object.fromEntries(
          changed.map((k) => [k, k === "lead_id" ? (values.lead_id ? Number(values.lead_id) : null) : (k === "start_date" || k === "end_date") ? values[k] || null : values[k]]),
        ) as ProjectPatch;
        await mutate(() => api.updateProject(numericId(project.id), patch), SCOPES.projectEdit);
        onSaved(project.id);
        return;
      }
      // The server adds the lead (if any) to the team and writes the first history entry.
      const created = await mutate(
        () =>
          api.createProject({
            name: clean(name),
            client: clean(client),
            department: clean(department),
            lead_id: lead ? Number(lead) : null,
            start_date: start || null,
            end_date: end || null,
            phase: status,
            priority,
            description: description.trim(),
          }),
        SCOPES.newProject,
      );
      onSaved(String(created.id));
    } catch (err) {
      const fields = err instanceof ApiError ? err.fields : {};
      const mapped: Partial<Record<NewProjectField, string>> = {};
      for (const [k, msgs] of Object.entries(fields)) if (SERVER_FIELDS[k]) mapped[SERVER_FIELDS[k]] = msgs[0];
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
  const invalidCls = (f: NewProjectField) => (errorFor(f) ? "border-st-red! focus:ring-st-red/20!" : "");
  const a11y = (f: NewProjectField) => ({
    invalid: !!errorFor(f),
    describedBy: errorFor(f) ? `np-${f}-error` : undefined,
    onBlur: () => touch(f),
  });
  const err = (f: NewProjectField) => <FieldMessage id={`np-${f}-error`} message={errorFor(f)} />;

  return (
    <Modal
      title={editing ? "Edit Project" : "New Project"}
      onClose={close}
      wide
      footer={
        <>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setDeleteError("");
                setConfirmDelete(true);
              }}
              disabled={saving || deleting}
              className="mr-auto h-10 rounded-lg px-3 text-[15px] font-medium text-st-red-strong hover:bg-st-red/8 disabled:opacity-50"
            >
              Delete project
            </button>
          )}
          {editing && (
            <span className="hidden self-center text-sm text-muted sm:inline" aria-live="polite">
              {dirty ? `${changed.length || 1} unsaved change${changed.length > 1 ? "s" : ""}` : "No changes yet"}
            </span>
          )}
          <button
            type="button"
            onClick={close}
            disabled={saving || deleting}
            className="h-10 rounded-lg border border-line bg-surface px-4 text-[15px] font-medium hover:bg-track/60 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="new-project-form"
            disabled={saving || deleting || (editing && !dirty)}
            className="h-10 rounded-lg bg-header px-5 text-[15px] font-semibold text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-st-blue/40 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
          >
            {editing ? (saving ? "Saving..." : "Save changes") : saving ? "Creating..." : "Create project"}
          </button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">
          Fields marked <span className="text-st-red-strong">*</span> are required.
        </p>

        <div>
          <label htmlFor="np-name" className={label}>
            Project Name{req}
          </label>
          <input
            id="np-name"
            autoFocus={!editing}
            autoComplete="off"
            maxLength={200}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              edited("name");
            }}
            onBlur={() => touch("name")}
            aria-required
            aria-invalid={!!errorFor("name")}
            aria-describedby={errorFor("name") ? "np-name-error" : undefined}
            placeholder="e.g. Employee Management System"
            className={`${control} w-full placeholder:text-muted ${invalidCls("name")}`}
          />
          {err("name")}
          {!errorFor("name") && duplicate && (
            <p className="mt-1 text-[13px] text-st-amber-strong">A project called {duplicate.name} already exists. You can still create this one.</p>
          )}
        </div>

        <div>
          <label htmlFor="np-client" className={label}>
            Client <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="np-client"
            autoComplete="off"
            maxLength={120}
            value={client}
            onChange={(e) => {
              setClient(e.target.value);
              edited("client");
            }}
            onBlur={() => touch("client")}
            aria-invalid={!!errorFor("client")}
            aria-describedby={errorFor("client") ? "np-client-error" : undefined}
            placeholder="Enter client name"
            className={`${control} w-full placeholder:text-muted ${invalidCls("client")}`}
          />
          {err("client")}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="np-department" className={label}>
              Domain{req}
            </label>
            <Combobox
              id="np-department"
              value={department}
              onChange={(v) => {
                setDepartment(v);
                edited("department");
              }}
              options={departmentOptions}
              placeholder="Select or type a domain"
              allowCreate
              {...a11y("department")}
            />
            {err("department")}
          </div>
          <div>
            <label htmlFor="np-lead" className={label}>
              Project Lead <span className="font-normal text-muted">(optional)</span>
            </label>
            <Combobox
              id="np-lead"
              value={lead}
              onChange={(v) => {
                setLead(v);
                edited("lead");
              }}
              options={leadOptions}
              placeholder="Select employee"
              clearable
              emptyText={team.length ? "No matching employee" : "Add employees in the Team tab first"}
              {...a11y("lead")}
            />
            {err("lead")}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="np-start" className={label}>
              Start Date <span className="font-normal text-muted">(optional)</span>
            </label>
            <DateField
              id="np-start"
              value={start}
              onChange={(iso, typed) => {
                setStart(iso);
                setStartTyped(typed);
                edited("start");
              }}
              {...a11y("start")}
            />
            {err("start")}
          </div>
          <div>
            <label htmlFor="np-end" className={label}>
              Deadline <span className="font-normal text-muted">(optional)</span>
            </label>
            <DateField
              id="np-end"
              value={end}
              min={start ? addDaysIso(start, 1) : undefined}
              onChange={(iso, typed) => {
                setEnd(iso);
                setEndTyped(typed);
                edited("end");
              }}
              {...a11y("end")}
            />
            {err("end")}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="np-status" className={label}>
              Project Status
            </label>
            <select
              id="np-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ProjectPhase)}
              className={`${control} w-full`}
            >
              {statusOptions.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="np-priority" className={label}>
              Priority
            </label>
            <select
              id="np-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as ProjectPriority)}
              className={`${control} w-full`}
            >
              {PROJECT_PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="np-description" className={label}>
              Description <span className="font-normal text-muted">(optional)</span>
            </label>
            {description.length > DESCRIPTION_MAX * 0.8 && (
              <span className={`text-xs ${description.length > DESCRIPTION_MAX ? "text-st-red-strong" : "text-muted"}`}>
                {description.length}/{DESCRIPTION_MAX}
              </span>
            )}
          </div>
          <textarea
            id="np-description"
            rows={4}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              edited("description");
            }}
            onBlur={() => touch("description")}
            aria-invalid={!!errorFor("description")}
            aria-describedby={errorFor("description") ? "np-description-error" : undefined}
            placeholder="Describe the project objectives and scope..."
            className={`w-full resize-y rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20 ${invalidCls("description")}`}
          />
          {err("description")}
        </div>

        {serverError && (
          <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
            {serverError}
          </p>
        )}
      </form>
      {confirmDelete && project && (
        <ConfirmDialog
          title="Delete project?"
          message={
            <>
              <p>
                <b className="text-ink">{project.name}</b> will be permanently deleted, along with its team list and objectives. This
                cannot be undone.
              </p>
              {openTasks > 0 && (
                <p className="mt-2 text-st-amber-strong">
                  It still has {openTasks} open task{openTasks === 1 ? "" : "s"}. Delete or finish them first, or the delete will be refused.
                </p>
              )}
            </>
          }
          confirmLabel="Delete project"
          busyLabel="Deleting..."
          busy={deleting}
          error={deleteError}
          onConfirm={remove}
          onCancel={closeConfirm}
        />
      )}
    </Modal>
  );
}

function FieldMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-[13px] font-medium text-st-red-strong">
      {message}
    </p>
  );
}

function ProjectDetail({
  p,
  now,
  onOpenTask,
  onAddTask,
  onEdit,
}: {
  p: Project;
  now: Date | null;
  onOpenTask: (id: string) => void;
  onAddTask: () => void;
  onEdit: () => void;
}) {
  const [objective, setObjective] = useState("");
  const candidates = team.filter((m) => !p.members.some((x) => x.name === m.name));
  const [newMember, setNewMember] = useState("");
  const [newRole, setNewRole] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // While dragging the slider or typing a decision, the new value lives here; the server gets it once, on release / blur.
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const [decisionDraft, setDecisionDraft] = useState<string | null>(null);
  const committing = useRef(false);
  const latestProgress = useRef<number | null>(null); // newest slider value, readable while a save is running
  const pid = numericId(p.id);
  const feed = useStore().histories[p.id];
  // The history is loaded lazily: only when this project's detail panel is open (first page, then "Load more").
  useEffect(() => {
    void loadProjectHistory(p.id);
  }, [p.id]);

  const progress = dragProgress ?? p.done;
  const live = progress === p.done ? p : { ...p, done: progress };
  const status = projectStatus(live);
  const used = timeUsed(live);
  const openWork = tasks.filter((t) => t.projectId === p.id && t.state !== "done").sort(byDue);
  const memberToAdd = newMember || candidates[0]?.name || "";

  /** Send one change to the server, refetch, and show the server's message if it was refused. */
  const run = async (write: () => Promise<unknown>, scope: readonly Scope[] = SCOPES.projectEdit) => {
    setBusy(true);
    setError("");
    try {
      await mutate(write, scope);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // A further slider step made while a save is in flight is sent as soon as that save finishes, so no step is lost.
  const commitProgress = async () => {
    if (committing.current || latestProgress.current === null) return;
    committing.current = true;
    let sent = p.done;
    let ok = true;
    while (ok && latestProgress.current !== null && latestProgress.current !== sent) {
      const value = latestProgress.current;
      ok = await run(() => api.updateProject(pid, { progress: value }));
      if (ok) sent = value;
    }
    latestProgress.current = null;
    setDragProgress(null);
    committing.current = false;
  };

  const commitDecision = async () => {
    if (decisionDraft === null || committing.current) return;
    if (decisionDraft.trim() === (p.decision ?? "")) return setDecisionDraft(null);
    committing.current = true;
    if (await run(() => api.setDecision(pid, decisionDraft.trim()), SCOPES.decision)) setDecisionDraft(null);
    committing.current = false;
  };

  return (
    <article className="rounded-xl border border-line bg-surface p-5 shadow-sm">
      {error && (
        <p role="alert" className="mb-4 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold leading-tight tracking-tight">{p.name}</h2>
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-sm font-medium text-muted hover:bg-track hover:text-ink"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden>
                <path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8l-9.3 9.3a1 1 0 0 1-.46.26l-3.9 1a.75.75 0 0 1-.91-.91l1-3.9a1 1 0 0 1 .26-.46l9.5-9.1Z" />
              </svg>
              Edit
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.client && (
              <span className="inline-block rounded-full bg-track/70 px-2.5 py-0.5 text-sm text-muted">Client: {p.client}</span>
            )}
            <span className="inline-block rounded-full bg-track/70 px-2.5 py-0.5 text-sm text-muted">{p.department}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted">
            Priority
            <select
              value={p.priority}
              disabled={busy}
              onChange={(e) => void run(() => api.updateProject(pid, { priority: e.target.value as ProjectPriority }))}
              className={`${control} w-32`}
            >
              {PROJECT_PRIORITIES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted">
            Status
            <select
              value={p.phase}
              disabled={busy}
              onChange={(e) => void run(() => api.updateProject(pid, { phase: e.target.value }))}
              className={`${control} w-40`}
            >
              {PHASES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-4 rounded-lg bg-track/50 px-4 py-3.5">
        <StatusBadge status={status} />
        <ul className="mt-2 list-disc space-y-0.5 pl-6 text-[15px]">
          {healthPoints(live).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile label="Project lead">
          <select
            value={p.lead}
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value;
              void run(() => api.updateProject(pid, { lead_id: next ? memberId(next) : null }));
            }}
            className={`${control} w-full`}
          >
            <option value="">No lead</option>
            {team.map((m) => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
        </Tile>
        <Tile label="Start date">
          <input
            type="date"
            value={p.startDate ?? ""}
            max={p.endDate ? addDaysIso(p.endDate, -1) : undefined}
            onChange={(e) => void run(() => api.updateProject(pid, { start_date: e.target.value || null }))}
            className={`${control} w-full`}
          />
        </Tile>
        <Tile label="Deadline">
          <input
            type="date"
            value={p.endDate ?? ""}
            min={p.startDate ? addDaysIso(p.startDate, 1) : undefined}
            onChange={(e) => void run(() => api.updateProject(pid, { end_date: e.target.value || null }))}
            className={`${control} w-full`}
          />
        </Tile>
        <Tile label="Time left">
          <div className="text-[15px]">{timeLeft(p)}</div>
        </Tile>
        <Tile label="Team size">
          <div className="text-[15px]">{p.members.length} {p.members.length === 1 ? "person" : "people"}</div>
        </Tile>
        <Tile
          label={
            <>
              Progress: <b className="text-st-blue">{progress}%</b>
            </>
          }
        >
          <input
            type="range"
            min={0}
            max={100}
            value={progress}
            aria-label="Progress"
            onChange={(e) => {
              latestProgress.current = Number(e.target.value);
              setDragProgress(latestProgress.current);
            }}
            onPointerUp={() => void commitProgress()}
            onKeyUp={() => void commitProgress()}
            className="mt-1 w-full accent-st-blue"
          />
        </Tile>
      </div>

      <div className="mt-5">
        <ProgressBar done={progress} time={used} status={status} />
        <p className="mt-2 text-muted">Bar: work completed. Tick: where the project should be today.</p>
      </div>

      <label className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="whitespace-nowrap text-[15px] text-muted">Needs your decision</span>
        <input
          value={decisionDraft ?? p.decision ?? ""}
          placeholder="Nothing needed right now"
          onChange={(e) => setDecisionDraft(e.target.value)}
          onBlur={() => void commitDecision()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          className={`${control} min-w-[12rem] flex-1 placeholder:text-muted`}
        />
      </label>

      <h3 className={`${sectionTitle} mt-6`}>Description</h3>
      <p className="mt-2 text-[15px] leading-relaxed">{p.description || <span className="text-muted">No description yet.</span>}</p>

      <h3 className={`${sectionTitle} mt-6`}>Key objectives</h3>
      <ul className="mt-2 list-disc space-y-1.5 pl-6 text-[15px]">
        {p.objectives.map((o, i) => (
          <li key={i}>{o}</li>
        ))}
        {p.objectives.length === 0 && <li className="list-none text-muted">No objectives yet.</li>}
      </ul>
      <form
        className="mt-3 flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!objective.trim() || busy) return;
          void run(() => api.addObjective(pid, objective.trim()), SCOPES.objective).then((ok) => ok && setObjective(""));
        }}
      >
        <input
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Add an objective"
          aria-label="New objective"
          className={`${control} min-w-0 flex-1 placeholder:text-muted`}
        />
        <button type="submit" disabled={busy} className={`${outlineBtn} disabled:cursor-not-allowed disabled:opacity-60`}>
          Add
        </button>
      </form>

      <h3 className={`${sectionTitle} mt-6`}>Team and roles</h3>
      <ul className="mt-1 divide-y divide-line border-b border-line">
        {p.members.map((m) => (
          <li key={m.name} className="flex items-center justify-between gap-4 py-2.5 text-[15px]">
            <span>{m.name}</span>
            <span className="flex items-center gap-3 text-muted">
              {m.role}
              {m.name !== p.lead && (
                <button
                  onClick={() => void run(() => api.removeProjectMember(pid, m.memberId ?? memberId(m.name)), SCOPES.projectMember)}
                  disabled={busy}
                  aria-label={`Remove ${m.name}`}
                  className="rounded px-1 text-lg leading-none hover:bg-track hover:text-ink"
                >
                  ×
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {candidates.length > 0 && (
        <form
          className="mt-4 flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !memberToAdd) return;
            void run(() => api.addProjectMember(pid, { member_id: memberId(memberToAdd), role: newRole.trim() }), SCOPES.projectMember).then((ok) => {
              if (ok) {
                setNewMember("");
                setNewRole("");
              }
            });
          }}
        >
          <select value={memberToAdd} onChange={(e) => setNewMember(e.target.value)} aria-label="Person" className={`${control} min-w-[10rem] flex-1`}>
            {candidates.map((m) => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
          <input
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            placeholder="Role on this project"
            aria-label="Role"
            className={`${control} min-w-[10rem] flex-1 placeholder:text-muted`}
          />
          <button type="submit" disabled={busy} className={`${outlineBtn} h-10 disabled:cursor-not-allowed disabled:opacity-60`}>
            Add to team
          </button>
        </form>
      )}

      <div className="mt-6 flex items-center justify-between">
        <h3 className={sectionTitle}>Open work ({openWork.length})</h3>
        <button onClick={onAddTask} className={`${outlineBtn} py-1.5`}>
          Add task
        </button>
      </div>
      <ul className="mt-2 divide-y divide-line border-b border-line">
        {openWork.map((t) => {
          const g = taskGroup(t);
          const tone =
            g === "overdue"
              ? { dot: "bg-st-red", text: "text-st-red-strong" }
              : g === "today"
                ? { dot: "bg-st-orange", text: "text-st-orange-strong" }
                : { dot: "bg-st-blue", text: "text-st-blue" };
          return (
            <li key={t.id}>
              <button onClick={() => onOpenTask(t.id)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-track/30">
                <span className={`mt-2 h-2.5 w-2.5 shrink-0 self-start rounded-full ${tone.dot}`} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px]">{t.title}</span>
                  <span className="text-muted">
                    {t.owner}
                    {t.state === "blocked" && (
                      <>
                        {" · "}
                        <b className="text-ink">Blocked</b>
                        {t.note && `: ${t.note}`}
                      </>
                    )}
                  </span>
                </span>
                <span className={`whitespace-nowrap text-[15px] font-semibold ${tone.text}`}>{dueText(t)}</span>
              </button>
            </li>
          );
        })}
        {openWork.length === 0 && <li className="py-4 text-muted">No open tasks.</li>}
      </ul>

      <h3 className={`${sectionTitle} mt-6`}>History</h3>
      <ul className="mt-1 divide-y divide-line">
        {(!feed || feed.status === "loading") && <li className="py-3 text-muted">Loading history...</li>}
        {feed?.status === "ready" && p.history.length === 0 && <li className="py-3 text-muted">No history yet.</li>}
        {feed?.status === "error" && (
          <li role="alert" className="flex flex-wrap items-center justify-between gap-3 py-3 text-st-red-strong">
            <span>Could not load the history. {feed.error}</span>
            <button
              onClick={() => void loadProjectHistory(p.id)}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-track"
            >
              Retry
            </button>
          </li>
        )}
        {p.history.map((h) => (
          <li key={h.id} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
            <span className="text-muted" suppressHydrationWarning>
              {now ? agoLabel(minutesBetween(h.createdAt, nowMs())) : ""}
            </span>
            <span className="text-[15px]">{h.text}</span>
          </li>
        ))}
      </ul>
      {feed?.status === "ready" && p.history.length < feed.count && (
        <div className="mt-3">
          {feed.moreError && (
            <p role="alert" className="mb-2 rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
              {feed.moreError}
            </p>
          )}
          <button
            onClick={() => void loadMoreProjectHistory(p.id)}
            disabled={feed.moreLoading}
            className="rounded-lg border border-line bg-surface px-3.5 py-1.5 text-sm font-medium shadow-sm hover:bg-track disabled:cursor-wait disabled:opacity-60"
          >
            {feed.moreLoading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </article>
  );
}

/* ---------- View ---------- */

export function ProjectsView({
  onOpen,
  focusId = null,
}: {
  onOpen: (ref: OpenRef) => void;
  focusId?: string | null; // project to select when arriving from another tab
}) {
  const now = useNow();
  const [mode, setMode] = useState<"cards" | "timeline">("cards");
  const [sort, setSort] = useState<Sort>("attention");
  const [filter, setFilter] = useState<ProjectStatus | "all">("all");
  const [phase, setPhase] = useState<ProjectPhase | "all">("all");
  const [selected, setSelected] = useState<string | null>(focusId);
  const [creating, setCreating] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [notice, setNotice] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);

  // Arriving with a project chosen: on narrow screens the detail sits below the list, so scroll to it.
  useEffect(() => {
    if (focusId && window.innerWidth < 1180) detailRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [focusId]);

  // Card counts follow the Health dropdown, so each card's number is exactly what clicking it shows.
  const healthMatches = projects.filter((p) => filter === "all" || projectStatus(p) === filter);
  const list = healthMatches.filter((p) => phase === "all" || p.phase === phase).sort(sorters[sort]);
  const phaseCount = (s: ProjectPhase | "all") =>
    s === "all" ? healthMatches.length : healthMatches.filter((p) => p.phase === s).length;
  const filtered = filter !== "all" || phase !== "all";
  const clearFilters = () => {
    setFilter("all");
    setPhase("all");
  };
  const current = list.find((p) => p.id === selected) ?? list[0];

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 4000);
  };

  const select = (id: string) => {
    setSelected(id);
    setMode("cards");
    // On narrow screens the detail sits below the list, so bring it into view.
    if (window.innerWidth < 1180) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth" }), 0);
  };

  const toggleBtn = (m: "cards" | "timeline", label: string) => (
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight">Projects</h2>
          <p className="mt-1 text-muted">
            {plural(projects.length, "project")} across the company. Select one for the full picture.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className={`${control} w-52`}>
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as ProjectStatus | "all")}
            aria-label="Health"
            className={`${control} w-36`}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="View">
            {toggleBtn("cards", "Cards")}
            {toggleBtn("timeline", "Timeline")}
          </div>
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-header px-5 py-2 text-[15px] font-semibold text-white hover:opacity-90 dark:bg-accent dark:text-header"
          >
            New project
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 desk:grid-cols-6 xl:gap-4">
        {PHASE_CARDS.map((c) => (
          <PhaseCard
            key={c.value}
            card={c}
            count={phaseCount(c.value)}
            active={phase === c.value}
            // Clicking the selected card again goes back to all projects.
            onClick={() => setPhase(phase === c.value ? "all" : c.value)}
          />
        ))}
      </div>
      {filtered && (
        <p className="-mt-3 text-sm text-muted">
          Showing {list.length} of {projects.length}
          <button onClick={clearFilters} className="ml-2 font-semibold text-st-blue underline-offset-2 hover:underline">
            Clear filters
          </button>
        </p>
      )}

      {mode === "timeline" ? (
        <Timeline list={list} now={now} onSelect={select} />
      ) : list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-surface py-12 text-center text-muted">
          {projects.length === 0 ? "No projects yet. Use New project to create the first one." : "No projects match this filter."}
        </p>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 desk:grid-cols-[minmax(0,23rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,27rem)_minmax(0,1fr)]">
          <div className="space-y-3">
            {list.map((p) => (
              <ProjectCard key={p.id} p={p} now={now} active={p.id === current.id} onSelect={() => select(p.id)} />
            ))}
          </div>
          <div ref={detailRef} className="scroll-mt-4">
            <ProjectDetail
              key={current.id}
              p={current}
              now={now}
              onOpenTask={(id) => onOpen({ kind: "task", id })}
              onAddTask={() => setAddingTask(true)}
              onEdit={() => setEditingProject(current)}
            />
          </div>
        </div>
      )}

      {notice && (
        <p
          role="status"
          className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-header px-4 py-2.5 text-sm font-medium text-white shadow-lg dark:bg-accent dark:text-header"
        >
          {notice}
        </p>
      )}
      {editingProject && (
        <ProjectDialog
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSaved={() => {
            flash("Project updated.");
            setEditingProject(null);
          }}
          onDeleted={() => {
            flash(`${editingProject.name} was deleted.`);
            setEditingProject(null);
            setSelected(null);
          }}
        />
      )}
      {creating && (
        <ProjectDialog
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            clearFilters(); // so the new project is visible
            setSelected(id);
            setMode("cards");
          }}
        />
      )}
      {addingTask && current && (
        <Modal title={`New task for ${current.name}`} onClose={() => setAddingTask(false)} wide>
          <NewTaskForm key={current.id} defaultProjectId={current.id} onCreated={() => setAddingTask(false)} onCancel={() => setAddingTask(false)} />
        </Modal>
      )}
    </div>
  );
}
