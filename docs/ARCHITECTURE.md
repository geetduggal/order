# Order — architecture in one page

The whole app is one idea applied repeatedly: **plain markdown files are
the database, and every surface is a different read of the same files.**
If you understand the file conventions, you understand the app.

## The data model (on disk)

```
<vault>/
├── Areas.md                      role: areas — lists the Areas
├── Seasons.md                    role: seasons — list of date ranges (optional)
├── todo.txt                      one-line calendar events (optional)
└── <Area>/
    ├── <Area>.md                 list: cards — lists the Categories
    └── <Category>/
        ├── <Category>.md         list: cards — lists the Notable Folders
        └── <NF>/
            ├── <NF>.md           category: <Category> — the Main Document
            ├── <note>.md         folder: "[[<NF>]]" — a regular note
            └── <attachment>      images/PDFs live NEXT TO their notes
```

Five frontmatter keys carry all structure:

| Key | Meaning |
|---|---|
| `role: areas` / `role: seasons` | marks the two vault-root index files |
| `list: cards` \| `lines` | note body's bullets render as a list |
| `category: <Category>` | this note is a Notable Folder Main Document |
| `folder: "[[NF]]"` | this note belongs to that Notable Folder |
| `date` + `startTime`/`allDay` | this note is a calendar event (Obsidian Full Calendar format) |

Everything else (`title`, `home`, `public`, `image`, …) is decoration.

## The code map (src/)

```
components/CardGrid.tsx    THE component. Loads notes, owns view/filter
                           state, routes every mutation. ~4k lines and
                           deliberately so — state lives in one place.
components/Card.tsx        One note: load → edit (Milkdown) → debounced save.
components/MilkdownSurface Crepe editor wrapper; paste, links, wikilinks.
components/RawTextSurface  Monospace <textarea> for .txt files (todo.txt).
components/CalendarView    Day/Week/Month via FullCalendar.
components/YearLinearView  Year — hand-rolled 12×37 strip.
components/SeasonView      Season — Areas grid over a date range.
components/Sidebar.tsx     Areas → Categories → NFs drill + filter pills.

lib/vault-fs.ts            All file IO. Wraps the Rust bridge; vault-
                           relative paths only.
lib/frontmatter.ts         YAML split/join; date normalization.
lib/taxonomy.ts            Walks the Areas.md chain into a tree.
lib/folders.ts             NF detection, colors, icons, +project slugs.
lib/list-folder.ts         list: bullets ↔ structured items.
lib/todo-txt.ts            todo.txt parse/serialize + .md mirror sync.
lib/seasons.ts             Seasons.md parse + per-Area activity query.

src-tauri/src/vault_fs.rs  The Rust side: 14 thin file commands.
src-tauri/src/fts.rs       Full-text index (build / load / search).
src-tauri/src/watcher.rs   Debounced fs notify → "vault-changed" events.
```

## The three flows

**Load.** `vault_walk_metadata` (Rust) returns every file's frontmatter
without bodies. Chain files and `.txt` get their bodies up front; leaf
bodies load lazily when a Card mounts. Everything derives from this one
`notes[]` array per render: taxonomy, calendar events, seasons, streams.

**Mutate.** Every mutation rewrites a file through `vaultFs` and patches
the in-memory `notes[]` in the same tick. Self-writes are stamped so the
watcher doesn't bounce them back as external edits.

**External edit.** The Rust watcher emits `vault-changed`; CardGrid
reloads metadata, matches notes by path (ids survive, so mounted editors
keep cursor + focus), and re-renders.

## Calendar events have two backings

An event is either an `.md` file (frontmatter date/time) or one line in
`todo.txt` (`due:YYYY-MM-DD HH:MM Title +project`). Identity is the
triple `(date, startTime, normalized title)`:

- the calendar renders each identity once — `.md` wins when both exist
- a sync pass mirrors every `.md` event into todo.txt and prunes stale
  mirror lines (a localStorage set of last-written keys detects deletes)
- chip mutations route by path: synthetic `todo.txt#L<n>` paths rewrite
  the line, real paths rewrite the file

The `+project` token fuzzy-matches Notable Folder names across kebab /
camel / snake case (`lib/folders.ts: resolveProjectToNf`).

## Invariants worth knowing

- Quoted dates. `date: "2026-06-12"` — unquoted dates parse as YAML
  Date objects and need `toIsoDateValue` everywhere they're compared.
- Attachments live next to their note. No global attachments dir for
  new content; moving a note drags its images along.
- The + button always creates in the home NF and pins the filter there.
  Only calendar drag/click creates todo.txt lines (when the toggle is on).
- Wikilinks resolve by name, not path, so moving folders never rewrites
  links.
- The published web viewer reuses the same components read-only — there
  is no separate template to drift.

## Testing

`pnpm test:e2e` runs Playwright against the real app in Chromium with a
mocked Tauri IPC layer (`tests/e2e/helpers.ts`) and an in-memory vault.
`ORDER_VAULT=<path> pnpm test:e2e consistency` lints any real vault for
structure/todo.txt consistency.
