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
  /** When set, this list item is a raw image embed (`* ![[file.png]]`)
   *  rather than a wikilink to a note. The renderer shows the file as
   *  a cover-only card; no title, no navigation, no resolve-by-name
   *  lookup. `ref` mirrors the image basename so dedup/drag-tracking
   *  still works. */
  image?: string;
  /** Optional caption for an image-only item, persisted as the pipe
   *  suffix in the wikilink (`* ![[file.png|caption text]]`). Round-
   *  trips with Obsidian — when present and non-numeric, Obsidian
   *  treats the suffix as alt text. */
  caption?: string;
}

/** Minimal vault index entry the list renderers + base evaluator
 *  share. `folder` / `ctime` / `mtime` are optional because some
 *  call sites (the local Card) don't have them; the base evaluator
 *  treats missing values as null. `body` is needed for inline
 *  sub-list expansion ("list of lists" rendering). */
export interface ListNoteRef {
  filename: string;
  frontmatter: Frontmatter;
  /** Last dirname segment — used by wikilink folder qualifiers
   *  (`[[Folder/Note]]`). */
  folder?: string;
  /** Full relative directory path (e.g.
   *  `Home/Stewardship/Stewardship Spaces/Readwise/Books`) — used by
   *  base-block `file.folder.contains(...)` so a filter against a
   *  grandparent name matches, matching Obsidian Bases semantics. */
  dir?: string;
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

// Image-embed bullet, accepting two equivalent forms:
//   * ![[file.png]]                  ← on-disk Obsidian-style embed
//   * ![[file.png|caption text]]     ← Obsidian alt-text suffix
//   * ![](vaultasset://…/file.png)   ← inflated form (Card.tsx swaps
//     `![[X]]` into a vaultasset URL before the editor sees it, so the
//     list parser also has to recognise the inflated form)
// All produce the same image-only list item; ref/image carry the
// bare basename so the renderer's per-item URL construction works.
// A non-numeric pipe suffix is captured as the caption; a numeric
// suffix (Obsidian size like `|640` or `|640x480`) is ignored.
const IMG_BULLET_RE = /^\s*[-*+]\s+!\[\[\s*([^\]|]+?)\s*(?:\|([^\]]*))?\]\]\s*$/;
const IMG_BULLET_INFLATED_RE = /^\s*[-*+]\s+!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const SIZE_SUFFIX_RE = /^\d+(?:x\d+)?$/;

// Milkdown normalises on save and backslash-escapes the wikilink
// brackets (they aren't standard markdown). Strip those escapes
// before regex matching so `\[\[Name]]` and `[[Name]]` both parse.
function unescapeBrackets(s: string): string {
  return s.replace(/\\([\[\]])/g, "$1");
}

function parseLine(line: string): ListItem | null {
  const unescaped = unescapeBrackets(line);
  // Image-only bullet — try Obsidian embed form first, then inflated
  // (`![](vaultasset://...)`) form. Either yields the same item.
  const ie = unescaped.match(IMG_BULLET_RE);
  if (ie) {
    const full = ie[1].trim();
    const base = full.split("/").pop() ?? full;
    const suffix = ie[2]?.trim();
    const caption = suffix && !SIZE_SUFFIX_RE.test(suffix) ? suffix : undefined;
    return { ref: base, image: base, ...(caption ? { caption } : {}) };
  }
  const iie = unescaped.match(IMG_BULLET_INFLATED_RE);
  if (iie) {
    const altText = iie[1]?.trim();
    const url = iie[2];
    const cleaned = url.split(/[?#]/)[0];
    let base = cleaned.split("/").pop() ?? cleaned;
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    const caption = altText && !SIZE_SUFFIX_RE.test(altText) ? altText : undefined;
    return { ref: base, image: url, ...(caption ? { caption } : {}) };
  }
  const m = unescaped.match(WIKI_BULLET_RE);
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
    .map((item) => {
      if (item.image) {
        // Always serialise to the on-disk Obsidian form using just the
        // basename. `item.ref` already holds the decoded basename in
        // both the on-disk and inflated cases (see parseLine), so the
        // round trip stays clean regardless of which form was loaded.
        const caption = item.caption?.trim();
        return caption ? `- ![[${item.ref}|${caption}]]` : `- ![[${item.ref}]]`;
      }
      return `- [[${item.ref}]]${item.meta ? ` · ${item.meta}` : ""}`;
    })
    .join("\n");
}

/** Collapse blank lines between consecutive list / task items. Milkdown's
 *  serializer emits "loose" lists (a blank line between every item); this
 *  rewrites them tight. A blank line is removed ONLY when it sits between
 *  two list-item lines (bullet, ordered, or task items), so blank lines
 *  around a list or within prose are preserved. */
export function tightenListSpacing(md: string): string {
  const isItem = (s: string) => /^[ \t]*(?:[-*+]|\d+\.)\s/.test(s);
  const lines = md.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      const prev = out.length ? out[out.length - 1] : "";
      const next = lines[i + 1] ?? "";
      if (isItem(prev) && isItem(next)) continue; // drop blank between items
    }
    out.push(line);
  }
  return out.join("\n");
}
