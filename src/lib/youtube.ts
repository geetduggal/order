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
 *  is on its own line so Milkdown / remark treat it as a block. */
export function inflateYoutubeEmbeds(body: string): string {
  return body.replace(IMAGE_EMBED_RE, (full, _alt: string, url: string) => {
    if (!YT_HOST_RE.test(url)) return full;
    const id = youtubeId(url);
    if (!id) return full;
    return `<iframe class="order-youtube-embed" data-yt="${id}" src="https://www.youtube.com/embed/${id}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
  });
}

// Match by the `src="https://www.youtube.com/embed/ID"` substring so the
// deflate works even if Milkdown's serializer drops `data-yt`, reorders
// attributes, or strips the order-youtube-embed class on round-trip.
const IFRAME_SRC_RE =
  /<iframe\b[^>]*\bsrc="https?:\/\/(?:www\.)?youtube\.com\/embed\/([\w-]+)[^"]*"[^>]*>\s*<\/iframe>/g;

/** `<iframe ... src="...youtube.com/embed/ID..." ...></iframe>` →
 *  `![](https://www.youtube.com/watch?v=ID)`. */
export function deflateYoutubeEmbeds(body: string): string {
  return body.replace(IFRAME_SRC_RE, (_full, id: string) => {
    return `![](https://www.youtube.com/watch?v=${id})`;
  });
}
