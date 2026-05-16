// Year view — linear strip layout.
//
// Ported from the user's Full Calendar Plus fork
// (src/ui/linear/LinearView.tsx). Each month is a horizontal row of 37
// day-cells; day-of-week columns align across all 12 months so weekends
// form vertical stripes and the cumulative shape of the year is legible
// at a glance. Drag any event bar to a new day → file's `date` rewrites;
// click → jumps to Stream. No FullCalendar dependency for this view —
// it's a small bespoke React component.

import { useMemo, useState } from "react";
import { isoDate, type Frontmatter } from "../lib/frontmatter";
import { isSameDay, parseIsoDate } from "../lib/calendar";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const ROW_CELLS = 37; // max needed: 31-day month starting Saturday = 6 + 31

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
}

interface Props {
  notes: NoteMeta[];
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  onEventClick?: (path: string) => void;
}

interface CellKey { month: number; day: number }
function cellKey({ month, day }: CellKey): string { return `${month}-${day}`; }

export function YearLinearView({ notes, onMoveEvent, onEventClick }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());

  // Group notes by (month, day-of-month) for O(1) cell lookup.
  const eventsByCell = useMemo(() => {
    const map = new Map<string, NoteMeta[]>();
    for (const note of notes) {
      const dateStr = note.frontmatter.date;
      if (typeof dateStr !== "string") continue;
      const date = parseIsoDate(dateStr);
      if (!date || date.getFullYear() !== year) continue;
      const key = cellKey({ month: date.getMonth(), day: date.getDate() });
      const arr = map.get(key);
      if (arr) arr.push(note);
      else map.set(key, [note]);
    }
    return map;
  }, [notes, year]);

  function onEventDragStart(e: React.DragEvent<HTMLDivElement>, path: string) {
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "move";
    (e.currentTarget as HTMLDivElement).classList.add("year-event-dragging");
  }
  function onEventDragEnd(e: React.DragEvent<HTMLDivElement>) {
    (e.currentTarget as HTMLDivElement).classList.remove("year-event-dragging");
  }
  function onCellDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
  // Drop handler used by both cells and events. closest('.year-cell')
  // resolves the correct target when the cursor lands on an event bar
  // (events are children of cells).
  async function onCellDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData("text/plain");
    if (!path) return;
    const target = e.currentTarget as HTMLElement;
    const cell = target.classList.contains("year-cell")
      ? target
      : target.closest<HTMLDivElement>(".year-cell");
    if (!cell) return;
    const dateStr = cell.dataset.date;
    if (!dateStr) return;
    await onMoveEvent(path, { date: dateStr });
  }

  function goPrev() { setYear(year - 1); }
  function goNext() { setYear(year + 1); }
  function goToday() { setYear(today.getFullYear()); }

  return (
    <div className="year-linear">
      <header className="year-head">
        <div className="year-nav">
          <button className="year-nav-btn" onClick={goPrev} title="Previous year">‹</button>
          <button className="year-nav-btn ghost" onClick={goToday}>today</button>
          <button className="year-nav-btn" onClick={goNext} title="Next year">›</button>
        </div>
        <h2 className="year-label">{year}</h2>
      </header>

      <div className="year-grid">
        {/* Single shared day-of-week header — cell i mod 7 is constant
            across all months because we align days to columns. */}
        <div className="year-corner" />
        {Array.from({ length: ROW_CELLS }).map((_, i) => (
          <div className={"year-dow" + (i % 7 === 0 || i % 7 === 6 ? " weekend" : "")} key={i}>
            {DOW_LETTERS[i % 7]}
          </div>
        ))}

        {MONTH_NAMES.map((monthName, monthIdx) => {
          const first = new Date(year, monthIdx, 1);
          const offset = first.getDay(); // 0 = Sunday
          const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();

          const cells: React.ReactNode[] = [];
          for (let i = 0; i < ROW_CELLS; i++) {
            const dayNum = i - offset + 1;
            const isValid = dayNum >= 1 && dayNum <= daysInMonth;
            const date = isValid ? new Date(year, monthIdx, dayNum) : null;
            const dateStr = date ? isoDate(date) : undefined;
            const isToday = date ? isSameDay(date, today) : false;
            const isWeekend = i % 7 === 0 || i % 7 === 6;
            const events = isValid
              ? eventsByCell.get(cellKey({ month: monthIdx, day: dayNum })) ?? []
              : [];

            cells.push(
              <div
                key={i}
                className={
                  "year-cell" +
                  (isValid ? "" : " empty") +
                  (isToday ? " today" : "") +
                  (isWeekend && isValid ? " weekend" : "")
                }
                data-date={dateStr}
                onDragOver={isValid ? onCellDragOver : undefined}
                onDrop={isValid ? (e) => { void onCellDrop(e); } : undefined}
              >
                {isValid && (
                  <>
                    <span className="year-cell-day">{dayNum}</span>
                    {events.map((note, idx) => (
                      <div
                        key={note.path}
                        className="year-event"
                        style={{ bottom: 2 + idx * 5 }}
                        draggable
                        onDragStart={(e) => onEventDragStart(e, note.path)}
                        onDragEnd={onEventDragEnd}
                        onDragOver={onCellDragOver}
                        onDrop={(e) => { void onCellDrop(e); }}
                        onClick={() => onEventClick?.(note.path)}
                        title={note.title}
                      />
                    ))}
                  </>
                )}
              </div>,
            );
          }
          return (
            <div className="year-month-row" key={monthIdx}>
              <div className={"year-month-label" + (today.getMonth() === monthIdx && today.getFullYear() === year ? " is-today" : "")}>
                {monthName}
              </div>
              {cells}
            </div>
          );
        })}
      </div>
    </div>
  );
}

