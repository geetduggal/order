// Spacetime: the canonical, minimal plain-text picture of the vault —
// `space` (the Areas → Categories → Notable Folders hierarchy) and
// `time` (events + seasons). Generated from the directory structure and
// note frontmatter and written to `spacetime.yml` at the vault root. See
// docs/CONVENTIONS.md for the format essay.
//
// The serializer is hand-rolled rather than js-yaml because the format
// has specific human conventions js-yaml won't produce: `space` as nested
// block lists, and `time` records as column-aligned flow mappings with
// `date` and `title` first. Output is still legal YAML (round-trip tested).

import yaml from "js-yaml";
import type { VaultTaxonomy, AreaNode, CategoryNode } from "./taxonomy";
import { type Frontmatter, toIsoDateValue, noteTitle } from "./frontmatter";
import { noteFolder } from "./folders";
import { parseSeasons, isSeasonsFile } from "./seasons";
import { parseMarkwhenEvents } from "./markwhen";

// ---------- Composability types ----------

/** A conflict detected while merging Spacetime sources. */
export interface SpacetimeConflict {
  /** "brood"     — two sources define the same parent's children differently.
   *  "folderRef" — an event references a folder not in the merged space. */
  kind: "brood" | "folderRef";
  message: string;
  /** Vault-relative paths of the files involved. */
  paths: string[];
}

/** A parsed Spacetime paired with the vault-relative path it came from. */
export interface SpacetimeSource {
  parsed: Spacetime;
  /** Vault-relative path (e.g. "spacetime.mw", "Work/work-archive.mw"). */
  path: string;
}

/** Result of merging multiple Spacetime sources. */
export interface SpacetimeMergeResult {
  spacetime: Spacetime;
  conflicts: SpacetimeConflict[];
}

// ---------- Space hierarchy ----------

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
  emails?: string[];       // Google sync recipients written on the line (Task 3 classifies)
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

/** Minimal note shape the Spacetime builder reads. */
export interface SpacetimeNote {
  filename: string;
  frontmatter: Frontmatter;
  body: string;
  /** Display title (frontmatter title or first line); falls back to the
   *  filename when absent. */
  title?: string;
  /** Vault path. Used to recover a note's Notable Folder when its
   *  frontmatter has no `folder:` (e.g. a markwhen source note): the
   *  folder is the note's parent directory. */
  path?: string;
}

/** The Notable Folder a note belongs to: its `folder:` frontmatter, else
 *  its parent directory name (files live only inside their NF). */
function folderOf(n: SpacetimeNote): string | undefined {
  const explicit = noteFolder(n.frontmatter);
  if (explicit) return explicit;
  if (!n.path) return undefined;
  const parts = n.path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

/** Build the canonical Spacetime model from the vault.
 *
 *  Space + seasons come from merging all `.mw` sources found in the vault
 *  (passed via `mwSources`), falling back to `existing` from `spacetime.yml`,
 *  then to the chain taxonomy / Seasons.md for un-migrated vaults.
 *
 *  Events are always regenerated from note frontmatter (notes are the truth
 *  for event content). Conflicts from the composability merge are returned
 *  alongside the model. */
export function buildSpacetime(
  notes: SpacetimeNote[],
  tax: VaultTaxonomy,
  existing?: Spacetime,
  mwSources?: SpacetimeSource[],
): Spacetime & { conflicts?: SpacetimeConflict[] } {

  let space: SpaceNode[];
  let seasons: SpacetimeSeason[];
  let conflicts: SpacetimeConflict[] | undefined;

  if (mwSources && mwSources.length > 0) {
    // Full composability path: merge all .mw sources
    const mergeResult = mergeSpacetimes(mwSources);
    space = mergeResult.spacetime.space.length > 0
      ? mergeResult.spacetime.space
      : (existing?.space.length ? existing.space : spaceFromTaxonomy(tax));
    seasons = mergeResult.spacetime.seasons.length > 0
      ? mergeResult.spacetime.seasons
      : (existing?.seasons.length ? existing.seasons : []);
    if (mergeResult.conflicts.length > 0) conflicts = mergeResult.conflicts;
  } else if (existing && existing.space.length > 0) {
    // Single-file path: existing spacetime.yml is authoritative
    space = existing.space;
    seasons = existing.seasons.length > 0 ? existing.seasons : [];
  } else {
    // Fallback: chain taxonomy + Seasons.md (un-migrated vaults)
    space = spaceFromTaxonomy(tax);
    const seasonsFile = notes.find((n) => isSeasonsFile(n.frontmatter, n.filename));
    seasons = (seasonsFile ? parseSeasons(seasonsFile.body) : [])
      .map((s) => ({ date: s.start, title: s.name ?? "", ...(s.end ? { endDate: s.end } : {}) }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // When no seasons from mw/yml yet, fall back to Seasons.md
  if (seasons.length === 0 && !mwSources?.length && existing?.seasons.length === 0) {
    const seasonsFile = notes.find((n) => isSeasonsFile(n.frontmatter, n.filename));
    if (seasonsFile) {
      seasons = parseSeasons(seasonsFile.body)
        .map((s) => ({ date: s.start, title: s.name ?? "", ...(s.end ? { endDate: s.end } : {}) }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  const byKey = new Map<string, SpacetimeEvent>();
  for (const n of notes) {
    const fm = n.frontmatter;
    const date = toIsoDateValue(fm.date);
    if (!date) continue;
    const startRaw = typeof fm.startTime === "string" ? fm.startTime : undefined;
    const time = startRaw && /^\d{2}:\d{2}$/.test(startRaw) ? startRaw : undefined;
    const endRaw = typeof fm.endTime === "string" ? fm.endTime : undefined;
    const endTime = endRaw && /^\d{2}:\d{2}$/.test(endRaw) ? endRaw : undefined;
    const allDay = fm.allDay === true || (!!startRaw && !time);
    if (!allDay && !time) continue; // dated reference note, not an event
    const endDate = typeof fm.endDate === "string" ? String(fm.endDate).slice(0, 10) : undefined;
    const folder = folderOf(n);
    const title = noteTitle(fm, n.body, n.filename.replace(/\.md$/i, ""));
    const ev: SpacetimeEvent = {
      date, title,
      ...(folder ? { folder } : {}),
      ...(time ? { time } : {}),
      ...(endTime ? { endTime } : {}),
      ...(endDate ? { endDate } : {}),
      ...(allDay ? { allDay: true } : {}),
    };
    const k = `${date}|${time ?? ""}|${title.toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, ev);
  }
  // markwhen notes (`markwhen: true`): fold their timeline events in too,
  // tagged with the note's own folder. Deduped against frontmatter events
  // by the same identity, so a materialized backing note won't double up.
  for (const n of notes) {
    if (n.frontmatter.markwhen !== true) continue;
    const folder = folderOf(n);
    for (const mw of parseMarkwhenEvents(n.body)) {
      const ev: SpacetimeEvent = { ...mw, ...(folder ? { folder } : {}) };
      const k = `${ev.date}|${ev.time ?? ""}|${ev.title.toLowerCase()}`;
      if (!byKey.has(k)) byKey.set(k, ev);
    }
  }
  const events = [...byKey.values()].sort((a, b) =>
    (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")),
  );
  return conflicts ? { space, seasons, events, conflicts } : { space, seasons, events };
}

/** Build a VaultTaxonomy from a parsed spacetime.yml `space` tree.
 *  Assumes the three-level invariant (Area → Category → NF); nodes that
 *  don't fit are skipped. hiddenRefs is empty because there are no chain
 *  index files to hide when spacetime drives the taxonomy. */
export function spacetimeTaxonomy(space: SpaceNode[]): VaultTaxonomy {
  const areas: AreaNode[] = [];
  for (const areaNode of space) {
    const categories: CategoryNode[] = [];
    for (const catNode of areaNode.children) {
      const folders = catNode.children.map((f) => f.name);
      categories.push({ ref: catNode.name, folders });
    }
    areas.push({ ref: areaNode.name, categories });
  }
  return { areas, hiddenRefs: new Set() };
}

/** Mutation types for the `space` tree. All structure edits (sidebar,
 *  migrations, apply-sync) go through `applySpaceMutation` so the
 *  tree-walk logic is in one place. */
export type SpaceMutation =
  | { kind: "addArea"; name: string }
  | { kind: "removeArea"; name: string }
  | { kind: "reorderAreas"; names: string[] }
  | { kind: "addCategory"; area: string; name: string }
  | { kind: "removeCategory"; area: string; name: string }
  | { kind: "reorderCategories"; area: string; names: string[] }
  | { kind: "addFolder"; area: string; category: string; name: string }
  | { kind: "removeFolder"; area: string; category: string; name: string }
  | { kind: "reorderFolders"; area: string; category: string; names: string[] };

export function applySpaceMutation(space: SpaceNode[], m: SpaceMutation): SpaceNode[] {
  switch (m.kind) {
    case "addArea":
      if (space.some((n) => n.name === m.name)) return space;
      return [...space, { name: m.name, children: [] }];
    case "removeArea":
      return space.filter((n) => n.name !== m.name);
    case "reorderAreas":
      return m.names.flatMap((name) => {
        const found = space.find((n) => n.name === name);
        return found ? [found] : [];
      });
    case "addCategory":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.some((c) => c.name === m.name) ? a.children
          : [...a.children, { name: m.name, children: [] }],
      });
    case "removeCategory":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.filter((c) => c.name !== m.name),
      });
    case "reorderCategories":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: m.names.flatMap((n) => {
          const found = a.children.find((c) => c.name === n);
          return found ? [found] : [];
        }),
      });
    case "addFolder":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: c.children.some((f) => f.name === m.name) ? c.children
            : [...c.children, { name: m.name, children: [] }],
        }),
      });
    case "removeFolder":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: c.children.filter((f) => f.name !== m.name),
        }),
      });
    case "reorderFolders":
      return space.map((a) => a.name !== m.area ? a : {
        ...a, children: a.children.map((c) => c.name !== m.category ? c : {
          ...c, children: m.names.flatMap((n) => {
            const found = c.children.find((f) => f.name === n);
            return found ? [found] : [];
          }),
        }),
      });
  }
}

// ---------- Composability engine ----------

/** Collect all "brood claims" from a space tree into a flat map.
 *  A brood claim is: "at path P the complete ordered children are [...]".
 *
 *  The ROOT LEVEL ("") is intentionally skipped — top-level areas are
 *  always unioned across sources. Brood claims are only collected at
 *  depth ≥ 1 (area→categories, category→folders), where the completeness
 *  invariant matters: if you declare a node's children, you must list all
 *  of them. A node with no children makes no claim (leaf or placeholder). */
function collectBroodClaims(
  nodes: SpaceNode[],
  parentPath: string,
  sourcePath: string,
  out: Map<string, { names: string[]; nodes: SpaceNode[]; source: string }[]>,
  depth = 0,
): void {
  if (nodes.length === 0) return;
  // Skip root-level claim: the top-level area list is always a UNION across
  // sources. Only record claims at depth ≥ 1 (non-root nodes).
  if (depth > 0) {
    if (!out.has(parentPath)) out.set(parentPath, []);
    out.get(parentPath)!.push({ names: nodes.map((n) => n.name), nodes, source: sourcePath });
  }
  for (const node of nodes) {
    if (node.children.length > 0) {
      collectBroodClaims(
        node.children,
        `${parentPath}/${node.name}`,
        sourcePath,
        out,
        depth + 1,
      );
    }
  }
}

/** Reconstruct the merged space tree. The root is built by unioning all
 *  top-level nodes across sources; every other level is resolved from the
 *  settled brood-claims map (first claim wins for ordering). */
function buildMergedSpace(
  parentPath: string,
  claims: Map<string, { names: string[]; nodes: SpaceNode[]; source: string }[]>,
  topLevelNodes: SpaceNode[],
): SpaceNode[] {
  if (parentPath === "") {
    // Union all top-level nodes; children are resolved recursively
    const seen = new Set<string>();
    const result: SpaceNode[] = [];
    for (const n of topLevelNodes) {
      if (seen.has(n.name)) continue;
      seen.add(n.name);
      const childPath = `/${n.name}`;
      const children = buildMergedSpace(childPath, claims, []);
      result.push({ name: n.name, children });
    }
    return result;
  }
  const entry = claims.get(parentPath);
  if (!entry || entry.length === 0) return [];
  return entry[0].names.map((name) => ({
    name,
    children: buildMergedSpace(`${parentPath}/${name}`, claims, []),
  }));
}

/** Merge multiple Spacetime sources following the brood rule.
 *
 *  Brood rule: for any given parent node, all sources that define its children
 *  must agree on the complete, ordered set. Two sources defining the same
 *  parent with different children is a conflict; two sources with the same
 *  set (in any order) are compatible (first-source order wins).
 *
 *  Events and seasons are concatenated and deduplicated by identity. */
export function mergeSpacetimes(sources: SpacetimeSource[]): SpacetimeMergeResult {
  const conflicts: SpacetimeConflict[] = [];
  const broodClaims = new Map<
    string,
    { names: string[]; nodes: SpaceNode[]; source: string }[]
  >();

  // Collect brood claims (depth ≥ 1) and all top-level nodes (for union)
  const allTopLevel: SpaceNode[] = [];
  const seenTopLevel = new Set<string>();
  for (const { parsed, path } of sources) {
    if (parsed.space.length > 0) {
      collectBroodClaims(parsed.space, "", path, broodClaims);
      // Union top-level nodes in source order (first occurrence wins for order)
      for (const n of parsed.space) {
        if (!seenTopLevel.has(n.name)) { seenTopLevel.add(n.name); allTopLevel.push(n); }
      }
    }
  }

  // Detect conflicts: same non-root parent, different child sets
  for (const [parentPath, entries] of broodClaims) {
    if (entries.length <= 1) continue;
    const refSet = new Set(entries[0].names);
    for (const e of entries.slice(1)) {
      const eSet = new Set(e.names);
      const sameSet = refSet.size === eSet.size && [...refSet].every((n) => eSet.has(n));
      if (!sameSet) {
        conflicts.push({
          kind: "brood",
          message:
            `Conflicting children at "${parentPath.replace(/^\//, "")}": ` +
            `[${entries[0].names.join(", ")}] in "${entries[0].source}" vs ` +
            `[${e.names.join(", ")}] in "${e.source}"`,
          paths: [entries[0].source, e.source],
        });
      }
    }
  }

  // Build merged space: top-level is a union; sub-levels use brood claims
  const space = buildMergedSpace("", broodClaims, allTopLevel);

  // Merge seasons: concatenate, dedup by date+title
  const seasonSeen = new Set<string>();
  const seasons: SpacetimeSeason[] = [];
  for (const { parsed } of sources) {
    for (const s of parsed.seasons) {
      const k = `${s.date}|${s.title.toLowerCase()}`;
      if (!seasonSeen.has(k)) { seasonSeen.add(k); seasons.push(s); }
    }
  }
  seasons.sort((a, b) => a.date.localeCompare(b.date));

  // Merge events: dedup by date|title
  const eventSeen = new Set<string>();
  const events: SpacetimeEvent[] = [];
  for (const { parsed } of sources) {
    for (const e of parsed.events) {
      const k = `${e.date}|${e.title.toLowerCase()}`;
      if (!eventSeen.has(k)) { eventSeen.add(k); events.push(e); }
    }
  }
  events.sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));

  const merged: Spacetime = { space, seasons, events };

  // Validate folder references
  conflicts.push(...validateFolderRefs(merged, sources));

  return { spacetime: merged, conflicts };
}

/** Check every event in merged for a folder that doesn't exist in
 *  the merged space tree. Returns one conflict per invalid reference. */
export function validateFolderRefs(
  merged: Spacetime,
  sources: SpacetimeSource[],
): SpacetimeConflict[] {
  // Build set of all leaf (Notable Folder) names from merged space
  const folderNames = new Set<string>();
  function collectFolders(nodes: SpaceNode[]) {
    for (const n of nodes) {
      if (n.children.length === 0) folderNames.add(n.name.toLowerCase());
      else collectFolders(n.children);
    }
  }
  collectFolders(merged.space);

  // Only validate when we actually have a space (avoid false positives on
  // empty-space vaults where events predate the hierarchy being defined).
  if (folderNames.size === 0) return [];

  // Build a lookup from event → source file
  const eventSource = new Map<string, string>();
  for (const { parsed, path } of sources) {
    for (const e of parsed.events) {
      const k = `${e.date}|${e.title.toLowerCase()}`;
      if (!eventSource.has(k)) eventSource.set(k, path);
    }
  }

  const conflicts: SpacetimeConflict[] = [];
  for (const e of merged.events) {
    if (!e.folder) continue;
    if (!folderNames.has(e.folder.toLowerCase())) {
      const k = `${e.date}|${e.title.toLowerCase()}`;
      const src = eventSource.get(k) ?? "unknown";
      conflicts.push({
        kind: "folderRef",
        message: `Event "${e.title}" (${e.date}) references folder "${e.folder}" which is not in the space hierarchy`,
        paths: [src],
      });
    }
  }
  return conflicts;
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
  caps: number[],
): string[] {
  const fmt = fmtVal;
  // Build the anchored segments per record so we can size each column.
  // segs[i] = the `key: value,` text for anchorKeys[i] (or "" if absent).
  const rowSegs = records.map((r) => anchorKeys.map((k) => seg(r, k)));
  // Column width = the max segment width, CAPPED so one very long title
  // (or folder) doesn't pad every row out to its length. Rows within the
  // cap align; a rare over-cap row overflows with a single trailing space.
  const colWidth = anchorKeys.map((_, i) => Math.min(anchorSegWidths[i], caps[i]) + 1);
  return records.map((r, ri) => {
    let line = "";
    rowSegs[ri].forEach((seg, ci) => {
      // Pad short segments to the column so the next field aligns; an
      // over-cap segment just gets one space so it stays readable.
      line += seg.length < colWidth[ci] ? seg.padEnd(colWidth[ci]) : seg + " ";
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

// Column caps (segment widths incl. the `key: ` prefix). Keep alignment
// tidy on screen: a single very long title or folder overflows on its own
// row instead of padding every other row out to its length. Dates are
// fixed width, so they're effectively uncapped.
const DATE_CAP = 99;
const TITLE_CAP = 44;
const FOLDER_CAP = 24;

// ---------- Markwhen serializer ----------

/** Translate a space-separated Notable Folder name to a Markwhen tag:
 *  "Board Games" → "#board-games". Used in spacetime.mw output. */
export function toMarkwhenTag(name: string): string {
  return "#" + name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** Brace folder tag: "Geet Duggal" → "#[Geet Duggal]". The canonical form on
 *  event lines — exact name, no kebab mangling. */
export function toBraceTag(name: string): string {
  return `#[${name}]`;
}

/** Strip a folder-tag token to a plain name. A brace token `#[Name]` → `Name`
 *  (trimmed); any other `#token` → the token minus its leading `#` (legacy
 *  kebab fallback). Used when a tag doesn't resolve to a known Space folder. */
export function stripTagToName(tag: string): string {
  const b = tag.match(/^#\[(.+)\]$/);
  return b ? b[1].trim() : tag.slice(1);
}

/** Serialize a Spacetime to the Markwhen `.mw` format:
 *  a `# Space` section (nested markdown lists) followed by a
 *  `# Time` section (seasons + date-aligned events). */
export function serializeMarkwhen(st: Spacetime): string {
  const lines: string[] = [];

  // Space section — mirror the YAML space hierarchy as nested lists
  lines.push("# Space", "");
  function renderMwSpace(nodes: SpaceNode[], depth: number) {
    const indent = "  ".repeat(depth);
    for (const node of nodes) {
      if (node.children.length > 0) {
        lines.push(`${indent}- ${node.name}`);
        renderMwSpace(node.children, depth + 1);
      } else {
        lines.push(`${indent}- ${node.name}`);
      }
    }
  }
  // Top-level areas get ## headings for readability
  for (const area of st.space) {
    lines.push(`## ${area.name}`);
    renderMwSpace(area.children, 0);
    lines.push("");
  }

  // Time section
  lines.push("# Time", "");

  // Seasons
  if (st.seasons.length > 0) {
    lines.push("## Seasons", "");
    // Compute alignment: longest "date / endDate: " prefix
    const dateW = Math.max(...st.seasons.map((s) =>
      s.endDate ? `${s.date} / ${s.endDate}`.length : s.date.length,
    ));
    for (const s of st.seasons) {
      const range = s.endDate ? `${s.date} / ${s.endDate}` : s.date;
      lines.push(`${range.padEnd(dateW)}: ${s.title}`);
    }
    lines.push("");
  }

  // Events — always emitted in stable date+time order.
  if (st.events.length > 0) {
    lines.push("## Events", "");
    const events = sortMwEvents(st.events);
    // Build date+time prefix per event for alignment
    const prefixes = events.map((e) => {
      const dt = e.time
        ? (e.endTime ? `${e.date} ${e.time}-${e.endTime}` : `${e.date} ${e.time}`)
        : (e.endDate ? `${e.date} / ${e.endDate}` : e.date);
      return dt;
    });
    const prefixW = Math.max(...prefixes.map((p) => p.length));
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const tag = e.folder ? ` ${toBraceTag(e.folder)}` : "";
      const recips = e.emails?.length ? ` ${e.emails.join(" ")}` : "";
      lines.push(`${prefixes[i].padEnd(prefixW)}: ${e.title}${tag}${recips}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Replace (or append) only the `## Events` block in an existing spacetime.mw
 *  body, leaving the Space and Seasons sections exactly as they are.
 *  Effect 1 uses this so a note-save never rewrites the user's Space layout. */
export function spliceMwEvents(mw: string, eventsIn: SpacetimeEvent[]): string {
  // Always write the events block in stable date+time order.
  const events = sortMwEvents(eventsIn);
  let evBlock = "## Events\n";
  if (events.length > 0) {
    const prefixes = events.map((e) =>
      e.time
        ? (e.endTime ? `${e.date} ${e.time}-${e.endTime}` : `${e.date} ${e.time}`)
        : (e.endDate ? `${e.date} / ${e.endDate}` : e.date),
    );
    const w = Math.max(...prefixes.map((p) => p.length));
    evBlock += "\n" + events.map((e, i) => {
      const tag = e.folder ? ` ${toBraceTag(e.folder)}` : "";
      const recips = e.emails?.length ? ` ${e.emails.join(" ")}` : "";
      return `${prefixes[i].padEnd(w)}: ${e.title}${tag}${recips}`;
    }).join("\n") + "\n";
  }
  const idx = mw.indexOf("## Events");
  if (idx >= 0) return mw.slice(0, idx) + evBlock;
  const timeIdx = mw.indexOf("# Time");
  if (timeIdx >= 0) return mw.trimEnd() + "\n\n" + evBlock;
  return mw.trimEnd() + "\n\n# Time\n\n" + evBlock;
}

// ---------- spacetime.mw event mutations (mw is the source of truth) ----------
// These read the mw, modify the `## Events` block, and re-serialize via
// spliceMwEvents — Space and Seasons are preserved byte-for-byte. Matching is
// by `${date}|${title.toLowerCase()}`, the same identity the calendar uses.

const mwEventKey = (date: string, title: string) => `${date}|${title.toLowerCase()}`;

/** Stable sort of events by date then time (all-day / untimed events sort first
 *  within a day). Array.prototype.sort is stable, so events sharing the same
 *  (date, time) keep their existing relative order — an edit only relocates the
 *  one event whose date/time changed, never reshuffling unrelated lines. */
function sortMwEvents(events: SpacetimeEvent[]): SpacetimeEvent[] {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const at = a.time ?? "", bt = b.time ?? "";
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });
}

/** Apply a partial update to the event matching (oldDate, oldTitle).
 *  Fields set to `undefined` in `next` are removed (e.g. clearing time for an
 *  all-day event). The block is re-sorted by date+time (stable). Returns the
 *  original mw unchanged when no event matches. */
export function mwUpdateEvent(
  mw: string,
  oldDate: string,
  oldTitle: string,
  next: Partial<SpacetimeEvent>,
): string {
  const st = parseMarkwhenFormat(mw);
  const k = mwEventKey(oldDate, oldTitle);
  const i = st.events.findIndex((e) => mwEventKey(e.date, e.title) === k);
  if (i < 0) return mw;
  const merged: SpacetimeEvent = { ...st.events[i], ...next };
  // Normalize the allDay flag against the resulting time fields.
  if (merged.time) delete merged.allDay;
  else if (!merged.endDate) merged.allDay = true;
  st.events[i] = merged;
  return spliceMwEvents(mw, st.events);
}

/** Remove the event matching (date, title). No-op if absent. */
export function mwDeleteEvent(mw: string, date: string, title: string): string {
  const st = parseMarkwhenFormat(mw);
  const k = mwEventKey(date, title);
  const kept = st.events.filter((e) => mwEventKey(e.date, e.title) !== k);
  if (kept.length === st.events.length) return mw;
  return spliceMwEvents(mw, kept);
}

/** Add an event in its sorted (date+time) position. No-op (returns mw
 *  unchanged) if an event with the same (date, title) already exists. */
export function mwAddEvent(mw: string, ev: SpacetimeEvent): string {
  const st = parseMarkwhenFormat(mw);
  const k = mwEventKey(ev.date, ev.title);
  if (st.events.some((e) => mwEventKey(e.date, e.title) === k)) return mw;
  st.events.push(ev);
  return spliceMwEvents(mw, st.events);
}

/** Merge vault-derived events INTO existing mw events, keeping mw as the truth.
 *  - mw events with a matching vault event: vault metadata (time, endTime, endDate,
 *    folder, allDay) is overlaid — the Order UI may have changed these.
 *  - mw-only events (no backing note): preserved as-is (future / hand-typed events).
 *  - new vault events not yet in mw: appended.
 *  Returns the original mw string unchanged when nothing structurally changed
 *  (guards CodeMirror cursor resets and write loops). */
export function mergeMwEventsWithVault(
  mw: string,
  vaultEvents: SpacetimeEvent[],
): string {
  const mwEvents = parseMarkwhenFormat(mw).events;

  const vaultByKey = new Map<string, SpacetimeEvent>();
  for (const ev of vaultEvents) {
    vaultByKey.set(`${ev.date}|${ev.title.toLowerCase()}`, ev);
  }

  const mwKeys = new Set<string>();
  let changed = false;
  const merged: SpacetimeEvent[] = [];

  for (const mwEv of mwEvents) {
    const key = `${mwEv.date}|${mwEv.title.toLowerCase()}`;
    mwKeys.add(key);
    const vEv = vaultByKey.get(key);
    if (!vEv) {
      merged.push(mwEv);
      continue;
    }
    // Overlay vault metadata; undefined fields are stripped to keep equality checks clean.
    const updated: SpacetimeEvent = { ...mwEv };
    if (vEv.time    !== undefined) updated.time    = vEv.time;    else delete updated.time;
    if (vEv.endTime !== undefined) updated.endTime = vEv.endTime; else delete updated.endTime;
    if (vEv.endDate !== undefined) updated.endDate = vEv.endDate; else delete updated.endDate;
    if (vEv.folder  !== undefined) updated.folder  = vEv.folder;  else delete updated.folder;
    if (vEv.allDay  !== undefined) updated.allDay  = vEv.allDay;  else delete updated.allDay;
    if (
      updated.time    !== mwEv.time    ||
      updated.endTime !== mwEv.endTime ||
      updated.endDate !== mwEv.endDate ||
      updated.folder  !== mwEv.folder  ||
      updated.allDay  !== mwEv.allDay
    ) changed = true;
    merged.push(updated);
  }

  // NOTE: We intentionally do NOT append vault events that don't exist in the
  // mw. The mw is the canonical source for which events exist; vault notes
  // only BACK events that are already declared there. Adding new events from
  // the vault caused an infinite duplication loop: lazy-loaded notes get a
  // filename-derived title that differs from the mw event title by a numeric
  // suffix (e.g. "FW Weekly 3" vs "FW Weekly"), so they're always treated as
  // new — generating a new mw entry, a new backing note, another mismatch, ad
  // infinitum. New events enter the mw via the calendar UI or direct editing.

  if (!changed) return mw;

  merged.sort((a, b) =>
    (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")),
  );
  return spliceMwEvents(mw, merged);
}

// ---------- Markwhen parser (reverse of serializeMarkwhen) ----------

/** Build a tag → original-name lookup from a space tree so event #tags
 *  can be resolved back to the exact folder name. */
function buildTagLookup(space: SpaceNode[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(nodes: SpaceNode[]) {
    for (const n of nodes) {
      map.set(toMarkwhenTag(n.name), n.name);
      map.set(toBraceTag(n.name), n.name);
      walk(n.children);
    }
  }
  walk(space);
  return map;
}

/** Parse a `spacetime.mw` file back into a Spacetime model. The format
 *  produced by `serializeMarkwhen` uses:
 *  - `# Space` / `# Time` top-level sections
 *  - `## AreaName` headings for areas inside Space
 *  - `- Category` / `  - Folder` indented lists under each area
 *  - `## Seasons` / `## Events` sub-sections inside Time
 *  - Season lines:  `DATE [/ END]: Title`
 *  - Event lines:   `DATE [HH:MM[-HH:MM]] [/ END]: Title [#tag]`
 * All column-padding is stripped via trim(). */
export function parseMarkwhenFormat(text: string): Spacetime {
  type Section = "none" | "space" | "seasons" | "events";
  let section: Section = "none";
  let currentArea: SpaceNode | null = null;
  let currentCategory: SpaceNode | null = null;

  const space: SpaceNode[] = [];
  const seasons: SpacetimeSeason[] = [];
  const events: SpacetimeEvent[] = [];

  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();

    // Top-level section switches
    if (trimmed === "# Space")  { section = "space";  currentArea = null; currentCategory = null; continue; }
    if (trimmed === "# Time")   { section = "none";   continue; }
    if (trimmed === "## Seasons") { section = "seasons"; continue; }
    if (trimmed === "## Events")  { section = "events";  continue; }
    if (!trimmed) continue;

    // ---- Space ----
    if (section === "space") {
      if (trimmed.startsWith("## ")) {
        const name = trimmed.slice(3).trim();
        currentArea = { name, children: [] };
        currentCategory = null;
        space.push(currentArea);
      } else if (raw.match(/^- /) && currentArea) {
        // Category: unindented `- Name`
        const name = trimmed.slice(2);
        currentCategory = { name, children: [] };
        currentArea.children.push(currentCategory);
      } else if (raw.match(/^  - /) && currentCategory) {
        // Folder: 2-space-indented `  - Name`
        const name = trimmed.slice(2);
        currentCategory.children.push({ name, children: [] });
      }
      continue;
    }

    // ---- Seasons ----
    if (section === "seasons") {
      // `2026-06-01 / 2026-08-31: Summer Building`  or  `2026-06-01: Open`
      const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\/\s*(\d{4}-\d{2}-\d{2}))?\s*:\s*(.+)$/);
      if (m) seasons.push({ date: m[1], title: m[3].trim(), ...(m[2] ? { endDate: m[2].trim() } : {}) });
      continue;
    }

    // ---- Events ----
    if (section === "events") {
      // `2026-06-16 09:00-09:30: Title #tag`  or  `2026-07-01 / 2026-07-05: Title`
      const m = trimmed.match(
        /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2})(?:-(\d{2}:\d{2}))?)?(?:\s*\/\s*(\d{4}-\d{2}-\d{2}))?\s*:\s*(.+)$/,
      );
      if (!m) continue;
      const [, date, time, endTime, endDate, rest] = m;
      // Peel trailing email recipients (Google sync) from the END first, then
      // the folder tag, leaving the title. Emails are written after the tag,
      // e.g. `Title #folder a@x.com b@y.com`. Each email must be preceded by
      // whitespace, so a sole title token is never mistaken for a recipient.
      let work = rest.trimEnd();
      const emails: string[] = [];
      const emailRe = /\s+([^@\s]+@[^@\s]+\.[^@\s]+)$/;
      let em: RegExpMatchArray | null;
      while ((em = work.match(emailRe))) {
        emails.unshift(em[1]);
        work = work.slice(0, work.length - em[0].length).trimEnd();
      }
      // Folder tag: try the brace form #[Exact Name] first (spaces/case ok),
      // then the legacy #kebab form. Store the raw token; it's resolved to the
      // real folder name after the Space section is parsed (when present).
      const braceM = work.match(/\s+#\[([^\]]+)\]$/);
      const kebabM = braceM ? null : work.match(/\s+(#[\w-]+)$/);
      const tagToken = braceM ? `#[${braceM[1].trim()}]` : (kebabM ? kebabM[1] : null);
      const tagLen = braceM ? braceM[0].length : (kebabM ? kebabM[0].length : 0);
      const title = (tagToken ? work.slice(0, work.length - tagLen) : work).trim();
      // Resolve tag → real folder name via tag lookup (built after full parse)
      events.push({
        date, title,
        ...(tagToken ? { folder: tagToken } : {}), // resolved to real name below
        ...(time    ? { time }   : {}),
        ...(endTime ? { endTime } : {}),
        ...(endDate ? { endDate } : {}),
        ...(emails.length ? { emails } : {}),
        ...(!time && !endDate ? { allDay: true } : {}),
      });
      continue;
    }
  }

  // Resolve #tag slugs in event folder fields to the real folder names
  if (events.length > 0 && space.length > 0) {
    const tagLookup = buildTagLookup(space);
    for (const ev of events) {
      if (ev.folder && ev.folder.startsWith("#")) {
        ev.folder = tagLookup.get(ev.folder) ?? stripTagToName(ev.folder);
      }
    }
  }

  return { space, seasons, events };
}

// ---------- YAML parsing (reverse of serialize) ----------

/** Parse the nested `space:` block back into SpaceNodes. Each item is
 *  either a bare name (leaf) or a single-key map `{Name: [children]}`. */
function parseSpaceNodes(items: unknown): SpaceNode[] {
  if (!Array.isArray(items)) return [];
  const out: SpaceNode[] = [];
  for (const item of items) {
    if (typeof item === "string") { out.push({ name: item, children: [] }); continue; }
    if (item && typeof item === "object") {
      const name = Object.keys(item as Record<string, unknown>)[0];
      if (!name) continue;
      const children = (item as Record<string, unknown>)[name];
      out.push({ name, children: parseSpaceNodes(children) });
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v); // a bare value coerced by YAML
  return undefined;
}

/** Parse a spacetime.yml document into the model. Uses JSON_SCHEMA so
 *  bare dates (`2026-06-15`) and times (`09:00`) stay STRINGS rather than
 *  being coerced to Date / sexagesimal-number values. Tolerant: malformed
 *  records are skipped. */
export function parseSpacetime(text: string): Spacetime {
  let doc: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    if (loaded && typeof loaded === "object") doc = loaded as Record<string, unknown>;
  } catch { /* fall through to empty */ }
  const space = parseSpaceNodes(doc.space);
  const time = (doc.time && typeof doc.time === "object" ? doc.time : {}) as Record<string, unknown>;
  const rawSeasons = Array.isArray(time.seasons) ? time.seasons : [];
  const rawEvents = Array.isArray(time.events) ? time.events : [];
  const seasons: SpacetimeSeason[] = [];
  for (const r of rawSeasons as Record<string, unknown>[]) {
    const date = str(r?.date); const title = str(r?.title);
    if (!date || !title) continue;
    seasons.push({ date, title, ...(str(r.endDate) ? { endDate: str(r.endDate)! } : {}) });
  }
  const events: SpacetimeEvent[] = [];
  for (const r of rawEvents as Record<string, unknown>[]) {
    const date = str(r?.date); const title = str(r?.title);
    if (!date || !title) continue;
    events.push({
      date, title,
      ...(str(r.folder) ? { folder: str(r.folder)! } : {}),
      ...(str(r.time) ? { time: str(r.time)! } : {}),
      ...(str(r.endTime) ? { endTime: str(r.endTime)! } : {}),
      ...(str(r.endDate) ? { endDate: str(r.endDate)! } : {}),
      ...(r.allDay === true ? { allDay: true } : {}),
    });
  }
  return { space, seasons, events };
}

/** Serialize a Spacetime model to the canonical YAML text. */
export function serializeSpacetime(st: Spacetime): string {
  const lines: string[] = [];
  lines.push("space:");
  lines.push(...renderSpace(st.space, 0));
  lines.push("time:");
  // Share the date + title column widths across seasons AND events so the
  // column after the title (endDate for seasons, folder for events) lines
  // up across both lists, the way docs/CONVENTIONS.md shows.
  const seasonRecs = st.seasons as unknown as Record<string, unknown>[];
  const eventRecs = st.events as unknown as Record<string, unknown>[];
  const dateTitleW = segWidths(seasonRecs, ["date", "title"], eventRecs);
  const folderW = segWidths(eventRecs, ["folder"]);
  lines.push("  seasons:");
  lines.push(...renderRecords(seasonRecs, ["date", "title"], ["endDate"], "    ", dateTitleW, [DATE_CAP, TITLE_CAP]));
  lines.push("  events:");
  lines.push(
    ...renderRecords(
      eventRecs,
      ["date", "title", "folder"],
      ["time", "endTime", "endDate", "allDay"],
      "    ",
      [...dateTitleW, folderW[0]],
      [DATE_CAP, TITLE_CAP, FOLDER_CAP],
    ),
  );
  return lines.join("\n") + "\n";
}
