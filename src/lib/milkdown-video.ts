// In-editor video embeds for `![[file.mov|mp4|webm|m4v]]` on disk.
//
// inflateImageEmbeds (lib/attachments.ts) rewrites those wikilink
// embeds into image syntax pointing at a vaultasset:// URL so Crepe
// can parse them as image nodes. Crepe would otherwise render them as
// broken <img src="…video.mov">; this plugin intercepts each such
// image node, hides the source, and mounts a native <video controls>
// widget right after it.
//
// Same pattern as milkdown-youtube.ts (which does the same trick for
// YouTube URLs). Decorations only — never mutates the document — so
// the on-disk `![[…]]` round-trips cleanly through deflate.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { isVideoPath } from "./attachments";

const KEY = new PluginKey("order-video-embed");

function buildVideo(src: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "order-video-embed-wrap";
  wrap.setAttribute("contenteditable", "false");
  const video = document.createElement("video");
  video.className = "order-video-embed";
  video.src = src;
  video.controls = true;
  video.preload = "metadata";
  // iOS Safari needs playsinline to keep the player in-page instead of
  // forcing the system video-takeover the moment the user taps Play.
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  wrap.appendChild(video);
  return wrap;
}

/** Scan the doc for image nodes whose src extension is a video.
 *  Returns (pos, end, src) tuples for the targets we'll decorate. */
function findVideoTargets(doc: ProseNode): { pos: number; end: number; src: string }[] {
  const out: { pos: number; end: number; src: string }[] = [];
  doc.descendants((node, pos) => {
    const attrs = node.attrs as { src?: unknown };
    if (typeof attrs?.src !== "string") return undefined;
    const src = attrs.src;
    // Strip any query string before extension-sniffing.
    const cleanPath = src.split(/[?#]/)[0];
    if (!isVideoPath(cleanPath)) return undefined;
    out.push({ pos, end: pos + node.nodeSize, src });
    return false; // don't recurse into image content
  });
  return out;
}

export function videoEmbedPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          decorations(state) {
            const targets = findVideoTargets(state.doc);
            if (targets.length === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            for (const { pos, end, src } of targets) {
              decos.push(
                Decoration.node(pos, end, {
                  class: "is-video-source",
                  "data-video-src": src,
                }),
              );
              // Widget keyed by src so PM reuses the existing <video>
              // node across re-renders instead of remounting (which
              // would reset playback state on every keystroke).
              decos.push(
                Decoration.widget(end, () => buildVideo(src), {
                  key: `video-${src}`,
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
