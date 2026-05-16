// Week calendar. 7-day grid, hour rows (6:00–22:00), notes positioned at
// their YAML `date` + `startTime`. Drag an event to a new day/time slot
// (snapped to 15 minutes) and the underlying file's frontmatter updates.

import { useMemo, useState } from "react";
import {
  addDays,
  daysOfWeek,
  formatClockTime,
  formatDayHeader,
  isSameDay,
  parseClockTime,
  parseIsoDate,
  startOfWeek,
  weekRangeLabel,
} from "../lib/calendar";
import type { Frontmatter } from "../lib/frontmatter";
import { isoDate } from "../lib/frontmatter";

const DAY_START_HOUR = 6;
const DAY_END_HOUR = 22; // exclusive — 22:00 is the last gridline
const HOUR_PX = 50;
const SNAP_MINUTES = 15;
const EVENT_DEFAULT_HEIGHT_PX = HOUR_PX; // one-hour placeholder

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
}

interface Props {
  notes: NoteMeta[];
  onMoveEvent: (path: string, patch: { date: string; startTime: string }) => Promise<void>;
}

interface PositionedEvent {
  note: NoteMeta;
  topPx: number;
  heightPx: number;
}

function eventsForDay(notes: NoteMeta[], day: Date): PositionedEvent[] {
  const out: PositionedEvent[] = [];
  for (const note of notes) {
    const dateStr = note.frontmatter.date;
    const timeStr = note.frontmatter.startTime;
    if (typeof dateStr !== "string") continue;
    const date = parseIsoDate(dateStr);
    if (!date || !isSameDay(date, day)) continue;
    const time = typeof timeStr === "string" ? parseClockTime(timeStr) : null;
    const startHour = time ? time.h + time.m / 60 : DAY_START_HOUR;
    const topPx = (startHour - DAY_START_HOUR) * HOUR_PX;
    out.push({ note, topPx, heightPx: EVENT_DEFAULT_HEIGHT_PX });
  }
  return out;
}

function clockFromOffsetPx(yPx: number): { h: number; m: number } {
  const totalMinutes = (yPx / HOUR_PX) * 60 + DAY_START_HOUR * 60;
  const snapped = Math.max(
    DAY_START_HOUR * 60,
    Math.min((DAY_END_HOUR - 1) * 60 + (60 - SNAP_MINUTES),
      Math.round(totalMinutes / SNAP_MINUTES) * SNAP_MINUTES),
  );
  return { h: Math.floor(snapped / 60), m: snapped % 60 };
}

export function WeekView({ notes, onMoveEvent }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const days = useMemo(() => daysOfWeek(weekStart), [weekStart]);
  const hours = useMemo(
    () => Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => DAY_START_HOUR + i),
    [],
  );

  function goPrev() { setWeekStart(addDays(weekStart, -7)); }
  function goNext() { setWeekStart(addDays(weekStart, 7)); }
  function goToday() { setWeekStart(startOfWeek(new Date())); }

  function onDragStart(e: React.DragEvent<HTMLDivElement>, path: string) {
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "move";
    (e.currentTarget as HTMLDivElement).classList.add("week-event-dragging");
  }
  function onDragEnd(e: React.DragEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLDivElement).classList.remove("week-event-dragging");
  }
  function onColDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
  // Drop handler used by both the day body and the events that sit
  // inside it. We always resolve drop position against the .week-day-body
  // rect — when the cursor hovers over an event element, currentTarget
  // is the event, so we walk up to find the body.
  async function onDayDrop(e: React.DragEvent<HTMLDivElement>, day: Date) {
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData("text/plain");
    if (!path) return;
    const target = e.currentTarget as HTMLElement;
    const body = target.classList.contains("week-day-body")
      ? target
      : target.closest<HTMLDivElement>(".week-day-body");
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const { h, m } = clockFromOffsetPx(y);
    await onMoveEvent(path, { date: isoDate(day), startTime: formatClockTime(h, m) });
  }

  const today = new Date();

  return (
    <div className="week">
      <header className="week-head">
        <div className="week-nav">
          <button className="week-nav-btn" onClick={goPrev} title="Previous week">‹</button>
          <button className="week-nav-btn ghost" onClick={goToday}>today</button>
          <button className="week-nav-btn" onClick={goNext} title="Next week">›</button>
        </div>
        <h2 className="week-label">{weekRangeLabel(weekStart)}</h2>
      </header>

      <div className="week-grid">
        <div className="week-time-axis">
          <div className="week-corner" />
          {hours.map((h) => (
            <div key={h} className="week-hour-label">{formatClockTime(h, 0)}</div>
          ))}
        </div>

        {days.map((day) => {
          const isToday = isSameDay(day, today);
          const head = formatDayHeader(day);
          const events = eventsForDay(notes, day);
          return (
            <div className="week-day" key={day.toISOString()}>
              <div className={"week-day-head" + (isToday ? " is-today" : "")}>
                <span className="week-dow">{head.dow}</span>
                <span className="week-day-num">{head.day}</span>
              </div>
              <div
                className="week-day-body"
                style={{ height: hours.length * HOUR_PX }}
                onDragOver={onColDragOver}
                onDrop={(e) => { void onDayDrop(e, day); }}
              >
                {hours.map((h) => (
                  <div key={h} className="week-hour-row" style={{ top: (h - DAY_START_HOUR) * HOUR_PX, height: HOUR_PX }} />
                ))}
                {events.map(({ note, topPx, heightPx }) => {
                  const time = note.frontmatter.startTime as string | undefined;
                  return (
                    <div
                      key={note.path}
                      className="week-event"
                      style={{ top: topPx, height: heightPx }}
                      draggable
                      onDragStart={(e) => onDragStart(e, note.path)}
                      onDragEnd={onDragEnd}
                      // Events block dragover on the body by sitting on top
                      // of it; mirror the column handlers so dropping over
                      // another event still lands in the right day/time.
                      onDragOver={onColDragOver}
                      onDrop={(e) => { void onDayDrop(e, day); }}
                      title={note.path}
                    >
                      <div className="week-event-time">{time ?? ""}</div>
                      <div className="week-event-title">{note.title || note.filename}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
