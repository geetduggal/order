import { useEffect } from "react";
import { CardGrid } from "./components/CardGrid";

const ZOOM_KEY = "order.zoom";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.4;

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

async function applyZoom(z: number): Promise<void> {
  // Native webview zoom — what Cmd+/Cmd- does in a real browser. Uses
  // the WKWebView/WebView2 native zoom path, which keeps caret hit-test
  // geometry consistent (unlike CSS `zoom` / `transform`).
  // Requires capability: core:webview:allow-set-webview-zoom.
  if (document.documentElement.style.zoom) {
    document.documentElement.style.zoom = "";
  }
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    await mod.getCurrentWebviewWindow().setZoom(z);
  } catch (err) {
    console.warn("webview setZoom failed; falling back to CSS zoom:", err);
    document.documentElement.style.zoom = String(z);
  }
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* non-fatal */ }
}

function useFontZoom(): void {
  useEffect(() => {
    void applyZoom(readZoom());

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        void applyZoom(clamp(readZoom() + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        void applyZoom(clamp(readZoom() - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX));
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        void applyZoom(1);
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
