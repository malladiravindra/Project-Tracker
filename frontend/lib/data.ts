// Types and pure helpers for the dashboard. The arrays below start empty and are filled in place
// from the REST API by lib/store.ts, so components can keep reading them directly.
// Dates are kept as absolute ISO dates (startDate / endDate / dueDate). The *Offset fields are days from the
// SERVER's today, derived by lib/store.ts from those dates and recomputed whenever the server's date changes.

export type ProjectStatus = "off-track" | "watch" | "on-track" | "not-started";
export type TaskState = "not-started" | "in-progress" | "blocked" | "done";
export type Priority = "Critical" | "High" | "Medium" | "Low";
export const PRIORITIES: Priority[] = ["Low", "Medium", "High", "Critical"];

export type ProjectPhase = "Planning" | "Not Started" | "In Progress" | "Under Testing" | "At Risk" | "On Hold" | "No Updates" | "Completed" | "Cancelled";
export type ProjectPriority = "Low" | "Medium" | "High" | "Critical";

export const PROJECT_PRIORITIES: ProjectPriority[] = ["Low", "Medium", "High", "Critical"];

export interface ProjectMember {
  name: string;
  role: string;
  memberId?: number; // server id of the member
}

export interface Project {
  id: string;
  name: string;
  department: string;
  client: string; // "" = no client (optional)
  lead: string; // "" = no lead (optional)
  phase: ProjectPhase; // status set by the project lead
  priority: ProjectPriority;
  description: string;
  startDate: string | null; // YYYY-MM-DD; null = not set (optional)
  endDate: string | null; // YYYY-MM-DD deadline; null = not set (optional)
  startOffset: number | null; // days from the server's today (negative = already started); null = no start date
  endOffset: number | null; // days from the server's today; null = no deadline
  done: number; // % of work completed
  decision?: string; // what leadership needs to decide, if anything
  objectives: string[];
  members: ProjectMember[];
  history: Activity[];
}

export interface Task {
  id: string;
  title: string;
  owner: string;
  projectId: string;
  workDate: string; // YYYY-MM-DD: the day the work was done (may be in the past)
  dueDate: string | null; // YYYY-MM-DD optional deadline
  dueOffset: number | null; // days from the server's today to the deadline (negative = overdue); null = no deadline
  workOffset: number; // days from the server's today to the work date (0 = today, negative = earlier)
  state: TaskState;
  priority: Priority;
  note?: string;
}

export type MemberStatus = "active" | "on_leave" | "inactive";
export type EmploymentType = "full_time" | "part_time" | "contract" | "intern";

export const MEMBER_STATUSES: { value: MemberStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "on_leave", label: "On leave" },
  { value: "inactive", label: "Inactive" },
];

export const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: "full_time", label: "Full-time" },
  { value: "part_time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "intern", label: "Intern" },
];

export interface Member {
  id?: number; // server id
  name: string;
  title: string; // job title
  role: string; // department
  load: number; // % of capacity allocated
  email?: string; // "" when not recorded
  phone?: string;
  status?: MemberStatus; // absent on dashboard summaries, which only carry the basics
  employmentType?: EmploymentType;
  startDate?: string | null; // YYYY-MM-DD
}

export const projects: Project[] = [];
export const tasks: Task[] = [];
export const team: Member[] = [];
export const departments: string[] = [];


/* ---------- Derived values ---------- */

/** % of the schedule elapsed; 0 without both dates, so health then follows progress alone (as on the server). */
export function timeUsed(p: Project): number {
  if (p.startOffset === null || p.endOffset === null) return 0;
  const total = p.endOffset - p.startOffset;
  const pct = Math.round((-p.startOffset / total) * 100);
  return Math.min(100, Math.max(0, pct));
}

export function projectStatus(p: Project): ProjectStatus {
  const used = timeUsed(p);
  if (used === 0 && p.done === 0) return "not-started";
  const gap = used - p.done;
  if (gap > 15) return "off-track";
  if (gap > 3) return "watch";
  return "on-track";
}

export function startsInLabel(p: Project): string {
  const d = p.startOffset;
  if (d === null) return "No start date";
  if (d <= 0) return "Not started yet";
  return d === 1 ? "Starts tomorrow" : `Starts in ${d} days`;
}

/* ---------- Team workload ---------- */

export type WorkloadKind = "overdue" | "blocked" | "soon" | "later";

export function workloadKind(t: Task): WorkloadKind {
  const b = taskBucket(t);
  if (b === "overdue" || b === "blocked") return b;
  return dateOffset(t) <= 7 ? "soon" : "later";
}

/** Days to the date a task is grouped by: its deadline, or its work date when it has none. */
export const dateOffset = (t: Task) => t.dueOffset ?? t.workOffset;

/** Sort by task date (deadline, or work date when there is none), earliest first. */
export const byDue = (a: Task, b: Task) => dateOffset(a) - dateOffset(b);

export interface WorkloadPerson extends Member {
  open: WorkloadKind[];
  stretched: boolean;
}

/* ---------- Dashboard figures served by the backend (cached by lib/store.ts after each refresh) ---------- */

export interface Summary {
  total: number;
  inFlight: number;
  notStarted: number;
  offTrack: number;
  watch: number;
  onTrack: number;
  overdue: number;
  dueToday: number;
  blocked: number;
  stretched: number;
}

export interface DecisionItem {
  projectId: string;
  name: string;
  decision: string;
  status: ProjectStatus;
  lead: string; // "" = no lead (optional)
  endOffset: number | null; // null = no deadline
}

export const emptySummary: Summary = {
  total: 0,
  inFlight: 0,
  notStarted: 0,
  offTrack: 0,
  watch: 0,
  onTrack: 0,
  overdue: 0,
  dueToday: 0,
  blocked: 0,
  stretched: 0,
};

export const dashboardCache: {
  summary: Summary;
  attention: AttentionItem[];
  keyDates: KeyDate[];
  teamWorkload: WorkloadPerson[];
  decisions: DecisionItem[];
} = { summary: emptySummary, attention: [], keyDates: [], teamWorkload: [], decisions: [] };

export const teamWorkload = (): WorkloadPerson[] => dashboardCache.teamWorkload;
export const decisions = (): DecisionItem[] => dashboardCache.decisions;

/* ---------- Key dates ---------- */

export interface KeyDate {
  key: string;
  offset: number;
  title: string;
  lead: string; // "" = no lead (optional)
  projectId: string;
}

export const keyDates = (withinDays = 30): KeyDate[] => dashboardCache.keyDates.filter((k) => k.offset <= withinDays);

export const projectById = (id: string) => projects.find((p) => p.id === id)!;

export type TaskBucket = "overdue" | "today" | "blocked" | "upcoming" | "done";

export function taskBucket(t: Task): TaskBucket {
  if (t.state === "done") return "done";
  if (t.state === "blocked") return "blocked";
  const d = dateOffset(t);
  if (d < 0) return "overdue";
  if (d === 0) return "today";
  return "upcoming";
}

export function dueLabel(t: Task): string {
  if (t.state === "done") return "Completed";
  if (t.state === "blocked") return "Blocked";
  const d = t.dueOffset;
  if (d === null) {
    const w = t.workOffset;
    return w === 0 ? "Today's work" : w < 0 ? `Work date ${-w} day${w === -1 ? "" : "s"} ago` : `Work date in ${w} days`;
  }
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} overdue`;
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  return `Due in ${d} days`;
}

export const STRETCHED_THRESHOLD = 100;

export const summary = (): Summary => dashboardCache.summary;

/* ---------- "Needs your attention" feed ---------- */

export type Marker = "square-red" | "dot-red" | "dot-purple" | "triangle-amber" | "dot-blue" | "dot-orange";

export interface AttentionItem {
  key: string;
  marker: Marker;
  title: string;
  subtitle: string;
  label: string;
  ref: { kind: "project"; id: string } | { kind: "task"; id: string };
}

export const attentionItems = (): AttentionItem[] => dashboardCache.attention;

/* ---------- Recent activity ---------- */

export interface Activity {
  id: string;
  createdAt: string; // ISO timestamp; the "5 min ago" label is computed at render time
  text: string;
}

export const activity: Activity[] = [];

export function agoLabel(minutes: number): string {
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

/* ---------- Daily work updates and recorded decisions (served by the backend, filled by lib/store.ts) ---------- */

export type OverallStatus = "On track" | "At risk" | "Blocked";
export type ReviewStatus = "new" | "reviewed" | "feedback";
export type FeedbackType = "Suggestion" | "Appreciation" | "Improvement required" | "Next steps";
export type Outcome = "Approved" | "Rejected" | "Deferred" | "Resolved";

export interface Feedback {
  id: string;
  updateId: string;
  managerName: string;
  type: FeedbackType;
  content: string;
  createdAt: string; // ISO timestamp
}

export interface DailyUpdate {
  id: string;
  employeeId: string;
  employeeName: string;
  projectId: string;
  date: string; // YYYY-MM-DD, the working day the update covers
  completed: string[];
  inProgress: string[];
  nextSteps: string[];
  blockers: string[];
  notes?: string;
  status: OverallStatus;
  sharedAt: string; // ISO timestamp
  reviewStatus: ReviewStatus;
  feedback: Feedback[];
  fromTasks: boolean; // built from logged tasks rather than shared by hand
  taskCount: number; // tasks behind this update (their items are merged into the lists above)
}

export interface DecisionRecord {
  id: string;
  projectId: string | null; // null once the project has been deleted
  title: string; // the decision that was asked for
  outcome: Outcome;
  notes?: string;
  decisionDate: string; // YYYY-MM-DD chosen by the manager
  recordedAt: string; // ISO timestamp when it was saved
  // Snapshot of the project when the decision was made
  projectName: string;
  lead: string; // "" = no lead (optional)
  health: ProjectStatus;
  deadline: string | null; // YYYY-MM-DD project deadline at the time; null = it had none
  context: string; // e.g. "71% done with 92% of the time used"
  activityId: number | null; // the activity entry written when it was recorded (needed to undo it)
}

export const dailyUpdates: DailyUpdate[] = []; // newest first
export const decisionRecords: DecisionRecord[] = []; // newest decision first
