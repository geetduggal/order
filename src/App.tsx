import { useEffect } from "react";
import { CardGrid } from "./components/CardGrid";

const ZOOM_KEY = "order.zoom";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.0;

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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function applyZoom(z: number): void {
  // CSS `zoom` scales everything proportionally without disturbing layout
  // positioning the way `transform: scale` would. Supported in WebKit
  // (Tauri on macOS) and Chromium (WebView2 on Windows).
  document.documentElement.style.zoom = String(z);
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* non-fatal */ }
}

function useFontZoom(): void {
  useEffect(() => {
    applyZoom(readZoom());

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Cmd+= / Cmd++ → zoom in. Browsers and OS surfaces both treat the
      // `=` key (unshifted) as the zoom-in trigger; `+` is the shifted form.
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
