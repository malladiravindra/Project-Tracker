import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysIso,
  diffDays,
  isoToDayNumber,
  isValidTimeZone,
  minutesBetween,
  serverDateIn,
  serverWallClock,
  wallClockIso,
} from "../lib/serverClock.ts";

const KOLKATA = "Asia/Kolkata"; // UTC+5:30, no DST
const LA = "America/Los_Angeles";

test("Asia/Kolkata midnight boundary: 23:59:59 vs 00:00:00 local", () => {
  // 2026-03-10T18:29:59Z = 23:59:59 IST on the 10th; one second later it is the 11th.
  assert.equal(serverDateIn(KOLKATA, new Date("2026-03-10T18:29:59Z")), "2026-03-10");
  assert.equal(serverDateIn(KOLKATA, new Date("2026-03-10T18:30:00Z")), "2026-03-11");
});

test("Asia/Kolkata: the UTC date differs from the server date between 18:30 and 24:00 UTC", () => {
  for (const hhmm of ["18:30:00", "20:00:00", "23:59:59"]) {
    const instant = new Date(`2026-03-10T${hhmm}Z`);
    assert.equal(instant.toISOString().slice(0, 10), "2026-03-10");
    assert.equal(serverDateIn(KOLKATA, instant), "2026-03-11", hhmm);
  }
  assert.equal(serverDateIn(KOLKATA, new Date("2026-03-11T00:00:00Z")), "2026-03-11");
  assert.equal(serverDateIn(KOLKATA, new Date("2026-03-10T18:29:59Z")), "2026-03-10");
});

test("America/Los_Angeles is behind UTC: late-evening local is already the next UTC day", () => {
  // 2026-01-15T07:59:59Z = 23:59:59 PST on the 14th; 08:00:00Z = 00:00:00 PST on the 15th.
  assert.equal(serverDateIn(LA, new Date("2026-01-15T07:59:59Z")), "2026-01-14");
  assert.equal(serverDateIn(LA, new Date("2026-01-15T08:00:00Z")), "2026-01-15");
  // During daylight time (PDT, UTC-7) the boundary is at 07:00Z.
  assert.equal(serverDateIn(LA, new Date("2026-07-15T06:59:59Z")), "2026-07-14");
  assert.equal(serverDateIn(LA, new Date("2026-07-15T07:00:00Z")), "2026-07-15");
});

test("DST change day in Los_Angeles (2026-03-08, clocks jump 02:00 -> 03:00)", () => {
  // Before the jump: PST. 09:59:59Z = 01:59:59 PST; 10:00:00Z = 03:00:00 PDT. Same calendar day.
  assert.equal(serverDateIn(LA, new Date("2026-03-08T09:59:59Z")), "2026-03-08");
  assert.equal(serverDateIn(LA, new Date("2026-03-08T10:00:00Z")), "2026-03-08");
  // The day is 23 hours long: midnight to midnight is 08:00Z (PST) to 07:00Z next day (PDT).
  assert.equal(serverDateIn(LA, new Date("2026-03-08T07:59:59Z")), "2026-03-07");
  assert.equal(serverDateIn(LA, new Date("2026-03-08T08:00:00Z")), "2026-03-08");
  assert.equal(serverDateIn(LA, new Date("2026-03-09T06:59:59Z")), "2026-03-08");
  assert.equal(serverDateIn(LA, new Date("2026-03-09T07:00:00Z")), "2026-03-09");
});

test("DST end day in Los_Angeles (2026-11-01, 25 hours long)", () => {
  assert.equal(serverDateIn(LA, new Date("2026-11-01T06:59:59Z")), "2026-10-31");
  assert.equal(serverDateIn(LA, new Date("2026-11-01T07:00:00Z")), "2026-11-01");
  assert.equal(serverDateIn(LA, new Date("2026-11-02T07:59:59Z")), "2026-11-01");
  assert.equal(serverDateIn(LA, new Date("2026-11-02T08:00:00Z")), "2026-11-02");
});

test("serverWallClock carries the server calendar and clock parts", () => {
  const w = serverWallClock(KOLKATA, new Date("2026-03-10T18:30:05Z")); // 00:00:05 on 11 March in Kolkata
  assert.equal(w.getFullYear(), 2026);
  assert.equal(w.getMonth(), 2);
  assert.equal(w.getDate(), 11);
  assert.equal(w.getHours(), 0);
  assert.equal(w.getMinutes(), 0);
  assert.equal(wallClockIso(w), "2026-03-11");
  const la = serverWallClock(LA, new Date("2026-01-15T07:59:00Z")); // 23:59 on 14 Jan
  assert.equal(la.getDate(), 14);
  assert.equal(la.getHours(), 23);
  assert.equal(la.getMinutes(), 59);
});

test("midnight is hour 0, never 24", () => {
  const w = serverWallClock(KOLKATA, new Date("2026-03-10T18:30:00Z"));
  assert.equal(w.getHours(), 0);
});

test("diffDays: exact integers across month, year ends and leap day", () => {
  assert.equal(diffDays("2026-03-11", "2026-03-10"), 1);
  assert.equal(diffDays("2026-03-10", "2026-03-10"), 0);
  assert.equal(diffDays("2026-03-09", "2026-03-10"), -1);
  assert.equal(diffDays("2026-03-01", "2026-02-28"), 1); // 2026 is not a leap year
  assert.equal(diffDays("2028-03-01", "2028-02-28"), 2); // 2028 is a leap year
  assert.equal(diffDays("2028-02-29", "2028-02-28"), 1);
  assert.equal(diffDays("2027-01-01", "2026-12-31"), 1);
  assert.equal(diffDays("2027-01-01", "2026-01-01"), 365);
  assert.equal(diffDays("2029-01-01", "2028-01-01"), 366);
  // Across the US DST change weeks: still whole days.
  assert.equal(diffDays("2026-03-09", "2026-03-08"), 1);
  assert.equal(diffDays("2026-11-02", "2026-11-01"), 1);
  assert.equal(isoToDayNumber("1970-01-01"), 0);
  assert.equal(isoToDayNumber("1970-01-02"), 1);
});

test("addDaysIso: month/year ends, leap day, negatives", () => {
  assert.equal(addDaysIso("2026-01-31", 1), "2026-02-01");
  assert.equal(addDaysIso("2026-02-28", 1), "2026-03-01");
  assert.equal(addDaysIso("2028-02-28", 1), "2028-02-29");
  assert.equal(addDaysIso("2028-02-29", 1), "2028-03-01");
  assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysIso("2027-01-01", -1), "2026-12-31");
  assert.equal(addDaysIso("2026-03-10", 0), "2026-03-10");
  assert.equal(addDaysIso("2026-03-10", 365), "2027-03-10");
  assert.equal(addDaysIso("2026-03-10", -10), "2026-02-28");
  for (const [iso, n] of [
    ["2026-03-08", 1],
    ["2028-02-29", -400],
    ["2026-12-31", 800],
  ]) {
    assert.equal(diffDays(addDaysIso(iso, n), iso), n);
  }
});

test("offsets flip when the server date changes (before and after midnight)", () => {
  const due = "2026-03-11";
  const before = serverDateIn(KOLKATA, new Date("2026-03-10T18:29:59Z")); // 23:59:59 IST on the 10th
  const after = serverDateIn(KOLKATA, new Date("2026-03-10T18:30:00Z")); // 00:00:00 IST on the 11th
  assert.equal(diffDays(due, before), 1); // due tomorrow
  assert.equal(diffDays(due, after), 0); // due today
  assert.equal(diffDays("2026-03-10", after), -1); // yesterday's task is now overdue
  // The UTC date would have said the 10th for all of 18:30-24:00 UTC: a day off.
  assert.equal(diffDays(due, "2026-03-10"), 1);
});

test("minutesBetween", () => {
  const t = Date.parse("2026-03-10T10:00:00Z");
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", t), 0);
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", t + 59_999), 0);
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", t + 60_000), 1);
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", new Date(t + 5 * 60_000)), 5);
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", t + 25 * 3_600_000), 1500);
  assert.equal(minutesBetween("2026-03-10T10:00:00Z", t - 120_000), 0); // clock skew never gives a negative age
  assert.equal(minutesBetween("2026-03-10T15:30:00+05:30", Date.parse("2026-03-10T10:10:00Z")), 10);
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("Asia/Kolkata"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});
