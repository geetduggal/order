// Flip a note card between its markdown editor and the sheet / drawing
// surfaces: the sidecar file is created on first flip, and the active view
// is persisted to the note's `view:` frontmatter.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";

async function openPlanningCard(page: import("@playwright/test").Page) {
  await bootVault(page, {
    extraFiles: { "spacetime.md": SPACETIME, [NOTE]: "# Planning\n\nBody.\n" },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}

test("flip to sheet: sidecar created, view persisted, grid renders", async ({ page }) => {
  const card = await openPlanningCard(page);
  await card.locator(".order-card-sheet").click();

  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.has("Work/Work Spaces/Planning/Planning.sheet.html")))
    .toBe(true);
  await expect
    .poll(() => page.evaluate((p) => (window as any).__VAULT__.read(p), NOTE))
    .toContain("view: sheet");
  await expect(card.locator(".order-sheet-surface")).toBeVisible({ timeout: 15_000 });
  // Toolbar palette is present.
  expect(await card.locator(".order-sheet-swatch").count()).toBeGreaterThan(3);

  // Background fill: select a cell, click a palette swatch → the selected
  // cell's <td> gets the bg class AND it is persisted to the sidecar.
  await card.locator(".Spreadsheet__cell").first().click();
  await card.locator(".order-sheet-swatch").first().click();
  await expect(card.locator(".Spreadsheet__cell.sheet-bg-rose").first()).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.read("Work/Work Spaces/Planning/Planning.sheet.html")))
    .toContain("data-bg=\"t:rose\"");

  // Flip back to the note by clicking the sheet icon again → view cleared.
  await card.locator(".order-card-sheet").click();
  await expect
    .poll(() => page.evaluate((p) => (window as any).__VAULT__.read(p), NOTE))
    .not.toContain("view: sheet");
});

test("flip to drawing: excalidraw sidecar created, view persisted", async ({ page }) => {
  const card = await openPlanningCard(page);
  await card.locator(".order-card-draw").click();

  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.has("Work/Work Spaces/Planning/Planning.excalidraw")))
    .toBe(true);
  await expect
    .poll(() => page.evaluate((p) => (window as any).__VAULT__.read(p), NOTE))
    .toContain("view: drawing");
  await expect(card.locator(".order-drawing-surface")).toBeVisible({ timeout: 20_000 });
});
