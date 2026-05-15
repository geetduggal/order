// Day / Week / Month / Year calendar views. Follows Obsidian Full Calendar
// conventions: timed events at their slot, all-day in a top row, year view
// renders multi-day events as horizontal bars across days.

import { useState } from "react";
import type { Note } from "../lib/types";
import { folderOf } from "../lib/types";

type CalView = "day" | "week" | "month" | "year";

type Props = {
  notes: Note[];
  selected: Set<string>;
  onUpdateNote: (n: Note, frontmatter: Record<string, any>) => void;
};

const HOURS = Array.from({ length: 14 }, (_, i) => i + 7); // 7am to 8pm

export function CalendarView({ notes, selected, onUpdateNote }: Props) {
  const [view, setView] = useState<CalView>("week");
  const [anchor, setAnchor] = useState<Date>(() => new Date());

  function nudge(delta: number) {
    const d = new Date(anchor);
    if (view === "day") d.setDate(d.getDate() + delta);
    else if (view === "week") d.setDate(d.getDate() + delta * 7);
    else if (view === "month") d.setMonth(d.getMonth() + delta);
    else d.setFullYear(d.getFullYear() + delta);
    setAnchor(d);
  }

  return (
    <section className="cal-wrap">
      <div className="cal-head">
        <button onClick={() => nudge(-1)}>‹</button>
        <button onClick={() => setAnchor(new Date())}>Today</button>
        <button onClick={() => nudge(1)}>›</button>
        <div className="cal-range">{rangeLabel(anchor, view)}</div>
        <div className="cal-view-switch">
          {(["day", "week", "month", "year"] as CalView[]).map(v => (
            <button
              key={v}
              className={view === v ? "on" : ""}
              onClick={() => setView(v)}
            >{v}</button>
          ))}
        </div>
      </div>

      {view === "day"   && <DayView   anchor={anchor} notes={notes} selected={selected} onUpdate={onUpdateNote} />}
      {view === "week"  && <WeekView  anchor={anchor} notes={notes} selected={selected} onUpdate={onUpdateNote} />}
      {view === "month" && <MonthView anchor={anchor} notes={notes} selected={selected} onUpdate={onUpdateNote}
                                      onPickDay={d => { setAnchor(d); setView("day"); }} />}
      {view === "year"  && <YearView  anchor={anchor} notes={notes} selected={selected} onUpdate={onUpdateNote}
                                      onPickMonth={d => { setAnchor(d); setView("month"); }} />}
    </section>
  );
}

// ---------- Day ----------

function DayView({ anchor, notes, selected, onUpdate }: ViewProps) {
  const key = iso(anchor);
  const events = notesOnDay(notes, selected, anchor).filter(n => n.frontmatter?.startTime);
  const allDay = notesOnDay(notes, selected, anchor).filter(n => !n.frontmatter?.startTime || n.frontmatter?.allDay);

  return (
    <>
      <div className="cal-allday-row">
        <div className="lbl">All day</div>
        <div className="slot"
          onDragOver={e => onDragOver(e)}
          onDrop={e => onDropToDay(e, anchor, undefined, notes, onUpdate)}>
          {allDay.map(n => (
            <Event key={n.path} note={n} kind="allday" />
          ))}
        </div>
      </div>
      <div className="cal-day-grid">
        {HOURS.map(h => (
          <div key={h} className="cal-day-row">
            <div className="cal-row-head">{formatHour(h)}</div>
            <div className="cal-cell"
              data-day={key} data-hour={h}
              onDragOver={e => onDragOver(e)}
              onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove("drop")}
              onDrop={e => onDropToDay(e, anchor, h, notes, onUpdate)}>
              {events.filter(n => parseHour(n.frontmatter?.startTime) === h).map(n => (
                <Event key={n.path} note={n} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- Week ----------

function WeekView({ anchor, notes, selected, onUpdate }: ViewProps) {
  const weekStart = startOfWeek(anchor);
  const days = range(7).map(i => addDays(weekStart, i));

  return (
    <>
      <div className="cal-allday-row">
        <div className="lbl">All day</div>
        {days.map((d, i) => (
          <div key={i} className="slot"
            onDragOver={onDragOver}
            onDrop={e => onDropToDay(e, d, undefined, notes, onUpdate)}>
            {notesOnDay(notes, selected, d).filter(n => n.frontmatter?.allDay || !n.frontmatter?.startTime).map(n => (
              <Event key={n.path} note={n} kind="allday" />
            ))}
          </div>
        ))}
      </div>
      <div className="cal-week-grid">
        <div className="cal-col-head" />
        {days.map((d, i) => (
          <div key={i} className={"cal-col-head" + (isToday(d) ? " today" : "")}>
            <div>{d.toLocaleDateString("en-US", { weekday: "short" })}</div>
            <div className="num">{d.getDate()}</div>
          </div>
        ))}
        {HOURS.map(h => (
          <RowFragment key={h} h={h}>
            <div className="cal-row-head">{formatHour(h)}</div>
            {days.map((d, i) => (
              <div key={i} className="cal-cell"
                data-day={iso(d)} data-hour={h}
                onDragOver={onDragOver}
                onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove("drop")}
                onDrop={e => onDropToDay(e, d, h, notes, onUpdate)}>
                {notesOnDay(notes, selected, d)
                  .filter(n => n.frontmatter?.startTime && parseHour(n.frontmatter?.startTime) === h)
                  .map(n => (<Event key={n.path} note={n} />))}
              </div>
            ))}
          </RowFragment>
        ))}
      </div>
    </>
  );
}

// React fragment-with-key helper so we can group siblings inside the grid.
function RowFragment({ h, children }: { h: number; children: React.ReactNode }) {
  return <>{children}</>;
}

// ---------- Month ----------

function MonthView({ anchor, notes, selected, onUpdate, onPickDay }: ViewProps & { onPickDay: (d: Date) => void }) {
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const gridStart = startOfWeek(monthStart);
  const cells = range(42).map(i => addDays(gridStart, i));
  const inMonth = (d: Date) => d.getMonth() === anchor.getMonth();

  return (
    <div className="cal-month">
      {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
        <div key={d} className="cal-month-dow">{d}</div>
      ))}
      {cells.map((d, i) => {
        const events = notesOnDay(notes, selected, d);
        return (
          <div key={i}
            className={"cal-month-cell" + (inMonth(d) ? "" : " other") + (isToday(d) ? " today" : "")}
            onDragOver={onDragOver}
            onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove("drop")}
            onDrop={e => onDropToDay(e, d, undefined, notes, onUpdate, /*preserveTime*/ true)}
            onDoubleClick={() => onPickDay(d)}>
            <div className="num">{d.getDate()}</div>
            <div className="chips">
              {events.slice(0, 4).map(n => (
                <Event key={n.path} note={n} kind="chip" />
              ))}
              {events.length > 4 && <span className="more">+{events.length - 4}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Year (linear) ----------

function YearView({ anchor, notes, selected, onUpdate, onPickMonth }: ViewProps & { onPickMonth: (d: Date) => void }) {
  const year = anchor.getFullYear();
  return (
    <div className="cal-year">
      {range(12).map(mi => {
        const monthStart = new Date(year, mi, 1);
        const daysInMonth = new Date(year, mi + 1, 0).getDate();
        return (
          <div key={mi} className="cal-year-row">
            <button className="cal-year-label" onClick={() => onPickMonth(monthStart)}>
              {monthStart.toLocaleDateString("en-US", { month: "short" })}
              <span className="yr">{year}</span>
            </button>
            <div className="cal-year-days" style={{ gridTemplateColumns: `repeat(31, 1fr)` }}>
              {range(daysInMonth).map(di => {
                const d = new Date(year, mi, di + 1);
                const dayEvents = notesOnDay(notes, selected, d);
                return (
                  <div key={di}
                    className={"cal-year-day" + (isWeekend(d) ? " weekend" : "") + (isToday(d) ? " today" : "")}
                    data-day={iso(d)}
                    onDragOver={onDragOver}
                    onDragLeave={e => (e.currentTarget as HTMLElement).classList.remove("drop")}
                    onDrop={e => onDropToDay(e, d, undefined, notes, onUpdate, true)}>
                    <span className="num">{di + 1}</span>
                    {dayEvents.length > 0 && (
                      <span
                        className={"blip" + (dayEvents.some(isPublic) ? " public" : "")}
                        title={dayEvents.map(n => n.title).join("\n")}
                      />
                    )}
                  </div>
                );
              })}
              {/* Multi-day bars overlay would render here in a fuller impl; MVP shows blips per day. */}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- shared ----------

type ViewProps = {
  anchor: Date;
  notes: Note[];
  selected: Set<string>;
  onUpdate: (n: Note, fm: Record<string, any>) => void;
};

function Event({ note, kind }: { note: Note; kind?: "chip" | "allday" }) {
  const color = colorOf(note);
  const start = note.frontmatter?.startTime;
  return (
    <div
      className={"cal-event" + (kind ? ` ${kind}` : "")}
      draggable
      style={{ borderLeftColor: color }}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/order-path", note.path);
        e.dataTransfer.effectAllowed = "move";
      }}
      title={`${note.title}${start ? " · " + start : ""}`}
    >
      <span className="t">{note.title}</span>
      {start && kind !== "chip" && kind !== "allday" && (
        <span className="w">{start} · {folderOf(note)}</span>
      )}
    </div>
  );
}

function colorOf(n: Note): string {
  const c = n.frontmatter?.color;
  if (typeof c === "string" && c.startsWith("#")) return c;
  if (folderOf(n) === "Log") return "#FF7F50";
  return "#4169E1";
}

function isPublic(n: Note): boolean { return n.frontmatter?.public === true; }

function notesOnDay(notes: Note[], selected: Set<string>, d: Date): Note[] {
  const key = iso(d);
  return notes.filter(n => {
    const folder = folderOf(n);
    if (!selected.has(folder) && folder !== "Log") return false;
    const date = n.frontmatter?.date;
    return typeof date === "string" && date === key;
  });
}

function onDragOver(e: React.DragEvent) {
  if (e.dataTransfer.types.includes("text/order-path")) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.add("drop");
  }
}
function onDropToDay(
  e: React.DragEvent,
  day: Date,
  hour: number | undefined,
  notes: Note[],
  onUpdate: (n: Note, fm: Record<string, any>) => void,
  preserveTime?: boolean,
) {
  e.preventDefault();
  (e.currentTarget as HTMLElement).classList.remove("drop");
  const path = e.dataTransfer.getData("text/order-path");
  const n = notes.find(x => x.path === path);
  if (!n) return;
  const patch: Record<string, any> = { date: iso(day) };
  if (hour !== undefined) patch.startTime = `${pad(hour)}:00`;
  else if (!preserveTime && !n.frontmatter?.startTime) patch.allDay = true;
  onUpdate(n, patch);
}

function rangeLabel(anchor: Date, view: CalView): string {
  if (view === "day") return anchor.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" });
  if (view === "month") return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  if (view === "year") return String(anchor.getFullYear());
  // week
  const s = startOfWeek(anchor);
  const e = addDays(s, 6);
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} — ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function startOfWeek(d: Date): Date {
  const s = new Date(d); s.setHours(0, 0, 0, 0);
  const day = s.getDay(); s.setDate(s.getDate() - ((day + 6) % 7));
  return s;
}
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function range(n: number): number[] { return Array.from({ length: n }, (_, i) => i); }
function iso(d: Date): string {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function isToday(d: Date): boolean { return iso(d) === iso(new Date()); }
function isWeekend(d: Date): boolean { return d.getDay() === 0 || d.getDay() === 6; }
function pad(n: number): string { return String(n).padStart(2, "0"); }
function formatHour(h: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${h < 12 ? "AM" : "PM"}`;
}
function parseHour(s: any): number { return typeof s === "string" ? parseInt(s.slice(0, 2), 10) : -1; }
