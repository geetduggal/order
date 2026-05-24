// Light/dark theme. Sets `data-theme` on <html>; the CSS variables flip
// under `[data-theme="dark"]`. Persisted in localStorage and defaults to
// the OS preference. The rail toggle and any consumer stay in sync via a
// window event (same pattern as text-scale).

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "order.theme";
const EVENT = "order:theme";

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
    if (v === "light" || v === "dark") return v;
  } catch { /* ignore */ }
  return systemTheme();
}

/** Apply a theme to <html>, persist it, and notify listeners. */
export function applyTheme(t: Theme): Theme {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* non-fatal */ }
  window.dispatchEvent(new CustomEvent<Theme>(EVENT, { detail: t }));
  return t;
}

export function toggleTheme(): Theme {
  return applyTheme(getTheme() === "dark" ? "light" : "dark");
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
