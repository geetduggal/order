// Weekly Hub — the Week view's two-zone "one stop shop": a configured Notable
// Folder's Main Document (the real, editable card) stacked above the week grid,
// each zone scrolling independently, with a draggable divider between them.
//
// Presentational + divider logic only. The document zone is whatever `doc` the
// caller passes (the wired main-doc <Card>, or a compact "pick a folder"
// prompt). The grid zone holds <CalendarView>, which self-measures its bounded
// height from its own top edge — so stacking a doc zone above it Just Works and
// needs no fork; we only nudge a `resize` when the split changes so it re-fits.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getWeekHubFraction, setWeekHubFraction } from "../lib/week-hub";

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
// Must match CalendarView's own dock allowance so both agree on where the
// usable region ends (54px dock + 14px inset + safe area).
// Keep in step with CalendarView's DOCK — the grid runs nearly to the bottom
// edge; the translucent dock floats over its lowest strip.
const DOCK = 34;
const MIN_DOC = 96;

interface Props {
  /** The document zone content: the main-doc card, or a compact picker prompt. */
  doc: React.ReactNode;
  /** The week grid (a <CalendarView>), rendered untouched. */
  grid: React.ReactNode;
  /** True when a folder is configured AND its main doc resolved — enables the
   *  resizable split. When false, the doc zone is a compact, non-resizable
   *  prompt and the grid takes the rest. */
  docConfigured: boolean;
  /** Phone layout: the grid is the primary glance, so the doc gets a smaller
   *  default share and a larger minimum grid. */
  mobile: boolean;
}

export function WeekHub({ doc, grid, docConfigured, mobile }: Props) {
  const hubRef = useRef<HTMLDivElement>(null);
  const minGrid = mobile ? 300 : 340;
  const defaultFraction = mobile ? 0.25 : 0.34;
  const [docPx, setDocPx] = useState(0);
  const draggingRef = useRef(false);

  // The usable region = from the hub's top edge to the viewport bottom, less the
  // hovering dock. Stable regardless of the split (the grid shrinks as the doc
  // grows), so the fraction math never feeds back on itself.
  const region = useCallback(() => {
    const el = hubRef.current;
    if (!el) return 0;
    return Math.max(0, window.innerHeight - el.getBoundingClientRect().top - DOCK);
  }, []);

  const applyFraction = useCallback((fraction: number) => {
    const r = region();
    if (r <= 0) return;
    setDocPx(clamp(Math.round(fraction * r), MIN_DOC, r - minGrid));
  }, [region, minGrid]);

  // Initial + on-resize: derive the doc height from the persisted fraction.
  // Skipped while dragging so the `resize` we dispatch for CalendarView (to
  // re-fit the grid) doesn't fight the live drag by snapping back to the
  // stored fraction.
  useLayoutEffect(() => {
    if (!docConfigured) return;
    const reapply = () => { if (!draggingRef.current) applyFraction(getWeekHubFraction() ?? defaultFraction); };
    reapply();
    window.addEventListener("resize", reapply);
    return () => window.removeEventListener("resize", reapply);
  }, [docConfigured, applyFraction, defaultFraction]);

  // Whenever the split changes (initial layout, drag, or config), nudge a resize
  // so CalendarView (which measures its bounded height off its own top edge)
  // re-fits to the new grid zone. rAF-coalesced; the reapply listener above is
  // guarded against the drag so this never snaps the divider back.
  useEffect(() => {
    if (!docConfigured) return;
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [docPx, docConfigured]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!docConfigured) return;
    e.preventDefault();
    draggingRef.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const el = hubRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const r = Math.max(0, window.innerHeight - rect.top - DOCK);
    setDocPx(clamp(Math.round(e.clientY - rect.top), MIN_DOC, r - minGrid));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    const r = region();
    if (r > 0) setWeekHubFraction(clamp(docPx / r, 0.05, 0.95));
  };

  return (
    <div className="week-hub" ref={hubRef}>
      <div
        className={"week-hub-doc" + (docConfigured ? "" : " is-prompt")}
        style={docConfigured ? ({ height: `${docPx}px`, "--wh-doc-h": `${docPx}px` } as React.CSSProperties) : undefined}
      >
        {doc}
      </div>
      {docConfigured && (
        <div
          className="week-hub-divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize weekly hub"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="week-hub-divider-grip" />
        </div>
      )}
      <div className="week-hub-grid">{grid}</div>
    </div>
  );
}
