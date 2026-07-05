// Day/Week give FC a bounded height so it scrolls the time grid INTERNALLY,
// keeping the day-header + all-day strip fixed (FC-native, WebKit-safe, and
// drag-friendly). Regression guard: scroll the internal grid and assert the
// header + all-day don't move, and the calendar stays within the viewport.
import { test, expect } from "@playwright/test";
import { bootVault } from "./helpers";

test("Week: header + all-day stay fixed while the time grid scrolls internally", async ({ page }) => {
  await bootVault(page); // every launch boots into Week view
  await page.waitForSelector(".fc-timegrid", { timeout: 10_000 });
  await page.waitForTimeout(500); // let the height measure settle

  const r = await page.evaluate(() => {
    const allDay = document.querySelector(".fc-timegrid .fc-daygrid-body") as HTMLElement | null;
    const header = document.querySelector(".fc-col-header") as HTMLElement | null;
    const fcEl = document.querySelector(".fc") as HTMLElement | null;
    const scroller = (Array.from(document.querySelectorAll(".fc-timegrid .fc-scroller")) as HTMLElement[])
      .find((s) => s.scrollHeight > s.clientHeight + 10) ?? null;

    const adBefore = allDay?.getBoundingClientRect().top ?? null;
    const hdBefore = header?.getBoundingClientRect().top ?? null;
    if (scroller) scroller.scrollTop = 500;
    const adAfter = allDay?.getBoundingClientRect().top ?? null;
    const hdAfter = header?.getBoundingClientRect().top ?? null;

    return {
      fcHeight: fcEl?.getBoundingClientRect().height ?? null,
      viewportH: window.innerHeight,
      hasScroller: !!scroller,
      scrolled: scroller?.scrollTop ?? 0,
      adBefore, adAfter, hdBefore, hdAfter,
    };
  });

  expect(r.hasScroller, "FC should have a bounded internal time-grid scroller").toBe(true);
  expect(r.scrolled).toBeGreaterThan(100);
  expect(Math.abs((r.adAfter ?? 0) - (r.adBefore ?? -999)), "all-day fixed").toBeLessThan(3);
  expect(Math.abs((r.hdAfter ?? 0) - (r.hdBefore ?? -999)), "header fixed").toBeLessThan(3);
  expect(r.fcHeight!, "calendar bounded within viewport").toBeLessThan(r.viewportH);
});
