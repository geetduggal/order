// Pointer-based drag-reorder for a set of tiles/rows marked with
// [data-tile-ref] inside a container (gridRef). HTML5 drag-drop is unusable
// in Tauri's webview, so we track pointer events: pointerdown seeds a drag,
// movement past a threshold starts it, pointerup drops the item at the
// nearest slot and reports the whole new ref order. The click that follows
// a drag is swallowed so it doesn't also activate the tile.
//
// While dragging we also paint a drop indicator — a bar shown in the gap
// where the item will land (vertical between side-by-side tiles, horizontal
// between stacked rows) so the drop target is always visible.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Options {
  /** Vertical list (compare Y) vs horizontal/grid (compare X). */
  vertical?: boolean;
  /** CSS selector for interactive controls inside a tile that should NOT
   *  start a drag (remove ×, reorder arrows, inputs). */
  exclude?: string;
  /** When set, a drag only starts if pointerdown landed inside this
   *  selector (a drag handle). Lets the rest of the row stay tappable /
   *  scrollable on touch — touch the handle to drag, anywhere else to
   *  scroll. Takes precedence over `exclude`. */
  handle?: string;
}

interface Cell {
  cx: number;
  cy: number;
  r: DOMRect;
}

export function useTileDrag(
  refs: string[],
  onReorder?: (order: string[]) => void,
  opts: Options = {},
) {
  const { exclude = "", handle = "" } = opts;
  // Container (a div or ul) — loose element type so either attaches.
  const gridRef = useRef<any>(null);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const drag = useRef<{ ref: string; x: number; y: number; lastX: number; lastY: number; started: boolean; el?: HTMLElement; pointerId: number; captureEl: HTMLElement } | null>(null);
  const indicator = useRef<HTMLDivElement | null>(null);
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!onReorder) return;
    const reorder = onReorder;

    // The non-dragged tiles with their live geometry, in DOM order.
    function cellsNow(): Cell[] {
      const d = drag.current;
      if (!gridRef.current || !d) return [];
      return (Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[])
        .filter((el) => el.dataset.tileRef && el.dataset.tileRef !== d.ref)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r };
        });
    }

    // True when any two cells share a row (a grid), false for a single column.
    function isMultiCol(cells: Cell[]): boolean {
      const minH = Math.min(...cells.map((c) => c.r.height), 24);
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          if (Math.abs(cells[i].cy - cells[j].cy) < minH * 0.5) return true;
        }
      }
      return false;
    }

    // Insertion index = how many cells the cursor is "past" in reading order
    // (top→bottom, then left→right within a row).
    function insertIndex(px: number, py: number, cells: Cell[], multiCol: boolean): number {
      let at = 0;
      for (const c of cells) {
        const tol = c.r.height * 0.5;
        let past: boolean;
        if (py > c.cy + tol) past = true;
        else if (py < c.cy - tol) past = false;
        else past = multiCol ? px > c.cx : py > c.cy;
        if (past) at++;
      }
      return at;
    }

    function ensureIndicator(): HTMLDivElement {
      if (!indicator.current) {
        const el = document.createElement("div");
        el.className = "tile-drop-indicator";
        document.body.appendChild(el);
        indicator.current = el;
      }
      return indicator.current;
    }
    function removeIndicator() {
      indicator.current?.remove();
      indicator.current = null;
    }

    // Paint the drop bar at insertion index `at`. `before`/`after` are the
    // tiles flanking the slot in reading order. A grid gets a vertical bar
    // in the column gutter; a single column gets a horizontal bar between
    // rows. At a row boundary the same index can mean "end of this row" or
    // "start of the next" — disambiguate by the cursor's row so the bar
    // lands next to where the finger/cursor actually is.
    function paintIndicator(px: number, py: number, at: number, cells: Cell[], multiCol: boolean) {
      if (cells.length === 0) { removeIndicator(); return; }
      const before = cells[at - 1]?.r;
      const after = cells[at]?.r;
      const el = ensureIndicator();
      if (multiCol) {
        const sameRow = before && after && Math.abs(before.top - after.top) < 4;
        let x: number, top: number, h: number;
        if (sameRow) {
          // Centered in the gutter between two tiles on the same row.
          x = (before!.right + after!.left) / 2; top = before!.top; h = before!.height;
        } else {
          // Pick the flanking tile in the cursor's row, draw on its near side.
          const dB = before ? Math.abs(py - (before.top + before.height / 2)) : Infinity;
          const dA = after ? Math.abs(py - (after.top + after.height / 2)) : Infinity;
          if (after && dA <= dB) { x = after.left - 3; top = after.top; h = after.height; }
          else if (before) { x = before.right + 3; top = before.top; h = before.height; }
          else if (after) { x = after.left - 3; top = after.top; h = after.height; }
          else { removeIndicator(); return; }
        }
        Object.assign(el.style, { left: `${x - 1.5}px`, top: `${top}px`, width: "3px", height: `${h}px` });
      } else if (after) {
        // Horizontal bar above the next stacked row.
        const y = before ? (before.bottom + after.top) / 2 : after.top - 2;
        Object.assign(el.style, { left: `${after.left}px`, top: `${y - 1.5}px`, width: `${after.width}px`, height: "3px" });
      } else if (before) {
        // Past the end: horizontal bar below the last row.
        Object.assign(el.style, { left: `${before.left}px`, top: `${before.bottom + 1 - 1.5}px`, width: `${before.width}px`, height: "3px" });
      }
    }

    function move(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.started) {
        // 12 px (Manhattan) start threshold: a finger tap routinely
        // wiggles 6–10 px before lift on iOS, and the previous 6 px
        // bar was promoting those taps to drags — the no-op drag's
        // click-swallow then ate the × tap on a filter pill, so the
        // first close looked like it did nothing.
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 12) return;
        d.started = true;
        setDragRef(d.ref);
        d.el = gridRef.current
          ? (Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[])
              .find((x) => x.dataset.tileRef === d.ref)
          : undefined;
        // Capture the pointer ONLY now that a real drag has begun, so
        // move/up keep firing through the drag (essential on touch). Doing
        // this on pointerdown instead would swallow the click on a plain
        // tap, breaking tap-to-drill-in.
        try { d.captureEl.setPointerCapture(d.pointerId); } catch { /* unsupported */ }
      }
      // Track the live position — pointerup on touch can report the
      // original touch point (or fire pointercancel), so we drop using the
      // last move position, not the up event's coordinates.
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      // Make the drag obvious: the grabbed item lifts and follows the cursor.
      if (d.el) {
        d.el.style.transform = `translate(${e.clientX - d.x}px, ${e.clientY - d.y}px) scale(1.04)`;
        d.el.style.zIndex = "500";
      }
      // Show where it will land.
      const cells = cellsNow();
      const multiCol = isMultiCol(cells);
      paintIndicator(e.clientX, e.clientY, insertIndex(e.clientX, e.clientY, cells, multiCol), cells, multiCol);
    }
    function resetEl(el?: HTMLElement) {
      if (!el) return;
      el.style.transform = "";
      el.style.zIndex = "";
    }
    function up() {
      const d = drag.current;
      drag.current = null;
      setDragRef(null);
      resetEl(d?.el);
      removeIndicator();
      if (!d?.started || !gridRef.current) return;
      const px = d.lastX;
      const py = d.lastY;
      // Rebuild cells with the dragged ref still excluded (drag.current is
      // now null, so reuse the same filter manually).
      const cells = (Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[])
        .filter((el) => el.dataset.tileRef && el.dataset.tileRef !== d.ref)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, r };
        });
      if (cells.length === 0) return;
      const multiCol = isMultiCol(cells);
      let insertAt = insertIndex(px, py, cells, multiCol);
      const order = refsRef.current.filter((r) => r !== d.ref);
      insertAt = Math.max(0, Math.min(insertAt, order.length));
      order.splice(insertAt, 0, d.ref);
      if (order.join("") === refsRef.current.join("")) return;

      // Only swallow the post-drag click when a real reorder happened.
      // A finger-jitter drag that lifts back over its origin would
      // otherwise eat a legitimate tap on a child control (filter
      // pill ×, area folder picker, etc.) — that was the "first × tap
      // does nothing, second works" symptom on iOS.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 50);
      reorder(order);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      removeIndicator();
    };
  }, [onReorder]);

  function onTilePointerDown(e: ReactPointerEvent, ref: string) {
    if (!onReorder || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (handle) { if (!target.closest(handle)) return; }
    else if (exclude && target.closest(exclude)) return;
    // Seed a candidate drag. Pointer capture is deferred until movement
    // crosses the threshold (see move()), so a tap remains a clean click.
    drag.current = {
      ref, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY,
      started: false, pointerId: e.pointerId, captureEl: e.currentTarget as HTMLElement,
    };
  }

  return { gridRef, dragRef, onTilePointerDown };
}
