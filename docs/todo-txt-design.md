# todo.txt support

Order learns the [todo.txt](https://github.com/todotxt/todo.txt) format as a first-class alternative to per-event markdown files. A vault-root `todo.txt` (or user-configured path) becomes a second source of calendar events. The file stays plain text on disk and stays editable in any other tool; Order reads, writes, and renders it natively.

## On-disk format

A vault-root file at `todo.txt`, configurable in Settings.

```
Task 1
Task 2

due:2026-05-04 10:30  Visit Jane (bring gift) +NotableFolder1
due:2026-05-04 17:00  Sing a song +second-notable-folder
due:2026-05-04 17:00  Put out the bins +NotableFolder1 end:18:00
due:2026-05-05        All-day event +second-notable-folder
2026-05-15 2026-05-07 Multi-day event +second-notable-folder
```

Order extends standard todo.txt with three calendar conventions:

- `due:YYYY-MM-DD HH:MM` — timed event. Default 30 minutes. Optional `end:HH:MM` overrides the end time.
- `due:YYYY-MM-DD` (no time) — single-day all-day event.
- `YYYY-MM-DD YYYY-MM-DD` as the two leading tokens — multi-day all-day span. End date first, start date second (matches todo.txt's `completion creation` date ordering).

`x ` prefix marks completion in the standard sense. Completed events still render on the calendar, struck through.

Lines with no `due:` and no leading date pair are plain undated tasks. They sit at the top of the file, are visible when the file is opened in Order, and never render on the calendar.

## Settings

A new "Todo.txt" section in `SettingsPanel`:

- Toggle: `Use todo.txt`. Persisted in `localStorage` as `order.todoTxt.enabled`.
- Text input: `Path` (vault-root relative, default `todo.txt`). Persisted as `order.todoTxt.path`.
- Button: `Open todo.txt`. Creates the file if absent and navigates to it as a card.

## Parser and serializer

A new `src/lib/todo-txt.ts` exposes:

```ts
type TodoItem = {
  raw: string;             // original line, for round-trip preservation
  index: number;           // line index in the file (stable id)
  completed: boolean;      // `x ` prefix
  priority?: string;       // single A-Z
  due?: string;            // YYYY-MM-DD
  startTime?: string;      // HH:MM
  endTime?: string;        // HH:MM (from `end:` key)
  endDate?: string;        // YYYY-MM-DD (multi-day all-day)
  allDay: boolean;
  text: string;            // task body with metadata stripped
  project?: string;        // first `+project` token
}

parseTodoTxt(body: string): TodoItem[]
serializeTodoTxt(items: TodoItem[]): string  // tight + canonical
```

Serialize rules: undated tasks first (in original order), then dated entries sorted by start date ascending; columns padded so `due:` rows align. Round-tripping a hand-edited file should produce byte-identical output for any line whose interpretation didn't change.

## NF resolution

A new `resolveProjectToNf(token: string, nfNames: string[]): string | null` lives in `lib/folders.ts`. It expands CamelCase / PascalCase / kebab-case / snake_case to space-separated tokens, lowercases both sides, and returns the first exact-match NF name. Returns `null` on no match.

When Order writes a new event whose folder is `Notable Folder Name`, it serializes the project as `+notable-folder-name` (kebab-case).

## Calendar event source

Today, `calendarNotes` in `CardGrid.tsx` is built from markdown notes only. The new flow:

1. Parse `todo.txt` once on load (and on every reload).
2. For each `TodoItem` with a `due:` or leading-date-pair, build a synthetic `NoteMeta`:
   - `path = "todo.txt#L<index>"` (synthetic, never written to disk; the suffix makes it match `:has(path)` semantics in the event-click pipeline).
   - `filename = "todo.txt"`.
   - `title = item.text`.
   - `frontmatter = { date, startTime, endTime, allDay, endDate, folder: matchedNf ? "[[<nf>]]" : undefined }`.
   - `color = matchedNf ? folderColor(matchedNf) : undefined`.
3. Concatenate to the markdown `calendarNotes` list.

Completed items carry `frontmatter.completed = true`; `CalendarView.renderEventContent` adds a `text-decoration: line-through` style based on that flag.

## Event mutations route to the source

`updateNoteFrontmatter`, `deleteEventNote`, and the new-event flow all gain a synthetic-path branch:

```ts
if (path.startsWith(TODO_TXT_PATH + "#L")) {
  await mutateTodoTxt(path, patch | "delete");
  return;
}
// existing markdown path
```

`mutateTodoTxt(path, patch)` reads the file, parses, mutates the line at the given index, re-serializes, writes back. Updates flow exactly like markdown updates — through `vaultFs.writeText`, picked up by the self-write filter, no double-reload.

New events created from the calendar drag-or-click flow:

- If the toggle is off, OR the toggle is on but `todo.txt` doesn't exist yet AND the patch carries an explicit folder context that doesn't suit a one-liner — fall through to the existing markdown create flow.
- Otherwise, append a new `TodoItem` and write the file. The file is created lazily on the first write.

The event-prompt popup gains an NF picker when the active event is from `todo.txt` and the line has no `+project` (or an unresolved one). Picking an NF writes `+kebab-case-name` back.

## Editing todo.txt inside Order

`Card` already routes through `MilkdownSurface` for every loaded note. A new `RawTextSurface` component renders a monospace `<textarea>` styled like a card body, debounce-saves through the same `onChange → vaultFs.writeText` pipeline that Crepe uses. `Card` picks the surface by extension:

```ts
const Surface = filename.endsWith(".txt") ? RawTextSurface : MilkdownSurface;
```

`RawTextSurface` is the *only* place todo.txt edits happen as freeform text. Mutations through the calendar still go through the structured `mutateTodoTxt` path so the file's spacing and sort order stays canonical.

## File watching

The existing `vault-changed` reload pipeline already covers `.txt`. The reload re-parses the file; any open Card holding it picks up the new body via the existing external-edit reconcile. No new watcher wiring needed.

## Out of scope

- Recurring events (`due:MM-DD` annual shorthand from the ellanew article).
- `@context` parsing — Order's Area-as-context mapping is implicit through the NF, as your brief specifies.
- Multi-day timed events (timed entries stay single-day).
- Converting a todo.txt event into a markdown event or vice versa.
