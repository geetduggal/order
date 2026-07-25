// Weekly Hub — the Week view's companion "one stop shop" surface: a configured
// Notable Folder's Main Document stacked above the week grid, both editable /
// visible at once.
//
// This module owns ONLY the small per-machine preferences (which folder, the
// split ratio, the resolution mode). It is deliberately NOT a store for the hub
// document itself — that lives in the Notable Folder's Main Doc, with spacetime
// as the source of truth. The hub just points at it.

const FOLDER_KEY = "order.week_hub.folder";
const MODE_KEY = "order.week_hub.mode";
const FRACTION_KEY = "order.week_hub.fraction";

/** How the hub decides which folder to show.
 *  - "fixed"  → always `folder` (implemented).
 *  - "weekly" → resolve to a folder for the current week (SEAM — see
 *    resolveWeekHubFolder; falls back to the fixed folder until wired). */
export type WeekHubMode = "fixed" | "weekly";

export function getWeekHubFolder(): string {
  try { return localStorage.getItem(FOLDER_KEY) ?? ""; } catch { return ""; }
}
export function setWeekHubFolder(ref: string): void {
  try {
    if (ref) localStorage.setItem(FOLDER_KEY, ref);
    else localStorage.removeItem(FOLDER_KEY);
  } catch { /* non-fatal */ }
}

export function getWeekHubMode(): WeekHubMode {
  try { return localStorage.getItem(MODE_KEY) === "weekly" ? "weekly" : "fixed"; } catch { return "fixed"; }
}
export function setWeekHubMode(mode: WeekHubMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* non-fatal */ }
}

/** Persisted document-zone height as a fraction of the hub's height, or null
 *  when the user hasn't dragged the divider yet (caller picks the default). */
export function getWeekHubFraction(): number | null {
  try {
    const raw = localStorage.getItem(FRACTION_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}
export function setWeekHubFraction(fraction: number): void {
  try { localStorage.setItem(FRACTION_KEY, String(fraction)); } catch { /* non-fatal */ }
}

/** Resolve the Notable Folder ref the Week hub should show.
 *
 *  `weekStartIso` (YYYY-MM-DD of the visible week's Sunday) is accepted now so
 *  the per-week convention can slot in without changing callers. Today only the
 *  "fixed" mode is implemented; "weekly" is a documented seam that currently
 *  defers to the fixed folder. A future per-week resolver would map
 *  `weekStartIso` → a dated/rolling folder here (e.g. a "2026-W30" hub note),
 *  and everything downstream (main-doc lookup, editor, save) is unchanged. */
export function resolveWeekHubFolder(weekStartIso?: string): string | null {
  const folder = getWeekHubFolder();
  const mode = getWeekHubMode();
  if (mode === "weekly") {
    // SEAM: return a per-week folder derived from `weekStartIso` here.
    void weekStartIso;
    return folder || null; // until wired, behave like "fixed"
  }
  return folder || null;
}
