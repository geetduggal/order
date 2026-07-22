// Apple / system calendar: with access granted and a calendar ticked, the
// per-day "import from system calendar" button pulls the day's events into the
// same review modal the Google import uses.

import { test, expect } from "@playwright/test";
import { bootVault, todayIso } from "./helpers";

const SPACETIME = `# Space

## Work
- Work Spaces
  - Planning
`;

test("import a day from the system calendar via the review modal", async ({ page }) => {
  const today = todayIso();
  // Seed the EventKit fixture + the "included calendars" selection before load.
  await page.addInitScript((d: string) => {
    (window as any).__APPLECAL = {
      status: "authorized",
      calendars: [{ id: "cal-home", title: "Home", source: "iCloud", writable: true }],
      dayEvents: [
        { title: "Standup", date: d, time: "09:00", endTime: "09:30", allDay: false, description: "", attendees: [] },
      ],
    };
    try { localStorage.setItem("order.applecal.included", JSON.stringify(["cal-home"])); } catch { /* ignore */ }
  }, today);

  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME } });
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible({ timeout: 15_000 });

  // Go to the week calendar (its day headers carry the import buttons).
  await page.click(".dock-btn-cal");
  const appleBtn = page.locator(".fc-day-import-apple").first();
  await expect(appleBtn).toBeAttached({ timeout: 10_000 });

  await appleBtn.click({ force: true });

  // The shared review modal opens, labelled for the system calendar, with the
  // mocked event pre-checked.
  const modal = page.locator(".settings-panel", { hasText: "from the system calendar" });
  await expect(modal).toBeVisible({ timeout: 10_000 });
  await expect(modal.locator("text=Standup")).toBeVisible();

  // Accept the import → the event lands in spacetime.md.
  await modal.locator("button", { hasText: /^Import \d/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__VAULT__.read("spacetime.md")))
    .toContain("Standup");
});

test("ticking a calendar in Settings persists (controlled-checkbox async fix)", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__APPLECAL = {
      status: "authorized",
      calendars: [
        { id: "cal-home", title: "Home", source: "iCloud", writable: true },
        { id: "cal-work", title: "Work", source: "iCloud", writable: true },
      ],
    };
    // Start with NOTHING included, so ticking must actually turn a box on.
  });
  await bootVault(page, { extraFiles: { "spacetime.md": SPACETIME } });
  await expect(page.locator('[data-tile-ref="Work"]')).toBeVisible({ timeout: 15_000 });

  await page.click(".dock-btn-settings");
  await page.click(".dock-tools-item:has-text('Vault settings')");
  const row = page.locator(".settings-row", { hasText: "Apple Calendar" });
  const homeBox = row.locator(".settings-toggle", { hasText: "Home" }).locator("input[type=checkbox]");
  await expect(homeBox).not.toBeChecked();

  await homeBox.check();
  // The box stays checked (not reverted by the async handler)…
  await expect(homeBox).toBeChecked({ timeout: 5_000 });
  // …and the selection persisted to localStorage.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("order.applecal.included")))
    .toContain("cal-home");
});
