// Changing `list:` in the frontmatter inspector must switch the list render
// live (no reload) — cards → masonry here.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";

test("changing list: in the inspector switches the render live", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]:
        "---\nlist: cards\n---\n# Planning\n\n" +
        "- One\n- Two\n- Three\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Starts as cards.
  await expect(card.locator(".basecard-grid")).toBeVisible({ timeout: 10_000 });
  await expect(card.locator(".mason-grid")).toHaveCount(0);

  // Open the inspector and switch list → masonry.
  await card.locator(".order-card-fm-toggle").click();
  await card.locator(".fm-select").selectOption("masonry");

  // The render switches live, no reload.
  await expect(card.locator(".mason-grid")).toBeVisible({ timeout: 5_000 });
  await expect(card.locator(".basecard-grid")).toHaveCount(0);
});

test("turning a plain note into a list populates items live", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]: "# Planning\n\n- One\n- Two\n- Three\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".mason-grid")).toHaveCount(0);

  await card.locator(".order-card-fm-toggle").click();
  await card.locator(".fm-select").selectOption("masonry");

  await expect(card.locator(".mason-grid")).toBeVisible({ timeout: 5_000 });
  expect(await card.locator(".mason-item").count()).toBeGreaterThanOrEqual(3);
});

test("switching a list back to (none) folds items back into the editor", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]: "---\nlist: masonry\n---\n# Planning\n\n- Alpha\n- Bravo\n- Charlie\n",
    },
  });
  for (const ref of ["Work", "Work Spaces", "Planning"]) {
    await page.click(`[data-tile-ref="${ref}"]`);
    await page.waitForTimeout(400);
  }
  const card = page.locator(".order-card.is-main").first();
  await expect(card.locator(".mason-grid")).toBeVisible({ timeout: 15_000 });

  await card.locator(".order-card-fm-toggle").click();
  await card.locator(".fm-select").selectOption("");

  // The list render is gone and the bullets are back as a markdown list in the
  // editor (not lost / blank).
  await expect(card.locator(".mason-grid")).toHaveCount(0);
  const editor = card.locator(".ProseMirror").first();
  await expect(editor.locator("li", { hasText: "Alpha" })).toBeVisible({ timeout: 5_000 });
  await expect(editor.locator("li", { hasText: "Charlie" })).toBeVisible();
});
