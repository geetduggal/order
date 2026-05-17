// Smart merge: take a base's filter/sort + the user's previously
// saved manual order + the current set of vault notes; return the
// resulting ordered list of refs. Items still matching keep their
// manual position; new ones append in the base's sort. Pure module.

import type { Filter, ParsedBase } from "./list-base";
import type { Frontmatter } from "./frontmatter";

export interface NoteRef {
  /** filename without `.md` — the wikilink ref */
  ref: string;
  /** directory name relative to vault root — for `file.folder` */
  folder: string;
  /** unix ms */
  ctime: number;
  mtime: number;
  frontmatter: Frontmatter;
}

function getProp(note: NoteRef, prop: string): unknown {
  switch (prop) {
    case "file.name": return note.ref;
    case "file.folder": return note.folder;
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

export function sortByBase(parsed: ParsedBase, notes: NoteRef[]): NoteRef[] {
  if (!parsed.view.sort) return notes;
  const { prop, dir } = parsed.view.sort;
  const sign = dir === "asc" ? 1 : -1;
  return [...notes].sort((a, b) => {
    const av = getProp(a, prop);
    const bv = getProp(b, prop);
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sign * ((av as number | string) < (bv as number | string) ? -1 : 1);
  });
}

/** Smart merge: items still matching keep their saved manual position;
 *  new items append in the base's sort; removed items drop out. */
export function smartMerge(
  parsed: ParsedBase,
  notes: NoteRef[],
  savedOrder: string[],
): string[] {
  const matched = matchNotes(parsed, notes);
  const matchedRefs = new Set(matched.map((n) => n.ref));
  const kept = savedOrder.filter((r) => matchedRefs.has(r));
  const keptSet = new Set(kept);
  const added = sortByBase(parsed, matched.filter((n) => !keptSet.has(n.ref)));
  return [...kept, ...added.map((n) => n.ref)];
}
