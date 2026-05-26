// Week / Month calendar built on FullCalendar v6 React.
//
// Reads notes' YAML frontmatter (date, startTime, endTime, allDay) in
// the Obsidian Full Calendar Plus convention. Drag and resize rewrite
// the underlying file's frontmatter via the parent's onMoveEvent
// callback; all-day-strip drops convert timed → allDay (dropping
// startTime/endTime), and dragging back into the timed grid restores
// them. Year view is deferred — Full Calendar Plus uses a custom
// LinearView plugin we haven't ported yet.

import { useEffect, useMemo, useRef } from "react";
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

export type CalendarRange = "timeGridWeek" | "dayGridMonth" | "multiMonthYear";

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
  onEventClick?: (path: string) => void;
  onCreate?: (patch: Frontmatter) => Promise<void>;
}

function notesToEvents(notes: NoteMeta[]): EventInput[] {
  const events: EventInput[] = [];
  for (const note of notes) {
    const date = note.frontmatter.date;
    if (typeof date !== "string") continue;

    const allDay = note.frontmatter.allDay === true;
    const startTime = typeof note.frontmatter.startTime === "string"
      ? note.frontmatter.startTime
      : null;
    const endTime = typeof note.frontmatter.endTime === "string"
      ? note.frontmatter.endTime
      : null;

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
        allDay: true,
        ...colorProps,
      });
      continue;
    }

    events.push({
      id: note.path,
      title,
      start: `${date}T${startTime}`,
      end: endTime ? `${date}T${endTime}` : undefined,
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
 *  Reuses FC's class names so the existing .fc-event-* CSS continues to
 *  apply (truncation, colors, layout). */
function renderEventContent(arg: EventContentArg) {
  const title = arg.event.title || "Untitled";
  const start = arg.event.allDay ? null : formatCompactStart(arg.event.start);
  return (
    <div className="fc-event-main-frame">
      <div className="fc-event-title-container">
        <div className="fc-event-title">{title}</div>
      </div>
      {start && <div className="fc-event-time">{start}</div>}
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

export function CalendarView(props: Props) {
  const { notes, initialView, onMoveEvent } = props;
  const apiRef = useRef<FullCalendar | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);

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
    if (arg.event.id) props.onEventClick?.(arg.event.id);
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

  return (
    <div className="fc-shell" ref={shellRef}>
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
        firstDay={0}
        height="auto"
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
}
