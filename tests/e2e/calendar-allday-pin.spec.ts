// The all-day strip in Day / Week must stay pinned beneath the sticky
// day-header while the timed grid scrolls under it. FC ships the all-day row
// scrolling away; CalendarView tags it (`.order-cal-allday`) + publishes the
// header height so CSS can stick it. Regression guard for that behaviour.
import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

test("all-day strip stays pinned while the week grid scrolls", async ({ page }) => {
  await bootVault(page); // every launch boots into Week view
  await page.waitForSelector(".fc-timegrid", { timeout: 10_000 });
  await page.waitForTimeout(300); // let pinAllDay's rAF tag + measure

  // The all-day row got tagged, and its cells are sticky (Safari won't stick a
  // <tr>, so the pin lives on the cells).
  const cell = page.locator("tr.order-cal-allday > *").first();
  await expect(cell).toHaveCSS("position", "sticky");

  // Scroll the page well past the all-day strip's natural position.
  await page.evaluate(() => {
    (document.scrollingElement as HTMLElement).scrollTop = 700;
    window.scrollTo(0, 700);
  });
  await page.waitForTimeout(150);

  // Still visible near the top (pinned at its sticky offset) — NOT scrolled off
  // to a large negative top the way it did before the fix (~ natural − 700).
  const afterTop = await cell.evaluate((el) => el.getBoundingClientRect().top);
  expect(afterTop).toBeGreaterThan(50);
  expect(afterTop).toBeLessThan(220);
});
