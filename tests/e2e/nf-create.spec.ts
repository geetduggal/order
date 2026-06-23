// Regression: create a Notable Folder via the sidebar "+ New folder" and
// confirm its Main Document is written, registered in spacetime, and shows
// as a card. Taxonomy is spacetime-driven (a seeded spacetime.mw) to mirror
// the real vault — without the harness loading .mw, this silently fell back
// to the Areas.md chain and never exercised the spacetime path.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME_MW = `# Space

## Alpha
- Alpha Spaces
  - Home Base
  - Side Quest
`;

test("new NF main doc is created, registered, and shown after create + click", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.mw": SPACETIME_MW } });

  // Drill: Areas → Alpha → Alpha Spaces (folders view).
  await page.click('.box[title="Open Alpha"]');
  await page.click('.box[title="Open Alpha Spaces"]');

  // Create the folder.
  await page.click(".sb-create-folder");
  const input = page.locator(".sb-create-folder-input");
  await input.fill("Reproduce NF");
  await input.press("Enter");

  // 1) The main doc file is written on disk with the # heading.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).__VAULT__.read("Alpha/Alpha Spaces/Reproduce NF/Reproduce NF.md"),
      ),
    )
    .toContain("# Reproduce NF");

  // 2) It is registered in spacetime.mw (so the taxonomy knows it).
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__VAULT__.read("spacetime.mw")),
    )
    .toContain("Reproduce NF");

  // 3) The new folder appears in the sidebar and clicking it shows the
  //    Main Document card.
  await page.click('.sb-folder-li[data-tile-ref="Reproduce NF"] .sb-folder-item');
  await expect(
    page.locator(".order-card.is-main", { hasText: "Reproduce NF" }),
  ).toBeVisible({ timeout: 5000 });
});
