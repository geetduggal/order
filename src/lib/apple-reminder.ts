// Bridge to the system Reminders (iOS / macOS) EventKit commands in
// src-tauri/src/applereminder.rs. An event's note carries `reminder: true` +
// `reminderId`; toggling drives save/delete here so the item shows (and
// notifies) in the user's default Reminders list.

import { invoke } from "@tauri-apps/api/core";

export type ReminderAccess =
  | "notDetermined" | "restricted" | "denied"
  | "authorized" | "writeOnly" | "unsupported" | "unknown";

export function accessStatus(): Promise<ReminderAccess> {
  return invoke<ReminderAccess>("reminder_access_status").catch(() => "unsupported" as const);
}

/** Prompt for Reminders authorization (once). Returns granted. */
export function requestAccess(): Promise<boolean> {
  return invoke<boolean>("reminder_request_access");
}

export interface SaveReminder {
  title: string;
  date: string;          // YYYY-MM-DD
  time?: string;         // HH:MM (omit for all-day → 9am)
  notes?: string;
  /** Existing calendarItemIdentifier to update in place. */
  id?: string;
  /** High-priority / time-sensitive urgent reminder. */
  urgent?: boolean;
}

/** Create or update a system reminder; resolves with its calendarItemIdentifier. */
export function saveReminder(input: SaveReminder): Promise<string> {
  return invoke<string>("reminder_save", { input });
}

/** Remove a system reminder by its calendarItemIdentifier. */
export function deleteReminder(id: string): Promise<string> {
  return invoke<string>("reminder_delete", { id });
}
