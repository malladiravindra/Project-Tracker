// Rule for marking a task Blocked: the server needs a note saying what it is waiting on. Pure, no imports.

/** Same limit the server enforces on a task note. */
export const NOTE_MAX_LENGTH = 2000;

export const BLOCKED_NOTE_REQUIRED = "Say what the task is waiting on, so others can help unblock it.";
export const BLOCKED_NOTE_TOO_LONG = `Keep the note to ${NOTE_MAX_LENGTH} characters or fewer.`;

/** The trimmed note to send, or null when there is none. */
export function blockedNoteOrNull(note: string): string | null {
  const t = note.trim();
  return t ? t : null;
}

/** An error message for a note that cannot be used to block a task, or "" when it is fine. */
export function blockedNoteProblem(note: string): string {
  const t = note.trim();
  if (!t) return BLOCKED_NOTE_REQUIRED;
  if (t.length > NOTE_MAX_LENGTH) return BLOCKED_NOTE_TOO_LONG;
  return "";
}
