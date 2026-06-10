// A "season" is a user-defined ISO 8601 date range that the Season
// calendar scope filters Notable Folder activity by. Persisted as a
// bullet list inside a vault-root file `Seasons.md`, distinguished
// by YAML `role: seasons` (paralleling `role: areas`).
//
// File body shape:
//   - 2026-01-27 - 2026-05-24 · Spring 2026
//   - 2026-06-01 -  · Current
//
// An empty end means the season is open ended (still current). The
// `· name` suffix is optional.
//
// This module is pure: parsing + the in-memory query that produces
// per-Area NF activity for a given season. The view layer renders.

import type { Frontmatter } from "./frontmatter";
import { parseRef } from "./folders";

export const SEASONS_FILENAME = "Seasons.md";

export interface Season {
  start: string;        // YYYY-MM-DD
  end: string | null;   // YYYY-MM-DD or null (open ended)
  name?: string;
}

const BULLET_RE =
  /^\s*[-*+]\s+(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})?\s*(?:[·•|]\s*(.*))?\s*$/;

export function parseSeasons(body: string): Season[] {
  const out: Season[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.match(BULLET_RE);
    if (!m) continue;
    const start = m[1];
    const end = m[2] ?? null;
    const name = m[3]?.trim() || undefined;
    out.push({ start, end, ...(name ? { name } : {}) });
  }
  return out;
}

export function isSeasonsFile(fm: Frontmatter, filename: string): boolean {
  if (fm.role === "seasons") return true;
  return filename === SEASONS_FILENAME;
}

/** Pick the season whose range contains `today`. If today is open ended
 *  (no `end`), `end` is treated as +infinity. Falls back to the most
 *  recent past season when nothing matches; null when the list is empty. */
export function findSeasonForDate(seasons: Season[], today: string): Season | null {
  if (seasons.length === 0) return null;
  const containing = seasons.find((s) =>
    today >= s.start && (s.end === null || today <= s.end));
  if (containing) return containing;
  const past = seasons.filter((s) => (s.end ?? s.start) < today);
  if (past.length === 0) return seasons[0];
  return past.reduce((a, b) =>
    (a.end ?? a.start) > (b.end ?? b.start) ? a : b);
}

/** Human-friendly label for a season — its name if present, else the
 *  bare date range with an open right edge rendered as "…". */
export function seasonLabel(s: Season): string {
  if (s.name) return s.name;
  return `${s.start} → ${s.end ?? "…"}`;
}

// ---------- Activity query ----------

export interface SeasonUpdate {
  /** Absolute on-disk path to the note — used for click-through nav. */
  path: string;
  /** Display title (note's first-line heading, fallback filename). */
  title: string;
  /** The all-day event's `date` field, YYYY-MM-DD. */
  date: string;
}

export interface NotableUpdate {
  /** Notable Folder name (filename without `.md`). */
  nf: string;
  /** Count of all-day events for this NF inside the season range. */
  count: number;
  /** Most recent all-day event date (YYYY-MM-DD) inside the range. */
  mostRecent: string;
  /** Per-event details, sorted by `date` descending — what the season
   *  view renders as nested bullets under the NF row. */
  updates: SeasonUpdate[];
}

/** Per-Area lists of Notable Folder activity for the season. Each list
 *  is sorted by `mostRecent` descending and capped to `cap` entries.
 *  NFs with zero in-range all-day events are omitted. */
export type SeasonActivity = Map<string, NotableUpdate[]>;

interface NoteForActivity {
  path: string;
  title: string;
  frontmatter: Frontmatter;
}

interface Resolver {
  /** NF name → its parent Area name (empty string if unknown). */
  areaOf(nf: string): string;
  /** Known Notable Folder names. Filters out `folder:` refs that
   *  resolve to nothing on disk. */
  isKnown(nf: string): boolean;
}

/** Cap used per Area cell. Locked in during design — see
 *  docs/seasons-design.md. */
export const PER_AREA_CAP = 8;

export function buildSeasonActivity(
  notes: NoteForActivity[],
  season: Season,
  resolver: Resolver,
  today: string,
): SeasonActivity {
  const end = season.end ?? today;
  // Per-NF aggregation. Accumulates the matching events so the view
  // can expand each NF row into nested bullets.
  const byNf = new Map<string, SeasonUpdate[]>();
  for (const n of notes) {
    if (n.frontmatter.allDay !== true) continue;
    const date = isoDateValue(n.frontmatter.date);
    if (!date) continue;
    if (date < season.start || date > end) continue;
    const nf = parseRef(n.frontmatter.folder);
    if (!nf || !resolver.isKnown(nf)) continue;
    const list = byNf.get(nf) ?? [];
    list.push({ path: n.path, title: n.title, date });
    byNf.set(nf, list);
  }
  // Group by Area.
  const byArea: SeasonActivity = new Map();
  for (const [nf, events] of byNf) {
    const area = resolver.areaOf(nf);
    if (!area) continue;
    // Most-recent first inside each NF.
    events.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const list = byArea.get(area) ?? [];
    list.push({
      nf,
      count: events.length,
      mostRecent: events[0].date,
      updates: events,
    });
    byArea.set(area, list);
  }
  // Sort each Area's NFs by recency desc, then cap.
  for (const [area, list] of byArea) {
    list.sort((a, b) => (a.mostRecent < b.mostRecent ? 1 : a.mostRecent > b.mostRecent ? -1 : 0));
    if (list.length > PER_AREA_CAP) byArea.set(area, list.slice(0, PER_AREA_CAP));
  }
  return byArea;
}

/** Same normalisation CalendarView's `toIsoDateValue` does, scoped down
 *  to what we need here: YYYY-MM-DD string or Date → YYYY-MM-DD. Inlined
 *  to keep the dependency surface of this module small. */
function isoDateValue(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return null;
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}
