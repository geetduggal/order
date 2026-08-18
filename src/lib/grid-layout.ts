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

    // A fullscreen card is position:fixed — OUT of the grid flow — so its cell
    // span is irrelevant while it's up. Measuring it (offsetHeight) on every
    // keystroke would still force a full-document synchronous layout across
    // every mounted cell behind it: the exact typing lag that scales with
    // folder size. Skip it; the ResizeObserver re-spans once on exit, when the
    // card returns to flow at its new height (the is-fullscreen class is gone
    // by the time that resize fires).
    function cellIsFullscreen(cell: HTMLElement): boolean {
      const card = cell.firstElementChild;
      return card instanceof HTMLElement && card.classList.contains("is-fullscreen");
    }

    // Observer-driven relayouts coalesce here: cells accumulate for the
    // current frame and flush as ONE read/write batch.
    const pending = new Set<HTMLElement>();
    let flushScheduled = false;
    function scheduleRelayout(cell: HTMLElement) {
      if (cellIsFullscreen(cell)) return;
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
      // childList/subtree only: a block added or removed changes the card's
      // height (re-span needed). characterData + attributes fired on EVERY
      // keystroke and selection change — height-irrelevant churn that forced a
      // synchronous layout per character. The ResizeObserver already re-spans
      // on any real height change (line wrap, block growth), so those are
      // covered without the per-character storm.
      cmo.observe(card, { childList: true, subtree: true });
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

    // Input-driven relayout — a throttled fallback for the app only (the viewer
    // has no editable surfaces). The ResizeObserver is the primary height
    // signal, but iOS WKWebView's RO can lag a frame, so a low-frequency input
    // catch-up keeps the card sized as you type. Throttled to ~150ms (leading +
    // trailing) so a fast typing burst can't force a full-grid layout every
    // frame — the core of the big-folder typing lag. `keyup` was a redundant
    // second trigger per keystroke and is gone.
    let inputLast = 0;
    let inputTrailing: ReturnType<typeof setTimeout> | null = null;
    function relayoutFromInput(cell: HTMLElement) {
      inputLast = performance.now();
      scheduleRelayout(cell);
    }
    function onInput(e: Event) {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const cell = t.closest(".card-grid-cell");
      if (!(cell instanceof HTMLElement) || cellIsFullscreen(cell)) return;
      const now = performance.now();
      if (now - inputLast >= 150) {
        relayoutFromInput(cell);
      } else {
        if (inputTrailing) clearTimeout(inputTrailing);
        inputTrailing = setTimeout(() => { inputTrailing = null; relayoutFromInput(cell); }, 150);
      }
    }
    grid.addEventListener("input", onInput, true);

    window.addEventListener("resize", relayoutAll);
    return () => {
      ro.disconnect();
      mo.disconnect();
      pending.clear();
      if (inputTrailing) clearTimeout(inputTrailing);
      grid.removeEventListener("input", onInput, true);
      window.removeEventListener("resize", relayoutAll);
    };
  }, [grid]);
}
