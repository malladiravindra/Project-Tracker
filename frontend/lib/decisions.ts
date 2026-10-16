"use client";

// Decision history: what the manager decided on each pending project decision.
//
// PENDING decisions come from the server (GET /dashboard/decisions/, i.e. each project's `decision` field).
// Recording an outcome (POST /projects/<id>/decision/resolve/) creates a record and clears the pending
// decision in one step, so an item can never be in both lists. Nothing is deleted: the record keeps a
// snapshot of the project at decision time. The records are loaded by lib/store.ts from GET /decision-history/.

import { api } from "./api";
import { decisionRecords, type DecisionRecord, type Outcome } from "./data";
import { mapDecisionRecord, mutate, numericId, SCOPES, useStore } from "./store";

export type { DecisionRecord, Outcome } from "./data";

export const OUTCOMES: Outcome[] = ["Approved", "Rejected", "Deferred", "Resolved"];

/** All recorded decisions, newest decision first (as served). Re-renders the caller whenever the store reloads. */
export function useDecisionHistory(): DecisionRecord[] {
  useStore();
  return decisionRecords;
}

export interface DecisionInput {
  projectId: string;
  outcome: Outcome;
  notes?: string;
  decisionDate: string; // YYYY-MM-DD
}

/** Saves the outcome; the server snapshots the project and clears the pending decision. Throws on failure. */
export async function recordDecision(input: DecisionInput): Promise<DecisionRecord> {
  const res = await mutate(
    () =>
      api.resolveDecision(numericId(input.projectId), {
        outcome: input.outcome,
        notes: input.notes,
        decision_date: input.decisionDate,
      }),
    SCOPES.decision,
  );
  // The refetch after the write has normally loaded the record already; otherwise map the server's copy.
  return decisionRecords.find((r) => r.id === String(res.record.id)) ?? mapDecisionRecord(res.record);
}

/** Undo: withdraws a record so the decision is pending again. Throws on failure (e.g. a newer decision exists). */
export async function removeDecision(rec: DecisionRecord): Promise<void> {
  if (rec.projectId === null || rec.activityId === null) throw new Error("This decision can no longer be undone.");
  const projectId = numericId(rec.projectId);
  const activityId = rec.activityId;
  await mutate(() => api.undoDecision(projectId, activityId), SCOPES.decision);
}
