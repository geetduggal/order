// Year view — linear strip layout (ported from Full Calendar Plus).
//
// 12 month rows, each a 37-cell strip aligned to day-of-week columns
// (weekends form vertical stripes). Events are absolutely positioned in
// a per-month overlay so multi-day spans render as one continuous bar
// across cells; spans that cross month boundaries split into segments,
// one per row. Stacking is greedy: each event takes the lowest free
// row in its month-strip that doesn't conflict horizontally.
//
// Click an empty cell → new all-day event on that date.
// Click an event bar → flip to Stream and pulse the matching card.
// Drag an event bar → rewrite its `date` (single-day events only for
// now; multi-day drag preserves the duration, just shifts the start).

import { useEffect, useMemo, useState } from "react";
import { isoDate, type Frontmatter } from "../lib/frontmatter";
import { isSameDay, parseIsoDate } from "../lib/calendar";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const DOW_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const ROW_CELLS = 37; // 31-day month starting Saturday needs 6 + 31 = 37

const DAY_LABEL_PX = 14;     // height reserved for the cell's day number
const EVENT_PX = 17;         // height of each event bar
const EVENT_GAP_PX = 2;      // vertical gap between stacked bars
const CELL_BOTTOM_PAD_PX = 4;
const MIN_EVENT_ROWS = 2;    // baseline empty rows so cells aren't tiny

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
}

interface Props {
  notes: NoteMeta[];
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  onCreate?: (patch: Frontmatter) => Promise<void>;
  onEventClick?: (path: string) => void;
}

interface PositionedEvent {
  note: NoteMeta;
  /** First cell index (0..36) within this month row. */
  startCell: number;
  /** Last cell index (0..36, inclusive) within this month row. */
  endCell: number;
  /** Stack row (0 = topmost). */
  row: number;
  /** Span continuation markers when the event extends past this month. */
  continuesLeft: boolean;
  continuesRight: boolean;
}

interface MonthLayout {
  events: PositionedEvent[];
  rowCount: number;
}

function packIntoMonth(
  year: number,
  monthIdx: number,
  notes: NoteMeta[],
): MonthLayout {
  const monthStart = new Date(year, monthIdx, 1);
  const monthEnd = new Date(year, monthIdx + 1, 0);
  const offset = monthStart.getDay(); // 0 = Sunday
  const daysInMonth = monthEnd.getDate();

  // Build raw spans (clipped to this month) sorted by start.
  type Raw = {
    note: NoteMeta;
    startCell: number;
    endCell: number;
    continuesLeft: boolean;
    continuesRight: boolean;
  };
  const raw: Raw[] = [];
  for (const note of notes) {
    const dateStr = note.frontmatter.date;
    if (typeof dateStr !== "string") continue;
    const start = parseIsoDate(dateStr);
    if (!start) continue;
    const endStr = note.frontmatter.endDate;
    const explicitEnd = typeof endStr === "string" ? parseIsoDate(endStr) : null;
    const end = explicitEnd ?? start;

    const clipStart = start < monthStart ? monthStart : start;
    const clipEnd = end > monthEnd ? monthEnd : end;
    if (clipStart > monthEnd || clipEnd < monthStart) continue;

    const startCell = offset + (clipStart.getDate() - 1);
    const endCell = offset + (clipEnd.getDate() - 1);
    raw.push({
      note,
      startCell,
      endCell,
      continuesLeft: start < monthStart,
      continuesRight: end > monthEnd,
    });
  }
  raw.sort((a, b) => a.startCell - b.startCell || a.endCell - b.endCell);

  // Greedy stacking: lowest free row that doesn't horizontally overlap.
  const rows: Array<Array<[number, number]>> = [];
  const events: PositionedEvent[] = [];
  for (const r of raw) {
    let assigned = -1;
    for (let i = 0; i < rows.length; i++) {
      const conflict = rows[i].some(([s, e]) => !(r.endCell < s || r.startCell > e));
      if (!conflict) { assigned = i; break; }
    }
    if (assigned === -1) {
      assigned = rows.length;
      rows.push([]);
    }
    rows[assigned].push([r.startCell, r.endCell]);
    events.push({ ...r, row: assigned });
  }

  return { events, rowCount: Math.max(MIN_EVENT_ROWS, rows.length) };
}

export function YearLinearView({ notes, onMoveEvent, onCreate, onEventClick }: Props) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());

  // Mouse-drag selection state. anchor = mousedown date, hover = the
  // most recent cell the mouse entered. While both are set we render a
  // coral preview band across the inferred range, and a global mouseup
  // listener commits the range as a new event.
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [hover, setHover] = useState<Date | null>(null);

  const monthLayouts = useMemo(
    () => Array.from({ length: 12 }, (_, m) => packIntoMonth(year, m, notes)),
    [year, notes],
  );

  // Range as inclusive [lo, hi] dates regardless of drag direction.
  const dragRange = useMemo(() => {
    if (!anchor || !hover) return null;
    const lo = anchor <= hover ? anchor : hover;
    const hi = anchor <= hover ? hover : anchor;
    return { lo, hi };
  }, [anchor, hover]);

  function isInDragRange(date: Date): boolean {
    if (!dragRange) return false;
    const t = date.getTime();
    return t >= dragRange.lo.getTime() && t <= dragRange.hi.getTime();
  }

  // Commit the drag on mouseup — anywhere on the document, so releasing
  // off the grid still finishes the selection cleanly.
  useEffect(() => {
    if (!anchor || !hover) return;
    function commit() {
      if (!anchor || !hover || !onCreate) {
        setAnchor(null); setHover(null); return;
      }
      const lo = anchor <= hover ? anchor : hover;
      const hi = anchor <= hover ? hover : anchor;
      const patch: Frontmatter = { date: isoDate(lo), allDay: true };
      if (!isSameDay(lo, hi)) patch.endDate = isoDate(hi);
      void onCreate(patch);
      setAnchor(null); setHover(null);
    }
    window.addEventListener("mouseup", commit);
    return () => window.removeEventListener("mouseup", commit);
  }, [anchor, hover, onCreate]);

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
  async function onCellDrop(e: React.DragEvent<HTMLDivElement>, dateStr: string) {
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData("text/plain");
    if (!path) return;
    await onMoveEvent(path, { date: dateStr });
  }

  function onCellMouseDown(e: React.MouseEvent<HTMLDivElement>, date: Date) {
    // Only start a drag for primary button on empty cell area; clicks
    // on an event bar set their own draggable handler.
    if (e.button !== 0) return;
    setAnchor(date);
    setHover(date);
  }
  function onCellMouseEnter(date: Date) {
    if (anchor) setHover(date);
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

      <div className="year-strip-header">
        <div className="year-corner" />
        {Array.from({ length: ROW_CELLS }).map((_, i) => (
          <div
            className={"year-dow" + (i % 7 === 0 || i % 7 === 6 ? " weekend" : "")}
            key={i}
          >
            {DOW_LETTERS[i % 7]}
          </div>
        ))}
      </div>

      {MONTH_NAMES.map((monthName, monthIdx) => {
        const first = new Date(year, monthIdx, 1);
        const offset = first.getDay();
        const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();
        const layout = monthLayouts[monthIdx];
        const overlayHeight = layout.rowCount * (EVENT_PX + EVENT_GAP_PX);
        const cellHeight = DAY_LABEL_PX + overlayHeight + CELL_BOTTOM_PAD_PX;
        const isTodayMonth = today.getMonth() === monthIdx && today.getFullYear() === year;

        return (
          <div className="year-month" key={monthIdx} style={{ minHeight: cellHeight }}>
            <div className={"year-month-label" + (isTodayMonth ? " is-today" : "")}>
              {monthName}
            </div>
            {Array.from({ length: ROW_CELLS }).map((_, i) => {
              const dayNum = i - offset + 1;
              const isValid = dayNum >= 1 && dayNum <= daysInMonth;
              const date = isValid ? new Date(year, monthIdx, dayNum) : null;
              const dateStr = date ? isoDate(date) : undefined;
              const isToday = date ? isSameDay(date, today) : false;
              const isWeekend = i % 7 === 0 || i % 7 === 6;
              const inRange = isValid && date ? isInDragRange(date) : false;
              return (
                <div
                  key={i}
                  className={
                    "year-cell" +
                    (isValid ? "" : " empty") +
                    (isToday ? " today" : "") +
                    (isWeekend && isValid ? " weekend" : "") +
                    (inRange ? " in-drag-range" : "")
                  }
                  data-date={dateStr}
                  onDragOver={isValid ? onCellDragOver : undefined}
                  onDrop={isValid && dateStr ? (e) => { void onCellDrop(e, dateStr); } : undefined}
                  onMouseDown={isValid && date ? (e) => onCellMouseDown(e, date) : undefined}
                  onMouseEnter={isValid && date ? () => onCellMouseEnter(date) : undefined}
                >
                  {isValid && <span className="year-cell-day">{dayNum}</span>}
                </div>
              );
            })}

            {/* Event overlay — absolutely positioned bars over the cell strip. */}
            <div
              className="year-month-overlay"
              style={{ height: overlayHeight, top: DAY_LABEL_PX }}
            >
              {layout.events.map(({ note, startCell, endCell, row, continuesLeft, continuesRight }) => {
                const leftPct = (startCell / ROW_CELLS) * 100;
                const widthPct = ((endCell - startCell + 1) / ROW_CELLS) * 100;
                const cls =
                  "year-event" +
                  (continuesLeft ? " continues-left" : "") +
                  (continuesRight ? " continues-right" : "");
                const isAllDay = note.frontmatter.allDay === true || !note.frontmatter.startTime;
                return (
                  <div
                    key={note.path + ":" + startCell}
                    className={cls + (isAllDay ? " all-day" : " timed")}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: row * (EVENT_PX + EVENT_GAP_PX),
                      height: EVENT_PX,
                    }}
                    draggable
                    onDragStart={(e) => onEventDragStart(e, note.path)}
                    onDragEnd={onEventDragEnd}
                    // Stop mousedown bubbling so clicking an event bar
                    // doesn't start a cell drag-to-create selection.
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onEventClick?.(note.path); }}
                    title={note.title}
                  >
                    <span className="year-event-title">{note.title}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

