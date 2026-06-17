// markwhen support. A note opts in with `markwhen: true` in its
// frontmatter; its body is then a markwhen timeline (https://markwhen.com).
// We parse it with the official @markwhen/parser and project each event
// into Spacetime's event shape. The caller assigns the folder (the
// markwhen note's own Notable Folder).
//
// markwhen's all-day convention is midnight to midnight: a bare `date:`
// spans to the next midnight, and a range `date/date:` spans to the day
// after its end. Timed events carry a clock on the from side.

import { parse, iter, isEvent } from "@markwhen/parser";
import type { SpacetimeEvent } from "./spacetime";

/** Shift a YYYY-MM-DD date by `n` days, in UTC (date-only, no tz drift). */
function addDaysUTC(isoDate: string, n: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Parse a markwhen document body into Spacetime events (no `folder` —
 *  the caller fills that in). Returns [] on a body markwhen can't read. */
export function parseMarkwhenEvents(body: string): SpacetimeEvent[] {
  let result: ReturnType<typeof parse>;
  try {
    result = parse(body);
  } catch {
    return [];
  }
  const out: SpacetimeEvent[] = [];
  for (const node of iter(result.events)) {
    if (!isEvent(node.eventy)) continue;
    const e = node.eventy;
    const title = (e.firstLine?.restTrimmed || "").trim();
    const fromIso = e.dateRangeIso?.fromDateTimeIso;
    if (!title || !fromIso) continue;
    const toIso = e.dateRangeIso?.toDateTimeIso ?? fromIso;
    const date = fromIso.slice(0, 10);
    const fromTime = fromIso.slice(11, 16);
    const toDate = toIso.slice(0, 10);
    const toTime = toIso.slice(11, 16);

    if (fromTime === "00:00" && toTime === "00:00") {
      // All-day. Single day spans to the next midnight; a longer span's
      // inclusive end is the day before `toDate`.
      const endInclusive = addDaysUTC(toDate, -1);
      if (endInclusive > date) out.push({ date, title, endDate: endInclusive });
      else out.push({ date, title, allDay: true });
    } else {
      const ev: SpacetimeEvent = { date, title, time: fromTime };
      if (toIso !== fromIso) {
        if (toDate === date) ev.endTime = toTime;
        else ev.endDate = toDate;
      }
      out.push(ev);
    }
  }
  return out;
}
