// Client-side store: loads everything from the REST API, maps it to the shapes the components already
// use, fills the shared arrays in lib/data.ts in place, and tells React when anything changed.
// The database is the only source of truth: every successful mutation is followed by a refetch of the
// resource groups it can have changed (see `mutate`). Nothing is updated optimistically.

import { useSyncExternalStore } from "react";
import {
  api,
  errorMessage,
  type ApiActivity,
  type ApiDailyUpdate,
  type ApiDecisionRecord,
  type ApiAttention,
  type ApiBrief,
  type ApiDecision,
  type ApiKeyDate,
  type ApiMember,
  type ApiProject,
  type ApiSummary,
  type ApiTask,
  type ApiToday,
  type ApiWorkload,
} from "./api";
import {
  activity,
  dailyUpdates,
  dashboardCache,
  decisionRecords,
  departments,
  projects,
  tasks,
  team,
  type Activity,
  type AttentionItem,
  type DailyUpdate,
  type DecisionItem,
  type DecisionRecord,
  type Feedback,
  type FeedbackType,
  type OverallStatus,
  type Outcome,
  type ReviewStatus,
  type KeyDate,
  type Marker,
  type Member,
  type Priority,
  type Project,
  type ProjectPhase,
  type ProjectPriority,
  type ProjectStatus,
  type Summary,
  type Task,
  type TaskState,
  type WorkloadKind,
  type WorkloadPerson,
} from "./data";
import { loadNextPage, PAGE_SIZE, reloadLoaded, type HasId, type PageResult } from "./activityMerge";

/** Rows per request for the daily-update and decision-history lists (the server allows up to 1000). */
export const LIST_PAGE = 100;
import { diffDays, isValidTimeZone, serverDateIn, serverWallClock } from "./serverClock";

/* ---------- The server's calendar ---------- */

let clock: () => number = () => Date.now();
let serverTimeZone: string | null = null;
let nowCache: Date | null = null;

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const zone = () => serverTimeZone ?? browserZone();

/** The real current instant (ms). Replaceable in tests. */
export const nowMs = () => clock();

/** Test hook: replace the clock the store reads (null restores the real clock). */
export function setClockForTests(fn: (() => number) | null) {
  clock = fn ?? (() => Date.now());
  nowCache = null;
}

/** The server's calendar date right now (YYYY-MM-DD). */
export const serverToday = () => serverDateIn(zone(), clock());

/** Wall clock in the server's zone (see serverWallClock); the value behind useNow(). */
export function getNow(): Date {
  return (nowCache ??= serverWallClock(zone(), clock()));
}

/* ---------- Mapping: API (snake_case) -> existing UI shapes ---------- */

export const mapActivity = (a: ApiActivity): Activity => ({
  id: String(a.id),
  createdAt: a.created_at,
  text: a.description,
});

export const mapMember = (m: ApiMember): Member => ({
  id: m.id,
  name: m.name,
  title: m.title,
  role: m.department,
  load: m.load,
  email: m.email ?? "",
  phone: m.phone ?? "",
  status: m.status ?? "active",
  employmentType: m.employment_type ?? "full_time",
  startDate: m.start_date ?? null,
});

/** Offsets are derived from the absolute dates and the SERVER's today, never taken from the API. */
export function mapProject(p: ApiProject, today: string = serverToday()): Project {
  return {
    id: String(p.id),
    name: p.name,
    department: p.department,
    client: p.client ?? "",
    lead: p.lead_name ?? "",
    phase: p.phase as ProjectPhase,
    priority: (p.priority ?? "Medium") as ProjectPriority,
    description: p.description,
    startDate: p.start_date,
    endDate: p.end_date,
    startOffset: p.start_date ? diffDays(p.start_date, today) : null,
    endOffset: p.end_date ? diffDays(p.end_date, today) : null,
    done: p.progress,
    decision: p.decision || undefined,
    objectives: (p.objectives ?? []).map((o) => o.description),
    members: (p.members ?? []).map((m) => ({ name: m.name, role: m.role, memberId: m.member_id })),
    history: [],
  };
}

export const mapTask = (t: ApiTask, today: string = serverToday()): Task => ({
  id: String(t.id),
  title: t.title,
  owner: t.owner_name,
  projectId: String(t.project),
  workDate: t.work_date,
  dueDate: t.due_date,
  dueOffset: t.due_date ? diffDays(t.due_date, today) : null,
  workOffset: diffDays(t.work_date, today),
  state: t.state as TaskState,
  priority: t.priority as Priority,
  note: t.note || undefined,
});

export const mapSummary = (s: ApiSummary): Summary => ({
  total: s.total,
  inFlight: s.in_flight,
  notStarted: s.not_started,
  offTrack: s.off_track,
  watch: s.watch,
  onTrack: s.on_track,
  overdue: s.overdue,
  dueToday: s.due_today,
  blocked: s.blocked,
  stretched: s.stretched,
});

export const mapAttention = (a: ApiAttention): AttentionItem => ({
  key: a.key,
  marker: a.marker as Marker,
  title: a.title,
  subtitle: a.subtitle,
  label: a.label,
  ref: { kind: a.ref.kind, id: String(a.ref.id) },
});

export const mapKeyDate = (k: ApiKeyDate): KeyDate => ({
  key: k.key,
  offset: k.offset,
  title: k.title,
  lead: k.lead,
  projectId: String(k.project_id),
});

export const mapWorkload = (w: ApiWorkload): WorkloadPerson => ({
  id: w.id,
  name: w.name,
  title: w.title,
  role: w.department,
  load: w.load,
  stretched: w.stretched,
  open: w.open as WorkloadKind[],
});

export const mapDecision = (d: ApiDecision): DecisionItem => ({
  projectId: String(d.project_id),
  name: d.name,
  decision: d.decision,
  status: d.health as ProjectStatus,
  lead: d.lead,
  endOffset: d.end_offset,
});

/** The weekly brief in the UI's shapes. Lists are exactly what the server selected and ordered. */
export function mapBrief(b: ApiBrief) {
  return {
    summary: mapSummary(b.summary),
    stats: b.stats,
    decisions: b.decisions.map(mapDecision),
    attentionProjects: b.attention_projects.map((p) => mapProject(p)),
    lateTasks: b.late_tasks.map((t) => mapTask(t)),
    keyDates: b.key_dates.map(mapKeyDate),
    stretchedPeople: b.stretched_people.map(mapMember),
    onTrackProjects: b.on_track_projects.map((p) => mapProject(p)),
    completedTasks: b.completed_tasks.map((t) => ({ id: String(t.id), title: t.title })),
  };
}
export type Brief = ReturnType<typeof mapBrief>;

export const fetchBrief = async (): Promise<Brief> => mapBrief(await api.weeklyBrief());

export const mapDailyUpdate = (u: ApiDailyUpdate): DailyUpdate => ({
  id: String(u.id),
  employeeId: String(u.employee),
  employeeName: u.employee_name,
  projectId: String(u.project),
  date: u.date,
  completed: u.completed,
  inProgress: u.in_progress,
  nextSteps: u.next_steps,
  blockers: u.blockers,
  notes: u.notes || undefined,
  status: u.status as OverallStatus,
  sharedAt: u.shared_at,
  reviewStatus: u.review_status as ReviewStatus,
  fromTasks: !!u.from_tasks,
  taskCount: u.tasks?.length ?? 0,
  feedback: u.feedback.map(
    (f): Feedback => ({
      id: String(f.id),
      updateId: String(u.id),
      managerName: f.manager_name,
      type: f.type as FeedbackType,
      content: f.content,
      createdAt: f.created_at,
    }),
  ),
});

export const mapDecisionRecord = (r: ApiDecisionRecord): DecisionRecord => ({
  id: String(r.id),
  projectId: r.project === null ? null : String(r.project),
  title: r.title,
  outcome: r.outcome as Outcome,
  notes: r.notes || undefined,
  decisionDate: r.decision_date,
  recordedAt: r.recorded_at,
  projectName: r.project_name,
  lead: r.lead,
  health: r.health as ProjectStatus,
  deadline: r.deadline,
  context: r.context,
  activityId: r.activity_id,
});

/* ---------- Lookups used when sending ids to the API ---------- */

/** The UI identifies people by name; the API wants ids. */
export function memberId(name: string): number {
  const id = team.find((m) => m.name === name)?.id;
  if (id === undefined) throw new Error(`${name} is not on the team list. Refresh and try again.`);
  return id;
}

export const numericId = (id: string) => Number(id);

/* ---------- Store state ---------- */

/** Paging/loading state of a newest-first feed (the global activity or one project's history). */
export interface FeedInfo {
  status: "loading" | "ready" | "error";
  error: string | null; // first-page failure
  count: number; // total rows on the server
  moreLoading: boolean;
  moreError: string | null; // "Load more" failure
}

const readyFeed = (count: number): FeedInfo => ({ status: "ready", error: null, count, moreLoading: false, moreError: null });

export interface StoreState {
  /** True once the first load succeeded. */
  loaded: boolean;
  /** True while the first load, or any refetch, is running. */
  loading: boolean;
  /** Message of the last failed load/refetch, cleared by the next success. */
  error: string | null;
  /** Bumped whenever the shared arrays were replaced. */
  version: number;
  /** IANA zone the server computes "today" in (null until the first load). */
  serverTimeZone: string | null;
  /** Paging state of the global activity list (`activity` holds the loaded rows). */
  activityFeed: FeedInfo;
  /** Paging state of project histories that were opened, by project id. */
  histories: Record<string, FeedInfo>;
  /** Paging state of the daily-update list (`dailyUpdates` holds the loaded rows) and its server-side "new" count. */
  updatesFeed: FeedInfo;
  newUpdates: number;
  /** Paging state of the decision history (`decisionRecords` holds the loaded rows). */
  decisionsFeed: FeedInfo;
}

let state: StoreState = {
  loaded: false,
  loading: false,
  error: null,
  version: 0,
  serverTimeZone: null,
  activityFeed: readyFeed(0),
  histories: {},
  updatesFeed: readyFeed(0),
  newUpdates: 0,
  decisionsFeed: readyFeed(0),
};
const listeners = new Set<() => void>();

function setState(patch: Partial<StoreState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** Subscribe to every store change (also used by useNow). */
export const subscribeStore = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export const getState = () => state;

/** Subscribe a component to the store; it re-renders after every load or refetch. */
export function useStore(): StoreState {
  return useSyncExternalStore(subscribeStore, getState, getState);
}

function replace<T>(target: T[], next: T[]) {
  target.splice(0, target.length, ...next);
}

/* ---------- Fetching resource groups ---------- */

/** Resource groups a mutation can ask to have refetched. */
export type Scope = "members" | "projects" | "tasks" | "activity" | "dashboard" | "departments" | "dailyUpdates" | "decisionHistory";
/** `today` (the server's date and zone) is refetched on a full reload and when the date changes. */
export type RefreshGroup = Scope | "today";
const ALL_GROUPS: readonly RefreshGroup[] = [
  "members",
  "projects",
  "tasks",
  "activity",
  "dashboard",
  "departments",
  "dailyUpdates",
  "decisionHistory",
  "today",
];

interface FeedRows<T = ApiActivity> {
  rows: T[];
  count: number;
}

interface Fetched {
  today?: ApiToday;
  members?: ApiMember[];
  departments?: string[];
  projects?: ApiProject[];
  tasks?: ApiTask[];
  dailyUpdates?: FeedRows<ApiDailyUpdate> & { newCount: number };
  decisionHistory?: FeedRows<ApiDecisionRecord>;
  activity?: FeedRows;
  histories?: Record<string, FeedRows>;
  dashboard?: {
    summary: ApiSummary;
    attention: ApiAttention[];
    keyDates: ApiKeyDate[];
    workload: ApiWorkload[];
    decisions: ApiDecision[];
  };
}

// Project histories are cached here (newest first) and attached to the project objects.
const historyCache = new Map<string, Activity[]>();
// Bumped every time refreshed activity rows are applied; a page fetched before that is stale.
let feedEpoch = 0;
// Same idea for the daily-update and decision-history lists.
let updatesEpoch = 0;
let decisionsEpoch = 0;

async function fetchGroups(groups: ReadonlySet<RefreshGroup>): Promise<Fetched> {
  const out: Fetched = {};
  const jobs: Promise<void>[] = [];
  const run = (f: () => Promise<void>) => void jobs.push(f());

  if (groups.has("today")) run(async () => void (out.today = await api.today()));
  if (groups.has("members")) run(async () => void (out.members = (await api.listMembers()).results));
  if (groups.has("departments")) run(async () => void (out.departments = (await api.listDepartments()).results));
  if (groups.has("projects")) run(async () => void (out.projects = (await api.listProjects()).results));
  if (groups.has("tasks")) run(async () => void (out.tasks = (await api.listTasks()).results));
  if (groups.has("dailyUpdates")) {
    // Re-read as many rows as are loaded now (at least one page), so a refetch never shrinks or duplicates the list.
    const loaded = dailyUpdates.length;
    run(async () => {
      let newCount = 0;
      const r = await reloadLoaded(
        loaded,
        async (limit, offset) => {
          const p = await api.listDailyUpdates(limit, offset);
          newCount = p.new_count;
          return p;
        },
        LIST_PAGE,
        loaded > 0 && loaded >= state.updatesFeed.count,
      );
      out.dailyUpdates = { ...r, newCount };
    });
  }
  if (groups.has("decisionHistory")) {
    const loaded = decisionRecords.length;
    run(async () => {
      out.decisionHistory = await reloadLoaded(loaded, (limit, offset) => api.decisionHistory(limit, offset), LIST_PAGE, loaded > 0 && loaded >= state.decisionsFeed.count);
    });
  }
  if (groups.has("activity")) {
    // Re-read as many rows as are loaded now, so rows never duplicate or vanish.
    const loaded = activity.length;
    run(async () => {
      const r = await reloadLoaded(loaded, (limit, offset) => api.listActivity(limit, offset), PAGE_SIZE, loaded > 0 && loaded >= state.activityFeed.count);
      out.activity = r;
    });
    // Project histories that were opened are re-read to the same depth, so they never go stale.
    const histories: Record<string, FeedRows> = {};
    out.histories = histories;
    for (const [id, items] of historyCache) {
      run(async () => {
        const total = state.histories[id]?.count ?? 0;
        histories[id] = await reloadLoaded(items.length, (limit, offset) => api.projectHistory(Number(id), limit, offset), PAGE_SIZE, items.length > 0 && items.length >= total);
      });
    }
  }
  if (groups.has("dashboard")) {
    run(async () => {
      const [summary, attention, keyDates, workload, decisions] = await Promise.all([
        api.summary(),
        api.attention(),
        api.keyDates(30),
        api.teamWorkload(),
        api.decisions(),
      ]);
      out.dashboard = {
        summary,
        attention: attention.results,
        keyDates: keyDates.results,
        workload: workload.results,
        decisions: decisions.results,
      };
    });
  }
  await Promise.all(jobs);
  return out;
}

/** Offsets are days from the server's today; recompute them in place from the stored ISO dates. */
function recomputeOffsets(today: string) {
  for (const p of projects) {
    p.startOffset = p.startDate ? diffDays(p.startDate, today) : null;
    p.endOffset = p.endDate ? diffDays(p.endDate, today) : null;
  }
  for (const t of tasks) {
    t.dueOffset = t.dueDate ? diffDays(t.dueDate, today) : null;
    t.workOffset = diffDays(t.workDate, today);
  }
}

function attachHistories() {
  for (const p of projects) p.history = historyCache.get(p.id) ?? [];
}

// The server date the dashboard figures were last fetched for. When the date moves on (a tab left open
// across midnight) the offsets are recomputed and the server-computed figures are refetched.
let appliedToday: string | null = null;

/** All of a fetch's results are applied together, synchronously, so the arrays are never half updated. */
function apply(data: Fetched) {
  if (data.today && isValidTimeZone(data.today.time_zone)) {
    serverTimeZone = data.today.time_zone;
    nowCache = null;
  }
  const today = serverToday();
  if (data.members) replace(team, data.members.map(mapMember));
  if (data.departments) replace(departments, data.departments);
  if (data.projects) replace(projects, data.projects.map((p) => mapProject(p, today)));
  if (data.tasks) replace(tasks, data.tasks.map((t) => mapTask(t, today)));
  if (data.dailyUpdates) replace(dailyUpdates, data.dailyUpdates.rows.map(mapDailyUpdate));
  if (data.decisionHistory) replace(decisionRecords, data.decisionHistory.rows.map(mapDecisionRecord));
  if (data.activity) replace(activity, data.activity.rows.map(mapActivity));
  if (data.histories) for (const [id, h] of Object.entries(data.histories)) historyCache.set(id, h.rows.map(mapActivity));
  if (data.dashboard) {
    dashboardCache.summary = mapSummary(data.dashboard.summary);
    dashboardCache.attention = data.dashboard.attention.map(mapAttention);
    dashboardCache.keyDates = data.dashboard.keyDates.map(mapKeyDate);
    dashboardCache.teamWorkload = data.dashboard.workload.map(mapWorkload);
    dashboardCache.decisions = data.dashboard.decisions.map(mapDecision);
    appliedToday = today;
  }
  recomputeOffsets(today);
  attachHistories();

  const next: Partial<StoreState> = { loaded: true, loading: false, error: null, version: state.version + 1, serverTimeZone };
  if (data.activity) {
    feedEpoch++;
    next.activityFeed = readyFeed(data.activity.count);
  }
  if (data.dailyUpdates) {
    updatesEpoch++;
    next.updatesFeed = readyFeed(data.dailyUpdates.count);
    next.newUpdates = data.dailyUpdates.newCount;
  }
  if (data.decisionHistory) {
    decisionsEpoch++;
    next.decisionsFeed = readyFeed(data.decisionHistory.count);
  }
  if (data.histories) {
    const histories = { ...state.histories };
    for (const [id, h] of Object.entries(data.histories)) histories[id] = readyFeed(h.count);
    next.histories = histories;
  }
  setState(next);
}

let latest = 0;
let inFlight = 0;
// Groups asked for but not yet applied. A newer refresh fetches the union, so a superseded or failed
// refresh never leaves a group stale.
const pending = new Set<RefreshGroup>();

/**
 * Reload resource groups from the server (everything when no scope is given). A newer call supersedes an
 * older one still in flight. Results are applied only if every requested group succeeded; on failure the
 * previous data stays and the error banner is shown. Never throws.
 */
export async function refresh(scope?: readonly RefreshGroup[]): Promise<void> {
  for (const g of scope ?? ALL_GROUPS) pending.add(g);
  const mine = ++latest;
  const groups = new Set(pending);
  setState({ loading: true });
  inFlight++;
  try {
    const data = await fetchGroups(groups);
    if (mine !== latest) return;
    apply(data);
    pending.clear();
  } catch (e) {
    if (mine !== latest) return;
    // Keep whatever was loaded before; never substitute made-up data.
    setState({ loading: false, error: errorMessage(e) });
  } finally {
    inFlight--;
  }
}

let started = false;
/** Start the first load once (called from an effect, so nothing is fetched during prerender). */
export function ensureLoaded() {
  if (started) return;
  started = true;
  void refresh();
}

/**
 * Which resource groups each kind of write refetches (see `mutate`). Chosen conservatively: when in doubt a
 * group is included, because the UI must never show stale data after a change.
 *  - task: create/update/complete/delete change the task list, the open-work lists embedded in projects,
 *    the activity log (and project histories), every dashboard figure (summary, attention, workload) and the
 *    Daily Work Updates built from tasks.
 *  - projectEdit: phase/lead/dates/progress change the project, its history and the dashboard figures.
 *  - decision: set/resolve/undo change the project's decision, activity (undo deletes an event), the
 *    decisions/attention figures and the decision history (resolve adds a record, undo removes it).
 *  - review: opening a daily update marks it reviewed; feedback also writes an activity entry.
 *  - objective, projectMember: only the project (objectives/members) and its history change.
 *  - newProject: a new project row, its first history entry and the dashboard totals.
 *  - newEmployee: the person, their project memberships, activity, workload figures and department list.
 *  - employeeEdit: the same groups, for editing or removing a person. A rename refetches everything instead,
 *    because tasks, daily updates and decisions all show people by name.
 */
export const SCOPES = {
  task: ["tasks", "projects", "activity", "dashboard", "dailyUpdates"], // tasks feed Daily Work Updates
  projectEdit: ["projects", "activity", "dashboard"],
  decision: ["projects", "activity", "dashboard", "decisionHistory"],
  review: ["dailyUpdates"],
  feedback: ["dailyUpdates", "activity"],
  objective: ["projects", "activity"],
  projectMember: ["projects", "activity"],
  newProject: ["projects", "activity", "dashboard"],
  newEmployee: ["members", "projects", "activity", "dashboard", "departments"],
  employeeEdit: ["members", "projects", "activity", "dashboard", "departments"],
} as const satisfies Record<string, readonly Scope[]>;

/**
 * Run a write call; when it succeeds, refetch the resource groups in `scope` so every tab shows database
 * state (no scope = everything, the safe default). Errors from the write itself propagate to the caller; a
 * failed refetch is reported through the store's error banner.
 */
export async function mutate<T>(write: () => Promise<T>, scope?: readonly Scope[]): Promise<T> {
  const result = await write();
  await refresh(scope);
  return result;
}

/**
 * Called every minute (and at start-up) by useNow's timer: refresh the wall clock and, when the server's
 * calendar date has changed, recompute every offset and refetch the server-computed dashboard figures.
 */
export function syncClock() {
  nowCache = serverWallClock(zone(), clock());
  const today = serverToday();
  if (state.loaded && appliedToday !== null && today !== appliedToday) {
    recomputeOffsets(today);
    setState({ version: state.version + 1 });
    if (inFlight === 0) void refresh(["dashboard", "today"]);
    return;
  }
  listeners.forEach((l) => l());
}

/* ---------- Paged activity: "Load more" ---------- */

function setHistory(id: string, info: FeedInfo) {
  setState({ histories: { ...state.histories, [id]: info }, version: state.version + 1 });
}

/** Load the first page of a project's history (called when its detail panel opens). */
export async function loadProjectHistory(id: string): Promise<void> {
  const cur = state.histories[id];
  if (cur && cur.status !== "error") return;
  setHistory(id, { status: "loading", error: null, count: 0, moreLoading: false, moreError: null });
  for (let attempt = 0; attempt < 3; attempt++) {
    const epoch = feedEpoch;
    try {
      const page = await api.projectHistory(numericId(id), PAGE_SIZE, 0);
      if (epoch !== feedEpoch) continue; // a refetch landed meanwhile; read again
      historyCache.set(id, page.results.map(mapActivity));
      attachHistories();
      setHistory(id, readyFeed(page.count));
      return;
    } catch (e) {
      setHistory(id, { status: "error", error: errorMessage(e), count: 0, moreLoading: false, moreError: null });
      return;
    }
  }
  setHistory(id, { status: "error", error: "The history kept changing while loading. Please try again.", count: 0, moreLoading: false, moreError: null });
}

/** Load the next page of a project's history (offset = rows already loaded, duplicates dropped). */
export async function loadMoreProjectHistory(id: string): Promise<void> {
  const info = state.histories[id];
  const items = historyCache.get(id);
  if (!info || info.status !== "ready" || info.moreLoading || !items || items.length >= info.count) return;
  setHistory(id, { ...info, moreLoading: true, moreError: null });
  const epoch = feedEpoch;
  try {
    const page = await loadNextPage(items, (limit, offset) => api.projectHistory(numericId(id), limit, offset), mapActivity);
    const now = state.histories[id];
    if (epoch !== feedEpoch) {
      if (now) setHistory(id, { ...now, moreLoading: false }); // a refetch replaced the rows; click again if needed
      return;
    }
    historyCache.set(id, page.rows);
    attachHistories();
    setHistory(id, readyFeed(page.count));
  } catch (e) {
    const now = state.histories[id] ?? info;
    setHistory(id, { ...now, moreLoading: false, moreError: errorMessage(e) });
  }
}

/** Load the next page of the global activity list. */
export async function loadMoreActivity(): Promise<void> {
  const info = state.activityFeed;
  if (info.moreLoading || activity.length >= info.count) return;
  setState({ activityFeed: { ...info, moreLoading: true, moreError: null } });
  const epoch = feedEpoch;
  try {
    const page = await loadNextPage(activity, (limit, offset) => api.listActivity(limit, offset), mapActivity);
    if (epoch !== feedEpoch) {
      setState({ activityFeed: { ...state.activityFeed, moreLoading: false } });
      return;
    }
    replace(activity, page.rows);
    setState({ activityFeed: readyFeed(page.count), version: state.version + 1 });
  } catch (e) {
    setState({ activityFeed: { ...state.activityFeed, moreLoading: false, moreError: errorMessage(e) } });
  }
}

/* ---------- Paged daily updates and decision history: "Load more" ---------- */

/**
 * Load the next page of a newest-first list that lives in a shared array. Duplicates are dropped, a refetch that
 * lands meanwhile discards this page (click again), and a failure is reported through the feed's `moreError`.
 */
async function loadMoreFeed<A extends HasId, T extends HasId>(o: {
  rows: T[];
  feed: () => FeedInfo;
  setFeed: (f: FeedInfo) => void;
  epoch: () => number;
  fetchPage: (limit: number, offset: number) => Promise<PageResult<A> & { new_count?: number }>;
  map: (a: A) => T;
}): Promise<void> {
  const info = o.feed();
  if (info.moreLoading || o.rows.length >= info.count) return;
  o.setFeed({ ...info, moreLoading: true, moreError: null });
  const epoch = o.epoch();
  try {
    let newCount: number | undefined;
    const page = await loadNextPage(
      o.rows,
      async (limit, offset) => {
        const p = await o.fetchPage(limit, offset);
        newCount = p.new_count;
        return p;
      },
      o.map,
      LIST_PAGE,
    );
    if (epoch !== o.epoch()) {
      o.setFeed({ ...o.feed(), moreLoading: false });
      return;
    }
    replace(o.rows, page.rows);
    o.setFeed(readyFeed(page.count));
    if (newCount !== undefined) setState({ newUpdates: newCount });
  } catch (e) {
    o.setFeed({ ...o.feed(), moreLoading: false, moreError: errorMessage(e) });
  }
}

export const loadMoreDailyUpdates = () =>
  loadMoreFeed({
    rows: dailyUpdates,
    feed: () => state.updatesFeed,
    setFeed: (updatesFeed) => setState({ updatesFeed, version: state.version + 1 }),
    epoch: () => updatesEpoch,
    fetchPage: (limit, offset) => api.listDailyUpdates(limit, offset),
    map: mapDailyUpdate,
  });

export const loadMoreDecisionRecords = () =>
  loadMoreFeed({
    rows: decisionRecords,
    feed: () => state.decisionsFeed,
    setFeed: (decisionsFeed) => setState({ decisionsFeed, version: state.version + 1 }),
    epoch: () => decisionsEpoch,
    fetchPage: (limit, offset) => api.decisionHistory(limit, offset),
    map: mapDecisionRecord,
  });
