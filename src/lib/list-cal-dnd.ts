// Pointer-based drag between a list (masonry / lines / cards) and the Week
// calendar, both visible in the Week hub. HTML5 drag-drop is unusable in
// Tauri's webview, so we hit-test the live FullCalendar / list-zone DOM at a
// screen point and coordinate the two halves via window CustomEvents — each
// component edits only its OWN side (the list removes/adds its item; CardGrid
// creates/deletes the calendar event) so there's no cross-component write race.

import { useEffect, useRef } from "react";
import type { ListItem } from "./list-folder";

/** A drop onto a Week time-grid slot → the date + a 30-minute span, or null if
 *  the point isn't over the timed grid. */
export function calendarHitAt(x: number, y: number): { date: string; startTime: string; endTime: string } | null {
  let date: string | null = null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (!(el instanceof HTMLElement)) continue;
    const col = el.closest<HTMLElement>(".fc-timegrid-col");
    if (!col) continue;
    // The day's ISO date lives on the col (or a dated descendant of it).
    const dated = col.matches("[data-date]") ? col : col.querySelector<HTMLElement>("[data-date]");
    const d = dated?.getAttribute("data-date");
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) { date = d; break; }
  }
  if (!date) return null;
  // The slots table spans the whole day (00:00–24:00); map the screen Y into it.
  const slots = document.querySelector<HTMLElement>(".fc-timegrid-slots");
  if (!slots) return null;
  const r = slots.getBoundingClientRect();
  if (r.height <= 0) return null;
  const frac = Math.max(0, Math.min(0.999, (y - r.top) / r.height));
  const mins = Math.max(0, Math.min(1410, Math.round((frac * 1440) / 30) * 30));
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return { date, startTime: fmt(mins), endTime: fmt(mins + 30) };
}

/** True when the point is over the Week hub's document (list) zone. */
export function overListZone(x: number, y: number): boolean {
  return document.elementsFromPoint(x, y).some(
    (el) => el instanceof HTMLElement && el.closest(".week-hub-doc") != null,
  );
}

// ---- target-slot indicator on the calendar --------------------------------

let calIndicator: HTMLDivElement | null = null;
/** Paint a translucent 30-min block at the slot under the pointer (or clear it
 *  if the point isn't over the grid). */
export function paintCalendarDropIndicator(x: number, y: number): void {
  let col: HTMLElement | null = null;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el instanceof HTMLElement) { const c = el.closest<HTMLElement>(".fc-timegrid-col"); if (c) { col = c; break; } }
  }
  const slots = document.querySelector<HTMLElement>(".fc-timegrid-slots");
  const hit = calendarHitAt(x, y);
  if (!col || !slots || !hit) { clearCalendarDropIndicator(); return; }
  const colR = col.getBoundingClientRect();
  const slotR = slots.getBoundingClientRect();
  const startMins = Number(hit.startTime.slice(0, 2)) * 60 + Number(hit.startTime.slice(3, 5));
  const top = slotR.top + (startMins / 1440) * slotR.height;
  const height = Math.max(10, (30 / 1440) * slotR.height);
  if (!calIndicator) {
    calIndicator = document.createElement("div");
    calIndicator.className = "cal-drop-indicator";
    document.body.appendChild(calIndicator);
  }
  Object.assign(calIndicator.style, {
    left: `${colR.left + 2}px`, top: `${top}px`, width: `${Math.max(0, colR.width - 4)}px`, height: `${height}px`,
  });
}
export function clearCalendarDropIndicator(): void { calIndicator?.remove(); calIndicator = null; }

/** Highlight the Week hub list zone while a calendar event is dragged over it. */
export function highlightListZone(x: number, y: number): void {
  const zone = document.querySelector<HTMLElement>(".week-hub-doc");
  if (!zone) return;
  zone.classList.toggle("is-drop-target", overListZone(x, y));
}
export function clearListZoneHighlight(): void {
  document.querySelectorAll(".week-hub-doc.is-drop-target").forEach((e) => e.classList.remove("is-drop-target"));
}

// ---- cross-surface events -------------------------------------------------

export interface ItemToCalendarDetail { title: string; date: string; startTime: string; endTime: string }
export interface EventToListDetail { title: string; date: string; time: string; path: string; hasNote: boolean }

export const ITEM_TO_CALENDAR = "order:list-item-to-calendar";
export const EVENT_TO_LIST = "order:calendar-event-to-list";

export function emitItemToCalendar(detail: ItemToCalendarDetail): void {
  window.dispatchEvent(new CustomEvent(ITEM_TO_CALENDAR, { detail }));
}
export function emitEventToList(detail: EventToListDetail): void {
  window.dispatchEvent(new CustomEvent(EVENT_TO_LIST, { detail }));
}

// ---- reusable pieces for the list components -------------------------------

export type CalendarDropTarget = {
  over: (x: number, y: number) => boolean;
  drop: (ref: string, x: number, y: number) => void;
  end: () => void;
};

/** useTileDrag dropTarget: drop a card onto the calendar → create a 30-min
 *  event (title = card text) and remove the card. */
export function calendarDropTarget(getItems: () => ListItem[], onChange: (next: ListItem[]) => void): CalendarDropTarget {
  return {
    over: (x, y) => { const hit = calendarHitAt(x, y); if (hit) paintCalendarDropIndicator(x, y); else clearCalendarDropIndicator(); return !!hit; },
    drop: (ref, x, y) => {
      clearCalendarDropIndicator();
      const hit = calendarHitAt(x, y);
      if (!hit) return;
      const items = getItems();
      const item = items.find((i) => i.ref === ref);
      const title = (item?.text ?? item?.caption ?? item?.ref ?? "").trim();
      if (!item || !title) return;
      emitItemToCalendar({ title, ...hit });
      onChange(items.filter((i) => i.ref !== ref));
    },
    end: () => clearCalendarDropIndicator(),
  };
}

/** Append a calendar event dragged onto the Week hub list as a plain text item.
 *  Only the list that actually lives in the hub's doc zone reacts. */
export function useEventToListAppend(
  gridRef: { current: HTMLElement | null },
  getItems: () => ListItem[],
  onChange: (next: ListItem[]) => void,
  canEdit: boolean,
): void {
  const gi = useRef(getItems); gi.current = getItems;
  const oc = useRef(onChange); oc.current = onChange;
  const ce = useRef(canEdit); ce.current = canEdit;
  useEffect(() => {
    function onEvt(e: Event) {
      if (!ce.current) return;
      const grid = gridRef.current;
      if (!grid || !grid.closest?.(".week-hub-doc")) return;
      const d = (e as CustomEvent<EventToListDetail>).detail;
      const title = d?.title?.trim();
      if (!title) return;
      oc.current([...gi.current(), { ref: title, text: title }]);
    }
    window.addEventListener(EVENT_TO_LIST, onEvt);
    return () => window.removeEventListener(EVENT_TO_LIST, onEvt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
