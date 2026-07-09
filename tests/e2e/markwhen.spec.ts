// markwhen parsing → Spacetime events, and folding markwhen notes into
// buildSpacetime. Pure node, no browser.

import { test, expect } from "@playwright/test";
import { parseMarkwhenEvents } from "../../src/lib/markwhen";
import { buildSpacetime } from "../../src/lib/spacetime";
import type { SpacetimeNote } from "../../src/lib/spacetime";

test("markwhen — all-day, multi-day span, and timed events", () => {
  const body = [
    "2026-06-15: Order v0.1.0 release",
    "2026-07-01/2026-07-05: Summer trip",
    "2026-08-20 17:00: Medium deadline",
  ].join("\n");
  const events = parseMarkwhenEvents(body);
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));

  expect(byTitle["Order v0.1.0 release"]).toEqual({
    date: "2026-06-15", title: "Order v0.1.0 release", allDay: true,
  });
  expect(byTitle["Summer trip"]).toEqual({
    date: "2026-07-01", title: "Summer trip", endDate: "2026-07-05",
  });
  expect(byTitle["Medium deadline"]).toEqual({
    date: "2026-08-20", title: "Medium deadline", time: "17:00",
  });
});

test("markwhen — buildSpacetime folds in a markwhen note's events with its folder", () => {
  // Folder identity is structural: the events inherit the markwhen
  // note's parent DIRECTORY (there is no `folder:` frontmatter).
  const notes: SpacetimeNote[] = [
    {
      filename: "Roadmap.md",
      frontmatter: { markwhen: true },
      path: "Craft/Craft Projects/Order/Roadmap.md",
      body: "2026-06-15: Order v0.1.0 release\n2026-08-20 17:00: Medium deadline\n",
      title: "Roadmap",
    },
  ];
  const st = buildSpacetime(notes, { areas: [], hiddenRefs: new Set() });
  const titles = st.events.map((e) => e.title).sort();
  expect(titles).toEqual(["Medium deadline", "Order v0.1.0 release"]);
  for (const e of st.events) expect(e.folder).toBe("Order");
});

test("markwhen — folder falls back to the note's directory when no folder: frontmatter", () => {
  const notes: SpacetimeNote[] = [
    {
      filename: "Retro SD Card.md",
      frontmatter: { markwhen: true }, // no folder:
      path: "Craft/Craft Projects/Retro SD Card/Retro SD Card.md",
      body: "2026-06-17 7am: Test\n",
      title: "Retro SD Card",
    },
  ];
  const st = buildSpacetime(notes, { areas: [], hiddenRefs: new Set() });
  expect(st.events).toHaveLength(1);
  expect(st.events[0]).toMatchObject({ date: "2026-06-17", title: "Test", time: "07:00", folder: "Retro SD Card" });
});

test("markwhen — a markwhen event already backed by a note is not duplicated", () => {
  const notes: SpacetimeNote[] = [
    {
      filename: "Roadmap.md",
      frontmatter: { markwhen: true, folder: "[[Order]]" },
      body: "2026-06-15: Order v0.1.0 release\n",
      title: "Roadmap",
    },
    {
      // The materialized backing note for the same event.
      filename: "2026-06-15 Order v0.1.0 release.md",
      frontmatter: { allDay: true, date: "2026-06-15", folder: "[[Order]]", title: "Order v0.1.0 release" },
      body: "# Order v0.1.0 release\n",
      title: "Order v0.1.0 release",
    },
  ];
  const st = buildSpacetime(notes, { areas: [], hiddenRefs: new Set() });
  const releaseEvents = st.events.filter((e) => e.title === "Order v0.1.0 release");
  expect(releaseEvents).toHaveLength(1);
});
