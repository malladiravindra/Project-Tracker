// Pure date helpers for "what day is it on the server". No imports, no React, erasable TypeScript only,
// so Node can run this file directly in tests. "ISO date" always means a calendar date: YYYY-MM-DD.

const pad = (n: number) => String(n).padStart(2, "0");

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(timeZone: string, instant: Date | number) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  const out: Record<string, number> = {};
  for (const p of f.formatToParts(instant)) if (p.type !== "literal") out[p.type] = Number(p.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Calendar date in the given IANA time zone at the given instant. */
export function serverDateIn(timeZone: string, instant: Date | number): string {
  const p = wallParts(timeZone, instant);
  return `${String(p.year).padStart(4, "0")}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * A Date constructed in the BROWSER's local zone whose year/month/day/hours/minutes/seconds are the wall-clock
 * parts in `timeZone`. Code that calls getDate()/getHours()/addDays() on it then works on the server's calendar.
 * It is not a real instant; never compare it with real timestamps.
 */
export function serverWallClock(timeZone: string, instant: Date | number): Date {
  const p = wallParts(timeZone, instant);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The YYYY-MM-DD of a Date's local (wall-clock) parts. */
export function wallClockIso(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A local-midnight Date for an ISO date (for display formatting only). */
export function isoToLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Whole days since 1970-01-01 for an ISO date. Pure UTC arithmetic, so no DST or zone drift. */
export function isoToDayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round(t.getTime() / 86_400_000);
}

/** Days from isoB to isoA (positive when isoA is later). `diffDays(date, today)` is the offset of `date`. */
export function diffDays(isoA: string, isoB: string): number {
  return isoToDayNumber(isoA) - isoToDayNumber(isoB);
}

/** The ISO date n days after (or before, when negative) `iso`. */
export function addDaysIso(iso: string, n: number): string {
  const t = new Date(0);
  t.setTime(isoToDayNumber(iso) * 86_400_000);
  t.setUTCDate(t.getUTCDate() + n);
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whole minutes (never negative) from an ISO timestamp to a real instant. */
export function minutesBetween(createdAtIso: string, instant: Date | number): number {
  const t = typeof instant === "number" ? instant : instant.getTime();
  return Math.max(0, Math.floor((t - Date.parse(createdAtIso)) / 60_000));
}

/** True when the string names a time zone this runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}
