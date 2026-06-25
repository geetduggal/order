// Run: npx tsx src/lib/gcal-import.test.ts  → "ALL CHECKS PASS"
import { classifyImports, type ImportedEvent } from "./gcal-import";
import type { SpacetimeEvent } from "./spacetime";

function assertEq<T>(actual: T, expected: T, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`);
  console.log(`ok: ${label}`);
}

const existing: SpacetimeEvent[] = [
  { date: "2026-06-25", title: "Standup", time: "09:00" },
  { date: "2026-06-25", title: "Holiday", allDay: true },
];
const imported: ImportedEvent[] = [
  { title: "Standup", date: "2026-06-25", time: "09:00", allDay: false, description: "x", attendees: [] },  // already have
  { title: "New mtg", date: "2026-06-25", time: "11:00", allDay: false, description: "", attendees: [] },     // new
  { title: "Holiday", date: "2026-06-25", allDay: true, description: "", attendees: [] },                      // already have (all-day)
];

assertEq(classifyImports(imported, existing).map((r) => [r.title, r.isNew]), [
  ["Standup", false], ["New mtg", true], ["Holiday", false],
], "classify new vs already-have by natural key");

console.log("ALL CHECKS PASS");
