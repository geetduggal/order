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
import { isIosSync } from "./vault";

const KEY = new PluginKey("order-youtube-embed");
const YT_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^\s"'<>)]+|youtu\.be\/[\w-]+(?:\?[^\s"'<>)]*)?)/;

function buildIframe(id: string): HTMLElement {
  // iOS WebView fallback: even with youtube-nocookie.com, the YouTube
  // player still rejects Tauri's tauri://localhost origin on iOS with
  // "Error 153 — Video player configuration error" for many videos
  // (live streams, certain audio tracks, embeds that require strict
  // origin checks). Inline playback isn't worth the broken cards, so
  // on iOS we render a clickable thumbnail card that opens the video
  // in the native YouTube app / Safari via the Tauri shell. Single
  // tap, full quality, no broken player state.
  if (isIosSync()) return buildThumbnailCard(id);

  const wrap = document.createElement("div");
  wrap.className = "order-youtube-embed-wrap";
  wrap.setAttribute("contenteditable", "false");
  const iframe = document.createElement("iframe");
  iframe.className = "order-youtube-embed";
  // youtube-nocookie.com is more permissive about non-standard origins
  // than youtube.com — needed for the macOS Tauri WebView too. The
  // same set of videos plays for the same set of contexts.
  // playsinline=1 keeps macOS inline-player behavior consistent;
  // rel=0 suppresses unrelated-channel suggestions at video end.
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&rel=0`;
  iframe.setAttribute("frameborder", "0");
  iframe.setAttribute(
    "allow",
    "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen",
  );
  iframe.setAttribute("allowfullscreen", "");
  iframe.setAttribute("loading", "lazy");
  iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  wrap.appendChild(iframe);
  return wrap;
}

/** Clickable thumbnail card — used wherever the iframe player can't
 *  reliably initialize (iOS WebView). Renders the maxres/hq thumbnail,
 *  a play-button overlay, and an Open-in-YouTube affordance. */
function buildThumbnailCard(id: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "order-youtube-embed-wrap order-youtube-thumb-wrap";
  wrap.setAttribute("contenteditable", "false");
  const card = document.createElement("button");
  card.type = "button";
  card.className = "order-youtube-thumb";
  card.setAttribute("aria-label", "Open video in YouTube");
  const img = document.createElement("img");
  img.className = "order-youtube-thumb-img";
  img.alt = "";
  img.loading = "lazy";
  img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  img.onerror = () => { img.src = `https://i.ytimg.com/vi/${id}/0.jpg`; };
  card.appendChild(img);
  const play = document.createElement("span");
  play.className = "order-youtube-thumb-play";
  play.setAttribute("aria-hidden", "true");
  play.textContent = "▶";
  card.appendChild(play);
  const label = document.createElement("span");
  label.className = "order-youtube-thumb-label";
  label.textContent = "Open in YouTube";
  card.appendChild(label);
  card.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void invoke("open_url", { url: `https://www.youtube.com/watch?v=${id}` })
      .catch((err) => console.warn("open_url failed:", err));
  });
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
