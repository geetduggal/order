// `type: list` Notable Folders render their Main Document body as a
// card grid: each `- [[Name]]` bullet becomes a card. Anything after
// the closing `]]` (typically `· author · ★★★★`) is the meta line.

import type { Frontmatter } from "./frontmatter";

export interface ListItem {
  ref: string;
  meta?: string;
}

export function isListFolder(frontmatter: Frontmatter): boolean {
  return frontmatter.type === "list";
}

const WIKI_BULLET_RE =
  /^\s*[-*+]\s+\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]\s*(.*)$/;

// Milkdown normalises on save and backslash-escapes the wikilink
// brackets (they aren't standard markdown). Strip those escapes
// before regex matching so `\[\[Name]]` and `[[Name]]` both parse.
function unescapeBrackets(s: string): string {
  return s.replace(/\\([\[\]])/g, "$1");
}

export function parseListItems(body: string): ListItem[] {
  const out: ListItem[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = unescapeBrackets(rawLine);
    const m = line.match(WIKI_BULLET_RE);
    if (!m) continue;
    const ref = (m[2] ?? m[1]).trim();
    const trailing = m[3]?.trim() ?? "";
    // Strip any leading separator characters (·, •, –, —, |, -).
    const meta = trailing.replace(/^[·•|\-–—]+\s*/, "").trim();
    out.push({ ref, meta: meta || undefined });
  }
  return out;
}
