// Filter pill stack — sticky left rail. A search icon sits at the top
// (opens the command palette, same as Cmd+K), with the active-filter
// pills below it. Each pill is a compact folder icon that expands on
// hover to reveal the folder name + a remove ×. Clicking the icon body
// focuses that folder (pins its Main Document to the top of the
// Pile); clicking × removes the pill. Shared by app + web viewer.

import { Search as SearchIcon, X as XIcon, FilterX } from "lucide-react";
import { folderColor, folderIcon } from "../lib/folders";
import type { Filter } from "../lib/filters";
import { useTileDrag } from "../lib/use-tile-drag";

const keyOf = (f: Filter) => `${f.kind}:${f.ref}`;

export function FilterPillStack({
  filters, onRemove, onJump, onSearch, onReorder, onClear, stickyRef,
}: {
  filters: Filter[];
  onRemove: (f: Filter) => void;
  onJump: (ref: string) => void;
  /** A folder ref that is pinned/non-removable (the home folder in pile
   *  view) — its pill renders without a remove ×. */
  stickyRef?: string;
  /** Open the folder search dialog (the Cmd+K command palette). When
   *  set, a search icon renders just above the pills. */
  onSearch?: () => void;
  /** Drag-reorder the pills (optional). */
  onReorder?: (next: Filter[]) => void;
  /** Clear/reset all active filters. When set, a clear icon renders
   *  below the pills (only while there are filters). */
  onClear?: () => void;
}) {
  const byKey = new Map(filters.map((f) => [keyOf(f), f]));
  const { gridRef, dragRef, onTilePointerDown } = useTileDrag(
    filters.map(keyOf),
    onReorder ? (order) => onReorder(order.map((k) => byKey.get(k)).filter((f): f is Filter => !!f)) : undefined,
    { vertical: true, exclude: ".filter-pill-x, .filter-search" },
  );
  if (filters.length === 0 && !onSearch) return null;
  return (
    <div className="filter-pills" role="list" aria-label="Active filters" ref={gridRef}>
      {onSearch && (
        <button
          type="button"
          className="filter-search"
          onClick={onSearch}
          title="Search folders (Cmd+K)"
          aria-label="Search folders"
        >
          <SearchIcon size={15} strokeWidth={2.2} />
        </button>
      )}
      {filters.map((f) => {
        const color = folderColor(f.ref);
        const Icon = folderIcon(f.ref);
        const isExclude = f.kind === "exclude";
        const isSticky = f.kind === "include" && !!stickyRef && f.ref === stickyRef;
        return (
          <div
            key={`${f.kind}:${f.ref}`}
            role="listitem"
            className={"filter-pill" + (isExclude ? " is-exclude" : "") + (isSticky ? " is-sticky" : "") + (onReorder ? " draggable" : "") + (dragRef === keyOf(f) ? " dragging" : "")}
            style={{ ["--pill-color" as string]: color }}
            data-tile-ref={keyOf(f)}
            onPointerDown={onReorder ? (e) => onTilePointerDown(e, keyOf(f)) : undefined}
          >
            <button
              type="button"
              className="filter-pill-jump"
              onClick={() => onJump(f.ref)}
              title={isExclude ? `Excluding ${f.ref} — click to jump` : `Jump to ${f.ref}`}
            >
              <span className="filter-pill-icon">
                <Icon size={14} strokeWidth={2.2} />
              </span>
              <span className="filter-pill-name">{f.ref}</span>
            </button>
            {!isSticky && (
              <button
                type="button"
                className="filter-pill-x"
                onClick={() => onRemove(f)}
                title={isExclude ? "Remove exclusion" : "Remove filter"}
                aria-label={`Remove ${f.ref} filter`}
              >
                <XIcon size={11} strokeWidth={2.4} />
              </button>
            )}
          </div>
        );
      })}
      {onClear && filters.length > 0 && (
        <button
          type="button"
          className="filter-clear"
          onClick={onClear}
          title="Clear filters"
          aria-label="Clear filters"
        >
          <FilterX size={15} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
