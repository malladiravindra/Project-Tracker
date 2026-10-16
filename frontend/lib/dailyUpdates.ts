"use client";

// Daily work updates shared with the manager, plus the manager's review status and feedback.
//
// DATA SOURCE: the REST API (GET /daily-updates/). lib/store.ts loads the rows into `dailyUpdates`
// (lib/data.ts) and refetches them after every change, so the database is the only source of truth.
// Reviews and feedback are saved with PATCH /daily-updates/<id>/ and POST /daily-updates/<id>/feedback/.

import { api } from "./api";
import { dailyUpdates, type DailyUpdate, type FeedbackType, type ReviewStatus } from "./data";
import { mutate, numericId, SCOPES, useStore } from "./store";

export type { DailyUpdate, Feedback, FeedbackType, OverallStatus, ReviewStatus } from "./data";

export const FEEDBACK_TYPES: FeedbackType[] = ["Suggestion", "Appreciation", "Improvement required", "Next steps"];

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  feedback: "Feedback given",
};

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** All shared updates, newest first (as served). Re-renders the caller whenever the store reloads. */
export function useDailyUpdates(): DailyUpdate[] {
  useStore();
  return dailyUpdates;
}

const reviewing = new Set<string>();

/**
 * Opening an update counts as reviewing it (only moves New -> Reviewed). The status changes only once the server
 * has accepted it, so on failure the update stays "New" (matching the database) and the server's error is thrown
 * for the caller to show.
 */
export async function markReviewed(update: DailyUpdate): Promise<void> {
  if (update.reviewStatus !== "new" || reviewing.has(update.id)) return;
  reviewing.add(update.id);
  try {
    await mutate(() => api.markUpdateReviewed(numericId(update.id)), SCOPES.review);
  } finally {
    reviewing.delete(update.id);
  }
}

/** Adds a feedback entry (earlier entries are kept). Throws the server's message on failure. */
export async function addFeedback(update: DailyUpdate, type: FeedbackType, content: string): Promise<void> {
  await mutate(() => api.addFeedback(numericId(update.id), { type, content }), SCOPES.feedback);
}
