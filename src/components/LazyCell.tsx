import { useEffect, useRef, useState, type ReactNode } from "react";

// Bare Stream renders one cell per vault note (hundreds, sometimes
// thousands once a viewer drops every filter). Mounting a Milkdown
// Crepe instance for each one synchronously stalls the main thread —
// noticeable on desktop, painful on iOS, fatal on the published page
// where there is no pagination at all.
//
// LazyCell wraps a single grid cell with an IntersectionObserver: it
// renders a sized placeholder while offscreen and swaps in the real
// Card once the cell comes within scroll reach (1.5 viewports above,
// 3 below — generous enough that fast scrolling rarely hits a blank
// frame). Once mounted, the cell stays mounted so ProseMirror state
// and in-progress edits don't get torn down on scroll-out.
//
// The placeholder uses a `min-height` so the masonry layout
// (grid-auto-rows + computed `grid-row-end: span N`) reserves a
// believable slot for the cell; once the real Card paints, the
// per-cell ResizeObserver in grid-layout.ts re-snaps the row span
// and the layout settles. `fallbackHeight` lets callers tune the
// reservation — defaults to 320px which matches a typical short
// note Card on a desktop column.

export function LazyCell({
  children,
  className,
  dataPath,
  fallbackHeight,
  forceMount,
  rootMargin = "1500px 0px 3000px 0px",
}: {
  children: () => ReactNode;
  className?: string;
  dataPath?: string;
  fallbackHeight?: number;
  /** Skip the gate and mount immediately (e.g. for a focused / pinned card). */
  forceMount?: boolean;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(!!forceMount);

  useEffect(() => {
    if (forceMount) setMounted(true);
  }, [forceMount]);

  useEffect(() => {
    if (mounted || !ref.current) return;
    const el = ref.current;
    // SSR / jsdom safety: IntersectionObserver isn't always defined.
    if (typeof IntersectionObserver === "undefined") {
      setMounted(true);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setMounted(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mounted, rootMargin]);

  const h = fallbackHeight ?? 320;
  return (
    <div
      ref={ref}
      className={className}
      data-path={dataPath}
      style={!mounted ? { minHeight: h } : undefined}
    >
      {mounted ? children() : null}
    </div>
  );
}
