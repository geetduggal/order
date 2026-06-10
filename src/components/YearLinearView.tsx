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

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from "react";
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

/** Coerce a YAML date value (string or js-yaml-parsed Date) into a
 *  local-midnight Date suitable for the linear-strip math. js-yaml
 *  hands us a UTC-midnight Date for unquoted YYYY-MM-DD, which can
 *  shift the calendar day in timezones west of UTC — normalize to
 *  the YMD parts via getUTC* and rebuild as a local-midnight Date. */
function toLocalDate(v: unknown): Date | null {
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return parseIsoDate(s.slice(0, 10));
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
  }
  if (v instanceof Date && !isNaN(v.getTime())) {
    return new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  }
  return null;
}

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
  /** Optional notable-folder color, threaded from CardGrid /
   *  ViewerApp so the linear strip tints each bar in the same
   *  palette CalendarView uses. */
  color?: string;
}

interface Props {
  notes: NoteMeta[];
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  onCreate?: (patch: Frontmatter) => Promise<void>;
  /** Pointer x/y forwarded so the parent can anchor an action menu at
   *  the click instead of jumping straight into the note. */
  onEventClick?: (path: string, coords?: { x: number; y: number }) => void;
  /** High-level calendar view picker — surfaced inside the year head
   *  so users can switch to Day/Week/Month without round-tripping to
   *  the sidebar. */
  currentView?: "day" | "week" | "month" | "year" | "season";
  onSelectView?: (v: "day" | "week" | "month" | "year" | "season") => void;
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
    // js-yaml parses unquoted YYYY-MM-DD as Date — accept both string
    // and Date here so Readwise-sync entries (unquoted) line up with
    // manually-typed quoted dates.
    const start = toLocalDate(note.frontmatter.date);
    if (!start) continue;
    const end = toLocalDate(note.frontmatter.endDate) ?? start;

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

export interface YearLinearViewHandle {
  prev(): void;
  next(): void;
  today(): void;
}

export const YearLinearView = forwardRef<YearLinearViewHandle, Props>(function YearLinearView(
  { notes, onMoveEvent, onCreate, onEventClick, currentView, onSelectView },
  navRef,
) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  useImperativeHandle(navRef, () => ({
    prev: () => setYear((y) => y - 1),
    next: () => setYear((y) => y + 1),
    today: () => setYear(today.getFullYear()),
  }), [today]);

  // Pointer-drag selection state. anchor = pointerdown date, hover = the
  // most recent cell the pointer entered. While both are set we render a
  // coral preview band across the inferred range, and a global pointerup
  // listener commits the range as a new event. Pointer events are used
  // (rather than mouse-only) so a single tap on iOS becomes a "create at
  // this date" gesture rather than a dead click — the previous mouse
  // listeners weren't reaching the WKWebView reliably on touch.
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [hover, setHover] = useState<Date | null>(null);

  // All-day filter. Default ON — at year zoom-out the timed entries
  // (meetings, classes) overwhelm the canvas and the wide spans that
  // actually read at this scale are the all-day ones (trips, book
  // reads, sprints, holiday holds). Flip OFF to widen back to every
  // event.
  const [allDayOnly, setAllDayOnly] = useState(true);

  const visibleNotes = useMemo(() => {
    return notes.filter((n) => {
      const explicitAllDay = n.frontmatter.allDay === true;
      const hasStartTime = typeof n.frontmatter.startTime === "string";
      // Skip date-only references (Readwise imports etc.) — they're
      // not calendar events regardless of view.
      if (!explicitAllDay && !hasStartTime) return false;
      if (!allDayOnly) return true;
      return explicitAllDay;
    });
  }, [notes, allDayOnly]);

  const monthLayouts = useMemo(
    () => Array.from({ length: 12 }, (_, m) => packIntoMonth(year, m, visibleNotes)),
    [year, visibleNotes],
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

  // Commit the drag on pointerup — anywhere on the document, so releasing
  // off the grid still finishes the selection cleanly. Pointer events
  // cover mouse, touch, and pen with one listener — on iOS a single tap
  // triggers down + up here, creating a single-day all-day event for
  // that cell. Pointermove during the press hovers the range so a tap-
  // and-drag across cells turns into a multi-day span.
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
    function move(e: PointerEvent) {
      // Touch / iPad: pointermove targets the original press element, so
      // hover tracking would freeze. Resolve the actual cell under the
      // finger via elementFromPoint and read its `data-date`.
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const cell = el?.closest<HTMLElement>(".year-cell[data-date]");
      const ds = cell?.dataset.date;
      if (!ds) return;
      const d = parseIsoDate(ds);
      if (d) setHover(d);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", commit);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", commit);
    };
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
  async function onCellDrop(e: React.DragEvent<HTMLDivElement>, dropDateStr: string) {
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData("text/plain");
    if (!path) return;
    const note = notes.find((n) => n.path === path);
    if (!note) return;

    const original = toLocalDate(note.frontmatter.date);
    const drop = parseIsoDate(dropDateStr);
    if (!original || !drop) return;

    // Delta in whole days — multi-day events shift BOTH date and
    // endDate by the same amount so the span preserves duration.
    const deltaMs = drop.getTime() - original.getTime();
    const patch: Frontmatter = { date: dropDateStr };

    const endStr = note.frontmatter.endDate;
    if (typeof endStr === "string") {
      const origEnd = parseIsoDate(endStr);
      if (origEnd) {
        patch.endDate = isoDate(new Date(origEnd.getTime() + deltaMs));
      }
    }
    await onMoveEvent(path, patch);
  }

  function onCellPointerDown(e: React.PointerEvent<HTMLDivElement>, date: Date) {
    // Primary button / touch / pen — anything that's not a secondary
    // mouse button. The drag-to-create flow listens on the window for
    // pointermove + pointerup so a release outside the grid still
    // commits cleanly.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    setAnchor(date);
    setHover(date);
  }

  function goPrev() { setYear(year - 1); }
  function goNext() { setYear(year + 1); }
  function goToday() { setYear(today.getFullYear()); }

  return (
    <div className="year-linear">
      <div className="fc-top-controls">
        <button
          type="button"
          className={"fc-allday-toggle" + (allDayOnly ? " is-on" : " is-off")}
          onClick={() => setAllDayOnly((v) => !v)}
          aria-pressed={allDayOnly}
          title={allDayOnly ? "Show timed events too" : "Show only all-day events"}
        >
          all-day only
        </button>
        {onSelectView && currentView && (
          <div className="fc-view-switch" role="tablist" aria-label="Calendar view">
            {(["day", "week", "month", "year", "season"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={currentView === v}
                className={"fc-view-tab" + (currentView === v ? " is-on" : "")}
                onClick={() => onSelectView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        )}
      </div>
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
                  onPointerDown={isValid && date ? (e) => onCellPointerDown(e, date) : undefined}
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
                const isAllDay = note.frontmatter.allDay === true;
                // Use the note's folder color (matching CalendarView): a
                // 29-alpha tint as background, full color as left
                // accent. Without a color we fall back to the royal /
                // coral default via CSS class.
                const colorStyle: React.CSSProperties = note.color
                  ? { backgroundColor: note.color + "29", borderLeftColor: note.color }
                  : {};
                return (
                  <div
                    key={note.path + ":" + startCell}
                    className={cls + (isAllDay ? " all-day" : " timed")}
                    style={{
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      top: row * (EVENT_PX + EVENT_GAP_PX),
                      height: EVENT_PX,
                      ...colorStyle,
                    }}
                    draggable
                    onDragStart={(e) => onEventDragStart(e, note.path)}
                    onDragEnd={onEventDragEnd}
                    // Stop pointerdown bubbling so tapping an event bar
                    // doesn't start a cell drag-to-create selection.
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onEventClick?.(note.path, { x: e.clientX, y: e.clientY }); }}
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
});

