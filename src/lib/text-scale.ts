// Single source of truth for the user-adjustable note text size.
//
// Scales the prose via the --text-scale CSS variable (font-size) — NOT
// CSS `zoom`/`transform` or native webview zoom. Those throw off
// ProseMirror's click-to-caret hit-testing (the caret lands away from the
// pointer) and the native path isn't supported on iOS (it fell back to
// CSS `zoom`, breaking the caret there). font-size simply reflows, so the
// caret stays aligned on every platform.
//
// The rail +/- buttons (CardGrid) and the Cmd± shortcuts (App) both go
// through here and stay in sync via a window event.

import { useEffect, useState } from "react";

const KEY = "order.zoom";
export const TEXT_SCALE_MIN = 0.6;
export const TEXT_SCALE_MAX = 2.4;
export const TEXT_SCALE_STEP = 0.1;
const EVENT = "order:text-scale";

function clamp(n: number): number {
  // Round to one decimal so repeated steps don't drift (0.1 + 0.2 …).
  return Math.max(TEXT_SCALE_MIN, Math.min(TEXT_SCALE_MAX, Math.round(n * 10) / 10));
}

export function getTextScale(): number {
  try {
    const raw = parseFloat(localStorage.getItem(KEY) ?? "");
    return Number.isFinite(raw) ? clamp(raw) : 1;
  } catch {
    return 1;
  }
}

/** Apply a scale to the document, persist it, and notify listeners.
 *  Returns the clamped value actually applied. */
export function applyTextScale(z: number): number {
  const v = clamp(z);
  const el = document.documentElement;
  el.style.zoom = ""; // clear any legacy page-zoom from older builds
  el.style.setProperty("--text-scale", String(v));
  try { localStorage.setItem(KEY, String(v)); } catch { /* non-fatal */ }
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: v }));
  return v;
}

/** Step the current scale by `delta` (e.g. +/- TEXT_SCALE_STEP). */
export function stepTextScale(delta: number): number {
  return applyTextScale(getTextScale() + delta);
}

/** React hook: the current scale, kept in sync across the keyboard
 *  shortcuts and the rail buttons via the window event. */
export function useTextScale(): number {
  const [scale, setScale] = useState<number>(getTextScale);
  useEffect(() => {
    const onChange = (e: Event) => setScale((e as CustomEvent<number>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return scale;
}
