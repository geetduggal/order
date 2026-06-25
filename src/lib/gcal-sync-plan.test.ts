// Run: npx tsx src/lib/gcal-sync-plan.test.ts  → "ALL CHECKS PASS"
import { gcalSyncPlan, naturalKey, type SyncRecord } from "./gcal-sync-plan";
import type { PushIntent } from "./gcal-push";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

// Simple deterministic signature for the test (host|date|time|title|attendees).
const sig = (it: PushIntent) => [it.host, it.date, it.time ?? "", it.title, [...it.attendees].sort().join(",")].join("|");
const intent = (o: Partial<PushIntent>): PushIntent => ({ host: "you@example.com", date: "2026-06-26", allDay: false, title: "X", attendees: [], ...o });

// Record of two previously-synced events.
const rec: SyncRecord = {
  [naturalKey("2026-06-26", "09:00", "Standup")]: { host: "you@example.com", date: "2026-06-26", time: "09:00", title: "Standup", sig: "you@example.com|2026-06-26|09:00|Standup|" },
  [naturalKey("2026-06-26", "11:00", "Sync")]: { host: "you@example.com", date: "2026-06-26", time: "11:00", title: "Sync", sig: "you@example.com|2026-06-26|11:00|Sync|dana@example.com" },
};

// Current syncable events: Standup unchanged, Sync's attendees changed, plus a new event. "Sync" at 11:00 is gone (deleted).
const intents: PushIntent[] = [
  intent({ time: "09:00", title: "Standup" }),                                  // unchanged → no push
  intent({ time: "14:00", title: "Planning", attendees: ["dana@example.com"] }), // new → push
];

const plan = gcalSyncPlan(rec, intents, sig);
assertEq(plan.pushes.map((p) => p.title), ["Planning"], "push: only the new/changed event");
assertEq(plan.deletes.map((d) => `${d.title}@${d.time}`), ["Sync@11:00"], "delete: synced event no longer present");

// Edit = swap: change Standup's time → old key deletes, new key pushes.
const swapped = gcalSyncPlan(rec, [intent({ time: "09:30", title: "Standup" })], sig);
assertEq(swapped.pushes.map((p) => p.time), ["09:30"], "reschedule pushes the new key");
assertEq(new Set(swapped.deletes.map((d) => `${d.title}@${d.time}`)), new Set(["Standup@09:00", "Sync@11:00"]), "reschedule deletes the old key (+ the removed one)");

console.log("ALL CHECKS PASS");
