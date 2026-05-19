// Renders a published note's body. Prose goes through `marked` after
// a wikilink-aware preprocessing pass that turns `[[Ref]]` into anchor
// tags pointing at the hash-routed viewer. If the note is itself a
// list folder, the resolved items are rendered through Order's
// existing ListView at the bottom (cards or lines per the YAML).

import { useEffect, useMemo, useRef } from "react";
import { Marked } from "marked";
import type { PublishedNote, PublishedSite } from "../src/lib/publish";
import type { ListNoteRef } from "../src/lib/list-folder";
import { ListView } from "../src/components/ListView";

interface Props {
  note: PublishedNote;
  data: PublishedSite;
  byRef: Map<string, PublishedNote>;
  onNavigate: (ref: string) => void;
  /** When true, render only a snippet (first ~3 paragraphs). */
  snippet?: boolean;
}

/** Replace [[Ref]] and [[Ref|Alias]] with markdown links that
 *  resolve to the viewer's hash routes. Run BEFORE marked so it sees
 *  standard `[label](url)` syntax. Also strip the Milkdown bracket
 *  escapes that round-trip through ProseMirror. */
function rewriteWikilinks(src: string, byRef: Map<string, PublishedNote>): string {
  let s = src.replace(/\\\[/g, "[").replace(/\\\]/g, "]");
  s = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, ref, alias) => {
    const r = (ref as string).trim();
    const label = ((alias as string | undefined) ?? r).trim();
    const target = byRef.get(r.toLowerCase());
    if (!target) return label;
    const url = `#/note/${encodeURIComponent(r)}`;
    return `[${label}](${url})`;
  });
  return s;
}

function firstParagraphs(md: string, n: number): string {
  // Split on blank lines, keep first n non-empty blocks.
  const blocks = md.split(/\n\s*\n/);
  const out: string[] = [];
  for (const b of blocks) {
    if (!b.trim()) continue;
    out.push(b.trim());
    if (out.length >= n) break;
  }
  return out.join("\n\n");
}

/** Strip a list folder's bullet section — bullets are rendered via
 *  ListView at the bottom of the page; we don't want them duplicated
 *  inside the prose. Match indented or root-level wikilink bullets. */
function stripWikilinkBullets(md: string): string {
  return md
    .split("\n")
    .filter((line) => !/^\s*[-*+]\s+\\?\[\\?\[[^\]]+\]\]/.test(line))
    .join("\n");
}

export function ViewerNote({ note, data, byRef, onNavigate, snippet }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const marked = useMemo(() => new Marked({ gfm: true, breaks: false }), []);

  const html = useMemo(() => {
    // Keep the body's leading H1 — the viewer no longer renders a
    // separate card title above the body, so the H1 IS the title.
    // Matches Order's app where Milkdown renders the body in full.
    let body = note.body;
    if (note.listRender !== null) body = stripWikilinkBullets(body);
    let prepared = rewriteWikilinks(body, byRef);
    if (snippet) prepared = firstParagraphs(prepared, 3);
    return marked.parse(prepared) as string;
  }, [note.body, note.listRender, byRef, marked, snippet]);

  // Intercept anchor clicks so internal hash links update via the
  // viewer's router (history.pushState would also work but plain
  // hash assignment is enough).
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    function onClick(e: MouseEvent) {
      const a = (e.target as Element | null)?.closest("a");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (href.startsWith("#/note/")) {
        e.preventDefault();
        onNavigate(decodeURIComponent(href.slice("#/note/".length)));
      }
    }
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [onNavigate]);

  // Build a ListNoteRef view for ListView (used when the note IS a
  // list folder and we want to render its items inline).
  const vaultNotes: ListNoteRef[] = useMemo(
    () => data.notes.map((n) => ({
      filename: `${n.ref}.md`,
      frontmatter: n.frontmatter,
      body: n.body,
    })),
    [data.notes],
  );

  return (
    <>
      {/* Wrap in Milkdown's class hierarchy so every typography rule
          the editor uses (h1 weight, paragraph rhythm, subtitle
          treatment, code blocks, blockquote, links, etc.) applies
          identically here. The viewer renders the same HTML shape
          marked produces — these are presentational classes only. */}
      <div className="milkdown-host" ref={ref}>
        <div className="ProseMirror" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {!snippet && note.listItems && note.listItems.length > 0 && note.listRender && (
        <ListView
          render={note.listRender}
          items={note.listItems}
          vaultNotes={vaultNotes}
          onChange={() => { /* read-only */ }}
          readOnlyMembership
          onNavigate={onNavigate}
          expandSublists={note.listItems.some((it) => {
            const sub = byRef.get(it.ref.toLowerCase());
            return !!sub?.listRender;
          })}
        />
      )}
    </>
  );
}
