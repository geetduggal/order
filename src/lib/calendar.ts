// Calendar week math. ISO week starts Monday, but Obsidian Full Calendar
// users tend to expect a Sunday or Monday start depending on locale.
// We default to Sunday (US convention) for now — easy to flip.

import { isoDate } from "./frontmatter";

export const WEEK_START_DOW = 0; // 0 = Sunday
export const WEEK_DAYS = 7;
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const dow = out.getDay();
  const diff = (dow - WEEK_START_DOW + WEEK_DAYS) % WEEK_DAYS;
  out.setDate(out.getDate() - diff);
  return out;
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function daysOfWeek(weekStart: Date): Date[] {
  return Array.from({ length: WEEK_DAYS }, (_, i) => addDays(weekStart, i));
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function parseClockTime(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h, m: min };
}

export function formatClockTime(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDayHeader(d: Date): { dow: string; day: number } {
  return { dow: DAY_NAMES[d.getDay()], day: d.getDate() };
}

export function weekRangeLabel(weekStart: Date): string {
  const end = addDays(weekStart, WEEK_DAYS - 1);
  const sameMonth = weekStart.getMonth() === end.getMonth();
  const startFmt = weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const endFmt = sameMonth
    ? String(end.getDate())
    : end.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${startFmt} – ${endFmt}, ${end.getFullYear()}`;
}

export function todayIso(): string {
  return isoDate(new Date());
}
