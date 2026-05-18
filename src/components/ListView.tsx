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
}

export function ListView({ render, items, vaultNotes, onChange, readOnlyMembership, expandSublists, onNavigate }: Props) {
  if (render === "lines") {
    return (
      <ListLines
        items={items}
        vaultNotes={vaultNotes}
        onChange={onChange}
        readOnlyMembership={readOnlyMembership}
        expandSublists={expandSublists}
        onNavigate={onNavigate}
      />
    );
  }
  return (
    <ListCards
      items={items}
      vaultNotes={vaultNotes}
      onChange={onChange}
      readOnlyMembership={readOnlyMembership}
      onNavigate={onNavigate}
    />
  );
}
