// Bug A: add a Notable Folder by editing spacetime.mw directly, then Apply
// the review. The new folder's Main Document (<NF>/<NF>.md) must be created.
// Before the fix, applyMwSync's materialization guard used folderDirIndex
// (the live spacetime taxonomy, which already lists the just-edited folder)
// so it skipped creating the main doc — the folder showed with no document.

import { test, expect } from "@playwright/test";
import { bootVault, emitTauriEvent } from "./helpers";

const SPACETIME_MW = `# Space

## Alpha
- Alpha Spaces
  - Home Base
  - Side Quest
`;

const SPACETIME_MW_PLUS = SPACETIME_MW + "  - Edited In Spacetime\n";

test("editing spacetime.mw to add a folder materializes its main doc on Apply", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.mw": SPACETIME_MW } });

  // The sync baseline is established asynchronously after boot; wait for it
  // so the hand-edit below is diffed against the original (not itself).
  await expect
    .poll(async () =>
      page.evaluate(() => localStorage.getItem("order.mwSyncBaseline")),
    )
    .not.toBeNull();

  // Simulate a hand-edit to spacetime.mw on disk (external editor), then
  // fire the watcher event the app listens for so it reloads + detects.
  await page.evaluate((content) => {
    return (window as any).__TAURI_INTERNALS__.invoke("vault_write_text", {
      rel: "spacetime.mw",
      content,
    });
  }, SPACETIME_MW_PLUS);
  await emitTauriEvent(page, "vault-changed", ["spacetime.mw"]);

  // Open the review and wait for the debounced reload + change detection to
  // stage the "New folder" item, then Apply.
  await page.click(".mw-pending-indicator", { timeout: 5000 });
  await expect(
    page.locator(".mw-change-text", { hasText: "Edited In Spacetime" }),
  ).toBeVisible({ timeout: 5000 });
  await page.click(".settings-actions .settings-btn:has-text('Apply')");

  // The new folder's Main Document must exist with the # heading.
  await expect
    .poll(async () =>
      page.evaluate(() =>
        (window as any).__VAULT__.read(
          "Alpha/Alpha Spaces/Edited In Spacetime/Edited In Spacetime.md",
        ),
      ),
    )
    .toContain("# Edited In Spacetime");
});
