// Build-time content renderer. marked turns a note body into HTML (Crepe
// can't run server-side — confirmed by spike), then we rewrite wikilinks
// to permalink anchors and attachment paths to root-absolute URLs. Rust
// wraps the returned content in the viewer bundle's shell.

import { marked } from "marked";
import type { PublishedSite } from "./publish";
import { resolveWikilink, type WikiRef } from "./wikilink";
import { ATTACHMENTS_DIRNAME, EMBED_REF_WIDTH } from "./attachments";
import { youtubeId } from "./youtube";

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
  const replaceWiki = (text: string): string =>
    text.replace(WIKI_RE, (_full, _open, inner: string) => {
      const label = inner.split("|").pop()!.split("/").pop()!.trim();
      const res = resolveWikilink(`[[${inner}]]`, vault);
      if (res.kind === "broken") return `<span class="wikilink-broken">${label}</span>`;
      const slug = slugOf(res.ref.filename.replace(/\.md$/i, ""));
      if (!slug) return `<span class="wikilink-broken">${label}</span>`;
      return `<a class="wikilink" href="/${slug}/">${label}</a>`;
    });
  // Skip ``` fenced blocks (so a code-block screenshot of the markdown
  // source survives as literal `[[Name]]`) and inline `…` code spans.
  const lines = md.split("\n");
  let inFence = false;
  return lines.map((line) => {
    if (/^```/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line
      .split(/(`[^`\n]+`)/g)
      .map((seg, i) => (i % 2 === 1 ? seg : replaceWiki(seg)))
      .join("");
  }).join("\n");
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
    .flatMap((n) => {
      const withLinks = rewriteWikilinks(n.body, vault, slugOf);
      let html = marked.parse(withLinks, { async: false }) as string;
      // Rewrite attachment image src (relative `Attachments/…` or
      // `./Attachments/…`) to root-absolute so it resolves from a page
      // one level deep.
      html = html.replace(
        /(<img\b[^>]*\bsrc=")(?:\.\/)?Attachments\//g,
        `$1${attachPrefix}`,
      );
      // A set image size rides in the alt as Crepe's size ratio (so the
      // viewer renders it). For the static HTML, convert that to an
      // explicit pixel width and drop the numeric alt.
      html = html.replace(
        /<img\b([^>]*?)\salt="(\d+(?:\.\d+)?)"([^>]*?)>/g,
        (_m, pre: string, ratio: string, post: string) =>
          `<img${pre}${post} style="width:${Math.round(parseFloat(ratio) * EMBED_REF_WIDTH)}px;max-width:100%">`,
      );
      // Obsidian-style video embeds (![[file.mov]] → inflateImageEmbeds
       // rewrote it to <img src="…video.mov"> via marked). Replace those
       // with a native <video controls> so the static page actually
       // plays the file (and is curl/unfurl-friendly).
      html = html.replace(
        /<img\b[^>]*\bsrc="([^"]*\.(?:mov|mp4|m4v|webm))(\?[^"]*)?"[^>]*>/gi,
        (_m, src: string, qs: string | undefined) =>
          `<video class="order-video-embed" controls playsinline preload="metadata" src="${src}${qs ?? ""}"></video>`,
      );
      // YouTube embeds (image syntax + ```embed fence) — emit a
      // clean card-style link with thumbnail + title that opens the
      // video in the native YouTube app (or default browser). The
      // SPA's milkdown-youtube plugin renders the same shape so the
      // static page matches what the editor shows.
      //
      // The static HTML can't run an oEmbed fetch (no JS at prerender
      // time), so the title slot starts as "YouTube video" and the
      // SPA hydration upgrades it once on load.
      const cardFor = (id: string) => {
        const url = `https://www.youtube.com/watch?v=${id}`;
        const thumbUrl = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
        // background-image inline so the CSS over-crop kicks in the
        // moment the page paints — no img element, no object-fit /
        // transform subpixel gap for letterbox bars to peek through.
        return `<a class="order-youtube-card" href="${url}" rel="noreferrer" aria-label="Open video on YouTube" data-yt-id="${id}">`
          + `<span class="order-youtube-card-thumb" style="background-image:url('${thumbUrl}')">`
          + `<span class="order-youtube-card-play" aria-hidden="true">▶</span>`
          + `</span>`
          + `<span class="order-youtube-card-meta">`
          + `<span class="order-youtube-card-title">YouTube video</span>`
          + `<span class="order-youtube-card-host">youtube.com</span>`
          + `</span>`
          + `</a>`;
      };
      html = html.replace(
        /<img\b[^>]*\bsrc="(https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^"]*|youtu\.be\/[^"]+))"[^>]*>/g,
        (full: string, url: string) => {
          const id = youtubeId(url);
          return id ? cardFor(id) : full;
        },
      );
      // Obsidian YouTube embeds (```embed YAML form, e.g. Auto Card
      // Link). marked emits the fence as <pre><code class="language-embed">
      // YAML </code></pre>; swap it for a card whenever the YAML has
      // a YouTube `url:` line.
      html = html.replace(
        /<pre><code(?:\s[^>]*)?>([\s\S]*?)<\/code><\/pre>/g,
        (full: string, body: string) => {
          // Decode HTML entities marked may have inserted for &, " etc.
          const decoded = body
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");
          const m = decoded.match(/url\s*:\s*['"]?(https?:\/\/[^\s'"<>]+)/);
          if (!m) return full;
          const id = youtubeId(m[1]);
          return id ? cardFor(id) : full;
        },
      );
      // The home note lives at the site root (index.html), but it also
      // has a slug — links/permalinks point at /<slug>/ — so emit it at
      // BOTH paths or that permalink 404s. Non-home notes: just /<slug>/.
      const paths: string[] = [];
      if (n.isHome) paths.push("index.html");
      if (n.slug) paths.push(`${n.slug}/index.html`);
      return paths.map((path) => ({ path, contentHtml: html, title: n.title }));
    });
}
