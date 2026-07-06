// The canonical spacetime file is `spacetime.md` (renamed from `spacetime.mw`);
// any `*.spacetime.md` composes as a sub-source. These prove the NEW naming
// drives the whole pipeline — critically that Order READS spacetime.md as the
// source of truth AND WRITES back to it (the adaptive canonical path), never a
// hardcoded "spacetime.mw". Legacy .mw stays covered by the other specs.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const ROOT_MD = `# Space

## Alpha
- Alpha Spaces
  - Home Base
  - Side Quest
`;

test("spacetime.md is the canonical source AND adaptive write target", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.md": ROOT_MD } });

  // Taxonomy is spacetime-driven: the seeded areas/folders come from
  // spacetime.md (not the fixture's Areas.md chain). Drill in to confirm.
  await page.click('.box[title="Open Alpha"]');
  await page.click('.box[title="Open Alpha Spaces"]');

  // Create a folder — this writes back to the CANONICAL spacetime file.
  await page.click(".sb-create-folder");
  const input = page.locator(".sb-create-folder-input");
  await input.fill("Reproduce NF");
  await input.press("Enter");

  // 1) Main doc written on disk.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).__VAULT__.read("Alpha/Alpha Spaces/Reproduce NF/Reproduce NF.md"),
      ),
    )
    .toContain("# Reproduce NF");

  // 2) THE crux: registration lands in spacetime.md (adaptive write path),
  //    and no stray spacetime.mw is created.
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__VAULT__.read("spacetime.md")),
    )
    .toContain("Reproduce NF");
  expect(
    await page.evaluate(() => (window as any).__VAULT__.has("spacetime.mw")),
  ).toBe(false);

  // 3) The new folder surfaces and its Main Document card renders.
  await page.click('.sb-folder-li[data-tile-ref="Reproduce NF"] .sb-folder-item');
  await expect(
    page.locator(".order-card.is-main", { hasText: "Reproduce NF" }),
  ).toBeVisible({ timeout: 5000 });
});

test("*.spacetime.md composes as a sub-source alongside root spacetime.md", async ({ page }) => {
  // Root defines Alpha; a disjoint sub-source file adds Beta. If Beta shows in
  // the sidebar, the *.spacetime.md file was discovered + merged.
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": ROOT_MD,
      "extra.spacetime.md": `# Space

## Beta
- Beta Spaces
  - Composed Folder
`,
    },
  });

  await expect(page.locator('.box[title="Open Alpha"]')).toBeVisible();
  await expect(page.locator('.box[title="Open Beta"]')).toBeVisible();
});
