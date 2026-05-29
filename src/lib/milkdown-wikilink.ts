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
import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { resolveWikilink, type WikiRef } from "./wikilink";
import { isNotableFolder } from "./folders";

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
              // Don't decorate inside fenced code blocks — the source
              // there is meant to display literally.
              if (node.type.name === "code_block") return false;
              if (!node.isText || !node.text) return undefined;
              // Same for inline `code` spans.
              if (node.marks.some((m) => m.type.name === "code")) return undefined;
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

// ---------- `[[` autocomplete ----------

const SUGGEST_KEY = new PluginKey("order-wikilink-suggest");
const MAX_SUGGESTIONS = 8;
// An open `[[` immediately before the cursor, capturing the query so far.
// Excludes `]` and newline so a closed link or a line break ends it.
const TRIGGER_RE = /\[\[([^[\]\n]*)$/;

interface Suggestion { name: string; kind: "folder" | "note" }

function filterVault(vault: WikiRef[], query: string): Suggestion[] {
  const q = query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const n of vault) {
    const name = n.filename.replace(/\.md$/i, "");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (q && !key.includes(q)) continue;
    seen.add(key);
    out.push({ name, kind: isNotableFolder(n.frontmatter) ? "folder" : "note" });
  }
  // Prefix matches first, then folders, then alphabetical.
  out.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out.slice(0, MAX_SUGGESTIONS);
}

/** Find an open `[[query` ending at the (empty) cursor, returning the
 *  range from the first `[` to the cursor plus the query text. */
function activeTrigger(view: EditorView): { from: number; to: number; query: string } | null {
  const sel = view.state.selection;
  if (!sel.empty) return null;
  const $from = sel.$from;
  const before = view.state.doc.textBetween($from.start(), $from.pos, "\n", "\n");
  const m = TRIGGER_RE.exec(before);
  if (!m) return null;
  // Suppress when this `[[` is already closed by a `]]` ahead of the
  // cursor (before any next `[[`). That distinguishes typing a fresh
  // `[[query` from clicking into an existing `[[Name]]` link to follow
  // it — the popup should only open while authoring an unclosed link.
  const after = view.state.doc.textBetween($from.pos, $from.end(), "\n", "\n");
  const closeIdx = after.indexOf("]]");
  const openIdx = after.indexOf("[[");
  if (closeIdx !== -1 && (openIdx === -1 || closeIdx < openIdx)) return null;
  return { from: $from.pos - m[0].length, to: $from.pos, query: m[1] };
}

/** `[[` typeahead: a popup of Notable Folders + notes, filtered as you
 *  type, inserting `[[Name]]` on select. Keyboard (↑ ↓ Enter/Tab Esc)
 *  and click. Kept out of read-only (viewer) editors. */
export function wikilinkAutocompletePlugin(getVault: () => WikiRef[]) {
  return $prose(
    () => {
      let popup: HTMLDivElement | null = null;
      let items: Suggestion[] = [];
      let selected = 0;
      let range: { from: number; to: number } | null = null;

      const close = () => {
        popup?.remove();
        popup = null;
        range = null;
        items = [];
        selected = 0;
      };

      const accept = (view: EditorView, item: Suggestion) => {
        const to = view.state.selection.from;
        const from = range ? range.from : to;
        const text = `[[${item.name}]]`;
        const tr = view.state.tr.insertText(text, from, to);
        const after = from + text.length;
        tr.setSelection(TextSelection.create(tr.doc, after));
        view.dispatch(tr);
        close();
        view.focus();
      };

      const render = (view: EditorView) => {
        if (!range) return close();
        if (!popup) {
          popup = document.createElement("div");
          popup.className = "wikilink-suggest";
          document.body.appendChild(popup);
        }
        popup.innerHTML = "";
        if (items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "wikilink-suggest-empty";
          empty.textContent = "No matches";
          popup.appendChild(empty);
        } else {
          items.forEach((it, i) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "wikilink-suggest-item" + (i === selected ? " is-selected" : "");
            const name = document.createElement("span");
            name.className = "wikilink-suggest-name";
            name.textContent = it.name;
            const kind = document.createElement("span");
            kind.className = "wikilink-suggest-kind";
            kind.textContent = it.kind;
            row.append(name, kind);
            // mousedown (not click) so the editor doesn't lose the selection first.
            row.addEventListener("mousedown", (e) => { e.preventDefault(); accept(view, it); });
            popup!.appendChild(row);
          });
        }
        const coords = view.coordsAtPos(range.from);
        popup.style.left = `${coords.left}px`;
        popup.style.top = `${coords.bottom + 4}px`;
      };

      return new Plugin({
        key: SUGGEST_KEY,
        view() {
          return {
            update: (view) => {
              const trig = activeTrigger(view);
              if (!trig) return close();
              range = { from: trig.from, to: trig.to };
              items = filterVault(getVault(), trig.query);
              if (selected >= items.length) selected = 0;
              render(view);
            },
            destroy: close,
          };
        },
        props: {
          handleKeyDown(view, event) {
            if (!popup || !range) return false;
            if (event.key === "Escape") { close(); return true; }
            if (items.length === 0) return false;
            if (event.key === "ArrowDown") {
              selected = (selected + 1) % items.length;
              render(view);
              return true;
            }
            if (event.key === "ArrowUp") {
              selected = (selected - 1 + items.length) % items.length;
              render(view);
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              accept(view, items[selected]);
              return true;
            }
            return false;
          },
        },
      });
    },
  );
}
