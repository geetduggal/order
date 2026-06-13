# Order — architecture

The whole app is one idea applied repeatedly: **plain markdown files are
the database, and every surface is a different read of the same files.**
If you understand the file conventions, you understand the app. The
rest of this doc is how that idea survives contact with a vault of tens
of thousands of files.

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

## Tech stack — what each layer is for

| Layer | Choice | Why this one |
|---|---|---|
| Shell | **Tauri v2** (Rust) | native file IO + system webview; one codebase ships macOS, Linux, Windows, **and iOS**. ~10 MB binaries vs Electron's ~150 |
| UI | **React 19 + TypeScript**, Vite | one SPA rendered into the webview; HMR in dev |
| Editor | **Milkdown Crepe** (ProseMirror) | WYSIWYG CommonMark, uncontrolled after mount — typing never round-trips through React state |
| Calendar | **FullCalendar v6** (Day/Week/Month) | drag/resize/select for free; Year and Season are hand-rolled React (FC buys nothing there) |
| YAML | js-yaml | frontmatter parse/dump, `noRefs` + quoted strings to stay Obsidian-compatible |
| Watcher | notify (Rust), 500 ms debounce | external edits reach the UI without polling JS-side |
| Assets | custom `vaultasset://` URI scheme | images/video stream through the webview's native fetch path with HTTP `Range` support — a 50 MB `![[clip.mov]]` never crosses the IPC bridge |

State management is deliberately primitive: **no Redux, no Zustand, no
Context**. `CardGrid.tsx` (~4k lines) owns `notes[]`, the view, and the
filter pile; everything derives per render. One place to look, one
place to debug.

```
CardGrid ── owns notes[], view, filters; routes every mutation
├── Sidebar           Areas → Categories → NFs drill + filter pills
├── LazyCell[] → Card per note: load → edit (Milkdown) → debounced save
│   ├── MilkdownSurface   Crepe wrapper: paste, links, wikilinks
│   ├── RawTextSurface    monospace <textarea> for .txt (todo.txt)
│   └── ListCards / ListLines   list: cards (grid) / lines (table)
├── CalendarView      Day / Week / Month (FullCalendar)
├── YearLinearView    Year — 12×37 strip
├── SeasonView        Season — Areas grid over a date range
└── CommandPalette    ⌘O/⌘K folder picker · FtsOverlay ⌘F search
```

## File operations — everything goes through one bridge

The frontend never touches a filesystem API. Every operation calls a
Rust command via `lib/vault-fs.ts`, with **vault-relative paths** — the
same code runs on desktop (absolute root) and iOS (security-scoped
bookmark), and `..` traversal is rejected at the bridge.

| Command | Used for |
|---|---|
| `vault_walk_metadata` | boot: every file's frontmatter, **no bodies** |
| `vault_read_text` / `vault_write_text` | note load on demand / debounced save |
| `vault_write_binary` | image paste |
| `vault_rename` / `vault_remove` | rename note (+ inbound wikilink rewrite), delete |
| `vault_read_dir` / `vault_list_dir` | NF file-browser flip side |
| `vault_import_files` | OS drag-drop (webview eats HTML5 dataTransfer; Rust copies by path) |
| `fts_build_index` / `fts_search` | full-text search, index lives Rust-side |
| `terminal_open` / `_write` / `_resize` / `_close` | real PTY (portable-pty) per in-card terminal — vim/htop/colors work |
| `open_url` / `open_path` | every external link → OS browser/app, never in-app |

**The write path.** Card edits debounce 600 ms, then:
`splitFrontmatter → mutate → joinFrontmatter → vault_write_text`.
Every write also stamps a 6-second **self-write marker**; the watcher
and the mtime poller treat stamped paths as "ours" so saving never
triggers a reload of the card being typed in. A `knownBodies` cache
lets the watcher distinguish a real external edit from a Dropbox/iCloud
metadata touch by comparing content, not just mtime.

**The external-edit path.** notify (Rust, 500 ms debounce) → `vault-changed`
event → JS coalesces another 250 ms → metadata re-walk → notes matched
**by path so React ids survive** — a mounted editor keeps its cursor,
selection, and scroll through a `git pull` happening underneath it.

## Scaling to tens of thousands of files

The budget: every interaction under a second (enforced by the E2E
suite). Five mechanisms carry it:

1. **Metadata-only boot.** `vault_walk_metadata` ships one small struct
   per file — frontmatter YAML string, body byte-length, mtime. At 10⁴
   notes that's the difference between megabytes and hundreds of
   megabytes crossing the IPC bridge. Bodies load lazily, per note, the
   moment a Card actually mounts. Only chain files (Areas/Categories/NF
   main docs, `list:` folders, `.txt`) get bodies up front, because the
   sidebar and calendar need their bullets immediately.

2. **Lazy editor mounting.** A ProseMirror instance per note is the
   expensive thing — hundreds of synchronous mounts stall the main
   thread. `LazyCell` wraps each grid cell in an IntersectionObserver:
   offscreen cells render a sized placeholder; the real Card mounts
   when scrolled within ~1.5 viewports above / 3 below. Once mounted it
   stays mounted, so in-progress edits never get torn down by scrolling.

3. **Pagination before virtualization.** The unfiltered Stream caps at
   60 cards with a "Show more" tile; filters lift the cap because a
   filtered set is small by construction. Combined with LazyCell this
   means cold boot mounts a handful of editors, not thousands.

4. **Masonry without layout thrash.** The Stream is CSS Grid with 8 px
   auto-rows; each cell's `grid-row-end: span N` comes from its measured
   height. Re-measure triggers are scoped — a per-card ResizeObserver,
   a ProseMirror MutationObserver, and a capturing input listener as
   backstop — so typing in one card never reflows the page.

5. **Derived state, no caches to invalidate.** Taxonomy tree, calendar
   events, season grids, todo.txt sync sources — all are `useMemo`-style
   derivations over the single `notes[]` array. There is no secondary
   store to drift; a 10⁴-element map/filter per render is microseconds,
   and it's always right.

Search is the one thing that can't derive from metadata: `⌘F` queries a
Rust-side full-text index (built once, loaded from disk on later
launches) so JS never holds every body in memory.

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

## UI flows worth knowing

**+ button.** In the Stream it behaves like Cmd+N: the note lands in
the top-of-pile Notable Folder (falling back to home) and the filter
pile is left alone. From any calendar view it jumps home — creates in
the home NF, pins the filter, lands the cursor in the new card.
Calendar drag/click also creates `.md` files — Order never creates
todo.txt-only events (a line whose only home is a file two devices
rewrite concurrently can lose the sync race; an `.md` regenerates its
mirror line on the next pass no matter what happened to todo.txt).

**Navigation is a pile.** Every surface — sidebar tile, palette pick,
wikilink, event-popup Open — puts the target NF on top of the
filter-pill stack. The just-touched section renders at scroll-top, so
the scroll target has nothing to drift through (matters on iOS).

**Folder move.** Reassigning a note's NF rewrites its YAML, moves the
file *and its same-folder images*, swaps the filter to the destination,
and scroll-targets the moved card. The React key survives the path
change so an open editor doesn't remount.

**Publish.** Collects `public: true` notes → prerenders one static HTML
page per permalink (real content for `curl` and unfurlers) → ships the
same React components as a read-only SPA. No template to drift.

**Lists.** A `list:` note's body bullets parse to `ListItem`s
(`lib/list-folder.ts`): a `- [[Name]]` bullet is a wikilink item
(`ref`, optional `· meta`); a plain `- text` bullet is a text item
(`ref === text`, `text` set); a `- ![[img]]` bullet is an image item.
`ListCards` / `ListLines` render and mutate the array, persisting via
the host Card's save. Both the add input and inline row-rename use
`WikiRefInput` — plain text until you type `[[`, which opens the same
folder autocomplete the Milkdown editor uses; the parent applies
"exactly `[[Name]]` → wikilink item, else text item."

## Invariants worth knowing

- Quoted dates. `date: "2026-06-12"` — unquoted dates parse as YAML
  Date objects and need `toIsoDateValue` everywhere they're compared.
- Attachments live next to their note. No global attachments dir for
  new content; moving a note drags its images along.
- Wikilinks resolve by name, not path, so moving folders never rewrites
  links.
- The published web viewer reuses the same components read-only — there
  is no separate template to drift.

## Testing

`pnpm test:e2e` runs Playwright against the real app in Chromium with a
mocked Tauri IPC layer (`tests/e2e/helpers.ts`) — an in-memory vault
stands in for the Rust bridge, so the full UI exercises real app code.
Interactive assertions carry a <1 s budget. `ORDER_VAULT=<path> pnpm
test:e2e consistency` lints any real vault: chain ↔ directory
integrity, attachment locality, todo.txt ↔ `.md` event sync.
