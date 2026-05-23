// The one wikilink resolver for the whole vault. A `[[Name]]` targets by
// name; resolution decides folder vs note purely by lookup, with no
// visual tell in the source:
//
//   - If the name matches a Notable Folder (a note whose YAML carries a
//     `category`, i.e. its Main Document <Name>/<Name>.md), the link
//     resolves to that folder.
//   - Else if it matches an ordinary note, it resolves to that note.
//   - On a name collision, the Notable Folder wins. `[[Folder/Note]]`
//     disambiguates to the note inside that folder (Obsidian convention).
//   - Otherwise the link is broken.
//
// The `[[Name]]` text is always the human-readable name. Ids and slugs
// live in frontmatter only, never in the link syntax — that keeps the
// source plain-text clean and Obsidian-compatible.

import { parseRef, isNotableFolder } from "./folders";
import type { ListNoteRef } from "./list-folder";

/** Minimal note shape the resolver needs. `folder` is the on-disk parent
 *  directory name when known; the YAML `folder:` ref is read from
 *  frontmatter. ListNoteRef already satisfies this. */
export type WikiRef = ListNoteRef;

export interface ParsedWikilink {
  /** The target name (last path segment, alias stripped). */
  name: string;
  /** Folder qualifier from `[[Folder/Name]]`, or null. */
  folderQualifier: string | null;
  /** Display alias from `[[Name|alias]]`, or null. */
  alias: string | null;
}

/** Parse the inside (or whole) of a `[[...]]` into its parts. Accepts
 *  the raw token with or without the surrounding brackets. */
export function parseWikilink(raw: string): ParsedWikilink {
  let s = raw.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
  let alias: string | null = null;
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    alias = s.slice(pipe + 1).trim() || null;
    s = s.slice(0, pipe).trim();
  }
  let folderQualifier: string | null = null;
  const slash = s.lastIndexOf("/");
  if (slash >= 0) {
    folderQualifier = s.slice(0, slash).trim() || null;
    s = s.slice(slash + 1).trim();
  }
  return { name: s, folderQualifier, alias };
}

export type WikiResolution =
  | { kind: "folder"; name: string; ref: WikiRef }
  | { kind: "note"; name: string; ref: WikiRef }
  | { kind: "broken"; name: string };

function baseName(n: WikiRef): string {
  return n.filename.replace(/\.md$/i, "");
}

/** Resolve a `[[...]]` token (with or without brackets) against the
 *  vault index. */
export function resolveWikilink(raw: string, vault: WikiRef[]): WikiResolution {
  const { name, folderQualifier } = parseWikilink(raw);
  const needle = name.toLowerCase();
  const nameMatches = (n: WikiRef) => baseName(n).toLowerCase() === needle;

  // Qualified `[[Folder/Note]]`: an ordinary note named `Note` whose
  // parent folder (YAML `folder:` or on-disk dir) is `Folder`.
  if (folderQualifier) {
    const fq = folderQualifier.toLowerCase();
    const note = vault.find(
      (n) =>
        nameMatches(n) &&
        !isNotableFolder(n.frontmatter) &&
        ((parseRef(n.frontmatter.folder)?.toLowerCase() ?? null) === fq ||
          (n.folder ?? "").toLowerCase() === fq),
    );
    if (note) return { kind: "note", name, ref: note };
    // Fall through to the unqualified rules if the qualifier misses.
  }

  // Collisions prefer the Notable Folder.
  const folder = vault.find((n) => nameMatches(n) && isNotableFolder(n.frontmatter));
  if (folder) return { kind: "folder", name, ref: folder };
  const note = vault.find((n) => nameMatches(n) && !isNotableFolder(n.frontmatter));
  if (note) return { kind: "note", name, ref: note };
  return { kind: "broken", name };
}

/** Convenience for the list renderers: the matched note ref (folder Main
 *  Doc or ordinary note), or undefined when broken. Replaces the
 *  per-component `resolve` helpers so there is one matching rule. */
export function resolveNoteRef(raw: string, vault: WikiRef[]): WikiRef | undefined {
  const r = resolveWikilink(raw, vault);
  return r.kind === "broken" ? undefined : r.ref;
}

// Match a `[[...]]` occurrence, tolerating the backslash-escaping
// Milkdown applies to brackets on save (`\[\[Name\]\]`). Groups capture
// the exact opening/closing delimiters so a rewrite preserves them.
const WIKI_OCCURRENCE_RE = /(\\?\[\\?\[)([^\]\n]+?)(\\?\]\\?\])/g;

/** Rewrite every inbound `[[Old]]` (and `[[Old|alias]]`,
 *  `[[Folder/Old]]`) in `body` to use `newName`, preserving alias,
 *  folder qualifier, and bracket-escaping style. Used on rename so
 *  source links stay valid, the way Obsidian rewrites links. Only the
 *  target name segment is matched; a folder qualifier that happens to
 *  equal `oldName` is left alone. */
export function rewriteWikilinksForRename(body: string, oldName: string, newName: string): string {
  const target = oldName.trim().toLowerCase();
  return body.replace(WIKI_OCCURRENCE_RE, (full, open, inner, close) => {
    const { name, folderQualifier, alias } = parseWikilink(`[[${inner}]]`);
    if (name.toLowerCase() !== target) return full;
    const q = folderQualifier ? `${folderQualifier}/` : "";
    const a = alias ? `|${alias}` : "";
    return `${open}${q}${newName}${a}${close}`;
  });
}
