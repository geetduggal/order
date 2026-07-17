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

async function openPlanningCardWith(
  page: import("@playwright/test").Page,
  extra: Record<string, string | null> = {},
) {
  await bootVault(page, {
    extraFiles: { "spacetime.md": SPACETIME, [NOTE]: "# Planning\n\nBody.\n", ...extra },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  return card;
}
const openPlanningCard = (page: import("@playwright/test").Page) => openPlanningCardWith(page);

// Long value + formula + a colored cell, seeded so we can verify RENDERING
// (overflow, formula eval, color) in the minimal card view without driving
// the fullscreen editor.
const SHEET_HTML = `<table class="order-sheet">
  <tr><td>This is a very long cell value that should overflow well past the boundary</td><td>=1+2</td></tr>
  <tr><td data-bg="t:rose"></td><td></td></tr>
</table>`;

test("flip to sheet: minimal card view renders overflow, formulas, and colors", async ({ page }) => {
  const card = await openPlanningCardWith(page, { "Work/Work Spaces/Planning/Planning.sheet.html": SHEET_HTML });
  await card.locator(".order-card-sheet").click();

  await expect
    .poll(() => page.evaluate((p) => (window as any).__VAULT__.read(p), NOTE))
    .toContain("view: sheet");
  await expect(card.locator(".order-sheet-surface")).toBeVisible({ timeout: 15_000 });

  // Card view is minimal: no palette dock, no header indicators.
  expect(await card.locator(".order-sheet-swatch").count()).toBe(0);
  expect(await card.locator(".Spreadsheet__header").count()).toBe(0);

  // Overflow: A1's value renders WIDER than its cell and the cell doesn't clip
  // it — both required for the text to actually spill (the earlier bug was a
  // wide span clipped by an overflow:hidden cell).
  const a1 = card.locator(".Spreadsheet__cell.sheet-col-0").first();
  const a1val = a1.locator(".order-sheet-val");
  await expect(a1val).toHaveText(/overflow well past/, { timeout: 10_000 });
  const spanW = await a1val.evaluate((el) => (el as HTMLElement).scrollWidth);
  const cell = await a1.evaluate((el) => ({
    w: (el as HTMLElement).clientWidth,
    overflow: getComputedStyle(el as HTMLElement).overflow,
  }));
  expect(spanW).toBeGreaterThan(cell.w + 40);
  expect(cell.overflow).toBe("visible");

  // Layering: text is always foreground. A CONTENT cell's span carries an
  // opaque background (so it clips earlier overflow), while an EMPTY colored
  // cell's span is transparent (its color lives on the TD, below the text, so
  // overflow passes OVER the color rather than being overwritten by it).
  const transparent = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  const a1bg = await a1val.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(transparent(a1bg)).toBe(false);
  const a2 = card.locator(".Spreadsheet__cell.sheet-col-0").nth(1); // empty + rose fill
  await expect(a2).toHaveClass(/sheet-bg-rose/); // color is on the TD
  const a2spanBg = await a2.locator(".order-sheet-val").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(transparent(a2spanBg)).toBe(true); // ...but the span stays transparent

  // Formula: B1 = "=1+2" evaluates to 3.
  await expect(card.locator(".Spreadsheet__cell.sheet-col-1 .order-sheet-val").first()).toHaveText("3");

  // Flip back to the note by clicking the sheet icon again → view cleared.
  await card.locator(".order-card-sheet").click();
  await expect
    .poll(() => page.evaluate((p) => (window as any).__VAULT__.read(p), NOTE))
    .not.toContain("view: sheet");
});

test("tall sheet shows the subtle 'open fullscreen' enticer in card view", async ({ page }) => {
  const rows = Array.from({ length: 14 }, (_, i) => `  <tr><td>Row ${i + 1}</td></tr>`).join("\n");
  const tall = `<table class="order-sheet">\n${rows}\n</table>`;
  const card = await openPlanningCardWith(page, { "Work/Work Spaces/Planning/Planning.sheet.html": tall });
  await card.locator(".order-card-sheet").click();
  await expect(card.locator(".order-sheet-surface")).toBeVisible({ timeout: 15_000 });
  // The enticer appears (content exceeds the preview cap) but the full row set
  // is NOT all rendered in the capped card view.
  await expect(card.locator(".order-sheet-expand")).toBeVisible({ timeout: 10_000 });
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
