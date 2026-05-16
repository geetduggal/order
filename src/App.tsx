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

async function applyZoom(z: number): Promise<void> {
  // Tauri's native webview zoom — what Cmd+/Cmd- does in a real browser.
  // CSS `zoom` was the prior approach; it caused caret misalignment in
  // contenteditable surfaces (Milkdown / ProseMirror) because WebKit
  // doesn't keep caret geometry in sync with `zoom`-scaled layout.
  // Clear any leftover CSS zoom from earlier sessions.
  if (document.documentElement.style.zoom) {
    document.documentElement.style.zoom = "";
  }
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    await mod.getCurrentWebviewWindow().setZoom(z);
  } catch (err) {
    // Non-Tauri environment (e.g. plain browser test) — fall back to
    // CSS zoom so the keymap still works, accepting the cursor quirk.
    console.warn("webview setZoom unavailable, falling back:", err);
    document.documentElement.style.zoom = String(z);
  }
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* non-fatal */ }
}

function useFontZoom(): void {
  useEffect(() => {
    void applyZoom(readZoom());

    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      // Cmd+= / Cmd++ → zoom in. Browsers and OS surfaces both treat the
      // `=` key (unshifted) as the zoom-in trigger; `+` is the shifted form.
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
