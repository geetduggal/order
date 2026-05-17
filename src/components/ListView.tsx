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
}

export function ListView({ render, items, vaultNotes, onChange, readOnlyMembership }: Props) {
  if (render === "lines") {
    return (
      <ListLines
        items={items}
        vaultNotes={vaultNotes}
        onChange={onChange}
        readOnlyMembership={readOnlyMembership}
      />
    );
  }
  return (
    <ListCards
      items={items}
      vaultNotes={vaultNotes}
      onChange={onChange}
      readOnlyMembership={readOnlyMembership}
    />
  );
}
