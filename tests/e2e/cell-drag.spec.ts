// Cell drag: with the "Cell drag" toggle on (fullscreen dock), press-and-drag a
// cell moves it to the drop location.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";
const SHEET = `<table class="order-sheet">
<tr><td>X</td><td></td><td></td></tr>
<tr><td></td><td></td><td></td></tr>
</table>`;

test("Cell drag moves a cell to the drop target", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]: "---\nview: sheet\n---\n# Planning\n\nBody.\n",
      "Work/Work Spaces/Planning/Planning.sheet.html": SHEET,
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(300);
  }
  const card = page.locator(".order-card", { has: page.locator(".order-sheet-surface") }).first();
  await card.locator(".order-sheet-surface").waitFor({ timeout: 10_000 });

  // Fullscreen (the dock, with the Cell-drag toggle, is fullscreen-only).
  await card.hover();
  await card.locator(".order-card-fullscreen").click();
  await card.locator(".order-sheet-checkbox input").check();

  // Select A1, then press-and-drag it to C2.
  const a1 = card.locator(".Spreadsheet__cell.sheet-col-0.sheet-row-0").first();
  const c2 = card.locator(".Spreadsheet__cell.sheet-col-2.sheet-row-1").first();
  await a1.click();
  const b1 = (await a1.boundingBox())!;
  const b2 = (await c2.boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + 25, b1.y + 15); // pass the drag threshold
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 6 });
  await page.mouse.up();

  // A1 emptied, C2 now holds the value.
  await expect(card.locator(".Spreadsheet__cell.sheet-col-2.sheet-row-1 .order-sheet-val").first()).toHaveText("X", { timeout: 5_000 });
  await expect(card.locator(".Spreadsheet__cell.sheet-col-0.sheet-row-0 .order-sheet-val").first()).toHaveText("");
});
