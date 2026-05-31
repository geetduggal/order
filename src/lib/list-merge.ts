// Smart merge: take a base's filter/sort + the user's previously
// saved manual order + the current set of vault notes; return the
// resulting ordered list of refs. Items still matching keep their
// manual position; new ones append in the base's sort. Pure module.

import type { Filter, ParsedBase } from "./list-base";
import type { ListNoteRef } from "./list-folder";

/** Re-export under the local name we use in this module. */
export type NoteRef = ListNoteRef;

function getProp(note: NoteRef, prop: string): unknown {
  switch (prop) {
    case "file.name": return note.filename.replace(/\.md$/i, "");
    case "file.folder": return note.dir ?? note.folder;
    case "file.ctime": return note.ctime;
    case "file.mtime": return note.mtime;
    default: return note.frontmatter[prop];
  }
}

function evalFilter(filter: Filter, note: NoteRef): boolean {
  if ("kind" in filter) {
    const v = getProp(note, filter.prop);
    const s = v == null ? "" : String(v);
    return s.toLowerCase().includes(filter.needle.toLowerCase());
  }
  if ("and" in filter) return filter.and.every((f) => evalFilter(f, note));
  if ("or" in filter) return filter.or.some((f) => evalFilter(f, note));
  return false;
}

export function matchNotes(parsed: ParsedBase, notes: NoteRef[]): NoteRef[] {
  const filters: Filter[] = [];
  if (parsed.outerFilters) filters.push(parsed.outerFilters);
  if (parsed.view.filters) filters.push(parsed.view.filters);
  if (filters.length === 0) return notes;
  const f: Filter = filters.length === 1 ? filters[0] : { and: filters };
  return notes.filter((n) => evalFilter(f, n));
}

/** Stable, human-meaningful tiebreaker for items that compare equal on
 *  the primary sort key — or both lack one. Title first (what the user
 *  reads on the card), filename second. Always ascending, regardless
 *  of the primary direction, so "no published date" items read like a
 *  predictable alphabetical appendix at the end of the list. */
function tiebreak(a: NoteRef, b: NoteRef): number {
  const titleA = typeof a.frontmatter.title === "string" ? a.frontmatter.title : "";
  const titleB = typeof b.frontmatter.title === "string" ? b.frontmatter.title : "";
  const ka = (titleA || a.filename.replace(/\.md$/i, "")).toLocaleLowerCase();
  const kb = (titleB || b.filename.replace(/\.md$/i, "")).toLocaleLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Normalize a sort key value so the comparator behaves the same on
 *  desktop (where js-yaml turns unquoted ISO datetimes into JS Dates)
 *  and in the published web viewer (where the same values come back
 *  as ISO strings after JSON round-trip). Date-looking values become
 *  epoch ms; arbitrary strings become lowercased text; numbers stay
 *  numbers. Returns null for missing/empty so the comparator can
 *  push those to the end of the list deterministically. */
function normalizeSortKey(v: unknown): number | string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    // Treat anything that round-trips through Date.parse as a date —
    // covers ISO dates, ISO datetimes, and a few looser forms — so
    // "2024-01-04" and "2024-01-04T00:00:00.000Z" sort identically
    // and a Date instance from yaml-parse sorts identically to its
    // JSON-stringified form in the viewer.
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (Number.isFinite(t)) return t;
    }
    return v.toLowerCase();
  }
  return String(v).toLowerCase();
}

export function sortByBase(parsed: ParsedBase, notes: NoteRef[]): NoteRef[] {
  if (!parsed.view.sort) return notes;
  const { prop, dir } = parsed.view.sort;
  const sign = dir === "asc" ? 1 : -1;

  // Pre-compute the normalized sort key for every note, then decide
  // whether the column is "date-typed" or "number-typed" — i.e. ANY
  // note's value normalized to a number. If so, every value that
  // ISN'T a number (a stray string like "" / "Unknown" / "TBD" /
  // bad-format date) joins the missing bucket at the end of the
  // list, not the middle of the numeric range. This is what the
  // user expects from a `sort: published DESC` over a Readwise
  // dump where most items have ISO dates and a handful don't.
  const keys = new Map<NoteRef, number | string | null>();
  let columnIsNumeric = false;
  for (const n of notes) {
    const k = normalizeSortKey(getProp(n, prop));
    keys.set(n, k);
    if (typeof k === "number") columnIsNumeric = true;
  }
  if (columnIsNumeric) {
    for (const [n, k] of keys) {
      if (typeof k === "string") keys.set(n, null);
    }
  }

  return [...notes].sort((a, b) => {
    const av = keys.get(a) ?? null;
    const bv = keys.get(b) ?? null;
    // Items without the sort key go to the END (regardless of
    // asc/desc) and sort lexicographically among themselves so the
    // bucket is stable and scannable instead of an arbitrary jumble.
    if (av === null && bv === null) return tiebreak(a, b);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return tiebreak(a, b);
    return sign * ((av as number | string) < (bv as number | string) ? -1 : 1);
  });
}

function noteRef(n: NoteRef): string {
  return n.filename.replace(/\.md$/i, "");
}

/** Smart merge: items still matching keep their saved manual position;
 *  new items append in the base's sort; removed items drop out. */
export function smartMerge(
  parsed: ParsedBase,
  notes: NoteRef[],
  savedOrder: string[],
): string[] {
  const matched = matchNotes(parsed, notes);
  const matchedRefs = new Set(matched.map(noteRef));
  const kept = savedOrder.filter((r) => matchedRefs.has(r));
  const keptSet = new Set(kept);
  const added = sortByBase(parsed, matched.filter((n) => !keptSet.has(noteRef(n))));
  return [...kept, ...added.map(noteRef)];
}
