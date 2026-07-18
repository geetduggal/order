// Masonry list layout (`list: masonry`): items render as variable-height boxes
// flowed into CSS columns (drag disabled), a third mode beside cards and lines.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";

test("a `list: masonry` folder renders items in the masonry grid", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]:
        "---\nlist: masonry\n---\n# Planning\n\n" +
        "- [[Alpha]] a short one\n" +
        "- [[Beta]] a much longer item with a lot more text so its box grows taller than the others in the masonry flow\n" +
        "- [[Gamma]] medium length item here\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // The masonry container renders (CSS columns), with the three item boxes.
  const grid = card.locator(".basecard-grid.is-masonry");
  await expect(grid).toBeVisible({ timeout: 10_000 });
  expect(await grid.locator(".basecard").count()).toBeGreaterThanOrEqual(3);

  // The masonry layout is actually applied: a CSS multi-column flow (not the
  // default grid), and items avoid breaking across columns.
  const layout = await grid.evaluate((el) => {
    const gs = getComputedStyle(el);
    const cell = el.querySelector(".basecard") as HTMLElement;
    return {
      display: gs.display,
      columnWidth: gs.columnWidth,
      breakInside: cell ? getComputedStyle(cell).breakInside : "",
    };
  });
  expect(layout.display).not.toBe("grid");
  expect(layout.columnWidth).not.toBe("auto"); // `columns: 190px` → a real width
  expect(layout.breakInside).toBe("avoid");
});
