// Pure classification of fetched Google events against current spacetime
// events by natural key (date|time|title). Drives the import review's
// pre-checked state: new events are checked, already-present ones unchecked.
import type { SpacetimeEvent } from "./spacetime";

export interface ImportedEvent {
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  /** Inclusive last day of a multi-day span (absent for single-day events). */
  endDate?: string;
  allDay: boolean;
  description: string;
  /** Guest emails from the Google event (resource rooms excluded). */
  attendees: string[];
}

export interface ImportRow extends ImportedEvent {
  isNew: boolean;
}

const key = (date: string, time: string | undefined, title: string) =>
  `${date}|${time ?? ""}|${title.toLowerCase()}`;

export function classifyImports(imported: ImportedEvent[], existing: SpacetimeEvent[]): ImportRow[] {
  const have = new Set(existing.map((e) => key(e.date, e.time, e.title)));
  return imported.map((ev) => ({ ...ev, isNew: !have.has(key(ev.date, ev.time, ev.title)) }));
}
