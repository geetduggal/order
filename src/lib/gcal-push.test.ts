// Run: npx tsx src/lib/gcal-push.test.ts  → "ALL CHECKS PASS"
import { buildPushIntents } from "./gcal-push";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const connected = ["geet@verkada.com", "geet.duggal@gmail.com"];
const def = "geet.duggal@gmail.com";

const events: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "No sync", time: "08:00" },                                   // no emails → skip
  { date: "2026-06-25", title: "Standup", time: "09:00", endTime: "09:15", emails: ["geet@verkada.com"] },          // own acct host, no invite
  { date: "2026-06-25", title: "Rohit 1:1", time: "11:00", endTime: "11:30", emails: ["rohit@verkada.com"] },        // default host + invite
  { date: "2026-06-25", title: "Allday", emails: ["bob@acme.com"], allDay: true },            // all-day, default host + invite
];

assertEq(buildPushIntents(events, connected, def), [
  { host: "geet@verkada.com", date: "2026-06-25", time: "09:00", endTime: "09:15", allDay: false, title: "Standup", attendees: [] },
  { host: "geet.duggal@gmail.com", date: "2026-06-25", time: "11:00", endTime: "11:30", allDay: false, title: "Rohit 1:1", attendees: ["rohit@verkada.com"] },
  { host: "geet.duggal@gmail.com", date: "2026-06-25", allDay: true, title: "Allday", attendees: ["bob@acme.com"] },
], "intents: skips no-email, resolves host/attendees, all-day");

// No default + a contact-only event → no host → skipped.
assertEq(buildPushIntents([{ date: "2026-06-25", title: "X", time: "10:00", emails: ["x@y.com"] }], connected, null), [], "no host → skipped");

// Multi-day events carry endDate to the intent (both all-day and timed spans).
assertEq(buildPushIntents([
  { date: "2026-06-25", title: "Trip", endDate: "2026-06-27", allDay: true, emails: ["bob@acme.com"] },
  { date: "2026-06-25", title: "Conf", time: "09:00", endTime: "17:00", endDate: "2026-06-27", emails: ["bob@acme.com"] },
], connected, def), [
  { host: "geet.duggal@gmail.com", date: "2026-06-25", endDate: "2026-06-27", allDay: true, title: "Trip", attendees: ["bob@acme.com"] },
  { host: "geet.duggal@gmail.com", date: "2026-06-25", time: "09:00", endTime: "17:00", endDate: "2026-06-27", allDay: false, title: "Conf", attendees: ["bob@acme.com"] },
], "intents: multi-day all-day + timed carry endDate");

console.log("ALL CHECKS PASS");
