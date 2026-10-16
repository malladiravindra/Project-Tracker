"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { dateOffset, PRIORITIES, projectById, tasks, team, type Priority, type TaskState } from "@/lib/data";
import { api, ApiError, errorMessage, type TaskPatch } from "@/lib/api";
import { memberId, mutate, numericId, SCOPES } from "@/lib/store";
import { useNow } from "./hooks";
import { control, dueText, FieldNote, STATES, workDateProblem } from "./TasksView";
import { DateField } from "./FormControls";
import { ConfirmDialog } from "./ui";
import { diffDays, wallClockIso } from "@/lib/serverClock";
import { BLOCKED_NOTE_TOO_LONG, blockedNoteProblem, NOTE_MAX_LENGTH } from "@/lib/blockedNote";

function dueTone(offset: number | null, state: TaskState) {
  if (state === "done") return "text-st-green";
  if (offset === null) return "text-muted";
  if (offset < 0) return "text-st-red-strong";
  if (offset === 0) return "text-st-orange-strong";
  if (offset <= 2) return "text-st-amber-strong";
  return "text-muted";
}

const label = "mb-1.5 block text-sm font-semibold text-muted";
const btn = "rounded-lg border border-line bg-surface px-4 py-2 text-[15px] font-medium hover:bg-track";

export default function TaskEditor({
  id,
  onClose,
  onProject,
}: {
  id: string;
  onClose: () => void;
  onProject: (projectId: string) => void;
}) {
  const now = useNow();
  const task = tasks.find((t) => t.id === id);
  const project = task ? projectById(task.projectId) : null;

  const [title, setTitle] = useState(task?.title ?? "");
  const [owner, setOwner] = useState(task?.owner ?? "");
  const [workDate, setWorkDate] = useState(task?.workDate ?? "");
  const [workTyped, setWorkTyped] = useState(false); // text entered but not a valid date
  const [due, setDue] = useState(task?.dueDate ?? ""); // "" = no deadline
  const [dueTyped, setDueTyped] = useState(false);
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "Medium");
  const [state, setState] = useState<TaskState>(task?.state ?? "not-started");
  const [note, setNote] = useState(task?.note ?? "");
  const [attempted, setAttempted] = useState(false); // show validation only after the first save attempt
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [serverFields, setServerFields] = useState<Record<string, string>>({});
  const titleRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) formRef.current?.requestSubmit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!task || !project || !now) return null;

  // Dates are compared as ISO strings; the offset is only for the preview and is relative to the server's today.
  const dueOffset = due ? diffDays(due, wallClockIso(now)) : null;
  const dirty =
    title.trim() !== task.title ||
    owner !== task.owner ||
    workDate !== task.workDate ||
    (due || null) !== task.dueDate ||
    workTyped ||
    dueTyped ||
    priority !== task.priority ||
    state !== task.state ||
    note.trim() !== (task.note ?? "");

  // Field-level problems; shown after the first save attempt, next to their field.
  const problems = {
    title: !title.trim() ? "Give the task a name." : "",
    work: workDateProblem(workDate, workTyped),
    due: dueTyped ? "Enter the due date as dd-mm-yyyy, or leave it empty." : "",
    note: state === "blocked" ? blockedNoteProblem(note) : note.trim().length > NOTE_MAX_LENGTH ? BLOCKED_NOTE_TOO_LONG : "",
  };
  const problem = problems.title || problems.work || problems.due || problems.note;
  const fieldError = (f: keyof typeof problems, server: string) => serverFields[server] || (attempted ? problems[f] : "");

  // Project team first (with their role), then everyone else.
  const members = project.members.map((m) => ({ name: m.name, text: `${m.name} (${m.role})` }));
  const others = team
    .filter((m) => !project.members.some((x) => x.name === m.name))
    .map((m) => ({ name: m.name, text: m.name }));
  const owners = [...members, ...others];
  if (!owners.some((o) => o.name === task.owner)) owners.unshift({ name: task.owner, text: task.owner });

  // The server records every change in the activity log, so the editor only sends what changed.
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true);
    setServerError("");
    setServerFields({});
    try {
      await mutate(write, SCOPES.task);
      onClose();
    } catch (e) {
      const fields = e instanceof ApiError ? e.fields : {};
      setServerFields(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v[0]])));
      setServerError(Object.keys(fields).length ? "Please fix the highlighted fields." : errorMessage(e));
      setBusy(false);
    }
  };

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setAttempted(true);
    if (problem) return;
    if (!dirty) return onClose();
    void run(() => {
      const patch: TaskPatch = {};
      if (title.trim() !== task.title) patch.title = title.trim();
      if (owner !== task.owner) patch.owner_id = memberId(owner);
      if (workDate !== task.workDate) patch.work_date = workDate;
      if ((due || null) !== task.dueDate) patch.due_date = due || null;
      if (priority !== task.priority) patch.priority = priority;
      if (state !== task.state) patch.state = state;
      if (note.trim() !== (task.note ?? "")) patch.note = note.trim();
      return api.updateTask(numericId(task.id), patch);
    });
  };

  const markDone = () => void run(() => api.completeTask(numericId(task.id)));
  const remove = () => void run(() => api.deleteTask(numericId(task.id)));

  const previewTask = { ...task, dueOffset, state };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <form
        ref={formRef}
        onSubmit={save}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-editor-title"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0">
            <h2 id="task-editor-title" className="text-xl font-bold">
              Edit task
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-muted">
              <button
                type="button"
                onClick={() => onProject(project.id)}
                className="font-medium text-st-blue underline-offset-2 hover:underline"
              >
                {project.name} →
              </button>
              <span aria-hidden>·</span>
              <span className={`font-semibold ${dueTone(dateOffset(task), task.state)}`}>
                {task.state === "done" ? "Completed" : task.state === "blocked" ? "Blocked" : dueText(task)}
              </span>
            </p>
          </div>
          <button type="button" onClick={onClose} className={btn}>
            Close
          </button>
        </header>

        <div className="space-y-4 overflow-y-auto px-6 py-5">
          <div>
            <label htmlFor="te-title" className={label}>
              Task
            </label>
            <input
              id="te-title"
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-invalid={!!fieldError("title", "title")}
              className={`${control} h-12! w-full text-base! ${fieldError("title", "title") ? "border-st-red!" : ""}`}
            />
            <FieldNote id="te-title-error" message={fieldError("title", "title")} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="te-project" className={label}>
                Project
              </label>
              <select id="te-project" disabled value={project.id} className={`${control} w-full cursor-not-allowed opacity-70`}>
                <option value={project.id}>{project.name}</option>
              </select>
            </div>
            <div>
              <label htmlFor="te-owner" className={label}>
                Employee
              </label>
              <select id="te-owner" value={owner} onChange={(e) => setOwner(e.target.value)} className={`${control} w-full`}>
                {members.length > 0 && (
                  <optgroup label={`${project.name} team`}>
                    {owners
                      .filter((o) => members.some((m) => m.name === o.name))
                      .map((o) => (
                        <option key={o.name} value={o.name}>
                          {o.text}
                        </option>
                      ))}
                  </optgroup>
                )}
                <optgroup label="Others">
                  {owners
                    .filter((o) => !members.some((m) => m.name === o.name))
                    .map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.text}
                      </option>
                    ))}
                </optgroup>
              </select>
            </div>

            <div>
              <label htmlFor="te-work" className={label}>
                Work date <span className="text-st-red-strong">*</span>
              </label>
              <DateField
                id="te-work"
                value={workDate}
                invalid={!!fieldError("work", "work_date")}
                onChange={(iso, typed) => {
                  setWorkDate(iso);
                  setWorkTyped(typed);
                }}
              />
              <FieldNote id="te-work-error" message={fieldError("work", "work_date")} />
            </div>
            <div>
              <label htmlFor="te-due" className={label}>
                Due date <span className="font-normal">(optional)</span>
              </label>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <DateField
                    id="te-due"
                    value={due}
                    invalid={!!fieldError("due", "due_date")}
                    onChange={(iso, typed) => {
                      setDue(iso);
                      setDueTyped(typed);
                    }}
                  />
                </div>
                {due && (
                  <button
                    type="button"
                    onClick={() => {
                      setDue("");
                      setDueTyped(false);
                    }}
                    className="shrink-0 rounded-md px-2 py-1 text-sm text-muted hover:bg-track hover:text-ink"
                  >
                    Clear
                  </button>
                )}
              </div>
              <FieldNote id="te-due-error" message={fieldError("due", "due_date")} />
              {!fieldError("due", "due_date") && (
                <p className={`mt-1 text-sm font-medium ${dueTone(dueOffset, state)}`}>
                  {state === "done" ? "Completed" : due ? dueText(previewTask) : "No due date"}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="te-priority" className={label}>
                Priority
              </label>
              <select
                id="te-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className={`${control} w-full`}
              >
                {PRIORITIES.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="te-status" className={label}>
                Status
              </label>
              <select
                id="te-status"
                value={state}
                onChange={(e) => setState(e.target.value as TaskState)}
                className={`${control} w-full`}
              >
                {STATES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="te-note" className={label}>
              {state === "blocked" ? "What is it waiting on?" : "Description / Work notes"}
              {state === "blocked" && <span className="ml-1 text-st-red-strong">*</span>}
            </label>
            <textarea
              id="te-note"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={state === "blocked" ? "e.g. Waiting for the vendor to resend the export file" : "Work performed, outcomes and any blockers..."}
              aria-invalid={!!fieldError("note", "note")}
              className={`w-full rounded-lg border border-line bg-surface px-3.5 py-2 text-[15px] outline-none placeholder:text-muted focus:border-st-blue focus:ring-2 focus:ring-st-blue/20 ${
                fieldError("note", "note") ? "border-st-red!" : ""
              }`}
            />
            <FieldNote id="te-note-error" message={fieldError("note", "note")} />
          </div>

          {serverError && (
            <p role="alert" className="rounded-lg bg-st-red/8 px-3 py-2 text-sm font-medium text-st-red-strong">
              {serverError}
            </p>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-6 py-3.5">
          {
            <span className="mr-auto flex gap-2">
              {task.state !== "done" && (
                <button type="button" onClick={markDone} disabled={busy} className={`${btn} text-st-green disabled:cursor-not-allowed disabled:opacity-60`}>
                  ✓ Mark as done
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="rounded-lg px-3 py-2 text-[15px] font-medium text-st-red-strong hover:bg-st-red/8"
              >
                Delete
              </button>
            </span>
          }
          <button type="button" onClick={onClose} className={btn}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!dirty || busy}
            title={dirty ? "Save (Ctrl+Enter)" : "No changes yet"}
            className="rounded-lg bg-header px-4 py-2 text-[15px] font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-accent dark:text-header"
          >
            {busy ? "Saving..." : "Save changes"}
          </button>
        </footer>
        {confirmDelete && (
          <ConfirmDialog
            title="Delete task?"
            message={
              <p>
                <b className="text-ink">{task.title}</b> will be permanently deleted. This cannot be undone.
              </p>
            }
            confirmLabel="Delete task"
            busyLabel="Deleting..."
            busy={busy}
            error={serverError}
            onConfirm={remove}
            onCancel={() => setConfirmDelete(false)}
          />
        )}
      </form>
    </div>
  );
}
