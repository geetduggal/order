// In-editor video embeds for `![[file.mov|mp4|webm|m4v]]` on disk.
//
// inflateImageEmbeds emits a raw HTML <video> block for video
// extensions. Milkdown's commonmark preset folds raw HTML into an
// `html` schema node whose toDOM renders the value as TEXT (not
// parsed HTML) — so without this plugin the user just sees the
// `<video class="order-vault-video" src="…">…` markup as literal
// text in the editor.
//
// This plugin walks the doc, finds `html` nodes whose value starts
// with our marker class, and adds:
//   - a node decoration that hides the literal-text rendering
//   - a widget decoration that mounts a real <video controls
//     playsinline> at the same position so the user sees a player.
//
// Same shape as the YouTube plugin. Decorations only — never mutates
// the document — so the round-trip through deflateImageEmbeds back
// to `![[X.mov]]` on save is unaffected.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";

const KEY = new PluginKey("order-video-embed");
const VIDEO_TAG_RE = /<video\b[^>]*\bclass="order-vault-video"[^>]*\bsrc="([^"]+)"[^>]*>/;

function buildVideo(src: string): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "order-video-embed-wrap";
  wrap.setAttribute("contenteditable", "false");
  const video = document.createElement("video");
  video.className = "order-video-embed";
  video.src = src;
  video.controls = true;
  video.preload = "metadata";
  // iOS Safari needs playsinline + webkit-playsinline to keep the
  // player in-page instead of triggering the system video-takeover
  // the moment the user taps Play.
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  wrap.appendChild(video);
  return wrap;
}

interface Target {
  pos: number;
  end: number;
  src: string;
}

function findVideoTargets(doc: ProseNode): Target[] {
  const out: Target[] = [];
  doc.descendants((node, pos) => {
    // Milkdown's commonmark html schema is an inline atom node with
    // a `value` attribute holding the raw HTML text.
    if (node.type.name !== "html") return undefined;
    const attrs = node.attrs as { value?: unknown };
    if (typeof attrs?.value !== "string") return undefined;
    const m = attrs.value.match(VIDEO_TAG_RE);
    if (!m) return undefined;
    out.push({ pos, end: pos + node.nodeSize, src: m[1] });
    return false;
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
              // Hide the text-rendered span (Milkdown's `html` node
              // renders as a `<span data-type="html">raw text</span>`).
              decos.push(
                Decoration.node(pos, end, {
                  class: "is-video-source",
                  "data-video-src": src,
                }),
              );
              // Mount the real video widget right after the source.
              // Keyed by src so PM reuses the existing <video> across
              // re-renders (otherwise every keystroke would reset
              // playback state).
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
