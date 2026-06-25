// Auto theme: with the default "auto" preference, <html data-theme> follows
// the OS light/dark scheme on first paint AND reacts live when the OS flips.
// An explicit theme ignores the OS. Driven via Playwright's emulateMedia.

import { test, expect, type Page } from "@playwright/test";
import { bootVault } from "./helpers";

const dataTheme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.theme);

test("auto — follows OS dark on first paint", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await bootVault(page, { seedTheme: false }); // no saved theme → default "auto"
  expect(await dataTheme(page)).toBe("dark");
});

test("auto — follows OS light on first paint", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await bootVault(page, { seedTheme: false });
  expect(await dataTheme(page)).toBe("light");
});

test("auto — reacts live when the OS flips", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await bootVault(page, { seedTheme: false });
  expect(await dataTheme(page)).toBe("dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => dataTheme(page)).toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => dataTheme(page)).toBe("dark");
});

test("an explicit theme ignores the OS (no auto-follow)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await bootVault(page, { seedTheme: "light" }); // explicit light despite OS dark
  expect(await dataTheme(page)).toBe("light");

  // Flipping the OS must NOT change an explicitly chosen theme.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(80);
  expect(await dataTheme(page)).toBe("light");
});
