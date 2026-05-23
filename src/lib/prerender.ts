// Build-time content renderer. marked turns a note body into HTML (Crepe
// can't run server-side — confirmed by spike), then we rewrite wikilinks
// to permalink anchors and attachment paths to root-absolute URLs. Rust
// wraps the returned content in the viewer bundle's shell.

import { marked } from "marked";
import type { PublishedSite } from "./publish";
import { resolveWikilink, type WikiRef } from "./wikilink";
import { ATTACHMENTS_DIRNAME } from "./attachments";

export interface PrerenderedPage {
  path: string;
  contentHtml: string;
  title: string;
}

// Match a `[[...]]` occurrence, tolerating Milkdown's bracket escaping.
const WIKI_RE = /(\\?\[\\?\[)([^\]\n]+?)(\\?\]\\?\])/g;

function rewriteWikilinks(
  md: string,
  vault: WikiRef[],
  slugOf: (ref: string) => string | null,
): string {
  return md.replace(WIKI_RE, (_full, _open, inner: string) => {
    const label = inner.split("|").pop()!.split("/").pop()!.trim();
    const res = resolveWikilink(`[[${inner}]]`, vault);
    if (res.kind === "broken") return `<span class="wikilink-broken">${label}</span>`;
    const slug = slugOf(res.ref.filename.replace(/\.md$/i, ""));
    if (!slug) return `<span class="wikilink-broken">${label}</span>`;
    return `<a class="wikilink" href="/${slug}/">${label}</a>`;
  });
}

/** Build per-page content HTML (no chrome — Rust wraps it in the bundle
 *  shell). `pubPath` is the publish sub-path (e.g. "order-home"), used
 *  for root-absolute attachment URLs since pages live one level deep. */
export function prerenderPages(site: PublishedSite, pubPath: string): PrerenderedPage[] {
  const vault: WikiRef[] = site.notes.map((n) => ({
    filename: `${n.ref}.md`,
    frontmatter: n.frontmatter,
  }));
  const refToSlug = new Map<string, string>();
  for (const [slug, ref] of Object.entries(site.slugMap)) refToSlug.set(ref.toLowerCase(), slug);
  const slugOf = (ref: string) => refToSlug.get(ref.toLowerCase()) ?? null;

  const attachPrefix = `/${pubPath}/${ATTACHMENTS_DIRNAME}/`;
  return site.notes
    .filter((n) => n.slug || n.isHome)
    .map((n) => {
      const withLinks = rewriteWikilinks(n.body, vault, slugOf);
      let html = marked.parse(withLinks, { async: false }) as string;
      // Rewrite attachment image src (relative `Attachments/…` or
      // `./Attachments/…`) to root-absolute so it resolves from a page
      // one level deep.
      html = html.replace(
        /(<img\b[^>]*\bsrc=")(?:\.\/)?Attachments\//g,
        `$1${attachPrefix}`,
      );
      return {
        path: n.isHome ? "index.html" : `${n.slug}/index.html`,
        contentHtml: html,
        title: n.title,
      };
    });
}
