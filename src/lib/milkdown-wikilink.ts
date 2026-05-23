// SPIKE — needs in-app (GUI) verification.
//
// Makes `[[Name]]` first-class inside the Milkdown Crepe editor WITHOUT a
// custom node or schema change: a ProseMirror decoration plugin styles
// each `[[...]]` text range and tags it with `data-wikilink` for
// click-to-navigate. Because it never touches the schema or the
// serializer, the markdown source stays exactly `[[Name]]` (Obsidian
// compatible) and editing the raw text still works — the decoration
// approach is what sidesteps Crepe's node ownership (which makes custom
// inline nodes fiddly; see the abandoned YouTube-node attempt).
//
// Resolution (folder vs note vs broken) comes from the one resolver in
// wikilink.ts, so the editor agrees with the list renderers and publish.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { resolveWikilink, type WikiRef } from "./wikilink";

const KEY = new PluginKey("order-wikilink");
// The editor shows the rendered (unescaped) text, so we match plain
// `[[...]]` here; on-disk bracket escaping is the serializer's concern.
const WIKI_RE = /\[\[([^\]\n]+?)\]\]/g;

/** A Milkdown plugin that decorates `[[...]]` ranges. `getVault` returns
 *  the current vault index so broken links can be styled differently;
 *  it's a getter so the live index is read on every decoration pass. */
export function wikilinkProsePlugin(getVault: () => WikiRef[]) {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          decorations(state) {
            const vault = getVault();
            const decos: Decoration[] = [];
            state.doc.descendants((node: ProseNode, pos: number) => {
              if (!node.isText || !node.text) return undefined;
              const text = node.text;
              WIKI_RE.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = WIKI_RE.exec(text)) !== null) {
                const from = pos + m.index;
                const to = from + m[0].length;
                const res = resolveWikilink(m[0], vault);
                const cls =
                  res.kind === "broken" ? "wikilink wikilink-broken" : "wikilink";
                decos.push(
                  Decoration.inline(from, to, {
                    class: cls,
                    "data-wikilink": m[1].trim(),
                  }),
                );
              }
              return undefined;
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
  );
}
