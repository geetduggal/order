// Obsidian-style YouTube embeds in Milkdown via a ProseMirror plugin.
//
// On-disk forms (both round-trip portably to Obsidian):
//
//   1. `![](https://www.youtube.com/watch?v=ID)`  (image syntax)
//   2. ```embed                                    (Obsidian's link-embed
//      url: "..."                                       YAML fence;
//      ```                                              Auto Card Link
//                                                       et al.)
//
// Implementation uses ProseMirror widget decorations rather than a
// MutationObserver because PM owns the editor DOM — anything we insert
// outside of decorations gets reverted on the next state update.
//
// For each image node whose src is a YouTube URL, or each code_block
// node whose body's first `url:` line is a YouTube URL, we add:
//
//   - a node decoration with class `is-yt-source` (CSS hides the source)
//   - a widget decoration positioned right after the node — its DOM is
//     an <iframe> player
//
// The widget callback is keyed by video id so PM reuses the existing
// DOM across re-renders instead of remounting the iframe each tick.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { invoke } from "@tauri-apps/api/core";
import { youtubeId } from "./youtube";

// Module-level title cache so repeated renders of the same video id
// (every keystroke in the editor) don't re-hit YouTube's oEmbed
// endpoint. Map<videoId, { title?: string; author?: string }>.
const oembedCache = new Map<string, { title?: string; author?: string; promise?: Promise<void> }>();
function fetchOEmbed(id: string): Promise<void> {
  let entry = oembedCache.get(id);
  if (entry?.title || entry?.promise) return entry?.promise ?? Promise.resolve();
  entry = entry ?? {};
  oembedCache.set(id, entry);
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${id}`,
  )}&format=json`;
  entry.promise = fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .then((data: { title?: string; author_name?: string } | null) => {
      if (!data) return;
      entry!.title = data.title;
      entry!.author = data.author_name;
    })
    .catch(() => { /* offline / network blocked / CORS — leave title empty */ })
    .finally(() => { entry!.promise = undefined; });
  return entry.promise;
}

const KEY = new PluginKey("order-youtube-embed");
const YT_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^\s"'<>)]+|youtu\.be\/[\w-]+(?:\?[^\s"'<>)]*)?)/;

function buildIframe(id: string): HTMLElement {
  // Always render a clickable thumbnail card: a clean preview with
  // the video's title that opens in the default browser on desktop
  // and the YouTube app (or Safari) on iOS via the Tauri shell.
  //
  // The previous inline iframe path was endlessly fragile:
  //   - iOS Tauri WebView rejects YouTube's player config on
  //     non-standard origins ("Error 153")
  //   - even when it works, the inline player invites stuttering
  //     UI work and unwanted autoplay
  //   - the published web viewer's iframe was fine but reads
  //     differently from the desktop / mobile app
  // A thumbnail card is consistent, fast, and uses the native
  // YouTube experience for actual playback.
  return buildThumbnailCard(id);
}

/** Clickable thumbnail card — the universal YouTube embed render.
 *  Thumbnail preview + title (fetched via oEmbed) + play affordance;
 *  a tap routes through the Tauri shell on desktop / iOS, and falls
 *  back to native anchor navigation in the published web viewer. */
function buildThumbnailCard(id: string): HTMLDivElement {
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const wrap = document.createElement("div");
  wrap.className = "order-youtube-embed-wrap order-youtube-card-wrap";
  wrap.setAttribute("contenteditable", "false");
  // <a> so the OS sees a real activation target even if the synthetic
  // JS handlers below don't fire — iOS WKWebView treats anchor taps
  // more permissively than button clicks inside contenteditable.
  const card = document.createElement("a");
  card.className = "order-youtube-card";
  card.href = watchUrl;
  // No target=_blank: WKWebView's default WKUIDelegate doesn't open
  // _blank links, so the tap appears dead. Letting the anchor stay
  // _self lets the platform-specific click handlers below take over
  // before any default WebView navigation fires.
  card.rel = "noreferrer";
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", "Open video on YouTube");
  card.setAttribute("draggable", "false");
  card.style.touchAction = "manipulation";

  // Inline pointer handlers — bound directly to the element so they
  // execute before any ProseMirror gesture machinery can swallow the
  // tap. Cascading attempts: invoke (desktop / iOS plugin) →
  // window.open → location.href as last resort. All three fire so
  // whichever the platform supports wins. Cooldown prevents duplicate
  // YouTube app launches when multiple events (touchend + click) fire
  // for one tap.
  let lastTap = 0;
  const openIt = (e: Event) => {
    const now = Date.now();
    if (now - lastTap < 700) { e.preventDefault(); e.stopPropagation(); return; }
    lastTap = now;
    e.preventDefault();
    e.stopPropagation();
    // Fire-and-forget invoke (works on desktop Tauri + iOS via the
    // vault plugin). Don't await — iOS UIApplication.open's completion
    // callback can take seconds while the user confirms the app-switch
    // prompt, and awaiting that would freeze the click handler.
    try {
      invoke("open_url", { url: watchUrl })
        .catch(() => {
          // Tauri rejected (web viewer or unsupported platform). Try
          // window.open. iOS WKWebView's default UIDelegate often
          // returns null for _blank popups — if that's the case the
          // location fallback fires.
          const w = window.open(watchUrl, "_blank");
          if (!w) window.location.href = watchUrl;
        });
    } catch {
      // invoke() is not a function (web viewer with no Tauri shim).
      const w = window.open(watchUrl, "_blank");
      if (!w) window.location.href = watchUrl;
    }
  };
  card.addEventListener("touchend", openIt, { capture: true, passive: false });
  card.addEventListener("click", openIt, { capture: true });

  // Thumbnail half.
  const thumb = document.createElement("span");
  thumb.className = "order-youtube-card-thumb";
  const img = document.createElement("img");
  img.className = "order-youtube-card-img";
  img.alt = "";
  img.loading = "lazy";
  img.draggable = false;
  // hqdefault is YouTube's universal 4:3 thumbnail (480x360). For a
  // 16:9 video the letterbox bars are 12.5% top + 12.5% bottom; the
  // 16:9 card container with `object-fit: cover` scales the image
  // horizontally to fill the width and crops exactly that 25% off
  // top + bottom — bars gone, real video frame edge-to-edge.
  // (maxresdefault was tempting but it's 1280x720 of whatever shape
  // YouTube cooked it into — sometimes still letterboxed, sometimes
  // 404. hqdefault is the most reliable shape across the catalog.)
  img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  img.onerror = () => {
    img.onerror = null;
    img.src = `https://i.ytimg.com/vi/${id}/0.jpg`;
  };
  thumb.appendChild(img);
  const play = document.createElement("span");
  play.className = "order-youtube-card-play";
  play.setAttribute("aria-hidden", "true");
  play.textContent = "▶";
  thumb.appendChild(play);
  card.appendChild(thumb);

  // Title / meta half.
  const meta = document.createElement("span");
  meta.className = "order-youtube-card-meta";
  const title = document.createElement("span");
  title.className = "order-youtube-card-title";
  title.textContent = "YouTube video";
  meta.appendChild(title);
  const host = document.createElement("span");
  host.className = "order-youtube-card-host";
  host.textContent = "youtube.com";
  meta.appendChild(host);
  card.appendChild(meta);

  // Cached title — fetch once per id and update the DOM when it lands.
  // The fallback "YouTube video" stays if the network call fails (no
  // CORS, offline, etc.) so the card always reads as a video.
  const cached = oembedCache.get(id);
  if (cached?.title) {
    title.textContent = cached.title;
    if (cached.author) host.textContent = `${cached.author} · youtube.com`;
  } else {
    void fetchOEmbed(id).then(() => {
      const entry = oembedCache.get(id);
      if (entry?.title) {
        title.textContent = entry.title;
        if (entry.author) host.textContent = `${entry.author} · youtube.com`;
      }
    });
  }

  // Route through Tauri's shell when available so the URL opens in
  // the native YouTube app (or Safari), not inside the in-app
  // WebView. Listen on multiple events because iOS WebView's
  // synthetic `click` is unreliable inside ProseMirror — the touch
  // gesture sometimes never escalates to a click, leaving the
  // anchor href as the only fallback. pointerup + touchend cover
  // every iOS pathway we've actually seen miss; click is still
  // there for desktop and keyboard activation.
  // No card-level click handler — MilkdownSurface's capture-phase
  // anchor handler routes every `<a href="http…">` inside the editor
  // through the same open_url path AND falls back to window.open in
  // the published web viewer (no Tauri). Adding our own handler here
  // produced two open_url calls per tap on desktop (one in capture,
  // one in bubble) and the racing awaits froze iOS during the
  // UIApplication.open completion handshake.

  wrap.appendChild(card);
  return wrap;
}

/** Scan the doc for nodes that should render as a YouTube embed,
 *  returning their (pos, end, videoId) tuples. */
function findEmbedTargets(doc: ProseNode): { pos: number; end: number; id: string }[] {
  const out: { pos: number; end: number; id: string }[] = [];
  doc.descendants((node, pos) => {
    // (A) Inline / block image with YouTube src — covers `![](url)`.
    const attrs = node.attrs as { src?: unknown };
    if (typeof attrs?.src === "string") {
      const id = youtubeId(attrs.src);
      if (id) {
        out.push({ pos, end: pos + node.nodeSize, id });
        return false; // don't recurse into image content
      }
    }
    // (B) Fenced code block whose text contains a YouTube URL —
    //     covers Obsidian's ```embed YAML form. node.textContent
    //     concatenates all text descendants which is what we want.
    if (node.type.name === "code_block" || node.type.name === "fence") {
      const m = node.textContent.match(YT_URL_RE);
      if (m) {
        const id = youtubeId(m[0]);
        if (id) {
          out.push({ pos, end: pos + node.nodeSize, id });
          return false;
        }
      }
    }
    return undefined;
  });
  return out;
}

export function youtubeEmbedPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          decorations(state) {
            const targets = findEmbedTargets(state.doc);
            if (targets.length === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            for (const { pos, end, id } of targets) {
              // Hide the broken-image / source widget.
              decos.push(
                Decoration.node(pos, end, {
                  class: "is-yt-source",
                  "data-yt": id,
                }),
              );
              // Mount the iframe right after the source node. The
              // `key` lets PM dedupe across rerenders so we don't
              // re-mount (and reload) the iframe on every keystroke.
              decos.push(
                Decoration.widget(end, () => buildIframe(id), {
                  key: `yt-${id}`,
                  side: 1,
                  ignoreSelection: true,
                }),
              );
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );
}
