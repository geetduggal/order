// Run: npx tsx src/lib/apple-sync-plan.test.ts  → "ALL CHECKS PASS"
import { appleIntents, appleSig, appleSyncPlan, type AppleSyncRecord } from "./apple-sync-plan";
import { naturalKey } from "./gcal-sync-plan";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const desc = () => "";
const events: SpacetimeEvent[] = [
  { date: "2026-07-20", time: "09:00", endTime: "09:30", title: "Sprint sync", apple: "Home" },
  { date: "2026-07-22", title: "Birthday", allDay: true }, // no @[cal] → ignored
  { date: "2026-07-25", title: "Furniture day", apple: "Home", allDay: true },
];

// Only @[cal] events become intents.
{
  const its = appleIntents(events, desc);
  assertEq(its.length, 2, "only tagged events become intents");
  assertEq(its[0].calendar, "Home", "calendar carried");
  assertEq(its[1].allDay, true, "all-day inferred");
}

// Empty record → everything is a write, nothing to delete.
{
  const its = appleIntents(events, desc);
  const plan = appleSyncPlan({}, its);
  assertEq(plan.writes.length, 2, "empty record → all writes");
  assertEq(plan.deletes.length, 0, "empty record → no deletes");
}

// Up-to-date record → no writes.
{
  const its = appleIntents(events, desc);
  const record: AppleSyncRecord = {};
  for (const it of its) record[naturalKey(it.date, it.time, it.title)] = { calendar: it.calendar, date: it.date, time: it.time, title: it.title, sig: appleSig(it) };
  const plan = appleSyncPlan(record, its);
  assertEq(plan.writes.length, 0, "synced record → no writes");
}

// Removing the @[cal] tag from an event → that record entry becomes a delete.
{
  const its = appleIntents(events, desc);
  const record: AppleSyncRecord = {};
  for (const it of its) record[naturalKey(it.date, it.time, it.title)] = { calendar: it.calendar, date: it.date, time: it.time, title: it.title, sig: appleSig(it) };
  // Now the user drops @[Home] from "Furniture day".
  const fewer = appleIntents(events.filter((e) => e.title !== "Furniture day"), desc);
  const plan = appleSyncPlan(record, fewer);
  assertEq(plan.deletes.length, 1, "dropped tag → one delete");
  assertEq(plan.deletes[0].title, "Furniture day", "correct delete");
}

// Editing an event's time → a write (sig changed).
{
  const its = appleIntents(events, desc);
  const record: AppleSyncRecord = {};
  for (const it of its) record[naturalKey(it.date, it.time, it.title)] = { calendar: it.calendar, date: it.date, time: it.time, title: it.title, sig: appleSig(it) };
  const moved = appleIntents(
    events.map((e) => (e.title === "Sprint sync" ? { ...e, time: "10:00" } : e)),
    desc,
  );
  const plan = appleSyncPlan(record, moved);
  // The moved event has a new natural key → it's a write, and the old key is a delete.
  assertEq(plan.writes.some((w) => w.title === "Sprint sync" && w.time === "10:00"), true, "reschedule → write");
  assertEq(plan.deletes.some((d) => d.title === "Sprint sync" && d.time === "09:00"), true, "old key → delete");
}

console.log("\nALL CHECKS PASS");
