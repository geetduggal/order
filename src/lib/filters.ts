// Shared filter model for the Stream — used by both the desktop app
// (CardGrid) and the read-only web viewer so the two never drift.
//
// The Stream is one recency-ordered timeline. Filters narrow it and
// surface as pills in the left rail:
//   - include: show only items in this folder (multiple compose OR)
//   - exclude: hide items in this folder
export type Filter = { kind: "include" | "exclude"; ref: string };

/** A note "belongs to" `ref` when it IS that folder's Main Document
 *  (filename stem === ref) or links to it via `folder: [[ref]]`.
 *  `folderRefOf` extracts the note's parent folder ref (already
 *  `parseRef`-resolved by the caller for the app; the viewer passes
 *  its pre-parsed `folder`). */
export function noteBelongsTo(
  filenameStem: string,
  folderRef: string | null,
  ref: string,
): boolean {
  if (filenameStem === ref) return true;
  return folderRef === ref;
}

/** Split a filter list into include / exclude ref arrays. */
export function partitionFilters(filters: Filter[]): {
  includeRefs: string[];
  excludeRefs: string[];
} {
  return {
    includeRefs: filters.filter((f) => f.kind === "include").map((f) => f.ref),
    excludeRefs: filters.filter((f) => f.kind === "exclude").map((f) => f.ref),
  };
}
