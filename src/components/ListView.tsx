// Thin dispatcher between the cards and lines renders. Centralises
// the "which renderer" decision so Card.tsx and any future caller
// don't repeat the check.

import { ListCards } from "./ListCards";
import { ListLines } from "./ListLines";
import type { ListItem, ListNoteRef, ListRender } from "../lib/list-folder";

interface Props {
  render: ListRender;
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  /** Fully static — no drag, no add, no delete, no inline edit.
   *  Used by the published viewer. */
  readOnly?: boolean;
  /** When true, the render hides add-row and per-item delete /
   *  inline edit affordances. Drag-reorder stays available. Used
   *  for base-driven lists where membership is controlled by the
   *  base block. */
  readOnlyMembership?: boolean;
  /** Lines-only: render each item's linked list folder as an
   *  indented sub-list under the row. Display-only. */
  expandSublists?: boolean;
  /** Title-click handler: navigate to the linked target by setting
   *  the folder filter to that ref. When omitted, title click falls
   *  back to inline rename. */
  onNavigate?: (ref: string) => void;
  /** Additive filter handler — used for NF refs so a title click
   *  ADDS the folder to the active set rather than replacing it. */
  onAddFilter?: (ref: string) => void;
}

export function ListView({ render, items, vaultNotes, onChange, readOnly, readOnlyMembership, expandSublists, onNavigate, onAddFilter }: Props) {
  if (render === "lines") {
    return (
      <ListLines
        items={items}
        vaultNotes={vaultNotes}
        onChange={onChange}
        readOnly={readOnly}
        readOnlyMembership={readOnlyMembership}
        expandSublists={expandSublists}
        onNavigate={onNavigate}
        onAddFilter={onAddFilter}
      />
    );
  }
  return (
    <ListCards
      items={items}
      vaultNotes={vaultNotes}
      onChange={onChange}
      readOnly={readOnly}
      readOnlyMembership={readOnlyMembership}
      onNavigate={onNavigate}
      onAddFilter={onAddFilter}
    />
  );
}
