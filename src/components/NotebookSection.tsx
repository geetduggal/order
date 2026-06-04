// A newspaper-style "section" for one Notable Folder: the folder's
// Main Document as a full-width-to-2-column centerpiece at the top,
// the most recent notes orbiting in a measured-masonry grid below /
// beside it, a "Show more" control to reveal older notes, and a
// section divider. Shared by the desktop app and the web viewer —
// each host builds the actual Card cells and passes them in.

import { useEffect, useState } from "react";
import { useGridLayout } from "../lib/grid-layout";

export interface SectionCell {
  /** Stable React key. */
  key: string;
  /** Value placed on the cell's data-path attr (scroll target +
   *  masonry). */
  dataPath: string;
  node: React.ReactNode;
}

export function NotebookSection({
  sectionRef, centerpiece, notes, batch = 14, divider = true, collapseSignal = 0, scrollTarget = null,
}: {
  /** Folder ref — anchors the section for pill click-to-jump. */
  sectionRef: string;
  /** The Main Document cell (centerpiece). Null when the filtered
   *  ref has no Main Document (e.g. a bare leaf-note filter). */
  centerpiece: SectionCell | null;
  /** All notes belonging to this folder, newest first. The section
   *  reveals them `batch` at a time via Show more. */
  notes: SectionCell[];
  batch?: number;
  divider?: boolean;
  /** Bump this to collapse the section back to its first batch (the
   *  home button uses it to reset all expansions). */
  collapseSignal?: number;
  /** When set, ensure the section is expanded enough to render the
   *  cell with this `dataPath`. The host already matches `dataPath`
   *  to what its scroll-target effect queries for, so a single string
   *  pass-through covers both desktop (path) and viewer (ref) hosts. */
  scrollTarget?: string | null;
}) {
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  useGridLayout(gridEl);
  const [shown, setShown] = useState(batch);
  // Collapse back to the first batch whenever the signal changes.
  useEffect(() => { setShown(batch); }, [collapseSignal, batch]);

  // Auto-extend `shown` so a navigation target (calendar Open,
  // palette pick, newly-created note past the first batch) actually
  // appears in this section before the host's scroll effect tries to
  // locate it in the DOM.
  useEffect(() => {
    if (!scrollTarget) return;
    const idx = notes.findIndex((c) => c.dataPath === scrollTarget);
    if (idx < 0) return;
    const need = idx + 1;
    setShown((cur) => (need <= cur ? cur : Math.ceil(need / batch) * batch));
  }, [scrollTarget, notes, batch]);

  const visibleNotes = notes.slice(0, shown);
  const hasMore = notes.length > shown;

  return (
    <section className="nf-section" data-section={sectionRef}>
      <div className="card-grid nf-grid" ref={setGridEl}>
        {centerpiece && (
          <div
            className="card-grid-cell is-centerpiece"
            data-path={centerpiece.dataPath}
            key={centerpiece.key}
          >
            {centerpiece.node}
          </div>
        )}
        {visibleNotes.map((c) => (
          <div className="card-grid-cell" data-path={c.dataPath} key={c.key}>
            {c.node}
          </div>
        ))}
      </div>
      {hasMore && (
        <div className="nf-show-more-row">
          <button
            type="button"
            className="nf-show-more"
            onClick={() => setShown((n) => n + batch)}
          >
            Show {Math.min(batch, notes.length - shown)} more
          </button>
        </div>
      )}
      {divider && <div className="nf-divider" aria-hidden />}
    </section>
  );
}
