// todo.txt parser and serializer.
//
// Order extends the standard todo.txt format with three calendar
// conventions on top of the metadata-extension mechanism:
//
//   due:YYYY-MM-DD HH:MM   timed event, default 30 min
//   end:HH:MM              optional end time, overrides default duration
//   due:YYYY-MM-DD         single-day all-day event (no time after date)
//   <end-date> <start-date> at the head of the line — multi-day all-day
//     span. End first / start second matches todo.txt's completion
//     date ordering convention.
//
// `x ` prefix marks completion in the standard sense. Order keeps
// completed lines on the calendar with a strikethrough rather than
// hiding them — the spec explicitly says completed lines should show.
//
// All non-event lines (plain undated tasks) are still parsed so the
// serializer can preserve them; the calendar layer ignores items
// without a date.

export const DEFAULT_TODO_TXT_PATH = "todo.txt";

// ---------- Settings persistence ----------
//
// Two tiny localStorage-backed slots: whether the calendar treats
// `todo.txt` as a calendar event source, and the vault-relative path
// to use. A custom `order:todoTxt` event lets consumers subscribe to
// changes (same pattern theme + text-scale already use).

const ENABLED_KEY = "order.todoTxt.enabled";
const PATH_KEY = "order.todoTxt.path";
const SETTINGS_EVENT = "order:todoTxt";

export interface TodoTxtSettings {
  enabled: boolean;
  path: string;
}

export function getTodoTxtSettings(): TodoTxtSettings {
  let enabled = false;
  let path = DEFAULT_TODO_TXT_PATH;
  try {
    enabled = localStorage.getItem(ENABLED_KEY) === "1";
    const p = localStorage.getItem(PATH_KEY);
    if (p && p.trim()) path = p.trim();
  } catch { /* localStorage unavailable */ }
  return { enabled, path };
}

export function setTodoTxtSettings(next: Partial<TodoTxtSettings>): TodoTxtSettings {
  const cur = getTodoTxtSettings();
  const merged: TodoTxtSettings = {
    enabled: next.enabled ?? cur.enabled,
    path: (next.path ?? cur.path).trim() || DEFAULT_TODO_TXT_PATH,
  };
  try {
    localStorage.setItem(ENABLED_KEY, merged.enabled ? "1" : "0");
    localStorage.setItem(PATH_KEY, merged.path);
  } catch { /* non-fatal */ }
  window.dispatchEvent(new CustomEvent<TodoTxtSettings>(SETTINGS_EVENT, { detail: merged }));
  return merged;
}

/** Subscribe to settings changes for the lifetime of the caller's
 *  effect. Returns the cleanup. */
export function subscribeTodoTxtSettings(fn: (s: TodoTxtSettings) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<TodoTxtSettings>).detail);
  window.addEventListener(SETTINGS_EVENT, handler);
  return () => window.removeEventListener(SETTINGS_EVENT, handler);
}

/** Identifies a synthetic NoteMeta path as belonging to a todo.txt
 *  line. Format: `<vault-rel-path>#L<index>`. */
export function isTodoTxtPath(path: string): boolean {
  return /\.txt#L\d+$/.test(path);
}

export function splitTodoTxtPath(path: string): { file: string; index: number } | null {
  const m = path.match(/^(.+\.txt)#L(\d+)$/);
  if (!m) return null;
  return { file: m[1], index: Number(m[2]) };
}

export function makeTodoTxtPath(file: string, index: number): string {
  return `${file}#L${index}`;
}

export interface TodoItem {
  /** Original line, for round-trip preservation of unrecognised
   *  metadata or comments. */
  raw: string;
  /** Line index in the file. Used as a stable id for the synthetic
   *  `todo.txt#L<index>` path the calendar wires up. */
  index: number;
  completed: boolean;
  /** Single uppercase letter A-Z when present. */
  priority?: string;
  /** Event start date (YYYY-MM-DD) — from `due:`, the second of the
   *  leading date pair, or the standalone first leading date. */
  due?: string;
  /** Time of day from `due:DATE HH:MM`. */
  startTime?: string;
  /** End time from `end:HH:MM`. */
  endTime?: string;
  /** End date for a multi-day all-day span (the FIRST of the leading
   *  date pair, since todo.txt orders dates completion-then-creation). */
  endDate?: string;
  /** True when the item is an all-day event (single or multi-day). */
  allDay: boolean;
  /** Task body with metadata tokens stripped. */
  text: string;
  /** First `+project` token, verbatim (no case expansion). */
  project?: string;
}

const PRIORITY_RE = /^\(([A-Z])\)\s+/;
const DUE_DATE_TIME_RE = /\bdue:(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/;
const END_TIME_RE = /\bend:(\d{2}:\d{2})/;
const PROJECT_RE = /(?:^|\s)\+(\S+)/;
const LEADING_TWO_DATES_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+/;
const LEADING_DATE_RE = /^(\d{4}-\d{2}-\d{2})\s+/;

function isDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseTodoTxt(body: string): TodoItem[] {
  const out: TodoItem[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    // Legacy mirror line — an earlier build of Order wrote `path:` to
    // tag mirrored .md events. The vault-relative path can contain
    // spaces, so we can't reliably token-strip it; instead, drop the
    // whole line so it doesn't render as a calendar chip. The cleanup
    // pass in CardGrid re-serializes without these, wiping them.
    if (raw.includes("path:")) continue;
    let rest = raw;
    let completed = false;
    let priority: string | undefined;

    // 1. Completion prefix `x ` (lowercase, with trailing space).
    if (rest.startsWith("x ")) {
      completed = true;
      rest = rest.slice(2);
    }

    // 2. Priority `(A) ` — allowed after the `x ` completion marker too.
    const pm = rest.match(PRIORITY_RE);
    if (pm) {
      priority = pm[1];
      rest = rest.slice(pm[0].length);
    }

    // 3. Leading date pair — multi-day all-day, end date first.
    //    A two-date prefix also covers the standard todo.txt "completion
    //    creation" pair on completed lines; either way we treat dates[0]
    //    as the span end and dates[1] as the span start.
    let due: string | undefined;
    let endDate: string | undefined;
    const two = rest.match(LEADING_TWO_DATES_RE);
    if (two) {
      endDate = two[1];
      due = two[2];
      rest = rest.slice(two[0].length);
    } else {
      const one = rest.match(LEADING_DATE_RE);
      if (one) {
        // A single leading date — standard todo.txt creation date.
        // Treat as a single-day all-day event so the line still shows
        // up on the calendar (matches todo.txt convention where the
        // creation date doubles as the "when" anchor).
        due = one[1];
        rest = rest.slice(one[0].length);
      }
    }

    // 4. `due:` metadata. Overrides the leading-date interpretation
    //    when both are present (an explicit `due:` is louder than a
    //    creation-date prefix).
    let startTime: string | undefined;
    const dm = rest.match(DUE_DATE_TIME_RE);
    if (dm) {
      due = dm[1];
      startTime = dm[2];
      rest = rest.replace(DUE_DATE_TIME_RE, "");
    }

    // 5. `end:HH:MM` — drops out of the visible text.
    let endTime: string | undefined;
    const em = rest.match(END_TIME_RE);
    if (em) {
      endTime = em[1];
      rest = rest.replace(END_TIME_RE, "");
    }

    // 6. First `+project` token — left in `text` for the user's eyes
    //    but also exposed as a structured field so the calendar layer
    //    can map it to a Notable Folder.
    let project: string | undefined;
    const prm = rest.match(PROJECT_RE);
    if (prm) project = prm[1];

    const text = rest.replace(/\s{2,}/g, " ").trim();
    const allDay = !!due && !startTime;

    out.push({
      raw,
      index: i,
      completed,
      ...(priority ? { priority } : {}),
      ...(due ? { due } : {}),
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
      ...(endDate ? { endDate } : {}),
      allDay,
      text,
      ...(project ? { project } : {}),
    });
  }
  return out;
}

/** Width of the date/time prefix column. Picked so the three shapes
 *  fit naturally:
 *
 *    due:YYYY-MM-DD HH:MM  (20)  + 1 trailing space  = 21
 *    YYYY-MM-DD YYYY-MM-DD (21)                       = 21
 *    due:YYYY-MM-DD       (14)  + 7 trailing spaces  = 21
 *
 *  Padding to a single column means every description starts at the
 *  same byte offset so the file reads like a table, both in Order's
 *  monospace card and in any external editor. */
const PREFIX_COL = 21;

/** Build a canonical line for an item: optional completion + priority
 *  lead, then a date/time prefix padded to a fixed column, then the
 *  description, then trailing metadata (`end:`, `path:`). The
 *  alignment is intentional — never collapse the padding spaces. */
export function formatTodoItem(item: TodoItem): string {
  const lead: string[] = [];
  if (item.completed) lead.push("x");
  if (item.priority) lead.push(`(${item.priority})`);

  let dateChunk = "";
  if (item.endDate && item.due && item.allDay) {
    // Multi-day all-day — leading date pair (end first, start second),
    // matching todo.txt's completion-creation ordering.
    dateChunk = `${item.endDate} ${item.due}`;
  } else if (item.due && item.startTime) {
    dateChunk = `due:${item.due} ${item.startTime}`;
  } else if (item.due) {
    // Single-day all-day uses the `due:` keyword so a hand-edited file
    // with a creation-date prefix doesn't get downgraded to untimed.
    dateChunk = `due:${item.due}`;
  }
  const padded = dateChunk ? dateChunk.padEnd(PREFIX_COL) : "";

  // end:HH:MM is only shown when the event duration differs from the
  // default 30 minutes — keeps each line as minimal as possible.
  const tail: string[] = [];
  if (item.endTime && item.startTime && !isDefaultDuration(item.startTime, item.endTime)) {
    tail.push(`end:${item.endTime}`);
  }

  let line = "";
  if (lead.length > 0) line += lead.join(" ") + " ";
  if (padded) line += padded + " ";
  if (item.text) line += item.text;
  if (tail.length > 0) line += " " + tail.join(" ");
  return line.replace(/[ \t]+$/, "");
}

/** True when `end - start` is exactly 30 minutes — the default
 *  duration Order assigns to a calendar event without an explicit
 *  end time. Used by the serializer to suppress the `end:` token in
 *  the common case. */
function isDefaultDuration(start: string, end: string): boolean {
  const s = start.match(/^(\d{2}):(\d{2})$/);
  const e = end.match(/^(\d{2}):(\d{2})$/);
  if (!s || !e) return false;
  const sm = Number(s[1]) * 60 + Number(s[2]);
  const em = Number(e[1]) * 60 + Number(e[2]);
  return em - sm === 30;
}

/** Serialize the full item set. Undated tasks first (in original
 *  order), then dated entries sorted by start date ascending. Columns
 *  are padded so that `due:` lines align across the file. */
export function serializeTodoTxt(items: TodoItem[]): string {
  const undated = items.filter((i) => !i.due);
  const dated = items.filter((i) => isDate(i.due)).slice().sort((a, b) => {
    if (a.due! < b.due!) return -1;
    if (a.due! > b.due!) return 1;
    // Same date → put timed before all-day so the day's chronology reads top-down.
    const at = a.startTime ?? "99:99";
    const bt = b.startTime ?? "99:99";
    return at < bt ? -1 : at > bt ? 1 : 0;
  });

  const out: string[] = [];
  for (const u of undated) out.push(formatTodoItem(u));
  if (undated.length > 0 && dated.length > 0) out.push("");
  for (const d of dated) out.push(formatTodoItem(d));
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

/** Apply a mutation to one line of the file. Returns the new file
 *  body. The mutation either rewrites the line in place (preserving
 *  its line index for subsequent edits in the same session) or
 *  removes it entirely.
 *
 *  We DON'T re-sort on a mutation — sorting only happens at the
 *  serializer's discretion, and the synthetic-path scheme needs line
 *  indices to stay stable inside a session so the user can drag the
 *  same event multiple times in a row without the id sliding out
 *  from under them. */
export function mutateTodoLine(
  body: string,
  index: number,
  next: TodoItem | null,
): string {
  const lines = body.split(/\r?\n/);
  if (index < 0 || index >= lines.length) return body;
  if (next === null) {
    lines.splice(index, 1);
  } else {
    lines[index] = formatTodoItem(next);
  }
  return lines.join("\n");
}

/** Append a new task line to the file. Returns { body, index } so
 *  the caller can immediately address the new line with the same
 *  synthetic path scheme. */
export function appendTodoItem(body: string, item: Omit<TodoItem, "raw" | "index">): {
  body: string;
  index: number;
} {
  const line = formatTodoItem({ ...item, raw: "", index: -1 } as TodoItem);
  // Trim a single trailing newline so we don't accumulate blank lines
  // across appends; re-add a fresh trailing newline at the end.
  const trimmed = body.replace(/\n+$/, "");
  const next = (trimmed ? trimmed + "\n" : "") + line + "\n";
  const index = trimmed ? trimmed.split(/\r?\n/).length : 0;
  return { body: next, index };
}

// ---------- .md <-> todo.txt mirror ----------
//
// The mirror has one job: keep todo.txt as a perfectly synced view of
// every calendar event in the vault. There's no on-disk marker — every
// line in todo.txt looks the same, whether it backs an .md file or
// not. Identity matching closes the loop:
//
//   `${date}|${startTime ?? ""}|${normalized title}`
//
// A todo.txt line that matches an .md event by this key is "the same
// event"; the calendar shows the .md side (which has prose, frontmatter,
// etc.) and the .txt line is the mirror representation of it. Lines
// that match nothing are native todo.txt events.
//
// Delete detection across restarts is handled by persisting the set of
// keys we last wrote as mirrors. When an .md is deleted, its key is
// in the last-mirror set but no longer in the current md-event set →
// the line in todo.txt gets dropped on next sync.

/** Caller-supplied descriptor of an .md calendar event. Order's
 *  CardGrid builds these from the loaded notes. */
export interface MirrorSource {
  title: string;
  date: string;
  startTime?: string;
  endTime?: string;
  endDate?: string;
  allDay: boolean;
  /** Already-resolved Notable Folder name. Kebab-cased into the
   *  +project token on the mirror line. */
  folder?: string;
  completed?: boolean;
}

/** Strip todo.txt metadata tokens (`+project`, `@context`) from a free-
 *  text description so two representations of the same event match
 *  even when one is a mirror line (which carries the project as a
 *  +token) and the other is the raw .md title. */
function normalizeTitle(text: string): string {
  return text
    .replace(/(?:^|\s)[+@]\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Identity key for an event. Used both for dedup on the calendar feed
 *  and for matching .md events against todo.txt lines during sync. */
export function eventKey(e: {
  date?: string;
  startTime?: string;
  title?: string;
}): string {
  return `${e.date ?? ""}|${e.startTime ?? ""}|${normalizeTitle(e.title ?? "")}`;
}

/** Identity key for an already-parsed todo.txt item. */
export function todoItemKey(item: TodoItem): string {
  return eventKey({ date: item.due, startTime: item.startTime, title: item.text });
}

/** Build a mirror TodoItem from an .md event. The produced line carries
 *  no marker tag — it's indistinguishable on disk from a native line of
 *  the same shape. Identity matching is what binds the two together. */
export function buildMirrorItem(src: MirrorSource): TodoItem {
  const project = src.folder
    ? src.folder.replace(/[-_.]+/g, " ").trim().toLowerCase().replace(/\s+/g, "-")
    : undefined;
  const text = [src.title || "Untitled", project ? `+${project}` : null]
    .filter(Boolean)
    .join(" ");
  return {
    raw: "",
    index: -1,
    completed: !!src.completed,
    due: src.date,
    ...(src.startTime ? { startTime: src.startTime } : {}),
    ...(src.endTime ? { endTime: src.endTime } : {}),
    ...(src.endDate ? { endDate: src.endDate } : {}),
    allDay: src.allDay,
    text,
    ...(project ? { project } : {}),
  };
}

/** Rebuild todo.txt to reflect the current vault state.
 *
 *  `lastMirrorKeys` is the set of identity keys we wrote as mirrors
 *  on the previous sync. It lets us tell apart "user-authored line
 *  that happens to match an .md" (kept as the mirror) from "stale
 *  mirror left behind after an .md was deleted" (dropped).
 *
 *  Returns `null` when no write is needed; otherwise the new body
 *  plus the fresh `mirrorKeys` to persist for next time.
 */
export function syncTodoBody(
  currentBody: string,
  sources: MirrorSource[],
  lastMirrorKeys: ReadonlySet<string>,
): { body: string; mirrorKeys: string[] } | null {
  const items = parseTodoTxt(currentBody);
  const mdKeyArr = sources.map((s) => eventKey({
    date: s.date,
    startTime: s.startTime,
    title: s.title,
  }));
  const mdKeySet = new Set(mdKeyArr);

  // Keep only lines that are native (don't match any current .md
  // event, and weren't a mirror last sync — so stale mirrors fall
  // off after their backing .md is gone).
  const native = items.filter((i) => {
    const k = todoItemKey(i);
    if (mdKeySet.has(k)) return false;
    if (lastMirrorKeys.has(k)) return false;
    return true;
  });
  const mirrored = sources.map(buildMirrorItem);
  const nextBody = serializeTodoTxt([...native, ...mirrored]);
  if (nextBody === currentBody) return null;
  return { body: nextBody, mirrorKeys: mdKeyArr };
}

// ---------- Persistence of the last mirror key set ----------

const MIRROR_KEYS_STORAGE = "order.todoTxt.mirrorKeys";

export function getMirrorKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(MIRROR_KEYS_STORAGE);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s): s is string => typeof s === "string"));
    }
  } catch { /* corrupt storage — start fresh */ }
  return new Set();
}

export function setMirrorKeys(keys: ReadonlyArray<string>): void {
  try {
    localStorage.setItem(MIRROR_KEYS_STORAGE, JSON.stringify([...keys]));
  } catch { /* localStorage unavailable */ }
}

