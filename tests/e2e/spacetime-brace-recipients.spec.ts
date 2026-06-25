// Pure data round-trip tests for the two sync surfaces that shipped since v0.1.0:
// (1) #[Exact Name] brace folder-tag syntax
// (2) trailing email recipients on event lines
// No browser/page — these call lib functions directly.

import { test, expect } from "@playwright/test";
import {
  parseMarkwhenFormat,
  serializeMarkwhen,
  spliceMwEvents,
  mwAddEvent,
  mwUpdateEvent,
  toBraceTag,
  stripTagToName,
  migrateMwTagsToBrace,
} from "../../src/lib/spacetime";
import type { Spacetime, SpacetimeEvent } from "../../src/lib/spacetime";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal spacetime.mw fixture with a Space section defining "Geet Duggal". */
function makeMw(eventLine: string): string {
  return [
    "# Space",
    "",
    "## Personal",
    "- People",
    "  - Geet Duggal",
    "",
    "# Time",
    "",
    "## Events",
    "",
    eventLine,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Brace folder tags
// ---------------------------------------------------------------------------

test("brace — #[Geet Duggal] event resolves folder to 'Geet Duggal'", () => {
  const mw = makeMw("2026-06-20: Dentist #[Geet Duggal]");
  const st = parseMarkwhenFormat(mw);
  expect(st.events).toHaveLength(1);
  expect(st.events[0].folder).toBe("Geet Duggal");
  expect(st.events[0].title).toBe("Dentist");
});

test("brace — legacy #geet-duggal (kebab) resolves to 'Geet Duggal' (back-compat)", () => {
  const mw = makeMw("2026-06-21: Yoga #geet-duggal");
  const st = parseMarkwhenFormat(mw);
  expect(st.events).toHaveLength(1);
  expect(st.events[0].folder).toBe("Geet Duggal");
  expect(st.events[0].title).toBe("Yoga");
});

test("brace — serializeMarkwhen emits #[Geet Duggal] brace form (case preserved)", () => {
  const st: Spacetime = {
    space: [{ name: "Personal", children: [{ name: "People", children: [{ name: "Geet Duggal", children: [] }] }] }],
    seasons: [],
    events: [{ date: "2026-06-22", title: "Run", folder: "Geet Duggal", allDay: true }],
  };
  const out = serializeMarkwhen(st);
  expect(out).toContain("#[Geet Duggal]");
  // The kebab form must NOT appear for this folder
  expect(out).not.toContain("#geet-duggal");
});

test("brace — round-trip: kebab → parse → serialize → contains #[Geet Duggal]; re-parse is stable", () => {
  const mw = makeMw("2026-06-23: Swim #geet-duggal");
  const parsed = parseMarkwhenFormat(mw);
  expect(parsed.events[0].folder).toBe("Geet Duggal");

  // Splice the events back so only the Events block is regenerated
  const serialized = spliceMwEvents(mw, parsed.events);
  expect(serialized).toContain("#[Geet Duggal]");
  expect(serialized).not.toContain("#geet-duggal");

  // Idempotency: a second parse of the serialized form gives the same folder
  const reparsed = parseMarkwhenFormat(serialized);
  expect(reparsed.events).toHaveLength(1);
  expect(reparsed.events[0].folder).toBe("Geet Duggal");
  expect(reparsed.events[0].title).toBe("Swim");
});

test("brace — migrateMwTagsToBrace rewrites kebab tags; Space section unchanged up to ## Events", () => {
  const mw = makeMw("2026-06-24: Walk #geet-duggal");

  // Capture the part of the mw before the ## Events marker (Space + leading Time section)
  const eventsIdx = mw.indexOf("## Events");
  const preEvents = mw.slice(0, eventsIdx);

  const migrated = migrateMwTagsToBrace(mw);

  // Event line now uses brace form
  expect(migrated).toContain("#[Geet Duggal]");
  expect(migrated).not.toContain("#geet-duggal");

  // Everything before ## Events is byte-identical
  const migratedEventsIdx = migrated.indexOf("## Events");
  const migratedPreEvents = migrated.slice(0, migratedEventsIdx);
  expect(migratedPreEvents).toBe(preEvents);
});

// ---------------------------------------------------------------------------
// Email recipients on event lines
// ---------------------------------------------------------------------------

test("emails — parse 'Sync #[Geet Duggal] a@x.com b@y.com' splits emails/folder/title cleanly", () => {
  const mw = makeMw("2026-07-01: Sync #[Geet Duggal] a@x.com b@y.com");
  const st = parseMarkwhenFormat(mw);
  expect(st.events).toHaveLength(1);
  const ev = st.events[0];
  expect(ev.title).toBe("Sync");
  expect(ev.folder).toBe("Geet Duggal");
  expect(ev.emails).toEqual(["a@x.com", "b@y.com"]);
});

test("emails — serializeMarkwhen writes emails after the brace tag", () => {
  const st: Spacetime = {
    space: [{ name: "Personal", children: [{ name: "People", children: [{ name: "Geet Duggal", children: [] }] }] }],
    seasons: [],
    events: [{
      date: "2026-07-02",
      title: "Call",
      folder: "Geet Duggal",
      allDay: true,
      emails: ["alice@example.com", "bob@example.com"],
    }],
  };
  const out = serializeMarkwhen(st);
  expect(out).toContain("alice@example.com");
  expect(out).toContain("bob@example.com");
  // Tag must precede the emails on the same line
  const line = out.split("\n").find((l) => l.includes("Call"))!;
  const tagIdx = line.indexOf("#[Geet Duggal]");
  const emailIdx = line.indexOf("alice@example.com");
  expect(tagIdx).toBeGreaterThan(0);
  expect(emailIdx).toBeGreaterThan(tagIdx);
});

test("emails — spliceMwEvents round-trip preserves emails", () => {
  const mw = makeMw("2026-07-03: Standup #[Geet Duggal] user@work.io");
  const st = parseMarkwhenFormat(mw);
  expect(st.events[0].emails).toEqual(["user@work.io"]);

  const spliced = spliceMwEvents(mw, st.events);
  const reparsed = parseMarkwhenFormat(spliced);
  expect(reparsed.events[0].emails).toEqual(["user@work.io"]);
  expect(reparsed.events[0].folder).toBe("Geet Duggal");
  expect(reparsed.events[0].title).toBe("Standup");
});

test("emails — mwUpdateEvent sets emails when none existed", () => {
  const mw = makeMw("2026-07-04: Review #[Geet Duggal]");
  const updated = mwUpdateEvent(mw, "2026-07-04", "Review", { emails: ["new@example.com"] });
  const st = parseMarkwhenFormat(updated);
  expect(st.events[0].emails).toEqual(["new@example.com"]);
});

test("emails — mwUpdateEvent replaces existing emails", () => {
  const mw = makeMw("2026-07-05: Debrief #[Geet Duggal] old@x.com");
  const updated = mwUpdateEvent(mw, "2026-07-05", "Debrief", { emails: ["new1@x.com", "new2@x.com"] });
  const st = parseMarkwhenFormat(updated);
  expect(st.events[0].emails).toEqual(["new1@x.com", "new2@x.com"]);
  // Old email gone
  expect(updated).not.toContain("old@x.com");
});

test("emails — mwUpdateEvent with emails: [] clears all recipients", () => {
  const mw = makeMw("2026-07-06: Meeting #[Geet Duggal] keep@x.com");
  const updated = mwUpdateEvent(mw, "2026-07-06", "Meeting", { emails: [] });
  expect(updated).not.toContain("keep@x.com");
  const st = parseMarkwhenFormat(updated);
  const ev = st.events[0];
  expect(ev.emails === undefined || ev.emails.length === 0).toBe(true);
});

test("emails — mwAddEvent with emails preserves them in the written line", () => {
  const mw = [
    "# Space",
    "",
    "## Personal",
    "- People",
    "  - Geet Duggal",
    "",
    "# Time",
    "",
    "## Events",
    "",
    "2026-08-01: Existing #[Geet Duggal]",
    "",
  ].join("\n");

  const newEv: SpacetimeEvent = {
    date: "2026-08-02",
    title: "Added",
    folder: "Geet Duggal",
    allDay: true,
    emails: ["added@example.com"],
  };
  const result = mwAddEvent(mw, newEv);
  expect(result).toContain("added@example.com");
  const st = parseMarkwhenFormat(result);
  const added = st.events.find((e) => e.title === "Added")!;
  expect(added).toBeDefined();
  expect(added.emails).toEqual(["added@example.com"]);
});

test("emails — mwAddEvent with duplicate (same date|title) is a no-op", () => {
  const mw = makeMw("2026-08-03: Yoga #[Geet Duggal] user@x.com");
  const dup: SpacetimeEvent = {
    date: "2026-08-03",
    title: "Yoga",
    folder: "Geet Duggal",
    allDay: true,
    emails: ["other@x.com"],
  };
  const result = mwAddEvent(mw, dup);
  // No-op: the original line is intact
  expect(result).toBe(mw);
  const st = parseMarkwhenFormat(result);
  expect(st.events).toHaveLength(1);
  // Original emails preserved (the new ones were not written)
  expect(st.events[0].emails).toEqual(["user@x.com"]);
});

// ---------------------------------------------------------------------------
// stripTagToName utility
// ---------------------------------------------------------------------------

test("stripTagToName — brace form returns exact inner name", () => {
  expect(stripTagToName("#[Geet Duggal]")).toBe("Geet Duggal");
  expect(stripTagToName("#[  Board Games  ]")).toBe("Board Games");
});

test("stripTagToName — kebab form returns slug minus leading #", () => {
  expect(stripTagToName("#geet-duggal")).toBe("geet-duggal");
  expect(stripTagToName("#board-games")).toBe("board-games");
});

// ---------------------------------------------------------------------------
// toBraceTag utility
// ---------------------------------------------------------------------------

test("toBraceTag — wraps name in #[...]", () => {
  expect(toBraceTag("Geet Duggal")).toBe("#[Geet Duggal]");
  expect(toBraceTag("Verkada")).toBe("#[Verkada]");
});
