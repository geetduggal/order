// Thin bridge to the Rust Apple EventKit commands (macOS + iOS). Mirrors
// gcal-accounts.ts. EventKit attendees are read-only, so this creates events
// without invites — invitations stay a Google-only feature.
import { invoke } from "@tauri-apps/api/core";
import type { ImportedEvent } from "./gcal-import";

export interface CalendarInfo {
  id: string;
  title: string;
  source: string;
  writable: boolean;
}

export interface SaveEventInput {
  calendarId: string;
  date: string;
  time?: string;
  endTime?: string;
  endDate?: string;
  allDay: boolean;
  title: string;
  description: string;
}

/** notDetermined | authorized | denied | restricted | writeOnly | unsupported */
export type AccessStatus = string;

export const accessStatus = () => invoke<AccessStatus>("applecal_access_status");
export const requestAccess = () => invoke<boolean>("applecal_request_access");
export const listCalendars = () => invoke<CalendarInfo[]>("applecal_list_calendars");
export const listDayEvents = (calendarIds: string[], date: string) =>
  invoke<ImportedEvent[]>("applecal_list_day_events", { calendarIds, date });
export const saveEvent = (input: SaveEventInput) =>
  invoke<string>("applecal_save_event", { input });
export const deleteEvent = (calendarId: string, date: string, time: string | undefined, title: string) =>
  invoke<string>("applecal_delete_event", { calendarId, date, time: time ?? null, title });

// ---- "which calendars to include" selection (per-machine, localStorage) ----
const INCLUDED_KEY = "order.applecal.included";

export function getIncludedCalendarIds(): string[] {
  try {
    const raw = localStorage.getItem(INCLUDED_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function setIncludedCalendarIds(ids: string[]): void {
  try {
    localStorage.setItem(INCLUDED_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* localStorage unavailable — non-fatal */
  }
}

export function toggleIncludedCalendar(id: string, on: boolean): string[] {
  const cur = new Set(getIncludedCalendarIds());
  if (on) cur.add(id); else cur.delete(id);
  const next = [...cur];
  setIncludedCalendarIds(next);
  return next;
}
