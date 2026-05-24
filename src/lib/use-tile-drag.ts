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
  const { vertical = false, exclude = "" } = opts;
  // Container (a div or ul) — loose element type so either attaches.
  const gridRef = useRef<any>(null);
  const [dragRef, setDragRef] = useState<string | null>(null);
  const drag = useRef<{ ref: string; x: number; y: number; started: boolean } | null>(null);
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
      }
    }
    function up(e: PointerEvent) {
      const d = drag.current;
      drag.current = null;
      setDragRef(null);
      if (!d?.started || !gridRef.current) return;
      // Swallow the click that fires right after the drag.
      const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 50);

      const tiles = Array.from(gridRef.current.querySelectorAll("[data-tile-ref]")) as HTMLElement[];
      let best: string | null = null;
      let bestRect: DOMRect | null = null;
      let bestDist = Infinity;
      for (const el of tiles) {
        const ref = el.dataset.tileRef;
        if (!ref || ref === d.ref) continue;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = (e.clientX - cx) ** 2 + (e.clientY - cy) ** 2;
        if (dist < bestDist) { bestDist = dist; best = ref; bestRect = r; }
      }
      if (!best || !bestRect) return;
      const order = refsRef.current.filter((r) => r !== d.ref);
      let at = order.indexOf(best);
      if (at < 0) return;
      const after = vertical
        ? e.clientY > bestRect.top + bestRect.height / 2
        : e.clientX > bestRect.left + bestRect.width / 2;
      if (after) at += 1;
      order.splice(at, 0, d.ref);
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
  }, [onReorder, vertical]);

  function onTilePointerDown(e: ReactPointerEvent, ref: string) {
    if (!onReorder || e.button !== 0) return;
    if (exclude && (e.target as HTMLElement).closest(exclude)) return;
    drag.current = { ref, x: e.clientX, y: e.clientY, started: false };
  }

  return { gridRef, dragRef, onTilePointerDown };
}
