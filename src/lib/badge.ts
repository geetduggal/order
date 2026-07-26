// App-icon badge (iOS / macOS): an optional count on the Order icon showing
// how many events fall on the upcoming (or current) Saturday in the Week Hub
// folder — the pinned "hub" folder for the week (Settings → Weekly hub).
//
// The count is computed in the frontend from the same events the calendar
// shows (spacetime is the source of truth — no parallel store); this module
// just carries the on/off preference and the native bridge.

import { invoke } from "@tauri-apps/api/core";

const ENABLED_KEY = "order.badge.enabled";

export function getBadgeEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === "1"; } catch { return false; }
}
export function setBadgeEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? "1" : "0"); } catch { /* non-fatal */ }
}

/** Prompt for badge/notification authorization (once). Returns granted. */
export async function badgeRequestPermission(): Promise<boolean> {
  try { return await invoke<boolean>("badge_request_permission"); }
  catch { return false; }
}

/** Write the icon badge count (0 clears it). Best-effort; never throws. */
export async function badgeSet(count: number): Promise<void> {
  try { await invoke("badge_set", { count: Math.max(0, Math.round(count)) }); }
  catch { /* non-Apple platform or not authorized — ignore */ }
}

/** ISO date (YYYY-MM-DD) of the upcoming Saturday, or today if today is a
 *  Saturday — the "current or upcoming Saturday" the badge counts. */
export function upcomingSaturdayIso(from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const delta = (6 - d.getDay() + 7) % 7; // 0 when today is Saturday
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
