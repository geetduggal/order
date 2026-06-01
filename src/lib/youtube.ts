// Obsidian-compatible YouTube embeds. On disk, a YouTube embed is plain
// markdown image syntax with a YouTube URL — the same shape Obsidian
// renders as an inline player:
//
//   ![](https://www.youtube.com/watch?v=VIDEO_ID)
//   ![](https://youtu.be/VIDEO_ID)
//   ![Alt text](https://m.youtube.com/watch?v=VIDEO_ID&t=42s)
//
// Milkdown by itself would try to <img src=youtube>, which fails. So we
// inflate to a raw <iframe> the editor renders directly, and deflate
// back to the canonical `![](watch-url)` form on save — keeping the
// on-disk markdown Obsidian-compatible.

const YT_HOST_RE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^)\s]*|youtu\.be\/[\w-]{6,})/;

/** Extract a YouTube video id from any supported URL form, or null. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, "");
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "");
      return /^[\w-]{6,}$/.test(id) ? id : null;
    }
    if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return id && /^[\w-]{6,}$/.test(id) ? id : null;
      }
      const embed = u.pathname.match(/^\/embed\/([\w-]{6,})$/);
      if (embed) return embed[1];
    }
    return null;
  } catch {
    return null;
  }
}

const IMAGE_EMBED_RE = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;

/** `![](youtube_url)` → `<iframe ...>` with a data-yt attribute carrying
 *  the id so the deflate step can rebuild the original URL. The iframe
 *  is on its own line so Milkdown / remark treat it as a block. Uses
 *  the privacy-enhanced youtube-nocookie.com endpoint because Tauri's
 *  iOS WebView origin (tauri://localhost) isn't accepted by the regular
 *  player ("Error 153 — Video player configuration error"). */
export function inflateYoutubeEmbeds(body: string): string {
  return body.replace(IMAGE_EMBED_RE, (full, _alt: string, url: string) => {
    if (!YT_HOST_RE.test(url)) return full;
    const id = youtubeId(url);
    if (!id) return full;
    return `<iframe class="order-youtube-embed" data-yt="${id}" src="https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen" allowfullscreen></iframe>`;
  });
}

// Match by the `src="https://www.youtube.com/embed/ID"` substring so the
// deflate works even if Milkdown's serializer drops `data-yt`, reorders
// attributes, or strips the order-youtube-embed class on round-trip.
const IFRAME_SRC_RE =
  /<iframe\b[^>]*\bsrc="https?:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com)\/embed\/([\w-]+)[^"]*"[^>]*>\s*<\/iframe>/g;

/** `<iframe ... src="...youtube.com/embed/ID..." ...></iframe>` →
 *  `![](https://www.youtube.com/watch?v=ID)`. */
export function deflateYoutubeEmbeds(body: string): string {
  return body.replace(IFRAME_SRC_RE, (_full, id: string) => {
    return `![](https://www.youtube.com/watch?v=${id})`;
  });
}

// Obsidian's Auto Card Link plugin (and many similar) serialize a
// YouTube video as a YAML-bodied fenced code block:
//
//   ```embed
//   title: "..."
//   image: "..."
//   description: "..."
//   url: "https://www.youtube.com/watch?v=ID"
//   ```
//
// Crepe's code-block component intercepts the fence render (NodeView
// override) so an in-editor ProseMirror plugin can't reach those nodes
// to swap them for an iframe. Instead, we transform the embed fence to
// the canonical image-syntax form (`![](watch-url)`) BEFORE Crepe sees
// it, and restore each fence verbatim on save so the on-disk YAML
// (title, image, description) survives the round trip.
//
// EMBED_FENCE_RE captures the fence prefix (` ``` ` plus an info word,
// commonly `embed`, optionally followed by other text on the same line)
// and the fence body. The body is the only thing we look at for URLs.
const EMBED_FENCE_RE = /(```embed[^\n]*\n)([\s\S]*?)\n```/g;

export interface EmbedFenceRestore {
  /** Map from canonical watch-URL → the original fence text it came from. */
  byUrl: Map<string, string>;
}

/** Replace `````embed` blocks whose body has a YouTube `url:` line with
 *  the canonical `![](watch-url)` image embed form so the existing
 *  image-handling YouTube plugin picks them up. Returns the rewritten
 *  body PLUS a restore map so saves can put the original fence text
 *  back when serializing. */
export function inflateEmbedFencesToImage(body: string): {
  body: string;
  restore: EmbedFenceRestore;
} {
  const restore: EmbedFenceRestore = { byUrl: new Map() };
  const out = body.replace(EMBED_FENCE_RE, (full, _prefix: string, inner: string) => {
    const m = inner.match(/^\s*url\s*:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
    if (!m) return full;
    const rawUrl = m[1].trim();
    const id = youtubeId(rawUrl);
    if (!id) return full;
    const watchUrl = `https://www.youtube.com/watch?v=${id}`;
    // Keep the FIRST fence per URL — later duplicates round-trip as
    // image-form, which is still a valid Obsidian embed.
    if (!restore.byUrl.has(watchUrl)) restore.byUrl.set(watchUrl, full);
    return `![](${watchUrl})`;
  });
  return { body: out, restore };
}

/** Inverse of `inflateEmbedFencesToImage`: any `![](youtube_url)` whose
 *  URL has a stashed fence in the restore map is rewritten back to the
 *  original fence on save. Image-form embeds the user typed directly
 *  (no stash) stay as image form. */
export function restoreEmbedFences(body: string, restore: EmbedFenceRestore): string {
  if (restore.byUrl.size === 0) return body;
  // Match the image form we emitted on load (no alt; optional alt too).
  return body.replace(
    /!\[[^\]]*\]\((https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^)\s]+|youtu\.be\/[\w-]+(?:\?[^)\s]*)?))\)/g,
    (full, url: string) => {
      const id = youtubeId(url);
      if (!id) return full;
      const canonical = `https://www.youtube.com/watch?v=${id}`;
      return restore.byUrl.get(canonical) ?? full;
    },
  );
}
