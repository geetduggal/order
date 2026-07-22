// Card toolbar layout: the close / "remove from view" button is inline in the
// toolbar; the spreadsheet + drawing flips moved into the "⋯" menu.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";

test("dismiss is inline; sheet/drawing live in the ⋯ menu", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]: "# Planning\n\nBody text.\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(300);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Close / remove-from-view is a visible inline toolbar button now.
  await expect(card.locator(".order-card-controls .order-card-dismiss")).toBeVisible();

  // Sheet/drawing flips are NOT inline anymore.
  await expect(card.locator(".order-card-controls .order-card-sheet")).toHaveCount(0);
  await expect(card.locator(".order-card-controls .order-card-draw")).toHaveCount(0);

  // They live in the ⋯ menu instead.
  await card.locator(".order-card-more").click();
  const menu = page.locator(".order-card-more-menu");
  await expect(menu.locator("text=Edit as a spreadsheet")).toBeVisible();
  await expect(menu.locator("text=Edit as a drawing")).toBeVisible();

  // Flipping to the sheet from the menu works.
  await menu.locator("text=Edit as a spreadsheet").click();
  await expect(card.locator(".order-sheet-surface")).toBeVisible({ timeout: 10_000 });
});
