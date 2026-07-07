// Masonry-style row-span layout for the .card-grid: each cell sets
// `gridRowEnd: span N` so the grid (with `grid-auto-rows: 8px`) sizes
// each cell to the natural height of its `.order-card` child.
//
// Shared between Order's main grid and the read-only viewer — both
// produce identical card chrome and need identical row sizing.

import { useEffect } from "react";

const GRID_ROW_PX = 8;

export function useGridLayout(grid: HTMLDivElement | null) {
  useEffect(() => {
    if (!grid) return;

    function relayoutCell(cell: HTMLElement) {
      const styles = getComputedStyle(grid as HTMLElement);
      const rowGap = parseFloat(styles.rowGap || styles.gap || "0");
      const child = cell.firstElementChild as HTMLElement | null;
      if (!child) return;
      // The visual gap between cards lives on the card's margin-bottom
      // (--card-gap), not on the grid's row-gap: with row-gap 0 the
      // quantization step stays GRID_ROW_PX, so every vertical gap lands
      // within 8px of the intended gap instead of wobbling by gap+8.
      // offsetHeight excludes margin, so fold it into the span here.
      const marginBottom = parseFloat(getComputedStyle(child).marginBottom || "0");
      const rows = Math.max(
        1,
        Math.ceil((child.offsetHeight + marginBottom + rowGap) / (GRID_ROW_PX + rowGap)),
      );
      cell.style.gridRowEnd = `span ${rows}`;
    }
    function relayoutAll() {
      const cells = grid?.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
      cells?.forEach((c) => relayoutCell(c));
    }

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const target = e.target as HTMLElement;
        const cell = target.closest(".card-grid-cell");
        if (cell instanceof HTMLElement) relayoutCell(cell);
      }
    });

    const cardMOs = new WeakMap<Element, MutationObserver>();

    function attachCardObservers(cell: HTMLElement) {
      const card = cell.firstElementChild;
      if (!(card instanceof HTMLElement)) return;
      ro.observe(card);
      if (cardMOs.has(card)) return;
      const cmo = new MutationObserver(() => relayoutCell(cell));
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
      if (cell instanceof HTMLElement) {
        requestAnimationFrame(() => relayoutCell(cell));
      }
    }
    grid.addEventListener("input", onInput, true);
    grid.addEventListener("keyup", onInput, true);

    window.addEventListener("resize", relayoutAll);
    return () => {
      ro.disconnect();
      mo.disconnect();
      grid.removeEventListener("input", onInput, true);
      grid.removeEventListener("keyup", onInput, true);
      window.removeEventListener("resize", relayoutAll);
    };
  }, [grid]);
}
