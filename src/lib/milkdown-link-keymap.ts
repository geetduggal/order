// Cmd+K / Ctrl+K → wrap the current selection in a markdown link mark.
//
// Crepe ships with a link tooltip that lets you click an existing link
// to edit its href, but the "highlight some text → press Cmd+K → type a
// URL" workflow that every other editor binds to that shortcut isn't
// wired up. Add a small ProseMirror plugin that:
//   1. catches Mod-k when the editor has focus
//   2. captures the current selection
//   3. prompts for a URL (or a key/value `title|href` pair)
//   4. applies the link mark to the selection
//
// Selection is required — if the cursor is collapsed we no-op and let
// the outer Cmd+K binding (the folder palette) run instead.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { MarkType } from "@milkdown/kit/prose/model";

const KEY = new PluginKey("order-link-keymap");

function isMod(e: KeyboardEvent): boolean {
  // Cmd on macOS / iOS, Ctrl elsewhere. Matches ProseMirror's own
  // 'Mod-…' shortcut convention.
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

export function linkKeymapPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          handleKeyDown(view, event) {
            if (!isMod(event)) return false;
            if (event.key !== "k" && event.key !== "K") return false;
            const { state, dispatch } = view;
            const { from, to, empty } = state.selection;
            // Cursor with no selection → let the outer Cmd+K binding
            // (folder palette) run. Prevents stealing the shortcut
            // when there's nothing to wrap.
            if (empty) return false;
            const linkType = state.schema.marks.link as MarkType | undefined;
            if (!linkType) return false;
            event.preventDefault();
            // Read the existing href off the selection's first link
            // mark (if any) so editing an existing link prefills the
            // prompt instead of asking for a fresh URL.
            const node = state.doc.nodeAt(from);
            const existing = node?.marks.find((m) => m.type === linkType);
            const initial = (existing?.attrs?.href as string | undefined) ?? "https://";
            // window.prompt blocks the editor for a moment but is the
            // simplest cross-platform input that doesn't require its
            // own popover component. Esc / blank submit cancels.
            const href = window.prompt("Link URL:", initial);
            if (href === null) return true;
            const trimmed = href.trim();
            if (!trimmed) {
              // Empty input on an existing link → clear the link.
              if (existing) {
                dispatch(state.tr.removeMark(from, to, linkType));
              }
              return true;
            }
            // Apply (or replace) the link mark across the selection.
            const tr = state.tr;
            if (existing) tr.removeMark(from, to, linkType);
            tr.addMark(from, to, linkType.create({ href: trimmed }));
            dispatch(tr);
            return true;
          },
        },
      }),
  );
}
