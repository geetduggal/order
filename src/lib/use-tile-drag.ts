// Pointer-based drag-reorder for a set of tiles/rows marked with
// [data-tile-ref] inside a container (gridRef). HTML5 drag-drop is unusable
// in Tauri's webview, so we track pointer events: pointerdown seeds a drag,
// movement past a threshold starts it, pointerup drops the item at the
// nearest slot and reports the whole new ref order. The click that follows
// a drag is swallowed so it doesn't also activate the tile.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Options {
  /** Vertical list (compare Y) vs horizontal/grid (compare X). */
  vertical?: boolean;
  /** CSS selector for interactive controls inside a tile that should NOT
   *  start a drag (remove ×, reorder arrows, inputs). */
  exclude?: string;
}

export function useTileDrag(
  refs: string[],
  onReorder?: (order: string[]) => void,
  opts: Options = {},
) {
  const { exclude = "" } = opts;
  // Container (a div or ul) — loose element type so either attaches.
  const gridRef = useRef<any>(null);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const drag = useRef<{ ref: string; x: number; y: number; lastX: number; lastY: number; started: boolean; el?: HTMLElement } | null>(null);
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!onReorder) return;
    const reorder = onReorder;
    function move(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      if (!d.started) {
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
        d.started = true;
        setDragRef(d.ref);
        d.el = gridRef.current
          ? (Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[])
              .find((x) => x.dataset.tileRef === d.ref)
          : undefined;
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
      if (!d?.started || !gridRef.current) return;
      const px = d.lastX;
      const py = d.lastY;
      // Swallow the click that fires right after the drag.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 50);

      const cells = (Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[])
        .filter((el) => el.dataset.tileRef && el.dataset.tileRef !== d.ref)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, h: r.height };
        });
      if (cells.length === 0) return;
      // Detect a multi-column layout (any two cells sharing a row). In a
      // single column we decide before/after by Y; in a grid row by X.
      const minH = Math.min(...cells.map((c) => c.h), 24);
      let multiCol = false;
      for (let i = 0; i < cells.length && !multiCol; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          if (Math.abs(cells[i].cy - cells[j].cy) < minH * 0.5) { multiCol = true; break; }
        }
      }
      // Insertion index = how many cells the cursor is "past" in reading
      // order (top→bottom, then left→right within a row).
      let insertAt = 0;
      for (const c of cells) {
        const tol = c.h * 0.5;
        let past: boolean;
        if (py > c.cy + tol) past = true;
        else if (py < c.cy - tol) past = false;
        else past = multiCol ? px > c.cx : py > c.cy;
        if (past) insertAt++;
      }
      const order = refsRef.current.filter((r) => r !== d.ref);
      insertAt = Math.max(0, Math.min(insertAt, order.length));
      order.splice(insertAt, 0, d.ref);
      if (order.join(" ") !== refsRef.current.join(" ")) reorder(order);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [onReorder]);

  function onTilePointerDown(e: ReactPointerEvent, ref: string) {
    if (!onReorder || e.button !== 0) return;
    if (exclude && (e.target as HTMLElement).closest(exclude)) return;
    drag.current = { ref, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false };
  }

  return { gridRef, dragRef, onTilePointerDown };
}
