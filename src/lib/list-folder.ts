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
  /** Plain-text bullets (`- hello world`) that aren't wikilinks. The
   *  renderer treats these as display-only items — text as title,
   *  no navigation, no note resolve. `ref` mirrors the text so
   *  dedup/drag-tracking still works. Round-trips on save as the
   *  original `- text` bullet rather than a wikilink. */
  text?: string;
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

// Plain-text bullets: `- some text`, `* anything`, `+ etc`. Captures
// the bullet content so we can echo it back on save and use it as the
// display title. Excludes empty bullets so a stray `- ` doesn't become
// a phantom item. Wikilink + image bullets are matched FIRST below, so
// only bullets that aren't either of those reach this regex.
const PLAIN_BULLET_RE = /^\s*[-*+]\s+(\S.*?)\s*$/;

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
  // Strip every Milkdown CommonMark backslash escape inserted into
  // text that COULD be markdown syntax — `[`, `]`, `!`, `_`, `*`,
  // `(`, `)`, etc. Inside our Obsidian-style `![[X]]` embeds these
  // escapes are noise: they don't change the embed's semantics and
  // they break filename matching on disk. `IMG\_0117.jpeg` would
  // resolve to a file that doesn't exist; the asset URL fails;
  // the card renders broken. Removing any `\<non-alphanumeric>`
  // backslash covers every char Milkdown might escape without
  // touching legitimate `\n` / `\t` / `\u…` sequences (those are
  // followed by alphanumerics).
  return s.replace(/\\([^a-zA-Z0-9])/g, "$1");
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
  if (m) {
    const ref = (m[2] ?? m[1]).trim();
    const trailing = m[3]?.trim() ?? "";
    const meta = trailing.replace(/^[·•|\-–—]+\s*/, "").trim();
    return { ref, meta: meta || undefined };
  }
  // Plain bullet — make it a display-only item so the list-folder
  // render shows it as a card (or line) titled by its text. The user
  // can later promote it to a real wikilink-backed note if they want.
  const pb = unescaped.match(PLAIN_BULLET_RE);
  if (pb) {
    const text = pb[1].trim();
    if (text) return { ref: text, text };
  }
  return null;
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

/** Strip any stale backslash escapes that snuck into an item ref
 *  (e.g. legacy Bookstore.md files where Milkdown escaped every `_`
 *  in `IMG_0117.jpeg` to `IMG\_0117.jpeg` and the escape got baked
 *  into item.ref). Heals broken on-disk filenames on the next save. */
function cleanRef(ref: string): string {
  return ref.replace(/\\([^a-zA-Z0-9])/g, "$1");
}

export function serializeListItems(items: ListItem[]): string {
  return items
    .map((item) => {
      if (item.image) {
        // Always serialise to the on-disk Obsidian form using just the
        // basename. `item.ref` already holds the decoded basename in
        // both the on-disk and inflated cases (see parseLine), so the
        // round trip stays clean regardless of which form was loaded.
        const ref = cleanRef(item.ref);
        const caption = item.caption?.trim();
        return caption ? `- ![[${ref}|${caption}]]` : `- ![[${ref}]]`;
      }
      // Plain text bullet — emit verbatim. No wikilink wrap, so a
      // round-trip through Order doesn't silently turn user text into
      // a wikilink to a nonexistent note.
      if (item.text) return `- ${cleanRef(item.text)}`;
      return `- [[${cleanRef(item.ref)}]]${item.meta ? ` · ${item.meta}` : ""}`;
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
