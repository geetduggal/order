// Week / Month calendar built on FullCalendar v6 React.
//
// Reads notes' YAML frontmatter (date, startTime, endTime, allDay) in
// the Obsidian Full Calendar Plus convention. Drag and resize rewrite
// the underlying file's frontmatter via the parent's onMoveEvent
// callback; all-day-strip drops convert timed → allDay (dropping
// startTime/endTime), and dragging back into the timed grid restores
// them. Year view is deferred — Full Calendar Plus uses a custom
// LinearView plugin we haven't ported yet.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Download as DownloadIcon, CalendarClock as CalendarClockIcon } from "lucide-react";
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
import { isoDate, isoTime, toIsoDateValue, addMinutesToIsoTime, DEFAULT_EVENT_MINUTES } from "../lib/frontmatter";
import { clearListZoneHighlight } from "../lib/list-cal-dnd";

// Cancel text selection while dragging an event (module-level = stable ref).
const preventSelect = (e: Event) => e.preventDefault();

export type CalendarRange = "timeGridDay" | "timeGridWeek" | "dayGridMonth" | "multiMonthYear";

export interface NoteMeta {
  path: string;
  filename: string;
  title: string;
  frontmatter: Frontmatter;
  /** Notable Folder color applied as the event background tint + border. */
  color?: string;
  /** "High bit for the day": an all-day event in the weekly-hub folder,
   *  rendered as a prominent card in the all-day band. Set upstream (where
   *  the hub folder is known); consumed as a class in the all-day strip. */
  /** A Frontier-folder quick-capture — rendered subtler/lighter. */
  frontier?: boolean;
}

interface Props {
  notes: NoteMeta[];
  initialView: CalendarRange;
  /** ISO date the calendar opens on. CardGrid passes the upcoming Saturday for
   *  the week view so entering it always lands on that week. The calendar
   *  remounts on each view entry, so this applies every time. */
  initialDate?: string;
  onMoveEvent: (path: string, patch: Frontmatter) => Promise<void>;
  /** Pointer x/y are forwarded so the parent can anchor an action menu
   *  next to the click instead of jumping straight into the note. */
  onEventClick?: (path: string, coords?: { x: number; y: number }) => void;
  /** Double-click an event's title to rename it inline. */
  onRenameEvent?: (path: string, title: string) => void;
  onCreate?: (patch: Frontmatter) => Promise<void>;
  /** Currently-active high-level view ("day" | "week" | "month" | "year"
   *  | "season"). The in-shell picker uses this for the active-state
   *  highlight. */
  currentView?: "day" | "week" | "month" | "year" | "season";
  /** Switch to a different calendar view. Routed to the parent so
   *  state stays in CardGrid / ViewerApp. */
  onSelectView?: (v: "day" | "week" | "month" | "year" | "season") => void;
  /** Called with an ISO date string when the user clicks the per-day
   *  import icon in Day / Week time-grid headers (Google). */
  onImportDay?: (dateIso: string) => void;
  /** Same, for the Apple/system calendar. Only passed when the system
   *  calendar is authorized with at least one included calendar. */
  onImportAppleDay?: (dateIso: string) => void;
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

function notesToEvents(notes: NoteMeta[]): EventInput[] {
  const events: EventInput[] = [];
  for (const note of notes) {
    // These NoteMeta are SYNTHESIZED (in CardGrid) from the filename-derived events
    // (buildSpacetime → markdownCalendarNotes) + todo.txt, so their frontmatter
    // already reflects the file names — reading date/time here is correct. The file
    // name is the source of truth one layer up, in buildSpacetime/event-filename.
    const date = toIsoDateValue(note.frontmatter.date);
    if (!date) continue;
    const allDay = note.frontmatter.allDay === true;
    const startTime = typeof note.frontmatter.startTime === "string" ? note.frontmatter.startTime : null;
    const endTime = typeof note.frontmatter.endTime === "string" ? note.frontmatter.endTime : null;
    const endDate = toIsoDateValue(note.frontmatter.endDate);

    const title = note.title || note.filename;
    const completed = note.frontmatter.completed === true;
    // Events wear the same chrome as cards (card surface + hairline via
    // the --fc-event-* tokens in styles.css) — no per-event inline
    // background/border. The folder color survives as a small dot in
    // renderEventContent, mirroring the sidebar swatches, so the
    // calendar scans by color without every event wearing a different
    // colored box.
    // Pass the completion flag + folder color through to
    // renderEventContent via extendedProps. FC's event store passes the
    // props straight through to event.extendedProps.
    // highBit only carries on genuinely all-day events (the hub's "high
    // bits" live in the all-day band); a timed hub event stays normal.
    const location = typeof note.frontmatter.location === "string" ? note.frontmatter.location.trim() : "";
    const extendedProps = { completed, folderColor: note.color ?? null, frontier: note.frontier === true, location };

    if (allDay) {
      events.push({
        id: note.path,
        title,
        start: date,
        // Exclusive end for all-day multi-day spans.
        end: endDate ? addOneDayIso(endDate) : undefined,
        allDay: true,
        extendedProps,
      });
      continue;
    }
    // Timed events (same-day; the convention has no timed multi-day range).
    // No explicit end time → default to a DEFAULT_EVENT_MINUTES (30-min) block, so a
    // `YYYY-MM-DD HHMM Title` event reads as a real half-hour slot, not a zero-width
    // sliver. An explicit end that is ≤ the start crosses midnight → end next day.
    if (!startTime) continue; // unreachable (parser gives time when not all-day), defensive
    const endIsoTime = endTime ?? addMinutesToIsoTime(startTime, DEFAULT_EVENT_MINUTES);
    const endDayIso = endTime && endTime <= startTime ? addOneDayIso(date) : date;
    events.push({
      id: note.path,
      title,
      start: `${date}T${startTime}`,
      end: `${endDayIso}T${endIsoTime}`,
      allDay: false,
      extendedProps,
    });
  }
  return events;
}

/** Initial scroll position for the Day / Week time grids. FC's
 *  `scrollTime` pins the given time to the TOP of the grid, so to land
 *  the current time roughly mid-screen we scroll to now minus ~3.5
 *  hours (half of a typical visible window), clamped to midnight. */
function nowCenteredScrollTime(): string {
  const d = new Date();
  const mins = Math.max(0, d.getHours() * 60 + d.getMinutes() - 210);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}:00`;
}

/** Scroll target that lands a Date near (not jammed against) the top of the
 *  grid — the event's time-of-day minus a short lead-in. Clamped to midnight. */
function leadInScrollTime(d: Date): string {
  const mins = Math.max(0, d.getHours() * 60 + d.getMinutes() - 20);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}:00`;
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
  // Completion comes through extendedProps (set by notesToEvents from
  // the note's frontmatter.completed flag — true for `x ` prefixed
  // todo.txt lines).
  const completed = arg.event.extendedProps?.completed === true;
  // The folder color rides as a small dot (same language as the sidebar
  // swatches) — the event box itself wears the neutral card chrome.
  const folderColor = arg.event.extendedProps?.folderColor as string | null | undefined;
  // Room / location shown subtly after the title (timed events only — the
  // all-day band is too short). Truncated by CSS so it never widens the block.
  const location = arg.event.allDay ? "" : String(arg.event.extendedProps?.location ?? "");
  return (
    <div className={"order-event-row" + (completed ? " is-completed" : "")}>
      {folderColor && <span className="order-event-dot" style={{ background: folderColor }} />}
      <span className="order-event-title">{title}</span>
      {location && <span className="order-event-loc">{location}</span>}
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
  // Phone / narrow tablet: three adjacent columns centered on SATURDAY
  // (Fri / Sat / Sun). Order's week is Saturday-centric — the app badge and
  // the weekly hub both key off the upcoming Saturday — so the narrow view
  // opens with Saturday in the middle and visible, rather than today (which
  // could hide Saturday entirely on, say, a Tuesday). Only a default: a
  // persisted column selection still wins.
  const visible = new Set([5, 6, 0]); // Fri, Sat, Sun
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
  const { notes, initialView, initialDate, onMoveEvent, onImportDay, onImportAppleDay } = props;
  const apiRef = useRef<FullCalendar | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  // One-shot guard so the load-time "scroll to the next event" runs once per
  // mount (CardGrid remounts this on view change), not on every later edit.
  const didAutoScrollRef = useRef(false);
  // Pending single-click action-menu open, held briefly so a double-click (rename
  // inline) can pre-empt it before the menu overlay covers the title.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last event click (id + time), so a second quick click on the same event
  // counts as a double even on touch, where `jsEvent.detail` stays 1.
  const lastClickRef = useRef<{ id: string; t: number } | null>(null);
  // While a calendar event is being dragged, this tracks the pointer so we can
  // highlight the Week hub list zone when the event is over it — and so the drop
  // uses the real release point (FullCalendar's eventDragStop jsEvent coords are
  // unreliable), not a stale one.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
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

  // Day / Week: give FC a bounded height so it scrolls the time grid INTERNALLY
  // and keeps the day-header + all-day strip fixed the way it ships them —
  // WebKit-safe and drag-friendly (FC owns the layout), unlike a CSS sticky pin
  // that WebKit mishandles. Month / Year keep "auto" and page-scroll with the
  // rest of the app. Measured from FC's top edge to the viewport bottom, less
  // the hovering bottom dock; any imprecision only leaves a small gap — the pin
  // itself holds as long as the height is bounded (not "auto").
  const isTimeGrid = initialView === "timeGridDay" || initialView === "timeGridWeek";
  const [calHeight, setCalHeight] = useState<number | "auto">(isTimeGrid ? 640 : "auto");
  useEffect(() => {
    if (!isTimeGrid) { setCalHeight("auto"); return; }
    const measure = () => {
      const fcEl = shellRef.current?.querySelector(".fc") as HTMLElement | null;
      if (!fcEl) return;
      const top = fcEl.getBoundingClientRect().top;
      // Minimal bottom clearance — the hovering dock is translucent and floats,
      // so the grid runs almost to the bottom edge (immersive) and the dock
      // overlays its lowest strip rather than reserving a big empty gap.
      const DOCK = 34;
      setCalHeight(Math.max(360, Math.round(window.innerHeight - top - DOCK)));
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", measure); };
  }, [isTimeGrid]);

  // Month view defaults to all-day-only (matching the year strip) so
  // a busy timed-event load doesn't crowd the cell grid. Day / Week
  // default off — those scales have room for timed bars. Toggle is
  // available in every view for symmetry.
  const isMonth = initialView === "dayGridMonth" || initialView === "multiMonthYear";
  const [allDayOnly, setAllDayOnly] = useState<boolean>(isMonth);
  const visibleNotes = useMemo(() => {
    if (!allDayOnly) return notes;
    return notes.filter((n) => {
      const allDay = n.frontmatter.allDay === true || !n.frontmatter.startTime;
      return allDay;
    });
  }, [notes, allDayOnly]);
  const events = useMemo(() => notesToEvents(visibleNotes), [visibleNotes]);

  // Auto-scroll (Day / Week) to the NEXT upcoming timed event in the visible
  // range, so opening the calendar lands you on what's next instead of a fixed
  // now-centered position. Guarded to fire once per "open" — driven by both the
  // events effect (notes load async) and FullCalendar's `datesSet` (fires after
  // the grid is laid out, so the scroll actually sticks when switching pile →
  // calendar). Refs keep the callback stable. Falls back to now-centered.
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const autoScrollToNext = useCallback(() => {
    if (didAutoScrollRef.current) return;
    const api = apiRef.current?.getApi();
    if (!api) return;
    const view = api.view;
    if (view.type !== "timeGridDay" && view.type !== "timeGridWeek") return;
    const rangeStart = view.activeStart.getTime();
    const rangeEnd = view.activeEnd.getTime();
    const now = Date.now();
    let next: Date | null = null;
    for (const ev of eventsRef.current) {
      if (ev.allDay || typeof ev.start !== "string") continue;
      const d = new Date(ev.start);
      const t = d.getTime();
      if (Number.isNaN(t) || t < rangeStart || t >= rangeEnd || t < now) continue;
      if (!next || d < next) next = d;
    }
    api.scrollToTime(next ? leadInScrollTime(next) : nowCenteredScrollTime());
    // Only lock once real events exist; an empty first render (notes not loaded
    // yet) shouldn't freeze the now-centered fallback in place.
    if (eventsRef.current.length > 0) didAutoScrollRef.current = true;
  }, []);
  useEffect(() => {
    if (!isTimeGrid) return;
    const id = requestAnimationFrame(autoScrollToNext);
    return () => cancelAnimationFrame(id);
  }, [events, isTimeGrid, autoScrollToNext]);

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
    const coords = { x: e.clientX, y: e.clientY };
    const id = arg.event.id;
    const now = Date.now();
    // Double = detail>=2 (mouse) OR a second quick tap on the same event (touch,
    // where detail stays 1). Must beat the 300ms menu delay below.
    const prev = lastClickRef.current;
    const isDouble = e.detail >= 2 || (!!prev && prev.id === id && now - prev.t < 280);
    lastClickRef.current = { id, t: now };
    // Double-click a titled event → rename it inline. Cancel the pending
    // single-click menu so its overlay doesn't cover the title.
    if (props.onRenameEvent && isDouble) {
      if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
      lastClickRef.current = null;
      startInlineTitleEdit(arg.el, id, arg.event.title);
      return;
    }
    // Single click → open the action menu. When rename is supported, wait a beat
    // so a following double-click/tap can pre-empt it (the menu's fixed overlay
    // would otherwise swallow the second click). Without rename, open at once.
    if (!props.onRenameEvent) { props.onEventClick?.(id, coords); return; }
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      props.onEventClick?.(id, coords);
    }, 300);
  }

  // Turn an event's `.order-event-title` into an inline-editable field.
  function startInlineTitleEdit(eventEl: HTMLElement, eventId: string, origTitle: string) {
    if (!props.onRenameEvent) return;
    const titleEl = eventEl.querySelector(".order-event-title") as HTMLElement | null;
    if (!titleEl) return;
    titleEl.contentEditable = "true";
    titleEl.spellcheck = false;
    titleEl.style.whiteSpace = "normal";
    titleEl.style.overflow = "visible";
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const onKey = (ke: KeyboardEvent) => {
      // FullCalendar treats an event element like a button — Space/Enter "activate"
      // it — so without this the keystrokes never reach the contentEditable (Space
      // did nothing while typing a title). Stop propagation so typing goes to the
      // field; we still handle Enter/Escape ourselves.
      ke.stopPropagation();
      if (ke.key === "Enter") { ke.preventDefault(); titleEl.blur(); }
      if (ke.key === "Escape") { ke.preventDefault(); titleEl.textContent = origTitle; titleEl.blur(); }
    };
    const cleanup = () => {
      titleEl.contentEditable = "false";
      titleEl.style.whiteSpace = "";
      titleEl.style.overflow = "";
      titleEl.removeEventListener("keydown", onKey);
    };
    const commit = () => {
      const next = (titleEl.textContent ?? "").trim();
      cleanup();
      if (next && next !== origTitle) props.onRenameEvent?.(eventId, next);
      else titleEl.textContent = origTitle;
    };
    titleEl.addEventListener("blur", commit, { once: true });
    titleEl.addEventListener("keydown", onKey);
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
      // A bare click (no drag) gives a zero-length range — default it to a
      // half-hour span so the event lands with a real endTime in its YAML.
      const startTime = isoTime(start);
      await props.onCreate({
        date: isoDate(start),
        allDay: false,
        startTime,
        endTime: sameInstant ? addMinutesToIsoTime(startTime, DEFAULT_EVENT_MINUTES) : isoTime(end),
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
  const { currentView, onSelectView } = props;

  return (
    <div className={`fc-shell${isWeek ? " fc-shell-week" : ""}${isTimeGrid ? " fc-shell-timegrid" : ""}`} ref={shellRef}>
      <div className="fc-top-controls">
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
      <FullCalendar
        ref={(instance) => {
          apiRef.current = instance;
          rememberApi(instance?.getApi() ?? null);
        }}
        plugins={[dayGridPlugin, timeGridPlugin, multiMonthPlugin, interactionPlugin]}
        initialView={initialView}
        initialDate={initialDate}
        // Multi-month opens on the CURRENT month (aligned to it, not January) and
        // runs 12 months forward as a single scrollable column, so "now" is first
        // and the future scrolls below — instead of a fixed Jan–Dec year grid.
        views={{
          multiMonthYear: {
            duration: { months: 12 },
            dateAlignment: "month",
            multiMonthMaxColumns: 1,
          },
        }}
        events={events}
        editable
        droppable
        selectable
        selectMirror
        nowIndicator
        firstDay={isWeek ? weekFirstDay : 0}
        hiddenDays={isWeek ? weekHidden : undefined}
        height={calHeight}
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
        // 30-min visual slots, but drags snap to 15-min for finer placement.
        slotDuration="00:30:00"
        snapDuration="00:15:00"
        // Events without an explicit endTime render as a half hour (not
        // FullCalendar's built-in one-hour default) — matches the duration
        // we write for click/Cmd+N-created events and the 30-min slot grid.
        defaultTimedEventDuration="00:30:00"
        // Open Day / Week scrolled so the current time sits mid-screen
        // (scrollTime pins to the top; the helper backs off ~3.5h).
        // Month / multi-month ignore this. scrollTimeReset keeps the
        // same anchor when paging prev/next instead of snapping to 06:00.
        scrollTime={nowCenteredScrollTime()}
        scrollTimeReset={false}
        // Fires after the view is rendered/laid out — the reliable moment to
        // land the scroll on the next event (esp. when switching pile → cal,
        // where a mount-time rAF runs before FC has sized the grid).
        datesSet={() => { requestAnimationFrame(autoScrollToNext); }}
        // Event content is rendered manually (see renderEventContent) so
        // FC's range formatter can't sneak a trailing separator in.
        // displayEventTime: false fully silences FC's default time
        // element — without it, the default time was still being added
        // beside our custom one and overflow-clipped to "10 —".
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false, omitZeroMinute: true }}
        displayEventTime={false}
        // While dragging an event, light up the list zone when the pointer is
        // over it, so it's clear the event can be dropped there.
        eventDragStart={() => {
          document.body.classList.add("is-tile-dragging");
          document.addEventListener("selectstart", preventSelect);
          // Clear any selection begun during the pre-drag threshold movement —
          // user-select:none stops NEW selection but not an existing one.
          try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
        }}
        // Drag a timed event up onto the Week hub's list zone → move it there:
        // emit for the list to append + CardGrid to delete. Dropped outside the
        // grid, FullCalendar reverts the event on its own.
        eventDragStop={(info) => {
          document.body.classList.remove("is-tile-dragging");
          document.removeEventListener("selectstart", preventSelect);
          clearListZoneHighlight();
          lastPointerRef.current = null;
          // The old drag-to-the-weekly-hub-list handoff is gone with the Frontier
          // change; normal reschedule still happens via eventDrop, untouched.
        }}
        eventContent={renderEventContent}
        // Frontier-folder quick-captures render subtler/lighter (see
        // .order-event-frontier) so the inbox doesn't visually dominate.
        eventClassNames={(arg) =>
          arg.event.extendedProps?.frontier ? ["order-event-frontier"] : []
        }
        dayHeaderContent={(arg) => {
          const iso = arg.date.toISOString().slice(0, 10);
          const isTimeGrid = arg.view.type === "timeGridDay" || arg.view.type === "timeGridWeek";
          return (
            <span className="fc-day-header-inner">
              <span>{arg.text}</span>
              {isTimeGrid && onImportDay && (
                <button
                  type="button"
                  className="fc-day-import-btn"
                  title="Import this day from Google"
                  aria-label="Import this day from Google"
                  onClick={(e) => { e.stopPropagation(); onImportDay(iso); }}
                >
                  <DownloadIcon size={11} strokeWidth={2.2} />
                </button>
              )}
              {isTimeGrid && onImportAppleDay && (
                <button
                  type="button"
                  className="fc-day-import-btn fc-day-import-apple"
                  title="Import this day from the system calendar"
                  aria-label="Import this day from the system calendar"
                  onClick={(e) => { e.stopPropagation(); onImportAppleDay(iso); }}
                >
                  <CalendarClockIcon size={11} strokeWidth={2.2} />
                </button>
              )}
            </span>
          );
        }}
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
