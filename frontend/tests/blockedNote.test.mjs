import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_NOTE_REQUIRED,
  BLOCKED_NOTE_TOO_LONG,
  NOTE_MAX_LENGTH,
  blockedNoteOrNull,
  blockedNoteProblem,
} from "../lib/blockedNote.ts";

test("empty and whitespace-only notes are rejected with the required message", () => {
  assert.equal(blockedNoteProblem(""), BLOCKED_NOTE_REQUIRED);
  assert.equal(blockedNoteProblem("   "), BLOCKED_NOTE_REQUIRED);
  assert.equal(blockedNoteProblem("\n\t \r\n"), BLOCKED_NOTE_REQUIRED);
  assert.equal(BLOCKED_NOTE_REQUIRED, "Say what the task is waiting on, so others can help unblock it.");
  assert.equal(blockedNoteOrNull("  \n "), null);
});

test("a real note is accepted and trimmed", () => {
  assert.equal(blockedNoteProblem("Waiting for the vendor"), "");
  assert.equal(blockedNoteOrNull("  Waiting for the vendor \n"), "Waiting for the vendor");
});

test("length limit matches the server (2000 characters, after trimming)", () => {
  assert.equal(NOTE_MAX_LENGTH, 2000);
  assert.equal(blockedNoteProblem("a".repeat(2000)), "");
  assert.equal(blockedNoteProblem("a".repeat(2001)), BLOCKED_NOTE_TOO_LONG);
  assert.equal(blockedNoteProblem(`  ${"a".repeat(2000)}  `), ""); // padding is trimmed away
  assert.equal(blockedNoteProblem("a".repeat(5000)), BLOCKED_NOTE_TOO_LONG);
});
