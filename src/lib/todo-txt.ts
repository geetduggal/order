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

/** Build a canonical line for an item: priority? leading-date(s)? +
 *  text with `due:` / `end:` metadata at the head when present. The
 *  serializer always emits new lines via this; round-tripping a line
 *  that the parser already recognised is byte-stable up to whitespace
 *  collapsing. */
export function formatTodoItem(item: TodoItem): string {
  const head: string[] = [];
  if (item.completed) head.push("x");
  if (item.priority) head.push(`(${item.priority})`);

  // Multi-day all-day → leading date pair (end first, start second),
  // matching todo.txt's completion-creation ordering.
  if (item.endDate && item.due && item.allDay) {
    head.push(item.endDate, item.due);
  } else if (item.due && item.startTime) {
    head.push(`due:${item.due} ${item.startTime}`);
    if (item.endTime) head.push(`end:${item.endTime}`);
  } else if (item.due) {
    // Single-day all-day with `due:` keyword so a hand-edited file with
    // a creation-date prefix doesn't get downgraded to "untimed task".
    head.push(`due:${item.due}`);
  }

  const tokens = [head.join(" "), item.text].filter(Boolean);
  return tokens.join(" ").replace(/\s{2,}/g, " ").trim();
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
