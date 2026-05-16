// Week / Month calendar built on FullCalendar v6 React.
//
// Reads notes' YAML frontmatter (date, startTime, endTime, allDay) in
// the Obsidian Full Calendar Plus convention. Drag and resize rewrite
// the underlying file's frontmatter via the parent's onMoveEvent
// callback; all-day-strip drops convert timed → allDay (dropping
// startTime/endTime), and dragging back into the timed grid restores
// them. Year view is deferred — Full Calendar Plus uses a custom
// LinearView plugin we haven't ported yet.

import { useMemo, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import multiMonthPlugin from "@fullcalendar/multimonth";
import interactionPlugin from "@fullcalendar/interaction";
import type {
  CalendarApi,
  EventClickArg,
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
}

interface Props {
  notes: NoteMeta[];
  initialView: CalendarRange;
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  onEventClick?: (path: string) => void;
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

    if (allDay || !startTime) {
      events.push({
        id: note.path,
        title,
        start: date,
        allDay: true,
      });
      continue;
    }

    events.push({
      id: note.path,
      title,
      start: `${date}T${startTime}`,
      end: endTime ? `${date}T${endTime}` : undefined,
      allDay: false,
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
    <div className="fc-shell">
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
        selectable={false}
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
        // Show 24h time labels by default — easy to flip via setting later.
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        // Month view: collapse overflow into a "+N more" popover (Full
        // Calendar Plus convention).
        dayMaxEvents
        // For month view, treat all-day rows so multi-day events span
        // cells naturally.
        eventDrop={handleEventDrop}
        eventResize={handleEventResize}
        eventClick={handleEventClick}
      />
    </div>
  );
}
