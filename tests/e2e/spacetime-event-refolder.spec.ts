// Changing an event's #[folder] tag in spacetime.md (the source of truth
// for placement) must MOVE the event's backing note into the new Notable
// Folder's directory. Event-only mw edits are applied silently (no review
// dialog), so the move happens as part of that same silent pass.

import { test, expect } from "@playwright/test";
import { bootVault, emitTauriEvent, todayIso } from "./helpers";

const today = todayIso();

const SPACETIME_MD = `# Space

## Alpha
- Alpha Spaces
  - Home Base
  - Side Quest

# Time

## Events

${today} 09:00-09:30: Standup #[Home Base]
`;

const SPACETIME_MD_REFOLDERED = SPACETIME_MD.replace(
  "#[Home Base]",
  "#[Side Quest]",
);

test("retagging an event's folder in spacetime.md moves its backing note", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME_MD } });

  // The sync baseline is established asynchronously after boot; wait for
  // it so the hand-edit below is diffed against the original.
  await expect
    .poll(async () =>
      page.evaluate(() => localStorage.getItem("order.mwSyncBaseline")),
    )
    .not.toBeNull();

  const oldPath = `Alpha/Alpha Spaces/Home Base/${today} Standup.md`;
  const newPath = `Alpha/Alpha Spaces/Side Quest/${today} Standup.md`;
  expect(await page.evaluate((p) => (window as any).__VAULT__.has(p), oldPath)).toBe(true);

  // Simulate a hand-edit that only changes the event's folder tag, then
  // fire the watcher event so the app reloads + detects. No structural
  // change → the edit applies silently (no review), moving the note.
  await page.evaluate((content) => {
    return (window as any).__TAURI_INTERNALS__.invoke("vault_write_text", {
      rel: "spacetime.md",
      content,
    });
  }, SPACETIME_MD_REFOLDERED);
  await emitTauriEvent(page, "vault-changed", ["spacetime.md"]);

  await expect
    .poll(async () => page.evaluate((p) => (window as any).__VAULT__.has(p), newPath), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(async () => page.evaluate((p) => (window as any).__VAULT__.has(p), oldPath), { timeout: 10_000 })
    .toBe(false);

  // The moved note keeps its body.
  const moved = await page.evaluate((p) => (window as any).__VAULT__.read(p), newPath);
  expect(moved).toContain("# Standup");
});

test("card's folder icon moves a note to the picked Notable Folder", async ({ page }) => {
  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME_MD } });

  const oldPath = `Alpha/Alpha Spaces/Home Base/${today} Standup.md`;
  const newPath = `Alpha/Alpha Spaces/Side Quest/${today} Standup.md`;

  // Open the Pile — Standup (a dated note) renders as a card there.
  await page.click('.bottom-dock button[aria-label="Pile"], .bottom-dock button[title="Pile"]');
  const cell = page.locator(`.card-grid-cell[data-path$="${oldPath}"]`);
  await expect(cell).toBeVisible({ timeout: 10_000 });
  // Wait for the card's editor to finish mounting: Crepe's init runs a
  // delayed focus() that would blur-close a picker opened mid-boot.
  await cell.locator(".ProseMirror").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);

  // Secondary actions live in the "⋯" menu now; open it and pick "Move…".
  await cell.hover();
  await cell.locator(".order-card-more").click();
  // The menu renders in a body portal, so it's page-level (not cell-scoped).
  await page.locator(".order-card-more-refolder").click();
  const input = page.locator(".order-card-folderpick .order-card-folder-input");
  await input.fill("Side Quest");
  await input.press("Enter");

  await expect
    .poll(async () => page.evaluate((p) => (window as any).__VAULT__.has(p), newPath), { timeout: 10_000 })
    .toBe(true);
  await expect
    .poll(async () => page.evaluate((p) => (window as any).__VAULT__.has(p), oldPath), { timeout: 10_000 })
    .toBe(false);

  // The note backs the Standup event, so its spacetime tag follows.
  const mw = await page.evaluate(() => (window as any).__VAULT__.read("spacetime.md"));
  expect(mw).toContain("Standup #[Side Quest]");
});
