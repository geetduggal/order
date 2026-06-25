// CRUD diff for Google Calendar push: compares the per-device record of what
// Order has synced against the current syncable events, producing the pushes
// (create/update) and deletes. Identity is the natural key (date,time,title);
// no Google event IDs are stored.
import type { PushIntent } from "./gcal-push";

export interface SyncedEntry {
  host: string;
  date: string;
  time?: string;
  title: string;
  /** The push signature the event had when last synced — a push is needed when
   *  the current signature differs (or there's no record entry). */
  sig: string;
}

/** Synced record, keyed by natural key. */
export type SyncRecord = Record<string, SyncedEntry>;

export function naturalKey(date: string, time: string | undefined, title: string): string {
  return `${date}|${time ?? ""}|${title.toLowerCase()}`;
}

export interface SyncPlan {
  pushes: PushIntent[];
  deletes: SyncedEntry[];
}

/** Diff current syncable intents against the synced record. A push: an intent
 *  whose natural key has no record entry, or whose signature changed. A delete:
 *  a record entry whose natural key is no longer among the syncable intents
 *  (event removed, recipients stripped, or rescheduled → its old key). */
export function gcalSyncPlan(record: SyncRecord, intents: PushIntent[], sigOf: (it: PushIntent) => string): SyncPlan {
  const currentKeys = new Set(intents.map((it) => naturalKey(it.date, it.time, it.title)));
  const pushes = intents.filter((it) => record[naturalKey(it.date, it.time, it.title)]?.sig !== sigOf(it));
  const deletes = Object.values(record).filter((e) => !currentKeys.has(naturalKey(e.date, e.time, e.title)));
  return { pushes, deletes };
}

const STORE_KEY = "order.gcal.synced";

export function loadSyncRecord(): SyncRecord {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as SyncRecord) : {};
  } catch { return {}; }
}

export function saveSyncRecord(r: SyncRecord): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(r)); } catch { /* non-fatal */ }
}
