// The dated-filename convention — the SOURCE OF TRUTH for an event's date and time.
//
// An event's schedule lives in its FILE NAME, not YAML frontmatter. The convention
// compactly expresses Markwhen-style scheduling using only filesystem-safe
// characters (no `/`, no `:`). Each shape adds exactly one token to the last:
//
//   YYYY-MM-DD Title                 all-day event
//   YYYY-MM-DD HHMM Title            point-in-time that day (defaults to 30 min)
//   YYYY-MM-DD HHMM-HHMM Title       same-day time range (24h)
//   YYYY-MM-DD - YYYY-MM-DD Title    multi-day all-day range (dash, not `/`)
//
// A timed multi-day range is deliberately out of scope. The `Title` remainder is the
// human label in the name; the event's DISPLAY title still prefers the note's `# `
// header when present (callers pass that through), falling back to this remainder.

export interface FilenameEvent {
  date: string;        // YYYY-MM-DD  (start day)
  time?: string;       // HH:MM       (start time; absent = all-day)
  endTime?: string;    // HH:MM       (same-day range end)
  endDate?: string;    // YYYY-MM-DD  (multi-day all-day range end, inclusive)
  allDay: boolean;
  /** The label after the date/time token(s) in the filename (may be empty). */
  title: string;
}

const DATE = "\\d{4}-\\d{2}-\\d{2}";
const HHMM = "\\d{4}";

// Patterns are checked most-specific first. All anchor at the start; the rest of the
// name (after one optional space) is the title.
const RE_DATE_RANGE = new RegExp(`^(${DATE}) - (${DATE})(?:\\s+([\\s\\S]*))?$`);
const RE_TIME_RANGE = new RegExp(`^(${DATE}) (${HHMM})-(${HHMM})(?:\\s+([\\s\\S]*))?$`);
const RE_DATE_TIME  = new RegExp(`^(${DATE}) (${HHMM})(?:\\s+([\\s\\S]*))?$`);
const RE_DATE_ONLY  = new RegExp(`^(${DATE})(?:\\s+([\\s\\S]*))?$`);

function isValidDate(d: string): boolean {
  // Structurally a date AND a real calendar day (rejects 2026-13-40).
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, da));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da;
}

/** "HHMM" → "HH:MM", or null if it isn't a real 24h time. */
function hhmmToTime(t: string): string | null {
  if (!/^\d{4}$/.test(t)) return null;
  const h = +t.slice(0, 2), m = +t.slice(2, 4);
  if (h > 23 || m > 59) return null;
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

/** "HH:MM" → "HHMM" (for building a filename). */
export function timeToHhmm(time: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m ? `${m[1]}${m[2]}` : time.replace(/[^\d]/g, "").slice(0, 4);
}

/**
 * Parse an event's date/time from its file's basename (WITHOUT extension).
 * Returns null when the name doesn't begin with a valid date — i.e. it isn't a
 * dated event. A date that parses but has a malformed time token degrades to the
 * next-simpler shape (so "2026-01-01 2530 X" is an all-day event titled "2530 X").
 */
export function parseEventFilename(nameNoExt: string): FilenameEvent | null {
  // A reserved leading sort marker (`& ` pinned, or `! ` main doc) is not part of
  // the schedule grammar — strip it, then parse the rest. So `& 2026-01-02 Foo`
  // is the same event as `2026-01-02 Foo`, just pinned.
  const s = nameNoExt.trim().replace(/^[!&]\s+/, "");

  // 1) Date range: YYYY-MM-DD - YYYY-MM-DD [Title]
  let m = RE_DATE_RANGE.exec(s);
  if (m && isValidDate(m[1]) && isValidDate(m[2])) {
    return { date: m[1], endDate: m[2], allDay: true, title: (m[3] ?? "").trim() };
  }

  // 2) Time range: YYYY-MM-DD HHMM-HHMM [Title]
  m = RE_TIME_RANGE.exec(s);
  if (m && isValidDate(m[1])) {
    const start = hhmmToTime(m[2]);
    const end = hhmmToTime(m[3]);
    if (start && end) {
      return { date: m[1], time: start, endTime: end, allDay: false, title: (m[4] ?? "").trim() };
    }
  }

  // 3) Date + time: YYYY-MM-DD HHMM [Title]
  m = RE_DATE_TIME.exec(s);
  if (m && isValidDate(m[1])) {
    const start = hhmmToTime(m[2]);
    if (start) {
      return { date: m[1], time: start, allDay: false, title: (m[3] ?? "").trim() };
    }
    // malformed time → fall through to date-only, keeping the token in the title
  }

  // 4) Date only: YYYY-MM-DD [Title]
  m = RE_DATE_ONLY.exec(s);
  if (m && isValidDate(m[1])) {
    return { date: m[1], allDay: true, title: (m[2] ?? "").trim() };
  }

  return null;
}

/** True iff the basename begins with a valid event date (i.e. it's an event). */
export function isEventFilename(nameNoExt: string): boolean {
  return parseEventFilename(nameNoExt) !== null;
}

/** The title label from an event filename (empty string when there's no label). */
export function titleFromEventFilename(nameNoExt: string): string {
  return parseEventFilename(nameNoExt)?.title ?? "";
}

export interface EventFilenameParts {
  date: string;
  time?: string;       // HH:MM
  endTime?: string;    // HH:MM
  endDate?: string;    // YYYY-MM-DD
  allDay?: boolean;
}

/**
 * Build the canonical event-filename BASE (no extension) from schedule parts + a
 * title. Inverse of parseEventFilename for the four in-scope shapes. A timed
 * multi-day range (time + a different endDate) collapses to a same-day timed event
 * (the endDate is dropped) since that shape is out of core scope.
 */
export function formatEventFilename(parts: EventFilenameParts, title: string): string {
  const t = (title ?? "").trim();
  const tail = t ? ` ${t}` : "";
  const { date, time, endTime, endDate } = parts;
  if (time) {
    // timed (same-day). endTime optional; endDate intentionally ignored (out of scope).
    return endTime
      ? `${date} ${timeToHhmm(time)}-${timeToHhmm(endTime)}${tail}`
      : `${date} ${timeToHhmm(time)}${tail}`;
  }
  if (endDate && endDate !== date) {
    return `${date} - ${endDate}${tail}`;
  }
  return `${date}${tail}`;
}
