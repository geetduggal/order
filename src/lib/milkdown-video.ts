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
const VIDEO_OPEN_TAG_RE = /<video\b[^>]*\bclass="order-vault-video"[^>]*\bsrc="([^"]+)"[^>]*>/;
// Any html-node fragment that should be hidden: an open <video class=
// "order-vault-video"…> tag, or a bare </video> close that Milkdown
// may have split out as its own html node. Both are 100%-ours-only
// output (`order-vault-video` is the marker on the open; a `</video>`
// elsewhere in the doc would be unusual and worth hiding regardless).
const VIDEO_FRAGMENT_RE = /(?:<video\b[^>]*\bclass="order-vault-video")|<\/video>/;

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

interface Hide {
  pos: number;
  end: number;
}
interface Widget {
  pos: number;
  src: string;
}

function scanVideoBlocks(doc: ProseNode): { hides: Hide[]; widgets: Widget[] } {
  const hides: Hide[] = [];
  const widgets: Widget[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "html") return undefined;
    const attrs = node.attrs as { value?: unknown };
    if (typeof attrs?.value !== "string") return undefined;
    const value = attrs.value;
    // Anything that's our output — opener tag or stranded closer —
    // gets hidden so the user doesn't see literal `<video…>` text in
    // the editor. Each opener also mounts a widget; closers don't.
    if (!VIDEO_FRAGMENT_RE.test(value)) return undefined;
    hides.push({ pos, end: pos + node.nodeSize });
    const open = value.match(VIDEO_OPEN_TAG_RE);
    if (open) widgets.push({ pos: pos + node.nodeSize, src: open[1] });
    return false;
  });
  return { hides, widgets };
}

export function videoEmbedPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          decorations(state) {
            const { hides, widgets } = scanVideoBlocks(state.doc);
            if (widgets.length === 0 && hides.length === 0) return DecorationSet.empty;
            const decos: Decoration[] = [];
            for (const { pos, end } of hides) {
              decos.push(
                Decoration.node(pos, end, { class: "is-video-source" }),
              );
            }
            for (const { pos, src } of widgets) {
              // Keyed by src so PM reuses the existing <video>
              // across re-renders (otherwise every keystroke would
              // reset playback state).
              decos.push(
                Decoration.widget(pos, () => buildVideo(src), {
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
