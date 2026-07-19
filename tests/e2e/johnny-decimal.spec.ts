// Johnny-Decimal Mode (Settings toggle): prefixes every Area / Category /
// Notable Folder in spacetime with a Johnny.Decimal id and renames the matching
// directories. Toggling it off strips the ids back off.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;
const NOTE = "Work/Work Spaces/Planning/Planning.md";

async function toggleJd(page: import("@playwright/test").Page, on: boolean) {
  await page.click(".dock-btn-settings");
  await page.click(".dock-tools-item:has-text('Vault settings')");
  const row = page.locator(".settings-row", { hasText: "Johnny-Decimal" });
  const box = row.locator('input[type="checkbox"]');
  if (on) await box.check(); else await box.uncheck();
  // Wait for the rename + reload to settle, then close the panel.
  await expect(row.locator("input")).toBeEnabled({ timeout: 10_000 });
  await page.click(".settings-close");
}

test("enabling prefixes areas, categories, and folders; disabling strips them", async ({ page }) => {
  await bootVault(page, {
    extraFiles: {
      "spacetime.md": SPACETIME,
      [NOTE]: "# Planning\n\n- One\n- Two\n",
    },
  });
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible({ timeout: 15_000 });

  await toggleJd(page, true);

  // Area tile now carries its range id.
  await expect(page.locator('[data-tile-ref="10-19 Work"]')).toBeVisible({ timeout: 10_000 });
  await page.click('[data-tile-ref="10-19 Work"]');
  await expect(page.locator('[data-tile-ref="11 Work Spaces"]')).toBeVisible({ timeout: 10_000 });
  await page.click('[data-tile-ref="11 Work Spaces"]');
  await expect(page.locator('[data-tile-ref="11.01 Planning"]')).toBeVisible({ timeout: 10_000 });

  // Turning it off restores the base names.
  await toggleJd(page, false);
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-tile-ref="10-19 Work"]')).toHaveCount(0);
});
