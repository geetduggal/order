// Masonry-style row-span layout for the .card-grid: each cell sets
// `gridRowEnd: span N` so the grid (with `grid-auto-rows: 8px`) sizes
// each cell to the natural height of its `.order-card` child.
//
// Shared between Order's main grid and the read-only viewer — both
// produce identical card chrome and need identical row sizing.
//
// PERF SHAPE: every relayout runs as a READ phase (all offsetHeights)
// followed by a WRITE phase (all row spans). Interleaving the two —
// read a cell, write its span, read the next — forces the browser
// into a full layout PER CELL, which turned "close a folder" (an
// 80-cell reflow) into hundreds of milliseconds of main-thread
// blocking. Observer callbacks additionally coalesce into one batch
// per animation frame, so a mutation storm (section swap, exit
// animations, ProseMirror rewrites) pays for one layout, not N.

import { useEffect } from "react";

const GRID_ROW_PX = 8;

export function useGridLayout(grid: HTMLDivElement | null) {
  useEffect(() => {
    if (!grid) return;

    function relayoutMany(cells: HTMLElement[]) {
      if (!grid || cells.length === 0) return;
      const styles = getComputedStyle(grid);
      const rowGap = parseFloat(styles.rowGap || styles.gap || "0");
      // The visual gap between cards lives on the card's margin-bottom
      // (--card-gap), not on the grid's row-gap: with row-gap 0 the
      // quantization step stays GRID_ROW_PX, so every vertical gap
      // lands within 8px of the intended gap. offsetHeight excludes
      // margin, so fold the gap into the span. Read the gap off the
      // GRID's computed style — one lookup for the whole batch.
      const cardGap = parseFloat(styles.getPropertyValue("--card-gap")) || 0;
      // READ phase: one forced layout covers every measurement.
      const heights = cells.map((cell) => {
        const child = cell.firstElementChild as HTMLElement | null;
        return child ? child.offsetHeight : -1;
      });
      // WRITE phase: spans applied together; layout runs once after.
      cells.forEach((cell, i) => {
        const h = heights[i];
        if (h < 0) return;
        const rows = Math.max(
          1,
          Math.ceil((h + cardGap + rowGap) / (GRID_ROW_PX + rowGap)),
        );
        cell.style.gridRowEnd = `span ${rows}`;
      });
    }
    function relayoutAll() {
      if (!grid) return;
      relayoutMany([...grid.querySelectorAll<HTMLElement>(":scope > .card-grid-cell")]);
    }

    // Observer-driven relayouts coalesce here: cells accumulate for the
    // current frame and flush as ONE read/write batch.
    const pending = new Set<HTMLElement>();
    let flushScheduled = false;
    function scheduleRelayout(cell: HTMLElement) {
      pending.add(cell);
      if (flushScheduled) return;
      flushScheduled = true;
      requestAnimationFrame(() => {
        flushScheduled = false;
        const batch = [...pending];
        pending.clear();
        relayoutMany(batch);
      });
    }

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const target = e.target as HTMLElement;
        const cell = target.closest(".card-grid-cell");
        if (cell instanceof HTMLElement) scheduleRelayout(cell);
      }
    });

    const cardMOs = new WeakMap<Element, MutationObserver>();

    function attachCardObservers(cell: HTMLElement) {
      const card = cell.firstElementChild;
      if (!(card instanceof HTMLElement)) return;
      ro.observe(card);
      if (cardMOs.has(card)) return;
      const cmo = new MutationObserver(() => scheduleRelayout(cell));
      cmo.observe(card, {
        childList: true, subtree: true, characterData: true, attributes: true,
      });
      cardMOs.set(card, cmo);
    }

    function reattachAndRelayout() {
      if (!grid) return;
      ro.disconnect();
      const cells = grid.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
      cells.forEach(attachCardObservers);
      // Synchronous on purpose: new cells must get a span before their
      // first paint or the pile visibly jumps into place.
      relayoutAll();
    }
    reattachAndRelayout();

    const mo = new MutationObserver(reattachAndRelayout);
    mo.observe(grid, { childList: true });

    // Triggered on user input inside any editor child — harmless in
    // the viewer (no editable surfaces) and load-bearing in the app
    // (catches ProseMirror DOM changes RO misses).
    function onInput(e: Event) {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const cell = t.closest(".card-grid-cell");
      if (cell instanceof HTMLElement) scheduleRelayout(cell);
    }
    grid.addEventListener("input", onInput, true);
    grid.addEventListener("keyup", onInput, true);

    window.addEventListener("resize", relayoutAll);
    return () => {
      ro.disconnect();
      mo.disconnect();
      pending.clear();
      grid.removeEventListener("input", onInput, true);
      grid.removeEventListener("keyup", onInput, true);
      window.removeEventListener("resize", relayoutAll);
    };
  }, [grid]);
}
