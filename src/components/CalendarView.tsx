// Week / Month calendar built on FullCalendar v6 React.
//
// Reads notes' YAML frontmatter (date, startTime, endTime, allDay) in
// the Obsidian Full Calendar Plus convention. Drag and resize rewrite
// the underlying file's frontmatter via the parent's onMoveEvent
// callback; all-day-strip drops convert timed → allDay (dropping
// startTime/endTime), and dragging back into the timed grid restores
// them. Year view is deferred — Full Calendar Plus uses a custom
// LinearView plugin we haven't ported yet.

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import multiMonthPlugin from "@fullcalendar/multimonth";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  CalendarApi,
  DateSelectArg,
  EventClickArg,
  EventContentArg,
  EventDropArg,
  EventInput,
} from "@fullcalendar/core";
import type { EventResizeDoneArg } from "@fullcalendar/interaction";
import type { Frontmatter } from "../lib/frontmatter";
import { isoDate, isoTime } from "../lib/frontmatter";

export type CalendarRange = "timeGridDay" | "timeGridWeek" | "dayGridMonth" | "multiMonthYear";

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
  /** Notable Folder color applied as the event background tint + border. */
  color?: string;
}

interface Props {
  notes: NoteMeta[];
  initialView: CalendarRange;
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  /** Pointer x/y are forwarded so the parent can anchor an action menu
   *  next to the click instead of jumping straight into the note. */
  onEventClick?: (path: string, coords?: { x: number; y: number }) => void;
  onCreate?: (patch: Frontmatter) => Promise<void>;
}

/** Add one day to a `YYYY-MM-DD` string (UTC-safe via the Date ctor).
 *  FullCalendar treats all-day `end` as EXCLUSIVE: a 3-day event that
 *  the user wrote `date: ...; endDate: 2026-06-10` (inclusive in the
 *  Obsidian Full Calendar YAML convention) needs end = 2026-06-11
 *  for the bar to span all three days in week/month views. */
function addOneDayIso(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Normalize `date` / `endDate` YAML values to ISO `YYYY-MM-DD`.
 *  js-yaml's default schema parses unquoted YYYY-MM-DD as a Date
 *  object — that's the standard YAML 1.1 / CORE_SCHEMA behaviour and
 *  it bit us for ages, because Readwise sync writes dates unquoted
 *  and they'd disappear from the calendar while manually-typed dates
 *  (which we write quoted via isoDate()) survived. Accept both
 *  shapes: string passes through (with a `.slice(0,10)` guard for
 *  datetime variants), Date is converted to an ISO date string. */
function toIsoDateValue(v: unknown): string | null {
  if (typeof v === "string") {
    // Strip whitespace, accept `YYYY-MM-DD` or a datetime starting
    // with one (the slice is a no-op when only a date is present).
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    // Last-ditch parse for free-form strings; if it produces a real
    // date, format back to ISO so FullCalendar accepts it.
    const t = Date.parse(s);
    if (!Number.isFinite(t)) return null;
    return new Date(t).toISOString().slice(0, 10);
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    // js-yaml gives us a UTC-midnight Date for unquoted YYYY-MM-DD.
    // Re-extract YYYY-MM-DD in UTC so we don't roll back a day in
    // timezones west of UTC.
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, "0");
    const d = String(v.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function notesToEvents(notes: NoteMeta[]): EventInput[] {
  const events: EventInput[] = [];
  for (const note of notes) {
    const date = toIsoDateValue(note.frontmatter.date);
    if (!date) continue;

    const allDay = note.frontmatter.allDay === true;
    const startTime = typeof note.frontmatter.startTime === "string"
      ? note.frontmatter.startTime
      : null;
    const endTime = typeof note.frontmatter.endTime === "string"
      ? note.frontmatter.endTime
      : null;
    // Optional `endDate` (Obsidian Full Calendar convention) — present
    // on multi-day events. The value the user writes is INCLUSIVE
    // (e.g. a Mon–Wed event has endDate: Wed). For FullCalendar's
    // all-day `end` we need exclusive, so we add a day before
    // handing it over. ISO date or full datetime both work.
    const endDate = toIsoDateValue(note.frontmatter.endDate);

    const title = note.title || note.filename;
    // Tint the background with the folder color and keep its border, but
    // let the title inherit --fc-event-text-color (var(--ink)) so it stays
    // readable in every theme. A hardcoded dark textColor here used to
    // vanish on the dark/black backgrounds.
    const colorProps = note.color
      ? { backgroundColor: note.color + "29", borderColor: note.color }
      : {};

    if (allDay || !startTime) {
      events.push({
        id: note.path,
        title,
        start: date,
        // Exclusive end for all-day multi-day spans.
        end: endDate ? addOneDayIso(endDate) : undefined,
        allDay: true,
        ...colorProps,
      });
      continue;
    }

    // Timed events. If `endDate` is set and differs from `date`, the
    // event spans multiple days — combine endDate with endTime (or
    // fall back to startTime so the event has a positive duration).
    // Otherwise stay on the same calendar day.
    const endDayIso = endDate && endDate !== date ? endDate : date;
    const endIsoTime = endTime ?? startTime;
    events.push({
      id: note.path,
      title,
      start: `${date}T${startTime}`,
      end: `${endDayIso}T${endIsoTime}`,
      allDay: false,
      ...colorProps,
    });
  }
  return events;
}

/** Round a Date to the nearest absolute half-hour mark (XX:00 or XX:30).
 *  setMinutes accepts values ≥ 60 and overflows into the next hour, so
 *  we don't need a wrap branch. Mutates a fresh copy, not the input. */
function roundToHalfHour(d: Date): Date {
  const out = new Date(d);
  out.setSeconds(0, 0);
  out.setMinutes(Math.round(out.getMinutes() / 30) * 30);
  return out;
}

/** Compact 24h start time, dropping `:00` so 10:00 → "10" and 10:30 →
 *  "10:30". Used by the custom event renderer to show just the start
 *  (Google Calendar–style); FC's eventTimeFormat still emits a range
 *  separator even with displayEventEnd: false, hence the manual render. */
function formatCompactStart(d: Date | null): string {
  if (!d) return "";
  const h = String(d.getHours()).padStart(2, "0");
  const m = d.getMinutes();
  return m === 0 ? h : `${h}:${String(m).padStart(2, "0")}`;
}

/** Custom event content: bold title first, dim compact start-time after.
 *  Uses our OWN class names rather than FC's `.fc-event-*` so FC's
 *  built-in stylesheet (sticky-title pinning, range-dash ::after,
 *  flex-direction switches, etc.) can't interfere with the layout. */
function renderEventContent(arg: EventContentArg) {
  const title = arg.event.title || "Untitled";
  const start = arg.event.allDay ? null : formatCompactStart(arg.event.start);
  return (
    <div className="order-event-row">
      <span className="order-event-title">{title}</span>
      {start && <span className="order-event-time">{start}</span>}
    </div>
  );
}

function patchFromEvent(arg: EventDropArg | EventResizeDoneArg): Frontmatter | null {
  const start = arg.event.start;
  if (!start) return null;
  const allDay = arg.event.allDay;
  if (allDay) {
    return {
      date: isoDate(start),
      allDay: true,
      // Drop time fields when the event becomes all-day — set to
      // undefined and the patch applier removes them from YAML.
      startTime: undefined,
      endTime: undefined,
    };
  }
  const startSnap = roundToHalfHour(start);
  const end = arg.event.end;
  const endSnap = end ? roundToHalfHour(end) : null;
  return {
    date: isoDate(startSnap),
    allDay: false,
    startTime: isoTime(startSnap),
    endTime: endSnap ? isoTime(endSnap) : undefined,
  };
}

/** Imperative handle exposed to the parent for Cmd+arrow nav. */
export interface CalendarViewHandle {
  prev(): void;
  next(): void;
  today(): void;
}

// Week-view column visibility. Stored as the SET OF HIDDEN day-of-week
// numbers (0=Sun..6=Sat) so an unconfigured array means "show all 7"
// and a freshly-cleared selection round-trips cleanly. The picker is
// the only thing that writes here.
const WEEK_HIDDEN_KEY = "order.calendar.week-hidden-days";
const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function readPersistedHiddenDays(): number[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WEEK_HIDDEN_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const days = parsed.filter((d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6);
    // Never restore a state that hides every column — that would
    // lock the week view out completely.
    if (days.length >= 7) return null;
    return days;
  } catch {
    return null;
  }
}

function mobileNarrowDefault(): number[] {
  // Phone / narrow tablet: yesterday / today / tomorrow only — three
  // adjacent columns with today in the middle once firstDay is
  // derived. Computed from the device's local day so the cell
  // alignment matches the user's wall clock on first launch.
  const today = new Date().getDay();
  const yesterday = (today + 6) % 7;
  const tomorrow = (today + 1) % 7;
  const visible = new Set([yesterday, today, tomorrow]);
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !visible.has(d));
}

function defaultHiddenDays(): number[] {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return [];
  return window.matchMedia("(max-width: 768px)").matches ? mobileNarrowDefault() : [];
}

function deriveFirstDay(hidden: ReadonlySet<number>): number {
  // First visible day-of-week, scanning Sun..Sat. Pinning firstDay
  // to the leftmost visible day keeps the visible columns flush to
  // the left edge of the week grid — and on a 3-day mobile default
  // centered on today, today lands in the middle column automatically.
  for (let d = 0; d < 7; d++) if (!hidden.has(d)) return d;
  return 0;
}

export const CalendarView = forwardRef<CalendarViewHandle, Props>(function CalendarView(props, navRef) {
  const { notes, initialView, onMoveEvent } = props;
  const apiRef = useRef<FullCalendar | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  useImperativeHandle(navRef, () => ({
    prev: () => apiRef.current?.getApi()?.prev(),
    next: () => apiRef.current?.getApi()?.next(),
    today: () => apiRef.current?.getApi()?.today(),
  }), []);

  // FullCalendar recomputes on window resize, but a sidebar toggle (or any
  // layout change that only resizes our pane) doesn't fire one. Observe
  // the shell and nudge the calendar so events / time-grid columns refit
  // to whatever width is now available.
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== last) {
        last = w;
        apiRef.current?.getApi()?.updateSize();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const events = useMemo(() => notesToEvents(notes), [notes]);

  // Week-view column visibility lives here so the desktop, iOS, and
  // published viewer all pick it up by mounting the same component.
  // The picker only renders for week view; switching to day / month
  // remounts CalendarView (CardGrid keys on view) and these props
  // simply don't flow through.
  const [weekHidden, setWeekHidden] = useState<number[]>(() => {
    const persisted = readPersistedHiddenDays();
    return persisted ?? defaultHiddenDays();
  });
  const weekHiddenSet = useMemo(() => new Set(weekHidden), [weekHidden]);
  const weekFirstDay = useMemo(() => deriveFirstDay(weekHiddenSet), [weekHiddenSet]);

  function persistWeekHidden(next: number[]) {
    setWeekHidden(next);
    try { window.localStorage.setItem(WEEK_HIDDEN_KEY, JSON.stringify(next)); } catch { /* localStorage unavailable */ }
  }
  function toggleWeekDay(d: number) {
    if (weekHiddenSet.has(d)) {
      persistWeekHidden(weekHidden.filter((x) => x !== d));
    } else {
      // Refuse to hide the last visible column — the calendar would
      // collapse to an empty grid and become unrecoverable from inside
      // FC's own toolbar.
      if (weekHiddenSet.size >= 6) return;
      persistWeekHidden([...weekHidden, d].sort((a, b) => a - b));
    }
  }
  function showAllWeekDays() { persistWeekHidden([]); }

  async function handleEventDrop(arg: EventDropArg) {
    const patch = patchFromEvent(arg);
    const id = arg.event.id;
    if (!patch || !id) { arg.revert(); return; }
    try {
      await onMoveEvent(id, patch);
    } catch (err) {
      console.error("eventDrop failed:", err);
      arg.revert();
    }
  }

  async function handleEventResize(arg: EventResizeDoneArg) {
    const patch = patchFromEvent(arg);
    const id = arg.event.id;
    if (!patch || !id) { arg.revert(); return; }
    try {
      await onMoveEvent(id, patch);
    } catch (err) {
      console.error("eventResize failed:", err);
      arg.revert();
    }
  }

  function handleEventClick(arg: EventClickArg) {
    // Click without drag (FullCalendar fires eventDrop instead for drags).
    if (!arg.event.id) return;
    const e = arg.jsEvent as MouseEvent;
    props.onEventClick?.(arg.event.id, { x: e.clientX, y: e.clientY });
  }

  async function handleSelect(arg: DateSelectArg) {
    if (!props.onCreate) return;
    // FullCalendar gives an exclusive end. For all-day we convert to
    // the inclusive last-selected day for the YAML `endDate` field
    // (Obsidian Full Calendar convention — endDate is inclusive).
    if (arg.allDay) {
      const start = arg.start;
      const endInclusive = new Date(arg.end.getTime() - 86_400_000);
      const patch: Frontmatter = { date: isoDate(start), allDay: true };
      // Single-day selection ⇒ start === endInclusive; only emit
      // endDate for genuine multi-day ranges so single events stay
      // clean in YAML.
      if (isoDate(start) !== isoDate(endInclusive)) {
        patch.endDate = isoDate(endInclusive);
      }
      await props.onCreate(patch);
    } else {
      const start = roundToHalfHour(arg.start);
      const end = roundToHalfHour(arg.end);
      const sameInstant = start.getTime() === end.getTime();
      await props.onCreate({
        date: isoDate(start),
        allDay: false,
        startTime: isoTime(start),
        endTime: sameInstant ? undefined : isoTime(end),
      });
    }
    arg.view.calendar.unselect();
  }

  // The view prop on FullCalendar is set once via initialView; consumers
  // change views by calling api.changeView() through the ref. CardGrid
  // remounts this component when initialView changes so we don't need
  // to wire that here — but the ref is kept for future view-switch
  // animations or imperative actions.
  function rememberApi(api: CalendarApi | null) {
    // CalendarApi-only helper; not strictly needed yet.
    void api;
  }

  const isWeek = initialView === "timeGridWeek";

  return (
    <div className={`fc-shell${isWeek ? " fc-shell-week" : ""}`} ref={shellRef}>
      {isWeek && (
        <div className="fc-week-day-picker" role="group" aria-label="Visible days of the week">
          {DAY_LABELS.map((label, d) => {
            const hidden = weekHiddenSet.has(d);
            return (
              <button
                key={d}
                type="button"
                className={`fc-week-day-chip${hidden ? " is-off" : " is-on"}`}
                onClick={() => toggleWeekDay(d)}
                aria-pressed={!hidden}
                aria-label={`${hidden ? "Show" : "Hide"} ${DAY_NAMES[d]}`}
                title={DAY_NAMES[d]}
              >
                {label}
              </button>
            );
          })}
          {weekHidden.length > 0 && (
            <button
              type="button"
              className="fc-week-day-all"
              onClick={showAllWeekDays}
              aria-label="Show all days"
              title="Show all days"
            >
              All
            </button>
          )}
        </div>
      )}
      <FullCalendar
        ref={(instance) => {
          apiRef.current = instance;
          rememberApi(instance?.getApi() ?? null);
        }}
        plugins={[dayGridPlugin, timeGridPlugin, multiMonthPlugin, interactionPlugin]}
        initialView={initialView}
        events={events}
        editable
        droppable
        selectable
        selectMirror
        nowIndicator
        firstDay={isWeek ? weekFirstDay : 0}
        hiddenDays={isWeek ? weekHidden : undefined}
        height="auto"
        // Touch-friendly: drop FC's 1000ms long-press to 250ms so dragging
        // an event or selecting a range with a finger feels responsive.
        // Mouse drags are unaffected (long-press only applies to touch).
        longPressDelay={250}
        eventLongPressDelay={250}
        selectLongPressDelay={250}
        // A touch needs to move ~6px to commit (vs FC's default 5) so a
        // tap-meant-as-click doesn't accidentally start a drag. Keeps the
        // event-click action menu reliable on mobile.
        eventDragMinDistance={6}
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "",
        }}
        // 30-min slots and drags snap to 30-min — events always fall on
        // a half-hour boundary.
        slotDuration="00:30:00"
        snapDuration="00:30:00"
        // Event content is rendered manually (see renderEventContent) so
        // FC's range formatter can't sneak a trailing separator in.
        // displayEventTime: false fully silences FC's default time
        // element — without it, the default time was still being added
        // beside our custom one and overflow-clipped to "10 —".
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false, omitZeroMinute: true }}
        displayEventTime={false}
        eventContent={renderEventContent}
        slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        // Month view: collapse overflow into a "+N more" popover (Full
        // Calendar Plus convention).
        dayMaxEvents
        // For month view, treat all-day rows so multi-day events span
        // cells naturally.
        eventDrop={handleEventDrop}
        eventResize={handleEventResize}
        eventClick={handleEventClick}
        select={handleSelect}
      />
    </div>
  );
});
