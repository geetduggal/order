// Tab / Shift-Tab inside a list → indent / outdent the CURRENT list item only.
//
// Crepe's default Tab handling on lists could nest following content in
// surprising ways ("everything underneath" gets pulled in). This plugin binds
// Tab to prosemirror-schema-list's `sinkListItem` (indent this item, carrying
// only its own children) and Shift-Tab to `liftListItem` (outdent), which is
// the standard, predictable behavior every outliner uses.
//
// It only acts when the caret is actually inside a `list_item`, so Tab keeps
// its normal meaning elsewhere. It's registered AFTER the wikilink autocomplete
// plugin so an open `[[` suggestion popup still gets first dibs on Tab.

import { $prose } from "@milkdown/kit/utils";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { sinkListItem, liftListItem } from "@milkdown/kit/prose/schema-list";
import type { NodeType } from "@milkdown/kit/prose/model";

const KEY = new PluginKey("order-list-keymap");

export function listKeymapPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: KEY,
        props: {
          handleKeyDown(view, event) {
            if (event.key !== "Tab") return false;
            const itemType = view.state.schema.nodes.list_item as NodeType | undefined;
            if (!itemType) return false;
            // Only handle Tab when the selection is inside a list item.
            const { $from } = view.state.selection;
            let inList = false;
            for (let d = $from.depth; d > 0; d--) {
              if ($from.node(d).type === itemType) { inList = true; break; }
            }
            if (!inList) return false;
            const cmd = event.shiftKey ? liftListItem(itemType) : sinkListItem(itemType);
            cmd(view.state, view.dispatch);
            // Swallow Tab regardless — even when sink/lift can't apply (e.g. the
            // first item can't be indented) we don't want Tab to move focus out
            // of the editor or insert a literal tab.
            event.preventDefault();
            return true;
          },
        },
      }),
  );
}
