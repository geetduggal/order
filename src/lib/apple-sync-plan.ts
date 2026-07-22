// CRUD diff for Apple/system-calendar create: compares the per-device record of
// what Order has created against the current `@[Calendar]`-tagged events, so a
// create/update happens only when something changed and a removed tag triggers a
// delete. Identity is the natural key (date,time,title); no EventKit IDs stored.
// Mirrors gcal-sync-plan.ts, kept separate so Apple and Google records don't mix.
import { naturalKey } from "./gcal-sync-plan";
import type { SpacetimeEvent } from "./spacetime";

export interface AppleSyncedEntry {
  calendar: string;
  date: string;
  time?: string;
  title: string;
  /** Signature of the event when last written; a re-write is needed when it differs. */
  sig: string;
}

export type AppleSyncRecord = Record<string, AppleSyncedEntry>;

/** An event Order should create/update on an Apple calendar: any event carrying
 *  an `@[Calendar]` (apple) field. */
export interface AppleIntent {
  calendar: string;
  date: string;
  time?: string;
  endTime?: string;
  endDate?: string;
  allDay: boolean;
  title: string;
  description: string;
}

/** Content signature — a re-save fires when any of these change. */
export function appleSig(it: AppleIntent): string {
  return [it.calendar, it.date, it.time ?? "", it.endTime ?? "", it.endDate ?? "", it.allDay ? "1" : "0", it.title, it.description].join("|");
}

/** Derive create/update intents from spacetime events that carry `@[Cal]`. */
export function appleIntents(events: SpacetimeEvent[], descriptionFor: (e: SpacetimeEvent) => string): AppleIntent[] {
  return events
    .filter((e) => !!e.apple)
    .map((e) => ({
      calendar: e.apple!,
      date: e.date,
      time: e.time,
      endTime: e.endTime,
      endDate: e.endDate,
      allDay: e.allDay ?? (!e.time && !e.endDate),
      title: e.title,
      description: descriptionFor(e),
    }));
}

export interface AppleSyncPlan {
  writes: AppleIntent[];
  deletes: AppleSyncedEntry[];
}

/** A write: an intent whose natural key has no record entry, or whose signature
 *  changed. A delete: a record entry whose key is no longer among the tagged
 *  events (tag removed, or event deleted / rescheduled to a new key). */
export function appleSyncPlan(record: AppleSyncRecord, intents: AppleIntent[]): AppleSyncPlan {
  const currentKeys = new Set(intents.map((it) => naturalKey(it.date, it.time, it.title)));
  const writes = intents.filter((it) => record[naturalKey(it.date, it.time, it.title)]?.sig !== appleSig(it));
  const deletes = Object.values(record).filter((e) => !currentKeys.has(naturalKey(e.date, e.time, e.title)));
  return { writes, deletes };
}

const STORE_KEY = "order.applecal.synced";

export function loadAppleSyncRecord(): AppleSyncRecord {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as AppleSyncRecord) : {};
  } catch { return {}; }
}

export function saveAppleSyncRecord(r: AppleSyncRecord): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch { /* non-fatal */ }
}
