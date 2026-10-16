"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  byDue,
  dateOffset,
  departments,
  EMPLOYMENT_TYPES,
  MEMBER_STATUSES,
  projects,
  STRETCHED_THRESHOLD,
  tasks,
  team,
  type EmploymentType,
  type Member,
  type MemberStatus,
  type Task,
} from "@/lib/data";
import { api, ApiError, errorMessage } from "@/lib/api";
import { mutate, numericId, SCOPES, serverToday } from "@/lib/store";
import type { OpenRef } from "./Overview";
import { control, dueText, taskGroup } from "./TasksView";
import { ConfirmDialog, MarkerIcon, Modal } from "./ui";

export type Show = "all" | "stretched" | "overdue" | "blocked";
type Sort = "stretched" | "tasks" | "name";

const SHOW: { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "stretched", label: "Stretched" },
  { value: "overdue", label: "Has overdue work" },
  { value: "blocked", label: "Has blocked work" },
];

const SORTS: { value: Sort; label: string }[] = [
  { value: "stretched", label: "Most stretched first" },
  { value: "tasks", label: "Most open tasks" },
  { value: "name", label: "Name A to Z" },
];

const sectionTitle = "text-[13px] font-semibold uppercase tracking-wide text-muted";

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

const STATUS_TONE: Record<MemberStatus, string> = {
  active: "border-st-green text-st-green",
  on_leave: "border-st-amber text-st-amber-strong",
  inactive: "border-st-slate text-st-slate",
};

const STATUS_DOT: Record<MemberStatus, string> = {
  active: "bg-st-green",
  on_leave: "bg-st-amber",
  inactive: "bg-st-slate",
};

const statusLabel = (s: MemberStatus) => MEMBER_STATUSES.find((x) => x.value === s)?.label ?? s;
const typeLabel = (t: EmploymentType) => EMPLOYMENT_TYPES.find((x) => x.value === t)?.label ?? t;

/** "Joined 3 Mar 2026" / "Starts 2 Nov 2026", from a YYYY-MM-DD date and the server's today. */
function startText(date: string) {
  const shown = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  return `${date > serverToday() ? "Starts" : "Joined"} ${shown}`;
}

/* Colour by how soon the task is due (a blocked task keeps its due-date colour and gets a pill). */
function dueTone(t: Task) {
  const d = dateOffset(t); // the deadline, or the work date when there is none
  if (d < 0) return { dot: "bg-st-red", text: "text-st-red-strong" };
  if (d === 0) return { dot: "bg-st-orange", text: "text-st-orange-strong" };
  if (d <= 2) return { dot: "bg-st-amber", text: "text-st-amber-strong" };
  if (d <= 7) return { dot: "bg-st-blue", text: "text-st-blue" };
  return { dot: "bg-st-slate", text: "text-st-slate" };
}

export function personInfo(m: Member) {
  const roles = projects.flatMap((p) =>
    p.members.filter((x) => x.name === m.name).map((x) => ({ project: p.name, projectId: p.id, role: x.role })),
  );
  const work = tasks.filter((t) => t.owner === m.name && t.state !== "done").sort(byDue);
  const overdue = work.filter((t) => taskGroup(t) === "overdue").length;
  const blocked = work.filter((t) => t.state === "blocked").length;
  const leads = projects.filter((p) => p.lead === m.name).length;
  return { roles, work, overdue, blocked, leads, stretched: m.load > STRETCHED_THRESHOLD };
}

type Info = ReturnType<typeof personInfo>;

export function whyText(m: Member, i: Info) {
  const parts: string[] = [];
  if (i.leads > 1) parts.push(`leads ${i.leads} projects`);
  if (i.overdue) parts.push(i.overdue === 1 ? "has an overdue task" : `has ${i.overdue} overdue tasks`);
  if (i.blocked) parts.push(i.blocked === 1 ? "has a blocked task" : `has ${i.blocked} blocked tasks`);
  if (parts.length === 0) parts.push(`is at ${m.load}% of capacity`);
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function Stat({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-track/50 px-3 py-2">
      <div className={`text-lg font-bold leading-tight ${alert ? "text-st-red-strong" : ""}`}>{value}</div>
      <div className="truncate text-sm text-muted">{label}</div>
    </div>
  );
}

function Capacity({ load }: { load: number }) {
  const color = load > STRETCHED_THRESHOLD ? "bg-st-orange" : load >= 90 ? "bg-st-amber" : "bg-st-green";
  return (
    <div className="mt-4">
      <div className="mb-1.5 flex justify-between text-sm">
        <span className="text-muted">Capacity</span>
        <span className={`font-semibold ${load > STRETCHED_THRESHOLD ? "text-st-orange-strong" : ""}`}>{load}%</span>
      </div>
      <div
        className="h-1.5 rounded-full bg-track"
        role="meter"
        aria-label="Capacity used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={load}
      >
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(load, 100)}%` }} />
      </div>
    </div>
  );
}

function PersonCard({
  m,
  info,
  onOpen,
  onEdit,
  highlight = false,
}: {
  m: Member;
  info: Info;
  onOpen: (ref: OpenRef) => void;
  onEdit?: () => void;
  highlight?: boolean;
}) {
  return (
    <article
      id={personId(m.name)}
      className={`flex h-full scroll-mt-6 flex-col rounded-xl border bg-surface p-5 shadow-sm transition-shadow duration-150 hover:shadow-md ${
        highlight ? "border-st-green ring-2 ring-st-green/30" : "border-line"
      }`}
    >
      <header className="flex items-start gap-3.5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-header text-sm font-semibold text-white dark:bg-accent dark:text-header">
          {initials(m.name)}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="font-bold leading-snug">{m.name}</h3>
          <p className="text-sm text-muted">
            {m.title} · {m.role}
          </p>
        </div>
        {m.status && m.status !== "active" && (
          <span
            className={`mt-1.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium ${STATUS_TONE[m.status]}`}
          >
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[m.status]}`} aria-hidden />
            {statusLabel(m.status)}
          </span>
        )}
        {info.stretched && (
          <span className="mt-1.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-sm font-medium">
            <MarkerIcon marker="triangle-amber" />
            Stretched
          </span>
        )}
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${m.name}`}
            title="Edit details"
            className="-mr-1.5 mt-0.5 shrink-0 rounded-md p-1.5 text-muted hover:bg-track hover:text-ink"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5" aria-hidden>
              <path d="M13.6 2.6a2 2 0 0 1 2.8 0l1 1a2 2 0 0 1 0 2.8l-9.3 9.3a1 1 0 0 1-.46.26l-3.9 1a.75.75 0 0 1-.91-.91l1-3.9a1 1 0 0 1 .26-.46l9.5-9.1Z" />
            </svg>
          </button>
        )}
      </header>

      {(m.email || m.phone || m.employmentType || m.startDate) && (
        <dl className="mt-3 space-y-1 text-sm">
          {m.email && (
            <div className="flex gap-2">
              <dt className="sr-only">Email</dt>
              <dd className="min-w-0 truncate">
                <a href={`mailto:${m.email}`} className="text-st-blue hover:underline">
                  {m.email}
                </a>
              </dd>
            </div>
          )}
          {m.phone && (
            <div className="flex gap-2">
              <dt className="sr-only">Phone</dt>
              <dd>
                <a href={`tel:${m.phone.replace(/[^\d+]/g, "")}`} className="hover:text-st-blue">
                  {m.phone}
                </a>
              </dd>
            </div>
          )}
          {(m.employmentType || m.startDate) && (
            <div className="flex gap-2 text-muted">
              <dt className="sr-only">Employment</dt>
              <dd>{[m.employmentType && typeLabel(m.employmentType), m.startDate && startText(m.startDate)].filter(Boolean).join(" · ")}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2.5">
        <Stat value={info.work.length} label="Open tasks" />
        <Stat value={info.overdue} label="Overdue" alert={info.overdue > 0} />
        <Stat value={info.roles.length} label="Projects" />
      </div>

      <Capacity load={m.load} />

      {info.stretched && (
        <p className="mt-3 rounded-lg bg-track/50 px-3.5 py-2.5 text-sm">
          <b>Why:</b> {whyText(m, info)}
        </p>
      )}

      <h4 className={`${sectionTitle} mt-5`}>Projects and role</h4>
      {info.roles.length ? (
        <ul className="mt-1 divide-y divide-line border-b border-line">
          {info.roles.map((r) => (
            <li key={r.projectId}>
              <button
                onClick={() => onOpen({ kind: "project", id: r.projectId })}
                className="flex w-full justify-between gap-4 py-2.5 text-left text-[15px] hover:text-st-blue"
              >
                <span>{r.project}</span>
                <span className="text-right text-muted">{r.role}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Not on any project yet.</p>
      )}

      <h4 className={`${sectionTitle} mt-5`}>Current work ({info.work.length})</h4>
      {info.work.length ? (
        <ul className="mt-1 divide-y divide-line">
          {info.work.map((t) => {
            const tone = dueTone(t);
            return (
              <li key={t.id}>
                <button
                  onClick={() => onOpen({ kind: "task", id: t.id })}
                  className="group flex w-full items-center gap-2.5 py-2.5 text-left"
                >
                  <span className={`mt-[7px] h-2 w-2 shrink-0 self-start rounded-full ${tone.dot}`} aria-hidden />
                  <span className="min-w-0 flex-1 text-[15px] group-hover:text-st-blue">
                    {t.title}
                    {t.state === "blocked" && (
                      <span className="mt-1 block w-fit rounded-full border border-st-purple px-2 text-[13px] font-medium leading-5 text-st-purple">
                        Blocked
                      </span>
                    )}
                  </span>
                  <span className={`whitespace-nowrap text-[15px] font-semibold ${tone.text}`}>{dueText(t)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">No open tasks.</p>
      )}
    </article>
  );
}

const MAX_LOAD = 200;
const personId = (name: string) => `person-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// Common misspellings of public mail domains, so "gmial.com" gets a "Did you mean" hint.
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "yahooo.com": "yahoo.com",
  "yaho.com": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "outlok.com": "outlook.com",
  "outloo.com": "outlook.com",
};

const phoneDigits = (s: string) => s.replace(/\D/g, "").length;
const phoneProblem = (s: string) =>
  s && (!/^\+?[0-9 ()\-.]+$/.test(s) || phoneDigits(s) < 7 || phoneDigits(s) > 15)
    ? "Enter 7 to 15 digits, optionally starting with +."
    : "";

/** The email domain most of the team already uses, used to suggest an address for a new person. */
function teamDomain() {
  const counts = new Map<string, number>();
  for (const m of team) {
    const d = m.email?.split("@")[1];
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function suggestEmail(name: string, domain: string) {
  const parts = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(" ")
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  if (!parts.length || !domain) return "";
  return `${parts.length > 1 ? `${parts[0]}.${parts.at(-1)}` : parts[0]}@${domain}`;
}

const STATUS_HELP: Record<MemberStatus, string> = {
  active: "Working and available for assignments.",
  on_leave: "Temporarily away. Stays on the team but should not get new work.",
  inactive: "No longer working on projects. Kept for history.",
};

type Field = "name" | "email" | "phone" | "title" | "department" | "start_date" | "load";

function Req() {
  return (
    <span className="text-st-red-strong" aria-hidden>
      {" "}
      *
    </span>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className="text-[13px] font-medium text-st-red-strong">
      {message}
    </span>
  );
}

/** The person's current project roles (projectId -> role), read from the loaded projects. */
function currentRoles(m: Member): Record<string, string> {
  return Object.fromEntries(
    projects.flatMap((p) =>
      p.members.filter((x) => (m.id !== undefined && x.memberId === m.id) || x.name === m.name).map((x) => [p.id, x.role]),
    ),
  );
}

const sameRoles = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k]?.trim() === v.trim());

/** Adds a new person, or edits `member` when given (then only the changed fields are sent). */
function EmployeeForm({
  member,
  onSaved,
  onRemoved,
  onCancel,
  onDirtyChange,
}: {
  member?: Member;
  onSaved: (name: string) => void;
  onRemoved?: (name: string) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const editing = !!member;
  const [initialRoles] = useState(() => (member ? currentRoles(member) : {}));
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [emailEdited, setEmailEdited] = useState(editing); // stop auto-suggesting once the user types their own
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [title, setTitle] = useState(member?.title ?? "");
  const [department, setDepartment] = useState(member?.role ?? "");
  const [employmentType, setEmploymentType] = useState<EmploymentType>(member?.employmentType ?? "full_time");
  const [startDate, setStartDate] = useState(() => (member ? (member.startDate ?? "") : serverToday()));
  const [status, setStatus] = useState<MemberStatus>(member?.status ?? "active");
  const [load, setLoad] = useState(member?.load ?? 60);
  const [roles, setRoles] = useState<Record<string, string>>(initialRoles); // projectId -> role
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const closeConfirm = useCallback(() => setConfirmRemove(false), []);
  const [removing, setRemoving] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState("");
  const [serverFields, setServerFields] = useState<Partial<Record<Field, string>>>({});

  const clean = name.trim().replace(/\s+/g, " ");
  const domain = teamDomain();
  const suggested = suggestEmail(clean, domain);
  const mail = (emailEdited ? email : suggested).trim().toLowerCase();
  const mailDomain = mail.split("@")[1] ?? "";
  const typoFix = DOMAIN_TYPOS[mailDomain];
  const others = team.filter((m) => !member || (member.id !== undefined ? m.id !== member.id : m.name !== member.name));
  const emailOwner = mail ? others.find((m) => m.email?.toLowerCase() === mail) : undefined;
  const titles = [...new Set(team.map((m) => m.title).filter(Boolean))].sort();
  const projectRoles = [...new Set(projects.flatMap((p) => p.members.map((m) => m.role)))].sort();

  const problems: Partial<Record<Field, string>> = {
    name: !clean
      ? "Enter the employee's full name."
      : others.some((m) => m.name.toLowerCase() === clean.toLowerCase())
        ? `${clean} is already on the team.`
        : "",
    // People added before emails were recorded can still be edited without one.
    email: !mail
      ? editing && !member.email
        ? ""
        : "Enter a work email address."
      : !EMAIL_RE.test(mail)
        ? "Enter a valid email address, e.g. name@company.com."
        : emailOwner
          ? `${mail} is already used by ${emailOwner.name}.`
          : "",
    phone: phoneProblem(phone.trim()),
    title: !title.trim() ? "Enter a job title." : "",
    department: !department.trim() ? "Choose or type a department." : "",
    start_date: !startDate ? "Enter a start date." : "",
    load: !Number.isFinite(load) || load < 0 || load > MAX_LOAD ? `Capacity must be between 0 and ${MAX_LOAD}%.` : "",
  };
  const firstProblem = (Object.keys(problems) as Field[]).find((f) => problems[f]);
  const errorFor = (f: Field) => serverFields[f] || ((attempted || touched[f]) && problems[f]) || "";
  const touch = (f: Field) => setTouched((t) => ({ ...t, [f]: true }));
  const edited = (f: Field) => setServerFields((s) => (s[f] ? { ...s, [f]: "" } : s));

  // What the form would save, and (when editing) which fields differ from the stored person.
  const values = {
    name: clean,
    email: mail,
    phone: phone.trim().replace(/\s+/g, " "),
    title: title.trim().replace(/\s+/g, " "),
    department: department.trim().replace(/\s+/g, " "),
    employment_type: employmentType,
    start_date: startDate || null,
    status,
    load: Math.round(load),
  };
  const stored: Partial<typeof values> = member
    ? {
        name: member.name,
        email: member.email ?? "",
        phone: member.phone ?? "",
        title: member.title,
        department: member.role,
        employment_type: member.employmentType ?? "full_time",
        start_date: member.startDate ?? null,
        status: member.status ?? "active",
        load: member.load,
      }
    : {};
  const changed = (Object.keys(values) as (keyof typeof values)[]).filter((k) => values[k] !== stored[k]);
  const rolesChanged = !sameRoles(initialRoles, roles);
  const changeCount = changed.length + (rolesChanged ? 1 : 0);
  const dirty = editing ? changeCount > 0 : !!(clean || phone || title || department || Object.keys(roles).length);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const memberInfo = member ? personInfo(member) : null;
  const ledIds = new Set(member ? projects.filter((p) => p.lead === member.name).map((p) => p.id) : []);
  const openWork = memberInfo?.work.length ?? 0;
  const statusWarning =
    member && status !== "active" && (member.status ?? "active") === "active" && (openWork || ledIds.size)
      ? `${member.name.split(" ")[0]} still ${[
          openWork && `owns ${openWork} open task${openWork === 1 ? "" : "s"}`,
          ledIds.size && `leads ${ledIds.size} project${ledIds.size === 1 ? "" : "s"}`,
        ]
          .filter(Boolean)
          .join(" and ")}. Consider reassigning that work.`
      : "";

  const toggleProject = (id: string, on: boolean) =>
    setRoles((r) => {
      const next = { ...r };
      if (on) next[id] = initialRoles[id] ?? "Team Member";
      else delete next[id];
      return next;
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (saving || removing || (editing && !dirty)) return;
    if (firstProblem) {
      document.getElementById(`new-${firstProblem}`)?.focus();
      return;
    }
    setSaving(true);
    setServerError("");
    setServerFields({});
    try {
      const memberships = Object.entries(roles).map(([projectId, role]) => ({ project_id: numericId(projectId), role: role.trim() }));
      if (member?.id !== undefined) {
        // Only the changed fields go to the server; it applies them and the project changes in one transaction.
        const patch = { ...Object.fromEntries(changed.map((k) => [k, values[k]])), ...(rolesChanged ? { memberships } : {}) };
        // A rename shows up on tasks, daily updates and decisions too, so refresh everything then.
        await mutate(() => api.updateMember(member.id!, patch), changed.includes("name") ? undefined : SCOPES.employeeEdit);
      } else {
        // The server creates the person, their project memberships and the activity entries in one step.
        await mutate(() => api.createMember({ ...values, memberships }), SCOPES.newEmployee);
      }
      onSaved(clean);
    } catch (err) {
      // Put field-level messages from the server next to the field they belong to.
      const fields = err instanceof ApiError ? err.fields : {};
      const mapped = Object.fromEntries(
        Object.entries(fields)
          .filter(([f]) => f !== "memberships" && f !== "status" && f !== "employment_type")
          .map(([f, msgs]) => [f, msgs[0]]),
      );
      setServerFields(mapped);
      setServerError(
        fields.memberships?.join(" ") || (Object.keys(mapped).length ? "Please fix the highlighted fields." : errorMessage(err)),
      );
      setSaving(false);
    }
  };

  const remove = async () => {
    if (member?.id === undefined || removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await mutate(() => api.deleteMember(member.id!), SCOPES.employeeEdit);
      onRemoved?.(member.name);
    } catch (err) {
      // A 409 explains what they still lead or own.
      setRemoveError(errorMessage(err));
      setRemoving(false);
    }
  };

  const field = "flex flex-col gap-1.5 text-sm font-semibold";
  const input = (f: Field) =>
    `${control} font-normal ${errorFor(f) ? "border-st-red! focus:ring-st-red/20!" : ""}`;
  const aria = (f: Field) => ({
    id: `new-${f}`,
    "aria-invalid": !!errorFor(f),
    "aria-describedby": errorFor(f) ? `new-${f}-error` : undefined,
    onBlur: () => touch(f),
  });
  const color = load > STRETCHED_THRESHOLD ? "bg-st-orange" : load >= 90 ? "bg-st-amber" : "bg-st-green";
  const pq = projectQuery.trim().toLowerCase();
  const shownProjects = projects.filter((p) => !pq || p.id in roles || p.name.toLowerCase().includes(pq));
  const picked = Object.keys(roles).length;

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <fieldset className="space-y-4">
        <legend className={`${sectionTitle} mb-3`}>Identity and contact</legend>
        <label className={field}>
          <span>
            Full name
            <Req />
          </span>
          <input
            required
            autoFocus={!editing}
            autoComplete="off"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              edited("name");
            }}
            className={input("name")}
            placeholder="e.g. Kavya Menon"
            {...aria("name")}
          />
          <FieldError id="new-name-error" message={errorFor("name")} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={field}>
            <label htmlFor="new-email">
              Work email
              <Req />
            </label>
            <input
              type="email"
              required
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              value={emailEdited ? email : suggested}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailEdited(true);
                edited("email");
              }}
              className={input("email")}
              placeholder={domain ? `name@${domain}` : "name@company.com"}
              {...aria("email")}
            />
            <FieldError id="new-email-error" message={errorFor("email")} />
            {typoFix && !errorFor("email") && (
              <button
                type="button"
                onClick={() => {
                  setEmail(`${mail.split("@")[0]}@${typoFix}`);
                  setEmailEdited(true);
                }}
                className="w-fit text-left text-[13px] font-medium text-st-blue hover:underline"
              >
                Did you mean {mail.split("@")[0]}@{typoFix}?
              </button>
            )}
            {!emailEdited && suggested && !errorFor("email") && (
              <span className="text-[13px] font-normal text-muted">Suggested from the name and the team&apos;s domain. Edit if needed.</span>
            )}
            {editing && !mail && suggested && (
              <button
                type="button"
                onClick={() => setEmail(suggested)}
                className="w-fit text-left text-[13px] font-medium text-st-blue hover:underline"
              >
                No email on record. Use {suggested}?
              </button>
            )}
          </div>
          <div className={field}>
            <label htmlFor="new-phone">
              Phone <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => {
                setPhone(e.target.value);
                edited("phone");
              }}
              className={input("phone")}
              placeholder="e.g. +91 98450 12345"
              {...aria("phone")}
            />
            <FieldError id="new-phone-error" message={errorFor("phone")} />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={`${sectionTitle} mb-3`}>Role and employment</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={field}>
            <span>
              Job title
              <Req />
            </span>
            <input
              required
              list="titles"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                edited("title");
              }}
              className={input("title")}
              placeholder="e.g. Business Analyst"
              {...aria("title")}
            />
            <datalist id="titles">
              {titles.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <FieldError id="new-title-error" message={errorFor("title")} />
          </label>
          <label className={field}>
            <span>
              Department
              <Req />
            </span>
            <input
              required
              list="departments"
              value={department}
              onChange={(e) => {
                setDepartment(e.target.value);
                edited("department");
              }}
              className={input("department")}
              placeholder="Pick or type a new one"
              {...aria("department")}
            />
            <datalist id="departments">
              {departments.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <FieldError id="new-department-error" message={errorFor("department")} />
          </label>
          <label className={field}>
            <span>
              Employment type
              <Req />
            </span>
            <select
              required
              value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
              className={`${control} font-normal`}
            >
              {EMPLOYMENT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className={field}>
            <span>
              Start date
              <Req />
            </span>
            <input
              required
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                edited("start_date");
              }}
              className={input("start_date")}
              {...aria("start_date")}
            />
            <FieldError id="new-start_date-error" message={errorFor("start_date")} />
          </label>
        </div>

        <div role="radiogroup" aria-labelledby="new-status-label">
          <span id="new-status-label" className="mb-1.5 block text-sm font-semibold">
            Status
            <Req />
          </span>
          <div className="grid grid-cols-3 gap-2">
            {MEMBER_STATUSES.map((s) => {
              const on = status === s.value;
              return (
                <label
                  key={s.value}
                  className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[15px] font-medium transition-colors ${
                    on ? `${STATUS_TONE[s.value]} bg-track/50` : "border-line hover:bg-track/40"
                  }`}
                >
                  <input
                    type="radio"
                    required
                    name="new-status"
                    value={s.value}
                    checked={on}
                    onChange={() => setStatus(s.value)}
                    className="sr-only"
                  />
                  <span className={`h-2 w-2 rounded-full ${STATUS_DOT[s.value]}`} aria-hidden />
                  {s.label}
                </label>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted">{STATUS_HELP[status]}</p>
          {statusWarning && <p className="mt-2 rounded-lg bg-st-amber/10 px-3 py-2 text-sm text-st-amber-strong">{statusWarning}</p>}
        </div>
      </fieldset>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm font-semibold">
          <label htmlFor="new-load">Capacity allocated</label>
          <span className={load > STRETCHED_THRESHOLD ? "text-st-orange-strong" : ""}>
            {load}%{load > STRETCHED_THRESHOLD && " · Stretched"}
          </span>
        </div>
        <input
          id="new-load"
          type="range"
          min={0}
          max={MAX_LOAD}
          step={5}
          value={load}
          onChange={(e) => setLoad(Number(e.target.value))}
          className="w-full accent-st-blue"
        />
        <div className="mt-1.5 h-1.5 rounded-full bg-track">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(load, 100)}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted">
          How much of their working time is already committed. Above 100% shows as Stretched.
          {status !== "active" && load > 0 && " They are not active, so you may want to set this to 0%."}
        </p>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold">
          Projects{" "}
          <span className="font-normal text-muted">
            ({editing ? `${picked} selected` : `optional${picked ? `, ${picked} selected` : ""}`})
          </span>
        </legend>
        {projects.length > 6 && (
          <input
            type="search"
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            placeholder="Filter projects"
            aria-label="Filter projects"
            className={`${control} mb-2 h-9! w-full text-sm! placeholder:text-muted`}
          />
        )}
        <datalist id="project-roles">
          {projectRoles.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {shownProjects.map((p) => {
            const on = p.id in roles;
            const leads = ledIds.has(p.id);
            const was = p.id in initialRoles;
            const note = !editing ? "" : leads ? "Lead" : on && !was ? "Adding" : !on && was ? "Removing" : "";
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <label className="flex min-w-0 flex-1 items-center gap-2.5 text-[15px]">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={leads}
                    onChange={(e) => toggleProject(p.id, e.target.checked)}
                    className="h-4 w-4 accent-st-blue disabled:opacity-60"
                  />
                  <span className={`truncate ${note === "Removing" ? "text-muted line-through" : ""}`}>{p.name}</span>
                  {note && (
                    <span
                      title={leads ? "Change the project lead from the project itself." : undefined}
                      className={`shrink-0 rounded-full border px-2 text-[12px] font-medium leading-5 ${
                        note === "Removing"
                          ? "border-st-red text-st-red-strong"
                          : note === "Adding"
                            ? "border-st-green text-st-green"
                            : "border-line text-muted"
                      }`}
                    >
                      {note}
                    </span>
                  )}
                </label>
                {on && (
                  <input
                    list="project-roles"
                    aria-label={`Role on ${p.name}`}
                    value={roles[p.id]}
                    readOnly={leads}
                    onChange={(e) => setRoles((r) => ({ ...r, [p.id]: e.target.value }))}
                    className={`${control} h-9! w-48 text-sm! read-only:bg-track/50 read-only:text-muted`}
                    placeholder="Role on this project"
                  />
                )}
              </li>
            );
          })}
          {!shownProjects.length && <li className="px-3 py-3 text-sm text-muted">No projects match.</li>}
        </ul>
      </fieldset>

      {serverError && (
        <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {serverError}
        </p>
      )}
      {attempted && !saving && !serverError && firstProblem && (
        <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
          {problems[firstProblem]}
        </p>
      )}

      {confirmRemove && member && (
        <ConfirmDialog
          title="Remove employee?"
          message={
            <p>
              <b className="text-ink">{member.name}</b> will be removed from the team, along with their project memberships. This cannot be
              undone.
            </p>
          }
          confirmLabel="Remove employee"
          busyLabel="Removing..."
          busy={removing}
          error={removeError}
          onConfirm={remove}
          onCancel={closeConfirm}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {editing && (
          <button
            type="button"
            onClick={() => {
              setRemoveError("");
              setConfirmRemove(true);
            }}
            className="rounded-lg px-3 py-2 font-medium text-st-red-strong hover:bg-st-red/8"
          >
            Remove from team
          </button>
        )}
        <span className="ml-auto text-sm text-muted" aria-live="polite">
          {editing && (dirty ? `${changeCount} unsaved change${changeCount === 1 ? "" : "s"}` : "No changes yet")}
        </span>
        <button type="button" onClick={onCancel} className="rounded-lg border border-line bg-surface px-4 py-2 font-medium hover:bg-track">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || removing || (editing && !dirty)}
          className="rounded-lg bg-header px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-accent dark:text-header"
        >
          {editing ? (saving ? "Saving..." : "Save changes") : saving ? "Adding..." : "Add employee"}
        </button>
      </div>
    </form>
  );
}

export function TeamView({
  onOpen,
  initialShow = "all",
  initialQuery = "",
}: {
  onOpen: (ref: OpenRef) => void;
  initialShow?: Show; // pre-set the filter when arriving from the Overview
  initialQuery?: string; // pre-fill the search when arriving from the navbar search
}) {
  const [query, setQuery] = useState(initialQuery);
  const [project, setProject] = useState("all");
  const [show, setShow] = useState<Show>(initialShow);
  const [sort, setSort] = useState<Sort>("stretched");
  const [status, setStatus] = useState<MemberStatus | "all">("all");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [added, setAdded] = useState<string | null>(null); // highlights the card of the person just added or edited
  const [notice, setNotice] = useState("");
  const dirty = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => void (dirty.current = d), []);

  const closeForm = () => {
    if (dirty.current && !window.confirm("Discard your unsaved changes?")) return;
    dirty.current = false;
    setAdding(false);
    setEditing(null);
  };

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? "" : n)), 4000);
  };

  const onRemoved = (name: string) => {
    dirty.current = false;
    setEditing(null);
    flash(`${name} was removed from the team.`);
  };

  const onCreated = (name: string) => {
    dirty.current = false;
    if (editing) flash(`Saved changes to ${name}.`);
    setEditing(null);
    setAdding(false);
    setQuery("");
    setProject("all");
    setShow("all");
    setStatus("all");
    setAdded(name);
    setTimeout(() => document.getElementById(personId(name))?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    setTimeout(() => setAdded((a) => (a === name ? null : a)), 4000);
  };

  const everyone = team.map((m) => ({ m, info: personInfo(m) }));
  const stretched = everyone.filter((p) => p.info.stretched).length;
  const withOverdue = everyone.filter((p) => p.info.overdue > 0).length;
  const blocked = everyone.reduce((n, p) => n + p.info.blocked, 0);
  const onLeave = team.filter((m) => m.status === "on_leave").length;

  const q = query.trim().toLowerCase();
  const people = everyone
    .filter(
      ({ m, info }) =>
        !q || [m.name, m.title, m.role, m.email ?? "", ...info.roles.map((r) => r.project)].some((s) => s.toLowerCase().includes(q)),
    )
    .filter(({ m }) => status === "all" || (m.status ?? "active") === status)
    .filter(({ info }) => project === "all" || info.roles.some((r) => r.projectId === project))
    .filter(
      ({ info }) =>
        show === "all" ||
        (show === "stretched" && info.stretched) ||
        (show === "overdue" && info.overdue > 0) ||
        (show === "blocked" && info.blocked > 0),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.m.name.localeCompare(b.m.name)
        : sort === "tasks"
          ? b.info.work.length - a.info.work.length || b.m.load - a.m.load
          : b.m.load - a.m.load,
    );

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[1.625rem] font-bold leading-tight tracking-tight">Team</h2>
          <p className="mt-1 text-muted">Who is working on which project, in what role, and how much is on their plate.</p>
          <p className="mt-2 text-sm text-muted">
            {plural(team.length, "person", "people")} · {plural(stretched, "stretched", "stretched")} ·{" "}
            {plural(withOverdue, "person", "people")} with overdue work · {plural(blocked, "blocked task", "blocked tasks")}
            {onLeave > 0 && ` · ${onLeave} on leave`}
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          className="rounded-lg bg-header px-5 py-2 text-[15px] font-semibold text-white hover:opacity-90 dark:bg-accent dark:text-header"
        >
          + Add employee
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, emails or projects"
          aria-label="Search people"
          className={`${control} h-11! w-full placeholder:text-muted desk:w-auto desk:min-w-[14rem] desk:flex-1`}
        />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" className={`${control} w-56`}>
          <option value="all">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={show} onChange={(e) => setShow(e.target.value as Show)} aria-label="Show" className={`${control} w-44`}>
          {SHOW.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as MemberStatus | "all")} aria-label="Status" className={`${control} w-40`}>
          <option value="all">Any status</option>
          {MEMBER_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className={`${control} w-52`}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {people.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 desk:grid-cols-3 xl:gap-5">
          {people.map(({ m, info }) => (
            <PersonCard
              key={m.id ?? m.name}
              m={m}
              info={info}
              onOpen={onOpen}
              onEdit={m.id !== undefined ? () => setEditing(m) : undefined}
              highlight={m.name === added}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-line bg-surface py-12 text-center text-muted">
          {team.length === 0 ? "No team members yet. Use + Add employee to add the first one." : "No one matches these filters."}
        </p>
      )}

      {notice && (
        <p
          role="status"
          className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-header px-4 py-2.5 text-sm font-medium text-white shadow-lg dark:bg-accent dark:text-header"
        >
          {notice}
        </p>
      )}

      {adding && (
        <Modal title="Add employee" onClose={closeForm} wide>
          <EmployeeForm onSaved={onCreated} onCancel={closeForm} onDirtyChange={onDirtyChange} />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={closeForm} wide>
          <EmployeeForm member={editing} onSaved={onCreated} onRemoved={onRemoved} onCancel={closeForm} onDirtyChange={onDirtyChange} />
        </Modal>
      )}
    </div>
  );
}
