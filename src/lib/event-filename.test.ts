// Run: npx tsx src/lib/event-filename.test.ts  → "ALL CHECKS PASS"
import { parseEventFilename, formatEventFilename, titleFromEventFilename, isEventFilename } from "./event-filename";

let failed = 0;
function eq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log("  ok:", label);
  else { console.error(`  FAIL: ${label}\n    expected ${e}\n    got      ${a}`); failed = 1; }
}

// ---- parse: the four shapes ----
eq(parseEventFilename("2026-08-13 Team Offsite"),
   { date: "2026-08-13", allDay: true, title: "Team Offsite" }, "date only → all-day");

eq(parseEventFilename("2026-08-13 0930 Standup"),
   { date: "2026-08-13", time: "09:30", allDay: false, title: "Standup" }, "date + time");

eq(parseEventFilename("2026-08-13 0930-1015 Standup"),
   { date: "2026-08-13", time: "09:30", endTime: "10:15", allDay: false, title: "Standup" }, "date + time range");

eq(parseEventFilename("2026-08-13 - 2026-08-16 Trip"),
   { date: "2026-08-13", endDate: "2026-08-16", allDay: true, title: "Trip" }, "date range → multi-day all-day");

// ---- titles: empty, punctuation, unicode ----
eq(parseEventFilename("2026-08-13")?.title, "", "date only, no title");
eq(parseEventFilename("2026-08-13 2200")?.title, "", "timed, no title");
eq(parseEventFilename("2026-08-13 Café — planning & review")?.title, "Café — planning & review", "unicode/punct title");
eq(parseEventFilename("2026-08-13 - 2026-08-16")?.endDate, "2026-08-16", "date range, no title");

// ---- not events ----
eq(parseEventFilename("Meeting notes"), null, "no date → not an event");
eq(parseEventFilename("2026-8-1 Bad"), null, "non-zero-padded date → not an event");
eq(parseEventFilename("Areas"), null, "plain note → not an event");
eq(isEventFilename("2026-08-13 x"), true, "isEventFilename true");
eq(isEventFilename("todo"), false, "isEventFilename false");

// ---- malformed time degrades to the next shape ----
eq(parseEventFilename("2026-01-01 2530 Party"),
   { date: "2026-01-01", allDay: true, title: "2530 Party" }, "invalid time (25:30) → all-day, token kept in title");
eq(parseEventFilename("2026-01-01 0960 X"),
   { date: "2026-01-01", allDay: true, title: "0960 X" }, "invalid minutes (:60) → all-day");
eq(parseEventFilename("2026-01-01 2400"),
   { date: "2026-01-01", allDay: true, title: "2400" }, "24:00 rejected → all-day title");
eq(parseEventFilename("2026-02-30 X"), null, "2026-02-30 is not a real day");

// ---- boundary times ----
eq(parseEventFilename("2026-08-13 0000 midnight")?.time, "00:00", "00:00 ok");
eq(parseEventFilename("2026-08-13 2359 last")?.time, "23:59", "23:59 ok");

// ---- title-only helpers ----
eq(titleFromEventFilename("2026-08-13 0930-1015 Standup"), "Standup", "titleFromEventFilename strips tokens");
eq(titleFromEventFilename("Plain"), "", "titleFromEventFilename on non-event → ''");

// ---- format: round-trips ----
eq(formatEventFilename({ date: "2026-08-13", allDay: true }, "Team Offsite"), "2026-08-13 Team Offsite", "format all-day");
eq(formatEventFilename({ date: "2026-08-13", time: "09:30" }, "Standup"), "2026-08-13 0930 Standup", "format timed");
eq(formatEventFilename({ date: "2026-08-13", time: "09:30", endTime: "10:15" }, "Standup"), "2026-08-13 0930-1015 Standup", "format timed range");
eq(formatEventFilename({ date: "2026-08-13", endDate: "2026-08-16" }, "Trip"), "2026-08-13 - 2026-08-16 Trip", "format date range");
eq(formatEventFilename({ date: "2026-08-13" }, ""), "2026-08-13", "format all-day, no title");
// out-of-scope timed multi-day collapses to same-day timed (endDate dropped)
eq(formatEventFilename({ date: "2026-08-13", time: "09:00", endTime: "10:00", endDate: "2026-08-14" }, "X"),
   "2026-08-13 0900-1000 X", "timed multi-day collapses to same-day");

// ---- round-trip parse(format(x)) for the four shapes ----
for (const [parts, title] of [
  [{ date: "2026-08-13", allDay: true }, "A B C"],
  [{ date: "2026-08-13", time: "07:05" }, "Run"],
  [{ date: "2026-08-13", time: "07:05", endTime: "08:00" }, "Run"],
  [{ date: "2026-08-13", endDate: "2026-08-20" }, "Vacation"],
] as const) {
  const name = formatEventFilename(parts, title);
  const back = parseEventFilename(name);
  eq(back?.date, parts.date, `round-trip date (${name})`);
  eq(back?.title, title, `round-trip title (${name})`);
}

if (failed) { console.error("SOME CHECKS FAILED"); process.exit(1); }
console.log("ALL CHECKS PASS");
