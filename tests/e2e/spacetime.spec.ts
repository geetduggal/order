// Pure-node tests for the Spacetime canonical serializer (no browser).
// Verifies the generated spacetime.yml is legal YAML, round-trips to the
// expected structure, leads each time record with date+title, and aligns
// the anchored columns the way SPACETIME.md shows.

import { test, expect } from "@playwright/test";
import yaml from "js-yaml";
import {
  serializeSpacetime,
  type Spacetime,
} from "../../src/lib/spacetime";

const SHOWCASE: Spacetime = {
  space: [
    {
      name: "Entertainment",
      children: [
        { name: "Games", children: [{ name: "Board Games", children: [] }, { name: "Video Games", children: [] }] },
        { name: "Music", children: [{ name: "Jazz", children: [] }, { name: "Rock", children: [] }] },
      ],
    },
    {
      name: "Work",
      children: [
        { name: "Projects", children: [{ name: "Order", children: [] }, { name: "PKM System", children: [] }] },
        { name: "Teams", children: [{ name: "Frontend", children: [] }, { name: "Firmware", children: [] }] },
      ],
    },
  ],
  seasons: [
    { date: "2026-06-01", title: "Summer Building", endDate: "2026-08-31" },
    { date: "2026-09-01", title: "Community Focus", endDate: "2026-11-30" },
  ],
  events: [
    { date: "2026-06-15", title: "Order v0.1.0 Release", folder: "Order", allDay: true },
    { date: "2026-06-16", title: "Team standup", folder: "Frontend", time: "09:00", endTime: "09:30" },
    { date: "2026-07-01", title: "Summer trip", folder: "Entertainment", endDate: "2026-07-05" },
    { date: "2026-07-10", title: "Company offsite", folder: "Work", allDay: true },
    { date: "2026-08-20", title: "Medium deadline", folder: "Order", time: "17:00" },
  ],
};

test("spacetime — output is legal YAML with the right shape", () => {
  const text = serializeSpacetime(SHOWCASE);
  // Legal YAML: parses without throwing.
  const parsed = yaml.load(text) as Record<string, unknown>;
  expect(parsed).toBeTruthy();
  expect(Object.keys(parsed)).toEqual(["space", "time"]);
  const time = parsed.time as { seasons: Record<string, unknown>[]; events: Record<string, unknown>[] };
  expect(time.seasons).toHaveLength(2);
  expect(time.events).toHaveLength(5);
  // Text fields round-trip cleanly. (Dates parse as YAML timestamps and
  // bare HH:MM as sexagesimal numbers — the example's own unquoted
  // convention; we assert the textual form below.)
  expect(time.events[1].title).toBe("Team standup");
  expect(time.events[1].folder).toBe("Frontend");
  // Space round-trips as nested lists/maps.
  const space = parsed.space as Array<Record<string, unknown>>;
  expect(Object.keys(space[0])).toEqual(["Entertainment"]);
});

test("spacetime — dates and times are emitted bare (example convention)", () => {
  const text = serializeSpacetime(SHOWCASE);
  expect(text).toMatch(/date: 2026-06-15,/);
  expect(text).toMatch(/time: 09:00,/);
  expect(text).toMatch(/endDate: 2026-07-05}/);
});

test("spacetime — records lead with date then title", () => {
  const text = serializeSpacetime(SHOWCASE);
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*- \{(.*)\}$/);
    if (!m) continue;
    expect(m[1].startsWith("date: ")).toBe(true);
    expect(m[1]).toMatch(/^date: \S+, +title: /);
  }
});

test("spacetime — anchored columns are aligned across event rows", () => {
  const text = serializeSpacetime(SHOWCASE);
  const eventLines = text
    .split("\n")
    .filter((l) => /^\s*- \{date: /.test(l) && /folder:/.test(l));
  expect(eventLines.length).toBe(5);
  // `folder:` starts at the same column in every event row.
  const cols = eventLines.map((l) => l.indexOf("folder:"));
  expect(new Set(cols).size).toBe(1);
  // `title:` likewise.
  const titleCols = eventLines.map((l) => l.indexOf("title:"));
  expect(new Set(titleCols).size).toBe(1);
});

test("spacetime — space nesting indents 4 spaces per level", () => {
  const text = serializeSpacetime(SHOWCASE);
  const lines = text.split("\n");
  expect(lines[0]).toBe("space:");
  expect(lines).toContain("  - Entertainment:");
  expect(lines).toContain("      - Games:");
  expect(lines).toContain("          - Board Games");
});
