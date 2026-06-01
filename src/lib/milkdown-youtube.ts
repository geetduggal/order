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
import { youtubeId } from "./youtube";

const KEY = new PluginKey("order-youtube-embed");
const YT_URL_RE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?[^\s"'<>)]+|youtu\.be\/[\w-]+(?:\?[^\s"'<>)]*)?)/;

function buildIframe(id: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "order-youtube-embed-wrap";
  wrap.setAttribute("contenteditable", "false");
  const iframe = document.createElement("iframe");
  iframe.className = "order-youtube-embed";
  // youtube-nocookie.com (privacy-enhanced) is more permissive about
  // non-standard origins than youtube.com — Tauri's iOS WebView serves
  // pages from tauri://localhost / https://tauri.localhost, which the
  // normal player rejects with "Error 153 — Video player configuration
  // error" (no valid referrer). The no-cookie endpoint plays for the
  // same set of videos in every browser context we ship to.
  // playsinline=1 keeps the player inline on iOS instead of forcing
  // full-screen takeover the moment the user taps Play.
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
