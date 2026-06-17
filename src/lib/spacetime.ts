// Spacetime: the canonical, minimal plain-text picture of the vault —
// `space` (the Areas → Categories → Notable Folders hierarchy) and
// `time` (events + seasons). Generated from the directory structure and
// note frontmatter and written to `spacetime.yml` at the vault root. See
// SPACETIME.md for the format essay.
//
// The serializer is hand-rolled rather than js-yaml because the format
// has specific human conventions js-yaml won't produce: `space` as nested
// block lists, and `time` records as column-aligned flow mappings with
// `date` and `title` first. Output is still legal YAML (round-trip tested).

import type { VaultTaxonomy } from "./taxonomy";

/** One node in the space hierarchy: a name plus its ordered children
 *  (the "brood"). Leaves have an empty children list. */
export interface SpaceNode {
  name: string;
  children: SpaceNode[];
}

export interface SpacetimeEvent {
  date: string;            // YYYY-MM-DD
  title: string;
  folder?: string;
  time?: string;           // HH:MM (maps from frontmatter startTime)
  endTime?: string;        // HH:MM
  endDate?: string;        // YYYY-MM-DD
  allDay?: boolean;
}

export interface SpacetimeSeason {
  date: string;            // YYYY-MM-DD (range start)
  title: string;
  endDate?: string;        // YYYY-MM-DD (range end; absent = open ended)
}

export interface Spacetime {
  space: SpaceNode[];
  seasons: SpacetimeSeason[];
  events: SpacetimeEvent[];
}

/** Build the `space` tree from Order's taxonomy: areas → categories →
 *  folder names. Three levels, leaves (folders) carry no children. */
export function spaceFromTaxonomy(tax: VaultTaxonomy): SpaceNode[] {
  return tax.areas.map((area) => ({
    name: area.ref,
    children: area.categories.map((cat) => ({
      name: cat.ref,
      children: cat.folders.map((f) => ({ name: f, children: [] })),
    })),
  }));
}

// ---------- YAML emission ----------

/** Quote a scalar only when bare YAML would misread it. Keeps the common
 *  case (plain names, ISO dates, HH:MM as a string) unquoted and readable;
 *  wraps anything with structural characters in double quotes. */
function scalar(v: string): string {
  // A time like 09:00 is fine bare in flow context after a key, but a
  // leading-zero/colon value as a standalone scalar can be read as a
  // sexagesimal number by some parsers — we only use scalar() for names
  // and titles, and emit times/dates directly, so plain is safe here.
  if (v === "") return '""';
  if (/^[\w][\w ./&'+()\-]*$/.test(v) && !/^\s|\s$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render the space hierarchy as nested block lists. The `- ` marker for
 *  a node at depth d sits at column 2 + 4·d; a node with children gets a
 *  trailing colon and its brood renders one level deeper. */
function renderSpace(nodes: SpaceNode[], depth: number): string[] {
  const indent = " ".repeat(2 + depth * 4);
  const out: string[] = [];
  for (const node of nodes) {
    if (node.children.length > 0) {
      out.push(`${indent}- ${scalar(node.name)}:`);
      out.push(...renderSpace(node.children, depth + 1));
    } else {
      out.push(`${indent}- ${scalar(node.name)}`);
    }
  }
  return out;
}

/** Render a list of records as column-aligned flow mappings. `anchorKeys`
 *  are aligned into columns (their `key: value,` segment is padded so the
 *  next field starts at a fixed column across every row); any remaining
 *  keys are packed after, comma separated. `date` and `title` lead. */
// Title and folder are free text and may need quoting; dates, times and
// allDay are emitted bare to match the example's look (still legal YAML —
// dates parse as timestamps, times stay as written).
const QUOTED = new Set(["title", "folder"]);
function fmtVal(key: string, v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return QUOTED.has(key) ? scalar(String(v)) : String(v);
}
/** The `key: value,` segment for a record/key, or "" when absent. */
function seg(r: Record<string, unknown>, k: string): string {
  const v = fmtVal(k, r[k]);
  return v === null ? "" : `${k}: ${v},`;
}
/** Per-key max segment width across a set of records — used to align a
 *  column. `extra` lets a column's width be shared with another record
 *  set (e.g. date+title aligned across both seasons and events). */
function segWidths(
  records: ReadonlyArray<Record<string, unknown>>,
  keys: string[],
  extra: ReadonlyArray<Record<string, unknown>> = [],
): number[] {
  return keys.map((k) =>
    Math.max(0, ...records.map((r) => seg(r, k).length), ...extra.map((r) => seg(r, k).length)),
  );
}

function renderRecords(
  records: ReadonlyArray<Record<string, unknown>>,
  anchorKeys: string[],
  tailKeys: string[],
  indent: string,
  anchorSegWidths: number[],
): string[] {
  const fmt = fmtVal;
  // Build the anchored segments per record so we can size each column.
  // segs[i] = the `key: value,` text for anchorKeys[i] (or "" if absent).
  const rowSegs = records.map((r) => anchorKeys.map((k) => seg(r, k)));
  // Column width = the (possibly shared) max segment width + 1 space gap,
  // so the following field lines up across all rows.
  const colWidth = anchorKeys.map((_, i) => anchorSegWidths[i] + 1);
  return records.map((r, ri) => {
    let line = "";
    rowSegs[ri].forEach((seg, ci) => {
      // Pad every anchored column to its width so the next column aligns,
      // except trailing padding before the close brace is trimmed later.
      line += seg.padEnd(colWidth[ci]);
    });
    const tail = tailKeys
      .map((k) => {
        const v = fmt(k, r[k]);
        return v === null ? null : `${k}: ${v}`;
      })
      .filter((x): x is string => x !== null)
      .join(", ");
    let body = line + tail;
    // Drop any trailing comma + padding (when there were no tail fields).
    body = body.replace(/,\s*$/, "").replace(/\s+$/, "");
    return `${indent}- {${body}}`;
  });
}

/** Serialize a Spacetime model to the canonical YAML text. */
export function serializeSpacetime(st: Spacetime): string {
  const lines: string[] = [];
  lines.push("space:");
  lines.push(...renderSpace(st.space, 0));
  lines.push("time:");
  // Share the date + title column widths across seasons AND events so the
  // column after the title (endDate for seasons, folder for events) lines
  // up across both lists, the way SPACETIME.md shows.
  const seasonRecs = st.seasons as unknown as Record<string, unknown>[];
  const eventRecs = st.events as unknown as Record<string, unknown>[];
  const dateTitleW = segWidths(seasonRecs, ["date", "title"], eventRecs);
  const folderW = segWidths(eventRecs, ["folder"]);
  lines.push("  seasons:");
  lines.push(...renderRecords(seasonRecs, ["date", "title"], ["endDate"], "    ", dateTitleW));
  lines.push("  events:");
  lines.push(
    ...renderRecords(
      eventRecs,
      ["date", "title", "folder"],
      ["time", "endTime", "endDate", "allDay"],
      "    ",
      [...dateTitleW, folderW[0]],
    ),
  );
  return lines.join("\n") + "\n";
}
