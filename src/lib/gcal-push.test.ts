// Run: npx tsx src/lib/gcal-push.test.ts  → "ALL CHECKS PASS"
import { buildPushIntents } from "./gcal-push";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const connected = ["you@example.com", "you-personal@example.com"];
const def = "you-personal@example.com";

const events: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "No sync", time: "08:00" },                                   // no emails → skip
  { date: "2026-06-25", title: "Standup", time: "09:00", endTime: "09:15", emails: ["you@example.com"] },          // own acct host, no invite
  { date: "2026-06-25", title: "Dana 1:1", time: "11:00", endTime: "11:30", emails: ["dana@example.com"] },        // default host + invite
  { date: "2026-06-25", title: "Allday", emails: ["sam@example.com"], allDay: true },            // all-day, default host + invite
];

assertEq(buildPushIntents(events, connected, def), [
  { host: "you@example.com", date: "2026-06-25", time: "09:00", endTime: "09:15", allDay: false, title: "Standup", attendees: [] },
  { host: "you-personal@example.com", date: "2026-06-25", time: "11:00", endTime: "11:30", allDay: false, title: "Dana 1:1", attendees: ["dana@example.com"] },
  { host: "you-personal@example.com", date: "2026-06-25", allDay: true, title: "Allday", attendees: ["sam@example.com"] },
], "intents: skips no-email, resolves host/attendees, all-day");

// No default + a contact-only event → no host → skipped.
assertEq(buildPushIntents([{ date: "2026-06-25", title: "X", time: "10:00", emails: ["x@y.com"] }], connected, null), [], "no host → skipped");

// Multi-day events carry endDate to the intent (both all-day and timed spans).
assertEq(buildPushIntents([
  { date: "2026-06-25", title: "Trip", endDate: "2026-06-27", allDay: true, emails: ["sam@example.com"] },
  { date: "2026-06-25", title: "Conf", time: "09:00", endTime: "17:00", endDate: "2026-06-27", emails: ["sam@example.com"] },
], connected, def), [
  { host: "you-personal@example.com", date: "2026-06-25", endDate: "2026-06-27", allDay: true, title: "Trip", attendees: ["sam@example.com"] },
  { host: "you-personal@example.com", date: "2026-06-25", time: "09:00", endTime: "17:00", endDate: "2026-06-27", allDay: false, title: "Conf", attendees: ["sam@example.com"] },
], "intents: multi-day all-day + timed carry endDate");

console.log("ALL CHECKS PASS");
