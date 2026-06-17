// Reverse-sync plan engine: diffing a desired spacetime model (from a
// hand-edited spacetime.yml) against the vault's current model.

import { test, expect } from "@playwright/test";
import { planSpacetimeSync, summarizePlan } from "../../src/lib/spacetime-sync";
import type { Spacetime } from "../../src/lib/spacetime";

const base: Spacetime = {
  space: [
    { name: "Work", children: [
      { name: "Projects", children: [{ name: "Order", children: [] }, { name: "PKM", children: [] }] },
    ] },
  ],
  seasons: [],
  events: [
    { date: "2026-06-15", title: "Release", folder: "Order", allDay: true },
    { date: "2026-06-16", title: "Standup", folder: "Order", time: "09:00" },
  ],
};

function clone(s: Spacetime): Spacetime { return JSON.parse(JSON.stringify(s)); }

test("sync — no changes yields an empty, non-destructive plan", () => {
  const plan = planSpacetimeSync(base, clone(base));
  expect(plan.destructive).toBe(false);
  expect(summarizePlan(plan).empty).toBe(true);
});

test("sync — a new event line is a create", () => {
  const desired = clone(base);
  desired.events.push({ date: "2026-07-01", title: "Trip", folder: "Order", allDay: true });
  const plan = planSpacetimeSync(base, desired);
  expect(summarizePlan(plan)).toMatchObject({ creates: 1, deletes: 0, updates: 0 });
  expect(plan.destructive).toBe(false);
});

test("sync — a removed event line is a destructive delete", () => {
  const desired = clone(base);
  desired.events = desired.events.filter((e) => e.title !== "Standup");
  const plan = planSpacetimeSync(base, desired);
  expect(summarizePlan(plan)).toMatchObject({ deletes: 1 });
  expect(plan.destructive).toBe(true);
});

test("sync — an in-place edit (same date+folder) is an update, not delete+create", () => {
  const desired = clone(base);
  const standup = desired.events.find((e) => e.title === "Standup")!;
  standup.title = "Daily standup";
  standup.time = "09:15";
  const plan = planSpacetimeSync(base, desired);
  const s = summarizePlan(plan);
  expect(s).toMatchObject({ updates: 1, creates: 0, deletes: 0 });
  expect(plan.destructive).toBe(false);
  const upd = plan.events.find((o) => o.kind === "update")!;
  expect(upd).toMatchObject({ kind: "update" });
});

test("sync — adding a folder is non-destructive; removing is destructive", () => {
  const added = clone(base);
  added.space[0].children[0].children.push({ name: "New", children: [] });
  expect(summarizePlan(planSpacetimeSync(base, added))).toMatchObject({ foldersAdded: 1 });
  expect(planSpacetimeSync(base, added).destructive).toBe(false);

  const removed = clone(base);
  removed.space[0].children[0].children = removed.space[0].children[0].children.filter((n) => n.name !== "PKM");
  const rplan = planSpacetimeSync(base, removed);
  expect(summarizePlan(rplan)).toMatchObject({ foldersRemoved: 1 });
  expect(rplan.destructive).toBe(true);
});

test("sync — reordering folders is a non-destructive reorder", () => {
  const desired = clone(base);
  desired.space[0].children[0].children.reverse(); // [Order, PKM] -> [PKM, Order]
  const plan = planSpacetimeSync(base, desired);
  expect(summarizePlan(plan)).toMatchObject({ reorders: 1, foldersAdded: 0, foldersRemoved: 0 });
  expect(plan.destructive).toBe(false);
});
