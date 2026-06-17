// Pure-node tests for the Spacetime canonical serializer (no browser).
// Verifies the generated spacetime.yml is legal YAML, round-trips to the
// expected structure, leads each time record with date+title, and aligns
// the anchored columns the way SPACETIME.md shows.

import { test, expect } from "@playwright/test";
import yaml from "js-yaml";
import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  serializeSpacetime,
  parseSpacetime,
  buildSpacetime,
  type Spacetime,
  type SpacetimeNote,
} from "../../src/lib/spacetime";
import { splitFrontmatter } from "../../src/lib/frontmatter";
import { buildVaultTaxonomy } from "../../src/lib/taxonomy";

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

test("spacetime — builds from a real vault on disk into legal YAML", async () => {
  const vaultRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "vault",
  );
  // Walk every .md, splitting frontmatter so we get the same notes the
  // app would. (Filenames carry {{TODAY}} placeholders, so we don't
  // assert on specific events — just that the build + serialize is sound.)
  const notes: SpacetimeNote[] = [];
  async function walk(dir: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      if (!ent.name.endsWith(".md")) continue;
      const raw = await fs.readFile(full, "utf8");
      const { frontmatter, body } = splitFrontmatter(raw);
      notes.push({ filename: ent.name, frontmatter, body });
    }
  }
  await walk(vaultRoot);
  const tax = buildVaultTaxonomy(notes);
  const text = serializeSpacetime(buildSpacetime(notes, tax));

  // Legal YAML, with the two top-level keys and the Alpha area in space.
  const parsed = yaml.load(text) as { space: Array<Record<string, unknown>>; time: unknown };
  expect(Object.keys(parsed)).toEqual(["space", "time"]);
  const areaNames = parsed.space.map((a) => Object.keys(a)[0] ?? Object.values(a)[0]);
  expect(areaNames).toContain("Alpha");
});

test("spacetime — a long title doesn't blow out the column for other rows", () => {
  const st: Spacetime = {
    space: [],
    seasons: [],
    events: [
      { date: "2025-11-06", title: "JD Firmware Delivery", folder: "Hiring", time: "15:30" },
      { date: "2025-11-13", title: "A".repeat(180), folder: "Hiring", time: "13:30" },
      { date: "2025-11-14", title: "Han Song", folder: "Hiring", time: "11:00" },
    ],
  };
  const text = serializeSpacetime(st);
  const lines = text.split("\n").filter((l) => /^\s*- \{date: /.test(l));
  // The short rows stay well under the runaway width (capped), even though
  // one row has a 180-char title.
  const shortRows = lines.filter((l) => !l.includes("A".repeat(180)));
  for (const l of shortRows) expect(l.length).toBeLessThan(110);
  // Still legal YAML.
  expect(() => yaml.load(text)).not.toThrow();
});

test("spacetime — serialize then parse round-trips the model", () => {
  const parsed = parseSpacetime(serializeSpacetime(SHOWCASE));
  expect(parsed).toEqual(SHOWCASE);
});

test("spacetime — parser keeps dates and times as strings (JSON schema)", () => {
  const parsed = parseSpacetime(serializeSpacetime(SHOWCASE));
  const standup = parsed.events.find((e) => e.title === "Team standup")!;
  expect(standup.time).toBe("09:00");
  expect(standup.date).toBe("2026-06-16");
  expect(typeof standup.time).toBe("string");
});

test("spacetime — space nesting indents 4 spaces per level", () => {
  const text = serializeSpacetime(SHOWCASE);
  const lines = text.split("\n");
  expect(lines[0]).toBe("space:");
  expect(lines).toContain("  - Entertainment:");
  expect(lines).toContain("      - Games:");
  expect(lines).toContain("          - Board Games");
});
