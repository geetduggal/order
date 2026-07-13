// Regression: create a Notable Folder from the sidebar in a vault where
// placement is STRUCTURAL — the Category exists only in spacetime.md and
// as a directory on disk, with NO `<Category>/<Category>.md` chain file
// (the state every vault is in after the "drop folder/category/area
// frontmatter" migration). The sidebar create used noteDirByRef(category),
// which finds a NOTE named after the category; post-migration none exists,
// so it failed with "Couldn't find <Category> on disk — add the Category
// first" even though the category dir is right there, full of folders.
//
// The existing nf-create.spec still has a stale `Alpha Spaces/Alpha
// Spaces.md` in its fixture, which is why it never caught this.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

// Category with folders but NO category .md — mirrors the real vault.
const SPACETIME_MD = `# Space

## Stewardship
- Stewardship Spaces
  - Readwise
- Empty Category
`;

test("sidebar create works in a structural-only category (folders present)", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME_MD,
      // A real Notable Folder main doc lives in the category dir; the
      // category itself has NO `Stewardship Spaces.md`.
      "Stewardship/Stewardship Spaces/Readwise/Readwise.md": "# Readwise\n",
    },
  });

  await page.click('.box[title="Open Stewardship"]');
  await page.click('.box[title="Open Stewardship Spaces"]');

  await page.click(".sb-create-folder");
  const input = page.locator(".sb-create-folder-input");
  await input.fill("Fresh Folder");
  await input.press("Enter");

  // Main doc written at the correct structural path, next to the sibling.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__VAULT__.read("Stewardship/Stewardship Spaces/Fresh Folder/Fresh Folder.md"),
      ),
    )
    .toContain("# Fresh Folder");

  // Registered in spacetime.md so the taxonomy knows it.
  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.read("spacetime.md")))
    .toContain("Fresh Folder");
});

test("sidebar create works in an EMPTY structural category (no folders yet)", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME_MD } });

  await page.click('.box[title="Open Stewardship"]');
  await page.click('.box[title="Open Empty Category"]');

  await page.click(".sb-create-folder");
  const input = page.locator(".sb-create-folder-input");
  await input.fill("First One");
  await input.press("Enter");

  // Falls back to constructing <vault>/<Area>/<Category>/<NF>/<NF>.md.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__VAULT__.read("Stewardship/Empty Category/First One/First One.md"),
      ),
    )
    .toContain("# First One");
});
