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

  // Overflow: a long value in A1 must render WIDER than its cell (continues
  // past to the right like a real spreadsheet) — the absolute value span
  // escapes the cell box.
  const a1 = card.locator(".Spreadsheet__cell.sheet-col-0").first();
  await a1.click();
  await page.keyboard.type("This is a very long cell value that should overflow past");
  await page.keyboard.press("Enter");
  const a1val = a1.locator(".order-sheet-val");
  await expect(a1val).toHaveText(/overflow past/, { timeout: 5_000 });
  const spanW = await a1val.evaluate((el) => (el as HTMLElement).scrollWidth);
  const cell = await a1.evaluate((el) => ({
    w: (el as HTMLElement).clientWidth,
    overflow: getComputedStyle(el as HTMLElement).overflow,
  }));
  // The span is wider than the cell AND the cell doesn't clip it — both are
  // required for the text to actually spill visually (the earlier bug was a
  // wide span clipped by an overflow:hidden cell).
  expect(spanW).toBeGreaterThan(cell.w + 40);
  expect(cell.overflow).toBe("visible");
  // "Stops at content": a cell with content gets the opaque surface bg (clips
  // overflow from its left); an empty neighbor stays transparent (lets it pass).
  await expect(a1).toHaveClass(/sheet-bg-surface/);
  await expect(card.locator(".Spreadsheet__cell.sheet-col-1").first()).not.toHaveClass(/sheet-bg-surface/);

  // Formula: B1 = "=1+2" evaluates to 3 in the viewer.
  const b1 = card.locator(".Spreadsheet__cell.sheet-col-1").first();
  await b1.click();
  await page.keyboard.type("=1+2");
  await page.keyboard.press("Enter");
  await expect(card.locator(".Spreadsheet__cell.sheet-col-1 .order-sheet-val").first()).toHaveText("3");

  // Background fill: select a cell, click a palette swatch → the selected
  // cell's <td> gets the bg class AND it is persisted to the sidecar.
  await a1.click();
  await card.locator(".order-sheet-swatch").first().click();
  await expect(card.locator(".Spreadsheet__cell.sheet-bg-rose").first()).toBeVisible({ timeout: 5_000 });
  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.read("Work/Work Spaces/Planning/Planning.sheet.html")))
    .toContain("data-bg=\"t:rose\"");

  // Delete a column via the header right-click menu: after deleting column A,
  // the formula that was in B1 shifts into A1 (still shows "3").
  await card.locator(".Spreadsheet__header", { hasText: /^A$/ }).first().click({ button: "right" });
  await expect(card.locator(".order-sheet-menu")).toBeVisible({ timeout: 5_000 });
  await card.getByRole("button", { name: /Delete column A/ }).click();
  await expect(card.locator(".Spreadsheet__cell.sheet-col-0 .order-sheet-val").first()).toHaveText("3", { timeout: 5_000 });

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
