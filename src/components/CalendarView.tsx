// Calendar — Week view as MVP. Notes with `date` + `startTime` appear as
// colored events. Click an event to open its note's section. Drag to move
// across days/times.

import { useState } from "react";
import type { Note } from "../lib/types";
import { folderOf } from "../lib/types";

type Props = {
  notes: Note[];
  selected: Set<string>;
  onUpdateNote: (n: Note, frontmatter: Record<string, any>) => void;
};

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7am to 8pm

export function CalendarView({ notes, selected, onUpdateNote }: Props) {
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });

  const eventsByDay = days.map(d => {
    const key = iso(d);
    return notes.filter(n => {
      const date = n.frontmatter?.date;
      const onDay = (typeof date === "string" && date === key);
      const inFilter = selected.has(folderOf(n)) || folderOf(n) === "Log";
      return onDay && inFilter && !!n.frontmatter?.startTime;
    });
  });

  function shift(by: number) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + by * 7);
    setWeekStart(d);
  }

  return (
    <section className="cal-wrap">
      <div className="cal-head">
        <button onClick={() => shift(-1)}>‹</button>
        <button onClick={() => setWeekStart(startOfWeek(new Date()))}>Today</button>
        <button onClick={() => shift(1)}>›</button>
        <span className="cal-range">
          {days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} —{" "}
          {days[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      </div>
      <div className="cal-grid">
        <div className="cal-col-head" />
        {days.map((d, i) => (
          <div key={i} className={"cal-col-head" + (isToday(d) ? " today" : "")}>
            <div>{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
            <div className="num">{d.getDate()}</div>
          </div>
        ))}
        {HOURS.map(h => (
          <>
            <div key={`hh-${h}`} className="cal-row-head">{formatHour(h)}</div>
            {days.map((d, di) => (
              <div
                key={`c-${h}-${di}`}
                className="cal-cell"
                data-day={iso(d)}
                data-hour={h}
                onDragOver={e => { e.preventDefault(); (e.currentTarget as HTMLElement).classList.add("drop"); }}
                onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove("drop")}
                onDrop={e => {
                  e.preventDefault();
                  (e.currentTarget as HTMLElement).classList.remove("drop");
                  const path = e.dataTransfer.getData("text/order-path");
                  const n = notes.find(x => x.path === path);
                  if (n) onUpdateNote(n, { date: iso(d), startTime: `${pad(h)}:00` });
                }}
              >
                {eventsByDay[di]
                  .filter(n => parseHour(n.frontmatter?.startTime) === h)
                  .map(n => (
                    <div
                      key={n.path}
                      className="cal-event"
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData("text/order-path", n.path);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      <div className="cal-event-title">{n.title}</div>
                      <div className="cal-event-when">{n.frontmatter?.startTime} · {folderOf(n)}</div>
                    </div>
                  ))}
              </div>
            ))}
          </>
        ))}
      </div>
    </section>
  );
}

function startOfWeek(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  const day = s.getDay();           // 0 = Sun
  s.setDate(s.getDate() - ((day + 6) % 7));  // back to Monday
  return s;
}
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function isToday(d: Date): boolean { return iso(d) === iso(new Date()); }
function pad(n: number): string { return String(n).padStart(2, "0"); }
function formatHour(h: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${h < 12 ? "AM" : "PM"}`;
}
function parseHour(s: any): number { return typeof s === "string" ? parseInt(s.slice(0, 2), 10) : -1; }
