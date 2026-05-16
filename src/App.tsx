import { useEffect } from "react";
import { CardGrid } from "./components/CardGrid";

const ZOOM_KEY = "order.zoom";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.4;
const ZOOM_VAR = "--editor-zoom";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function readZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (!raw) return 1;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? clamp(n, ZOOM_MIN, ZOOM_MAX) : 1;
  } catch {
    return 1;
  }
}

function applyZoom(z: number): void {
  // We scale editor body text via a CSS variable instead of CSS `zoom`
  // or webview-native zoom — both of those misalign the caret in
  // Milkdown / ProseMirror contenteditables under WebKit. Editor
  // headings use `em` so they scale proportionally; card chrome,
  // sidebar, calendar, etc. stay at their natural size.
  document.documentElement.style.setProperty(ZOOM_VAR, String(z));
  // Belt-and-suspenders: clear any leftover CSS zoom from the prior
  // approach so the cursor isn't dragged off by a stale value.
  if (document.documentElement.style.zoom) {
    document.documentElement.style.zoom = "";
  }
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* non-fatal */ }
}

function useFontZoom(): void {
  useEffect(() => {
    applyZoom(readZoom());

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        applyZoom(clamp(readZoom() + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        applyZoom(clamp(readZoom() - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        applyZoom(1);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  useFontZoom();
  return <CardGrid />;
}
