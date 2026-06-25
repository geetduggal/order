// Light/dark theme. Sets `data-theme` on <html>; the CSS variables flip
// under `[data-theme="dark"]`. Persisted in localStorage and defaults to
// the OS preference. The rail toggle and any consumer stay in sync via a
// window event (same pattern as text-scale).

import { useEffect, useState } from "react";

// Themes cycled by the rail button, in this order:
//   auto (follow OS) → light → dark → black (OLED) → wordperfect (DOS blue) →
//   terminal (WordPerfect chrome on pure black) →
//   typewriter (Terminal chrome on pure white) →
//   america (red/white/blue) → christmas (red/green) → lcars → auto.
// "auto" is a PREFERENCE: it's persisted as "auto" but resolves to the OS
// light/dark on apply, and `initSystemThemeWatch` re-applies it live when the
// OS scheme flips. All other themes are explicit overrides.
export type Theme = "auto" | "light" | "dark" | "black" | "wordperfect" | "terminal" | "typewriter" | "america" | "christmas" | "lcars";
const KEY = "order.theme";
const EVENT = "order:theme";

/** Cycle order for the toggle. */
export const THEME_CYCLE: Theme[] = ["auto", "light", "dark", "black", "wordperfect", "terminal", "typewriter", "america", "christmas", "lcars"];

/** Human label for tooltips. */
export function themeLabel(t: Theme): string {
  switch (t) {
    case "auto": return "Auto";
    case "wordperfect": return "WordPerfect";
    case "terminal": return "Terminal";
    case "typewriter": return "Typewriter";
    case "america": return "America";
    case "christmas": return "Christmas";
    case "lcars": return "LCARS";
    default: return t[0].toUpperCase() + t.slice(1);
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Resolve a preference to a concrete CSS theme: "auto" → the OS light/dark
 *  scheme; every other theme resolves to itself. The result is what goes on
 *  `data-theme` (CSS has no `[data-theme="auto"]`). */
export function resolveTheme(pref: Theme): Theme {
  return pref === "auto" ? systemTheme() : pref;
}

/** The stored PREFERENCE (may be "auto"). Defaults to "auto" so a fresh
 *  install follows the OS. */
export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (THEME_CYCLE as string[]).includes(v)) return v as Theme;
  } catch { /* ignore */ }
  return "auto";
}

/** Follow OS light/dark changes while the preference is "auto". Call once at
 *  startup (app + published viewer). Idempotent. */
let systemWatchStarted = false;
export function initSystemThemeWatch(): void {
  if (systemWatchStarted) return;
  systemWatchStarted = true;
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      if (getTheme() === "auto") applyTheme("auto"); // re-resolve + notify
    });
  } catch { /* no matchMedia (older webview) — stays on last resolved theme */ }
}

/** The mode the toggle will switch to next (light → dark → black → …). */
export function nextTheme(t: Theme = getTheme()): Theme {
  const i = THEME_CYCLE.indexOf(t);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
}

/** Apply a theme preference: write the RESOLVED theme to <html> (so "auto"
 *  becomes the OS light/dark), persist the PREFERENCE, and notify listeners
 *  with the preference (so the UI shows "Auto"). */
export function applyTheme(t: Theme): Theme {
  document.documentElement.dataset.theme = resolveTheme(t);
  try { localStorage.setItem(KEY, t); } catch { /* non-fatal */ }
  window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: t }));
  return t;
}

export function toggleTheme(): Theme {
  return applyTheme(nextTheme());
}

/** React hook: current theme, kept in sync across the toggle and any
 *  other consumer via the window event. */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(getTheme);
  useEffect(() => {
    const onChange = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return theme;
}
