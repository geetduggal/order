// Run: npx tsx src/lib/spacetime.gcal-serialize.test.ts  → "ALL CHECKS PASS"
import { parseMarkwhenFormat, serializeMarkwhen, spliceMwEvents, type SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const events: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "Standup", folder: "Verkada", time: "09:00", emails: ["geet@verkada.com"] },
  { date: "2026-06-25", title: "Planning", folder: "Verkada", time: "14:00", emails: ["a@x.com", "b@y.com"] },
  { date: "2026-06-25", title: "Solo", folder: "Verkada", time: "16:00" },
];

// serializeMarkwhen round-trips emails.
const mw = serializeMarkwhen({ space: [], seasons: [], events });
const back = parseMarkwhenFormat(mw).events;
const norm = (e: SpacetimeEvent) => ({ date: e.date, title: e.title, time: e.time, emails: e.emails ?? null });
assertEq(back.map(norm),
  [
    { date: "2026-06-25", title: "Standup", time: "09:00", emails: ["geet@verkada.com"] },
    { date: "2026-06-25", title: "Planning", time: "14:00", emails: ["a@x.com", "b@y.com"] },
    { date: "2026-06-25", title: "Solo", time: "16:00", emails: null },
  ],
  "serializeMarkwhen round-trip");

// The serialized line literally contains the emails after the tag.
if (!mw.includes(": Standup #verkada geet@verkada.com")) throw new Error("FAIL: emails not appended after tag in serializeMarkwhen\n" + mw);
console.log("ok: emails appear after tag");

// spliceMwEvents also emits emails.
const spliced = spliceMwEvents("# Time\n\n## Events\n", events);
if (!spliced.includes(": Planning #verkada a@x.com b@y.com")) throw new Error("FAIL: spliceMwEvents did not append emails\n" + spliced);
console.log("ok: spliceMwEvents appends emails");

console.log("ALL CHECKS PASS");
