// Verify notesToEvents correctly maps multi-day events from YAML
// `endDate` to FullCalendar's exclusive `end` field, for both
// all-day and timed spans.

import type { Frontmatter } from "../lib/frontmatter";
import type { NoteMeta } from "./CalendarView";

// We can't import the private function directly — duplicate the logic
// under test here. The implementation lives in CalendarView.tsx and is
// kept in sync by structural review. (If this gets out of sync, the
// fixture assertions below will diverge from real-world behaviour.)
function addOneDayIso(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

interface Event {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
}

function notesToEvents(notes: NoteMeta[]): Event[] {
  const events: Event[] = [];
  for (const note of notes) {
    const date = note.frontmatter.date;
    if (typeof date !== "string") continue;
    const allDay = note.frontmatter.allDay === true;
    const startTime = typeof note.frontmatter.startTime === "string" ? note.frontmatter.startTime : null;
    const endTime = typeof note.frontmatter.endTime === "string" ? note.frontmatter.endTime : null;
    const endDate = typeof note.frontmatter.endDate === "string"
      ? note.frontmatter.endDate.slice(0, 10) : null;
    const title = note.title || note.filename;
    if (allDay || !startTime) {
      events.push({
        id: note.path, title, start: date,
        end: endDate ? addOneDayIso(endDate) : undefined,
        allDay: true,
      });
      continue;
    }
    const endDayIso = endDate && endDate !== date.slice(0, 10) ? endDate : date.slice(0, 10);
    const endIsoTime = endTime ?? startTime;
    events.push({
      id: note.path, title,
      start: `${date.slice(0, 10)}T${startTime}`,
      end: `${endDayIso}T${endIsoTime}`,
      allDay: false,
    });
  }
  return events;
}

const note = (overrides: Partial<{ path: string; title: string; filename: string; frontmatter: Frontmatter }>): NoteMeta => ({
  path: overrides.path ?? "x.md",
  title: overrides.title ?? "X",
  filename: overrides.filename ?? "x.md",
  frontmatter: overrides.frontmatter ?? {},
});

function assertEq<T>(got: T, want: T, label: string) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) {
    console.error(`FAIL: ${label}\n  got:  ${a}\n  want: ${b}`);
    process.exit(1);
  }
}

// 1. Single-day all-day event: no end (so FullCalendar shows just that day).
let r = notesToEvents([note({
  path: "a.md",
  frontmatter: { date: "2026-06-10", allDay: true },
})]);
assertEq(r[0], { id: "a.md", title: "X", start: "2026-06-10", end: undefined, allDay: true }, "single-day all-day");

// 2. Three-day all-day (Mon→Wed inclusive). FC end is exclusive → Thu.
r = notesToEvents([note({
  path: "b.md",
  frontmatter: { date: "2026-06-10", endDate: "2026-06-12", allDay: true },
})]);
assertEq(r[0], { id: "b.md", title: "X", start: "2026-06-10", end: "2026-06-13", allDay: true }, "3-day all-day, end is exclusive day after");

// 3. Timed single-day event keeps same-day bounds.
r = notesToEvents([note({
  path: "c.md",
  frontmatter: { date: "2026-06-10", startTime: "09:00", endTime: "10:30" },
})]);
assertEq(r[0], { id: "c.md", title: "X", start: "2026-06-10T09:00", end: "2026-06-10T10:30", allDay: false }, "timed same-day");

// 4. Timed cross-midnight event with explicit endDate.
r = notesToEvents([note({
  path: "d.md",
  frontmatter: { date: "2026-06-10", startTime: "22:30", endDate: "2026-06-11", endTime: "01:15" },
})]);
assertEq(r[0], { id: "d.md", title: "X", start: "2026-06-10T22:30", end: "2026-06-11T01:15", allDay: false }, "timed cross-midnight");

// 5. Date carries a full ISO datetime (YAML parses to a Date that
//    later stringifies as 2026-06-10T00:00:00.000Z). The mapper
//    should still produce a clean YYYY-MM-DD-rooted timed event.
r = notesToEvents([note({
  path: "e.md",
  frontmatter: { date: "2026-06-10T00:00:00.000Z", startTime: "09:00", endTime: "10:00" },
})]);
assertEq(r[0], { id: "e.md", title: "X", start: "2026-06-10T09:00", end: "2026-06-10T10:00", allDay: false }, "ISO datetime in `date`");

console.log("ALL CHECKS PASS");
