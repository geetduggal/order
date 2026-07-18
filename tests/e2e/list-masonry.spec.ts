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
        "- Short\n" +
        "- This is a much longer text item with a great deal more content so that when its title wraps across many lines the box grows substantially taller than the short one, which is the whole point of a masonry layout sizing boxes by their content length\n" +
        "- Medium length item here\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // The masonry container renders (CSS columns), with the three text boxes.
  const grid = card.locator(".mason-grid");
  await expect(grid).toBeVisible({ timeout: 10_000 });
  expect(await grid.locator(".mason-item").count()).toBeGreaterThanOrEqual(3);
  // The item CONTENT is the text itself.
  await expect(grid.locator(".mason-text").first()).toHaveText(/Short/);

  // The masonry layout is actually applied: a CSS multi-column flow (not the
  // default grid), and items avoid breaking across columns.
  const layout = await grid.evaluate((el) => {
    const gs = getComputedStyle(el);
    const cell = el.querySelector(".mason-item") as HTMLElement;
    return {
      display: gs.display,
      columnWidth: gs.columnWidth,
      breakInside: cell ? getComputedStyle(cell).breakInside : "",
    };
  });
  expect(layout.display).not.toBe("grid");
  expect(layout.columnWidth).not.toBe("auto"); // `columns: 190px` → a real width
  expect(layout.breakInside).toBe("avoid");

  // The point of masonry: a box with more text is meaningfully taller than a
  // short one (full text, no 2-line clamp).
  const heights = await grid.locator(".mason-item").evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).offsetHeight),
  );
  expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights) + 30);
});
