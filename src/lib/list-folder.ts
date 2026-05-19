// A list folder is a note whose YAML carries a `list:` key. The value
// names the render style (`cards` or `lines`). The body is a bullet
// list of wikilinks; each `- [[Name]] · meta` bullet becomes a row in
// the rendered list. Legacy `type: list` is still accepted on read
// (treated as `list: cards`) so a half-migrated vault still renders.

import type { Frontmatter } from "./frontmatter";

export type ListRender = "cards" | "lines";

export interface ListItem {
  ref: string;
  meta?: string;
}

/** Minimal vault index entry the list renderers + base evaluator
 *  share. `folder` / `ctime` / `mtime` are optional because some
 *  call sites (the local Card) don't have them; the base evaluator
 *  treats missing values as null. `body` is needed for inline
 *  sub-list expansion ("list of lists" rendering). */
export interface ListNoteRef {
  filename: string;
  frontmatter: Frontmatter;
  folder?: string;
  ctime?: number;
  mtime?: number;
  body?: string;
}

export function listRender(frontmatter: Frontmatter): ListRender | null {
  const v = frontmatter.list;
  if (v === "cards" || v === "lines") return v;
  // Legacy: `type: list` → cards.
  if (frontmatter.type === "list") return "cards";
  return null;
}

export function isListFolder(frontmatter: Frontmatter): boolean {
  return listRender(frontmatter) !== null;
}

const WIKI_BULLET_RE =
  /^\s*[-*+]\s+\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*(.*)$/;

// Milkdown normalises on save and backslash-escapes the wikilink
// brackets (they aren't standard markdown). Strip those escapes
// before regex matching so `\[\[Name]]` and `[[Name]]` both parse.
function unescapeBrackets(s: string): string {
  return s.replace(/\\([\[\]])/g, "$1");
}

function parseLine(line: string): ListItem | null {
  const m = unescapeBrackets(line).match(WIKI_BULLET_RE);
  if (!m) return null;
  const ref = (m[2] ?? m[1]).trim();
  const trailing = m[3]?.trim() ?? "";
  const meta = trailing.replace(/^[·•|\-–—]+\s*/, "").trim();
  return { ref, meta: meta || undefined };
}

export function parseListItems(body: string): ListItem[] {
  const out: ListItem[] = [];
  for (const line of body.split(/\r?\n/)) {
    const item = parseLine(line);
    if (item) out.push(item);
  }
  return out;
}

/** Split a Notable Folder body into its prose portion (everything
 *  except the wikilink bullets) and the bullets themselves. Lets the
 *  card own the items as a structured array while Milkdown still
 *  handles the rest of the document. Trailing blank lines on the
 *  prose half are trimmed so we can re-append bullets cleanly on save. */
export function splitBodyAndBullets(body: string): { prose: string; items: ListItem[] } {
  const proseLines: string[] = [];
  const items: ListItem[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const item = parseLine(rawLine);
    if (item) items.push(item);
    else proseLines.push(rawLine);
  }
  while (proseLines.length > 0 && proseLines[proseLines.length - 1].trim() === "") {
    proseLines.pop();
  }
  return { prose: proseLines.join("\n"), items };
}

/** What to show as the visible title for a row. Prefers the linked
 *  note's `title:` frontmatter — useful when filenames are
 *  prettified (`Tech Habits — How I…`) but the article title proper
 *  carries punctuation we can't put on disk (`Tech Habits: How I…`).
 *  Falls back to the bullet's wikilink ref. */
export function displayTitleFor(
  item: ListItem,
  note?: { frontmatter: Frontmatter } | null,
): string {
  const t = note?.frontmatter.title;
  if (typeof t === "string" && t.trim()) return t;
  return item.ref;
}

export function serializeListItems(items: ListItem[]): string {
  return items
    .map((item) => `- [[${item.ref}]]${item.meta ? ` · ${item.meta}` : ""}`)
    .join("\n");
}
