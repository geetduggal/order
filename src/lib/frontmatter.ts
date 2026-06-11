// YAML frontmatter shim. The editor (Milkdown Crepe) doesn't understand
// `---\n…\n---\n` at the top of a markdown file — it would render the
// fences as horizontal rules and corrupt the YAML on save. We strip
// frontmatter before handing the body to the editor, parse it for app
// use, and recombine it on disk so the file format stays intact for
// Obsidian / other tools to read.

import yaml from "js-yaml";

export type Frontmatter = Record<string, unknown>;

export interface Split {
  /** Parsed YAML object — empty {} if the file has no frontmatter. */
  frontmatter: Frontmatter;
  /** The original raw YAML text (including the surrounding `---` lines)
   *  or '' if there was none. Useful for re-emitting unchanged content
   *  byte-for-byte when the caller didn't modify the frontmatter. */
  raw: string;
  /** Everything after the closing `---\n`, with no leading whitespace
   *  trimmed — round-trips cleanly with the body the editor sees. */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(content: string): Split {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, raw: "", body: content };

  const raw = match[0];
  const yamlText = match[1];
  let frontmatter: Frontmatter = {};
  try {
    const parsed = yaml.load(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Frontmatter;
    }
  } catch {
    // Malformed YAML: treat the file as having no parseable frontmatter
    // but still strip the raw block so the editor doesn't see it.
  }
  return { frontmatter, raw, body: content.slice(raw.length) };
}

export function joinFrontmatter(frontmatter: Frontmatter, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yamlText = yaml.dump(frontmatter, {
    indent: 2,
    lineWidth: 120,
    // `noRefs: true` keeps the serializer from emitting `&` anchor syntax
    // for repeated values, which Obsidian Full Calendar / similar plugins
    // don't expect to see.
    noRefs: true,
    // Quote strings only when necessary; matches what Obsidian writes.
    quotingType: '"',
  });
  // yaml.dump always ends with a single newline.
  return `---\n${yamlText}---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

/** True when the markdown body's first non-empty line is an ATX h1 (`# Title`). */
export function bodyHasH1(body: string): boolean {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === "") continue;
    return /^#\s/.test(line);
  }
  return false;
}

/** ISO date — YYYY-MM-DD — for the supplied Date or `new Date()`. */
export function isoDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Normalize a YAML `date` / `endDate` value to an ISO `YYYY-MM-DD`
 *  string. js-yaml's default schema parses an unquoted `2026-06-12`
 *  as a Date object (YAML 1.1 CORE_SCHEMA behaviour), so plain
 *  `typeof === "string"` checks miss the unquoted case and the event
 *  silently drops out of date-keyed indexes (calendar dedup, mirror
 *  source build, etc.). Handles both shapes. */
export function toIsoDateValue(v: unknown): string | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    // js-yaml gives a UTC-midnight Date for unquoted YYYY-MM-DD —
    // re-extract YYYY-MM-DD in UTC so we don't roll back a day west
    // of UTC.
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

/** HH:MM (24h) for the supplied Date or `new Date()`. */
export function isoTime(d: Date = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Obsidian Full Calendar compatibility: an event is a markdown note whose
 * frontmatter carries `date`, `startTime`, `allDay`. We inject those for
 * notes that don't begin with an h1 (treating "no headline = a log entry")
 * and don't already have a `date` key set. A non-empty `title:` field in
 * frontmatter counts as a headline too — external-source notes (Readwise,
 * Reader, etc.) typically put their name there instead of as a body h1
 * and would otherwise all stamp onto today's calendar. Returns the patch
 * to merge, or null if no injection is needed.
 */
export function suggestCalendarPatch(
  frontmatter: Frontmatter,
  body: string,
  now: Date = new Date(),
): Frontmatter | null {
  if (bodyHasH1(body)) return null;
  if (typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0) return null;
  if (typeof frontmatter.date === "string" && frontmatter.date.length > 0) return null;
  return {
    date: isoDate(now),
    startTime: isoTime(now),
    allDay: false,
  };
}

/** Title derived from the body's first non-empty line, with common
 *  leading markdown markers stripped (heading hashes, list bullets,
 *  blockquote `>`). Returns null for an empty body. Used by auto-rename
 *  so the filename always tracks the visible first line of the note,
 *  regardless of whether it's formatted as a heading. */
export function firstLineTitle(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const stripped = trimmed.replace(/^(?:#+|>|[-*+]|\d+\.)\s+/, "").trim();
    return stripped === "" ? null : stripped;
  }
  return null;
}

/** Filename for an event in the Obsidian Full Calendar convention:
 *  `YYYY-MM-DD Title.md` (date prefix + title). Unsafe filesystem
 *  characters in the title get replaced with `-`. */
export function basenameForEvent(date: string | undefined, title: string): string {
  const datePart = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : isoDate();
  const safe = (title || "Untitled").replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
  return `${datePart} ${safe}.md`;
}
