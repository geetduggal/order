// Light/dark theme. Sets `data-theme` on <html>; the CSS variables flip
// under `[data-theme="dark"]`. Persisted in localStorage and defaults to
// the OS preference. The rail toggle and any consumer stay in sync via a
// window event (same pattern as text-scale).

import { useEffect, useState } from "react";

// Themes cycled by the rail button, in this order:
//   light → dark → black (OLED) → wordperfect (DOS blue) →
//   america (red/white/blue) → christmas (red/green) → light.
export type Theme = "light" | "dark" | "black" | "wordperfect" | "america" | "christmas";
const KEY = "order.theme";
const EVENT = "order:theme";

/** Cycle order for the toggle. */
export const THEME_CYCLE: Theme[] = ["light", "dark", "black", "wordperfect", "america", "christmas"];

/** Human label for tooltips. */
export function themeLabel(t: Theme): string {
  switch (t) {
    case "wordperfect": return "WordPerfect";
    case "america": return "America";
    case "christmas": return "Christmas";
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

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v && (THEME_CYCLE as string[]).includes(v)) return v as Theme;
  } catch { /* ignore */ }
  return systemTheme();
}

/** The mode the toggle will switch to next (light → dark → black → …). */
export function nextTheme(t: Theme = getTheme()): Theme {
  const i = THEME_CYCLE.indexOf(t);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
}

/** Apply a theme to <html>, persist it, and notify listeners. */
export function applyTheme(t: Theme): Theme {
  document.documentElement.dataset.theme = t;
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
