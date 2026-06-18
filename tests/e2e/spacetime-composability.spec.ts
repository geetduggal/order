// Pure-node tests for Spacetime composability:
// - brood merging (compatible + conflicting)
// - folder-ref validation
// - season and event deduplication across sources
import { test, expect } from "@playwright/test";
import {
  mergeSpacetimes, validateFolderRefs, type SpacetimeSource, type Spacetime,
} from "../../src/lib/spacetime";

function src(parsed: Spacetime, path: string): SpacetimeSource {
  return { parsed, path };
}

// ---------- Compatible merge (non-overlapping broods) ----------

test("compatible merge: two files define different areas", () => {
  const a: Spacetime = {
    space: [
      { name: "Entertainment", children: [
        { name: "Games", children: [] },
        { name: "Music", children: [] },
      ]},
    ],
    seasons: [], events: [],
  };
  const b: Spacetime = {
    space: [
      { name: "Work", children: [
        { name: "Projects", children: [] },
        { name: "Teams", children: [] },
      ]},
    ],
    seasons: [], events: [],
  };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  expect(r.conflicts).toHaveLength(0);
  expect(r.spacetime.space).toHaveLength(2);
  expect(r.spacetime.space.map(n => n.name)).toEqual(["Entertainment", "Work"]);
});

test("compatible merge: one file defines areas, another adds folders under them", () => {
  // File A: top-level with areas and empty categories
  const a: Spacetime = {
    space: [
      { name: "Work", children: [
        { name: "Projects", children: [] },
      ]},
    ],
    seasons: [], events: [],
  };
  // File B: defines folders under Work/Projects
  const b: Spacetime = {
    space: [
      { name: "Work", children: [
        { name: "Projects", children: [
          { name: "Order Build", children: [] },
          { name: "PKM System", children: [] },
        ]},
      ]},
    ],
    seasons: [], events: [],
  };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  // B provides a deeper brood for the same nodes — both define Work's children
  // as [Projects] so that's compatible; B adds folders under Projects
  expect(r.conflicts).toHaveLength(0);
  const proj = r.spacetime.space[0]?.children[0];
  expect(proj?.name).toBe("Projects");
  expect(proj?.children).toHaveLength(2);
});

// ---------- Brood conflict detection ----------

test("conflict: two files define the same parent's children differently", () => {
  const a: Spacetime = {
    space: [
      { name: "Entertainment", children: [
        { name: "Games", children: [] },
        { name: "Music", children: [] },
      ]},
    ],
    seasons: [], events: [],
  };
  const b: Spacetime = {
    space: [
      { name: "Entertainment", children: [
        { name: "Games", children: [] },
        { name: "Music", children: [] },
        { name: "Art", children: [] },   // <-- extra child
      ]},
    ],
    seasons: [], events: [],
  };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  expect(r.conflicts.length).toBeGreaterThan(0);
  expect(r.conflicts[0].kind).toBe("brood");
  expect(r.conflicts[0].paths).toContain("a.mw");
  expect(r.conflicts[0].paths).toContain("b.mw");
});

test("no conflict: same children in different order is compatible", () => {
  const a: Spacetime = {
    space: [{ name: "Work", children: [
      { name: "Projects", children: [] },
      { name: "Teams", children: [] },
    ]}],
    seasons: [], events: [],
  };
  const b: Spacetime = {
    space: [{ name: "Work", children: [
      { name: "Teams", children: [] },   // order swapped — same SET
      { name: "Projects", children: [] },
    ]}],
    seasons: [], events: [],
  };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  expect(r.conflicts).toHaveLength(0);
  // First source's order wins
  expect(r.spacetime.space[0].children.map(n => n.name)).toEqual(["Projects", "Teams"]);
});

// ---------- Single-source: brood completeness examples from spec ----------

test("spec example: valid brood (all areas)", () => {
  const a: Spacetime = {
    space: [
      { name: "Entertainment", children: [
        { name: "Games", children: [] },
        { name: "Music", children: [] },
      ]},
      { name: "Work", children: [
        { name: "Projects", children: [] },
        { name: "Teams", children: [] },
      ]},
    ],
    seasons: [], events: [],
  };
  const r = mergeSpacetimes([src(a, "spacetime.mw")]);
  expect(r.conflicts).toHaveLength(0);
  expect(r.spacetime.space).toHaveLength(2);
});

// ---------- Folder-ref validation ----------

test("valid folder ref: event folder exists in space", () => {
  const st: Spacetime = {
    space: [{ name: "Work", children: [
      { name: "Projects", children: [
        { name: "Order Build", children: [] },
      ]},
    ]}],
    seasons: [],
    events: [{ date: "2026-06-15", title: "Ship day", folder: "Order Build" }],
  };
  const conflicts = validateFolderRefs(st, [src(st, "spacetime.mw")]);
  expect(conflicts).toHaveLength(0);
});

test("invalid folder ref: event folder not in space", () => {
  const st: Spacetime = {
    space: [{ name: "Work", children: [
      { name: "Projects", children: [
        { name: "Order Build", children: [] },
      ]},
    ]}],
    seasons: [],
    events: [{ date: "2026-06-15", title: "Ship day", folder: "Nonexistent Folder" }],
  };
  const conflicts = validateFolderRefs(st, [src(st, "spacetime.mw")]);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].kind).toBe("folderRef");
  expect(conflicts[0].message).toContain("Nonexistent Folder");
});

test("no false positive: empty space skips folder-ref validation", () => {
  const st: Spacetime = {
    space: [],   // not yet defined
    seasons: [],
    events: [{ date: "2026-06-15", title: "Ship day", folder: "Order Build" }],
  };
  const conflicts = validateFolderRefs(st, [src(st, "archive.mw")]);
  expect(conflicts).toHaveLength(0);
});

// ---------- Season dedup across sources ----------

test("seasons deduplicated by date+title across files", () => {
  const a: Spacetime = {
    space: [], events: [],
    seasons: [{ date: "2026-06-01", title: "Summer", endDate: "2026-08-31" }],
  };
  const b: Spacetime = {
    space: [], events: [],
    seasons: [
      { date: "2026-06-01", title: "Summer", endDate: "2026-08-31" }, // dup
      { date: "2026-09-01", title: "Fall" },
    ],
  };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  expect(r.spacetime.seasons).toHaveLength(2);
  expect(r.spacetime.seasons.map(s => s.title)).toEqual(["Summer", "Fall"]);
});

// ---------- Event dedup across sources ----------

test("events deduplicated by date+title across files", () => {
  const ev = { date: "2026-06-15", title: "Ship day", folder: "Order Build" };
  const a: Spacetime = { space: [], seasons: [], events: [ev] };
  const b: Spacetime = { space: [], seasons: [], events: [ev, { date: "2026-07-01", title: "Vacation" }] };
  const r = mergeSpacetimes([src(a, "a.mw"), src(b, "b.mw")]);
  expect(r.spacetime.events).toHaveLength(2);
  expect(r.spacetime.events.map(e => e.title)).toContain("Ship day");
  expect(r.spacetime.events.map(e => e.title)).toContain("Vacation");
});
