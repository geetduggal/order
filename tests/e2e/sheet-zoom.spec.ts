// The zoom buttons / ⌘± (which set --text-scale) must scale spreadsheet text
// too, not just prose. react-spreadsheet sizes cells in `em`, so a scaled
// font-size on .Spreadsheet grows the text and the grid together.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";
const SHEET = `<table class="order-sheet">
<tr><td>Item</td><td>Cost</td></tr>
<tr><td>Sofa</td><td>1800</td></tr>
</table>`;

test("zooming scales spreadsheet cell text", async ({ page }) => {
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
  const cell = page.locator(".order-sheet-surface .order-sheet-val", { hasText: "Sofa" }).first();
  await cell.waitFor({ timeout: 10_000 });
  const fontSizePx = () => cell.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

  const before = await fontSizePx();

  // Open the tools popup and click zoom-in twice (+0.1 each).
  await page.click(".dock-btn-settings");
  const zoomIn = page.locator(".dock-tools-zoom-btn").last();
  await zoomIn.click();
  await zoomIn.click();
  await page.waitForTimeout(200);

  const after = await fontSizePx();
  // 13px * 1.2 ≈ 15.6px — clearly larger than the base 13px.
  expect(after).toBeGreaterThan(before + 1.5);
});
