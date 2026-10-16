"use client";

// Navbar Refresh: re-reads every data source from the backend without reloading the page.

import { getState, refresh } from "./store";

const MIN_SPINNER_MS = 600; // long enough for the spinner to register, so the click feels acknowledged

/** Reloads everything from the API. Throws if the reload failed (the previous data stays on screen). */
export async function refreshData(): Promise<void> {
  const started = Date.now();
  await refresh(); // never throws: a failure is recorded in the store
  const { error } = getState();
  if (error) throw new Error(error);
  const elapsed = Date.now() - started;
  if (elapsed < MIN_SPINNER_MS) await new Promise((r) => setTimeout(r, MIN_SPINNER_MS - elapsed));
}
