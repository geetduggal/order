// Editing spacetime.md directly from the sidebar: the same raw-text editing as
// the pile view, with the editor expanding to fill the sidebar.

import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning

# Time

## Events

2026-07-20 : Kickoff #[Planning]
`;

test("edit spacetime.md from the sidebar and it saves", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME } });
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible({ timeout: 15_000 });

  // The edit toggle lives in the sidebar.
  const editBtn = page.locator(".sb-spacetime-edit-btn");
  await expect(editBtn).toBeVisible();
  await editBtn.click();

  // The editor takes over the sidebar and shows the spacetime source.
  const editor = page.locator(".sb-spacetime-editor .cm-content");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await expect(editor).toContainText("# Space");
  await expect(editor).toContainText("Kickoff");
  // It expands to fill the sidebar (tall).
  const h = await page.locator(".sb-spacetime-editor").evaluate((el) => (el as HTMLElement).offsetHeight);
  expect(h).toBeGreaterThan(300);

  // Append a new event line, then confirm it persists to spacetime.md.
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type("\n2026-07-21 : Review #[Planning]\n");
  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.read("spacetime.md")), { timeout: 5_000 })
    .toContain("Review");

  // Done returns to the taxonomy drill.
  await page.locator(".sb-spacetime-done").click();
  await expect(page.locator(".sb-spacetime-editor")).toHaveCount(0);
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible();
});
