# Order

*Your notes, at home at last.*

A specialized, local-first note app. One screen for thinking, browsing, and
publishing. Markdown files with YAML frontmatter as the single source of truth,
an Obsidian-compatible vault, built on Tauri v2 — one codebase ships both
desktop and iOS.

![Order — a Notable Folder rendered as a newspaper section: the Main Document as a wide centerpiece with recent notes orbiting around it](img/order-home.png)

**Demo videos:** [Basics](https://drive.google.com/file/d/1H2Yv9Jf59Og1bimFuDhJmIlOvjCA4iDp/view?usp=sharing) · [Lists](https://drive.google.com/file/d/1TdWU6fPFFOTDnodDT3AWenjyuuMRjffg/view?usp=sharing)

---

## Build from source

**v0.1.0** is here as source. Build it yourself in a few minutes — packaged
desktop and iOS releases are next.

**Prerequisites**
- Node.js 20+ and pnpm 9+
- Rust 1.77+ (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- For iOS: Xcode 15+ with the iOS 14 SDK or newer, plus `xcode-select --install`

**Desktop (macOS, Linux, Windows)**
```bash
git clone https://github.com/geetduggal/order.git
cd order
pnpm install
pnpm tauri:dev      # dev window with hot reload
pnpm tauri:build    # signed app bundle in src-tauri/target/release/bundle
```

**iOS**
```bash
pnpm tauri:ios:init   # one-time; generates the Xcode project under src-tauri/gen/apple
pnpm tauri:ios:dev    # opens the iOS Simulator
pnpm tauri:ios:build  # device build (.ipa under src-tauri/gen/apple/build)
```

On desktop, first launch reads `~/Documents/Dropbox/Home/` as the vault root.
On iOS it prompts you once to pick a vault folder and keeps a security-scoped
bookmark to it.

> **A twenty-year through line.** The impulse behind Order is old. It first
> surfaced around 2004 in [*PileTiddly*](https://geetduggal.com/PileTiddly.html) —
> a TiddlyWiki experiment, preserved here for nostalgia — built on the idea that
> digital spaces should behave like *piles*: recently touched things float up,
> ignored things sink, structure follows attention instead of imposing on it.
> Two decades later the same shape keeps returning: a digital space that feels
> like a real **place**, where what you see is what you have, and where structure
> serves attention rather than constraining it. Order is the latest and most
> complete expression of that idea, and nearly every decision below traces back
> to it. This isn't a fresh aesthetic; it's a twenty-five-year-old itch finally
> scratched.

---

## Principles

1. **Local-first, plain text forever.** Files live on your machine as plain `.md`
   with YAML frontmatter. No proprietary store, no cloud lock-in; sync is whatever
   you already use (Dropbox, iCloud, git). This is less a technical choice than a
   *covenant with your future self* — tools die, companies pivot, subscriptions
   lapse, but plain text has outlived every decade of personal computing. The
   files outlive the tool. If Order vanished tomorrow, the vault still opens.
2. **Portable conventions.** The vault opens cleanly in Obsidian. Same files, same
   YAML, same wikilinks. Order is a different *surface* on the same data — never a
   place your notes are trapped.
3. **Edit in place.** Every interaction — capture, browse, refine — happens on the
   same surface. No modals, no editor/viewer toggle. Double-click and type. The
   itch here is old: WYSIWYG that goes back to Microsoft FrontPage in the nineties,
   the conviction that authoring and the finished thing should not be two places.
4. **Constraint as clarity.** Johnny Decimal limits: max 10 Areas, max 10
   Categories per Area. The 10-box grid makes the limit visible. The constraint is
   the *feature* — by promising you only ten Areas, it forces you to ask what your
   ten Areas actually are. Most tools invite infinite branching, and infinite
   branching is exactly what makes a system rot: you forget where things are, you
   duplicate, you abandon and start over. Fewer choices, clearer mind.
5. **Workspace is presentation space.** What you see while editing is what your
   reader sees — there's no separate "article view." This is a small act of
   honesty: no draft mode hiding behind a rendered mode, no translation layer
   between authoring and publishing.
6. **Subtle UI.** The default palette is just two accents — royal blue `#4169E1`
   and coral `#FF7F50` — with sans-serif for chrome, serif for prose, and
   whitespace and hairlines doing the work of borders. The aim is *sehaj* — an
   intuitive equipoise where the layout asks nothing of you; you don't navigate
   it, you inhabit it. A theme switcher layers on top (light, dark, OLED black,
   and a few deliberately loud ones) without disturbing that resting calm, and
   note text scales with `Cmd ±`.
7. **Speed matters.** Startup, scan, filter, edit, save — all optimized for flow.

---

## The hierarchy

- **Area** — broadest level, max 10 per vault (e.g. *Personal*, *Projects*).
- **Category** — within an Area, max 10 (e.g. *Reading* within *Personal*).
- **Notable Folder** — within a Category. A note whose YAML carries `category:`.
  Holds a Main Document (long-form prose, a curated list, or an auto-grid) plus
  any number of regular notes that link to it via `folder: "[[Folder Name]]"`.

Areas and Categories live on disk as the chain files themselves — `Areas.md`
lists the Areas, each Area file lists its Categories, each Category file lists its
Notable Folders — so the hierarchy (including empty Areas / Categories you've
added) survives any vault scan with no separate database. A legacy `localStorage`
taxonomy (`order.taxonomy`) is still read once, during the first-launch migration.

Why "Notable" and not "Project"? Most PKM systems organize around projects
(PARA's *Projects, Areas, Resources, Archives*), but projects come and go while
people, long arcs, and the spaces of a life persist. Order leans toward ALPPS
(*Archives, Logs, People, Projects, Spaces*): a Notable Folder can be a person, a
creative project, a paper, a tool, an idea, a whole section of life — anything
that *holds your attention*. The shape of your Notable Folders becomes a record
of what you've cared about, which is closer to a true map of a life than a project
list will ever be. And because the 10×10 grid maps cleanly onto a small set of
essential life spaces, the structure of the file system ends up mirroring the
structure of attention itself.

---

## Inspirations

- **Typora** — WYSIWYG markdown that hides syntax until you put your cursor on the
  line. Order uses Milkdown Crepe, which gives the same feel without the licensing
  question.
- **[Tolaria](https://github.com/...)** — root-owned-hooks architecture and the
  insight that note metadata belongs in YAML, not a sidecar database.
- **Obsidian** — the vault model (a plain folder of markdown files) and Bases
  (structured cards over frontmatter). Order's `type: list` folders draw straight
  from Bases.
- **Johnny Decimal** — the 10×10 constraint that makes hierarchy honest.
- **Google Keep** — card-grid browsing on desktop; frictionless capture as the bar
  for "how easy a new note should feel."
- **Wikipedia** — Main Document per Folder; reading and editing share the same
  prose surface.
- **Medium** — typographic restraint. No borders or fills in resting state; hover
  is the only visual change.
- **NYT** — hairline dividers between cards, never heavy chrome.

The combination is the point. Order ties them into one coherent surface and takes
only the single best thing from each.

---

## Architecture

> **Mental model in one page:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
> — the file conventions, the code map, the three data flows, and the
> invariants. Start there; the sections below add depth per topic.

### Stack

- **Tauri v2** — Rust shell, system webview. Native window, native file IO; ships
  both desktop and iOS from one codebase (`pnpm tauri:dev` for the desktop dev
  window). On iOS a custom `vaultasset://` URI-scheme handler and a
  security-scoped folder bookmark stand in for direct filesystem access.
- **React 19 + TypeScript** — single-page app rendered into the webview.
- **Vite** — dev server with HMR on `localhost:1420`.
- **[Milkdown Crepe](https://milkdown.dev/)** — ProseMirror-based WYSIWYG markdown
  editor. One instance per Card; uncontrolled after mount.
- **[FullCalendar v6 React](https://fullcalendar.io/)** — Day, Week, and Month
  calendars. Year is a hand-rolled linear strip (`YearLinearView.tsx`) ported
  from a fork of `obsidian-full-calendar`. Touch-friendly: long-press for
  drag / select is dropped from 1000ms to 250ms; the bottom resize handle
  paints a visible grip bar under `@media (hover: none)`; `touch-action: none`
  on `.fc-event` so a drag doesn't fight page scrolling.
- **js-yaml** — frontmatter parse / dump on the JS side.
- **notify** (Rust) — debounced filesystem watcher behind the `start_watcher`
  command; emits `vault-changed` to the frontend on external edits (desktop).

### Source of truth

The on-disk markdown file is authoritative. Every save round-trips through
`splitFrontmatter` → mutate → `joinFrontmatter` so out-of-band edits (calendar
drags, sidebar mutations, the editor itself) compose cleanly. The Rust side
exposes thin file-IO commands (`read_text`, `write_text`, `write_binary`,
`rename_file`, `delete_file`) and stays out of the schema entirely.

### Storage layout

The on-disk directory tree literally mirrors the chain: every Notable
Folder lives in its own directory inside its Category, which lives inside
its Area, all rooted at the vault.

```
~/Documents/Dropbox/Home/               (vault root)
├── Areas.md                            list: cards, role: areas
├── Creative/
│   ├── Creative.md                     list: cards (the Area file)
│   ├── Creative Spaces/                Category dir
│   │   ├── Creative Spaces.md
│   │   ├── Articles/                   Notable Folder
│   │   │   └── Articles.md
│   │   └── Geet Duggal/                NF — home Notable Folder
│   │       ├── Geet Duggal.md          (home: "<gh user>/<repo>/<path>")
│   │       ├── 2024-07-22 - First Geet.md
│   │       └── Pasted image 20240725165042.png
│   └── Creative Projects/              every published article as its own NF
│       └── Tech Habits — …/
└── Craft/
    ├── Craft.md
    ├── Craft Spaces/{Tools, Academic}/
    └── Craft Projects/                 every tool & paper as its own NF
```

**A Notable Folder is the folder it sits in.** Not "a note that points at a
folder" — the folder itself IS the Notable Folder, with a Main Document inside
named after it. That single decision pulls everything else into place:

- **Attachments live next to the note that uses them.** Paste or drop an
  image and it lands in the NF's own directory, embedded as
  `![[image.png]]` (Obsidian's `attachmentFolderPath: "./"` convention).
  Move the note, the images come along. A legacy root `Attachments/` dir
  still resolves, but new content takes the local route.
- **Sidecar artifacts have a home.** Exported PDFs, screenshots, scratch
  JSON — anything a tool produces next to a note goes in the same NF
  directory, discoverable from Finder / Obsidian / VS Code.
- **Cross-tool portability is free.** The vault opens cleanly in Obsidian:
  same wikilinks, same embeds, same chain of index files. git, `grep`,
  `rsync`, and backup scripts all see a sensible folder tree.

At edit time the embeds are inflated to `vaultasset://` URLs — served by a
custom URI-scheme handler on the Rust side (`lib.rs`) that resolves them
against the vault root, including the iOS security-scoped bookmark — and
deflated back to `![[…]]` on save; a Crepe resize is preserved as an
Obsidian pixel width. The `vaultasset://` handler honors HTTP `Range`
requests (returning 206 Partial Content with `Accept-Ranges: bytes`), so
a multi-megabyte `![[clip.mov]]` streams through the WKWebView's native
chunked-fetch path instead of blocking the IPC bridge waiting for the
full body. PDF and other non-image attachment links go through the OS
opener (Tauri `open_path` on desktop; `tauri-plugin-vault.openUrl` →
`UIApplication.open` on iOS) so they launch in the user's default app.

External `http(s)://` links from anywhere in the UI route through a single
`open_url` Tauri command — `std::process::Command` for `open` / `xdg-open` /
`start` on desktop, and on iOS through the project-local
**tauri-plugin-vault**'s Swift module, which resolves the invoke
*before* calling `UIApplication.shared.open` so Rust's `run_mobile_plugin`
doesn't deadlock the main thread waiting for the user to confirm iOS's
app-switch prompt.

### State

No Redux / Zustand / Context. `CardGrid` is the top-level component and owns the
loaded `notes[]`, the current view, the folder filter set, and the right-sidebar
open state. Cards manage their own load + debounced save lifecycle and call
parents back via props when their path / title / frontmatter changes.

![Stream + right sidebar — list folder card grid on the left, stream cards in the middle, drilled Areas grid on the right](img/stream-with-sidebar.png)

```
CardGrid                 # top: loads notes, owns view + filter state
├── Sidebar              # drill: Areas → Categories → Notable Folders
├── Card[]               # Stream view; each card owns its file
│   ├── MilkdownSurface  # editor (or readonly Crepe in the viewer)
│   └── ListView         # ListCards / ListLines for any list folder
├── CalendarView         # Day / Week / Month
├── YearLinearView       # Year — 12 rows × 37 cells
├── SeasonView           # Season — Areas grid filtered by a date range
└── CommandPalette       # Cmd+K folder picker
```

The Stream's masonry-style row sizing lives in `src/lib/grid-layout.ts`
(`useGridLayout`) so the same hook drives the layout in both the
desktop app and the published web viewer.

### List folders

A list folder is any note whose YAML carries a `list:` key. The value names the
render style:

```yaml
---
list: cards   # or "lines"
---

# Books

- [[On Photography]] · Susan Sontag · ★★★★½
- [[Slowness]] · Milan Kundera · ★★★★
```

Bullets of wikilinks in the body are the source of truth for what's in the
list and in what order. On load we split them off the prose (the editor only
sees the prose); on save we serialize them back. Legacy `type: list` is still
read (treated as `list: cards`) so vaults from before the unification render
without migration.

#### Renders

- **`list: cards`** — basecard masonry, cover image (from the linked note's
  `image:` field) or alternating royal/coral icon fallback, title, meta.
- **`list: lines`** — dense one-row-per-item layout, drag-handle on hover,
  click-to-edit title and meta.

Image embeds (`![[image.png]]`) on their own bullet are first-class list
items — the image renders in place of the title with an inline caption
(from a `|caption` suffix). A bare wiki-link to an image (`[[image.png]]`,
no `!`) stays a text link the way Obsidian renders it; clicking it opens
the file in the OS's default viewer on desktop.

**Video embeds**: `![[clip.mov]]` (also `.mp4`, `.m4v`, `.webm`) inflates
to a native `<video controls playsinline preload="metadata">` inline in
the card — same on desktop, iOS, and the published page. The asset rides
through Order's custom `vaultasset://` URI scheme, which honors HTTP
`Range` requests so a multi-megabyte clip streams instead of blocking the
IPC bridge waiting for the full body. The static published page emits the
same `<video>` element verbatim, so it plays without JS.

**YouTube embeds**: a markdown image with a YouTube URL (`![](https://…)`)
or an Obsidian `embed` YAML fence renders as a single horizontal link
card with thumbnail + title + host. The title is fetched once via YouTube's
oEmbed and cached. Tap behavior: iOS opens the YouTube app, desktop opens
the default browser, the published page opens a new tab. The card shape
matches pre- and post-hydration on the static page, so layout doesn't
shift when the SPA wakes up.

![List folder — Books rendered as a basecard grid below the editor](img/list-folder-grid.png)

Both renders share the same operations: drag-reorder, click-to-edit title and
meta inline, hover-× to delete, "+ New" tile/row to append. Reorder runs through
one shared pointer-drag hook (`use-tile-drag.ts`) — the grabbed item lifts and a
drop-indicator bar shows exactly where it'll land (vertical between grid cells,
horizontal between rows); lines drag from a grip handle so the rest of the row
stays scrollable on touch, cards drag from the body. The same hook powers
reordering of the sidebar Areas / Categories / Notable Folders and the filter
pills. Pointer events end-to-end — Tauri's webview intercepts HTML5 drag-drop at
the OS layer so `drop` never reaches in-page handlers — with `setPointerCapture`
(deferred until a drag actually begins, so a tap stays a click) keeping touch
drags alive on iOS.

#### Areas, Categories, Notable Folders — also list folders

The three-level hierarchy is one consequence of the list model, not a separate
concept:

- `<vault>/Areas.md` — `list: cards, role: areas`, capped at 10 bullets
- each Area file — `list: cards`, bullets are Category wikilinks, capped at 10
- each Category file — `list: cards`, bullets are Notable Folder wikilinks
- each Notable Folder's Main Document (inside the folder's directory) —
  `list: cards` (or `lines`), bullets are leaf notes

The sidebar drill walks this chain. The 10-item caps fire from the same
add-bullet path that any list folder uses; over-cap attempts flash a coral
toast at the bottom of the screen and refuse the write.

A one-shot migration runs on first launch: if no Areas.md exists, Order
generates the chain from the legacy localStorage taxonomy + any Notable
Folder Main Docs (notes with `category:` in YAML), and rewrites those notes'
YAML to swap `type: list → list: cards`.

#### Base blocks — auto-populated lists

A fenced ```` ```base ```` code block inside a list folder body auto-populates
the list from the rest of the vault, Obsidian Bases style:

````yaml
```base
filters:
  and:
    - folder.contains("Books")
views:
  - type: cards
    name: All Books
    sort:
      - property: file.mtime
        direction: DESC
    image: note.image
```
````

Supported subset: `filters` with `and:`/`or:` composition; `.contains(string)`
predicates; `file.name`/`file.folder`/`file.ctime`/`file.mtime` and arbitrary
frontmatter keys; first `views[]` entry only; `view.type` of `cards` or `lines`;
single-key `sort`; `image: note.<field>` for the cover. Anything outside the
subset is parsed, ignored, and surfaced as a coral "(N unsupported)" hint
above the grid.

**Smart merge** preserves user reordering across regenerations. The base block
is the source of truth for which items appear; the host note's
`manual_order: [refs…]` YAML key is the source of truth for what order. On
render: items still matching the base keep their saved position; newly-matched
items append in the base's `sort` order; items no longer matching drop out.
Drag in base mode updates `manual_order`. A "Reset order" button above the
grid clears it.

Sort is deterministic even when notes are missing the key. Items without the
sort property bucket to the **end** of the list regardless of `asc` / `desc`
and sort lexicographically among themselves; any tie on the primary key falls
through to the same lexicographic tiebreak (title, then filename, case-
insensitive). So a `sort: published DESC` always shows newest first followed
by an alphabetical appendix of items without a `published` date — instead of
those drifting to arbitrary positions on each re-render.

In base mode the membership UI is read-only — no add tile, no per-item delete,
no inline rename (membership is the filter, not bullets) — but drag-reorder
stays available.

#### Lists of lists

When a list folder's items resolve to other list folders, the parent renders
as lines and each row gets the sub-list expanded inline below it. The sub-list
honours its own `list:` value: `list: lines` shows as compact indented
bullets, `list: cards` as a small basecard grid (read-only). Sub-list rows
are uncapped — long lists render in full.

Section headings ("Articles", "Tools", "Academic") render at 26px / weight
900, flush-left under their colored icon. Sub-list rows align under the
heading text, with each row's title link in royal blue and any meta
(date, journal · year, description) inline after a middle dot.

#### Click-to-navigate

Any item title whose linked target exists in the vault renders in royal blue
and navigates on click — sets the folder filter to that ref so the Stream
focuses on just that note. Items pointing at notes that don't exist yet fall
back to inline rename, so broken/placeholder wikilinks stay editable.

### Files and organization

Order doesn't require any particular layout on disk — any `.md` in the vault
shows up in the Stream regardless of where it sits. The defaults are a
convention, not a constraint, and the convention is small on purpose:

- **Notable Folders are the only place notes and files live.** Areas and
  Categories are pure navigation — they organize Notable Folders, never hold
  notes or files directly. This is the Johnny Decimal rule: only the leaf
  level of the hierarchy holds items. Every note belongs to exactly one
  Notable Folder.
- **`log/`** is the default Notable Folder — the catch-all for anything that
  doesn't naturally fit a Category. Quick captures, scratch, daily notes
  land here rather than scattering loose at the root.
- **Attachments live next to the note they belong to.** Images, PDFs,
  exported diagrams, scratch JSON — anything you paste, drop, or generate
  alongside a note writes into the NF's own directory, not a shared
  `Attachments/` pool. Moving a note moves its files; deleting an NF clears
  its sidecar artifacts in the same gesture. A legacy `Attachments/` dir at
  the vault root keeps working for migrations, but new content takes the
  local route.

The point isn't structure for its own sake. It's the smallest set of rules
that keeps the vault legible at 10 notes and at 10,000, leaves room to grow
into new file types without revisiting the layout, and stays honest to the
spirit of Johnny Decimal — a place for everything, with the constraint as
the thing that makes that possible.

A few things follow from this:

- **Order isn't a file browser, and isn't trying to be one.** Obsidian, VS
  Code, and Finder are already excellent at browsing arbitrary trees. Order's
  job is to browse Notable Folders efficiently and edit the notes inside them.
  Reach for one of those other tools when you need to see the whole tree.
- **Other file types are first-class citizens of a Notable Folder.** AI tools
  increasingly produce sidecar artifacts — HTML one-pagers, generated diagrams,
  exported PDFs, scratch JSON. Drop them next to the Main Document in the
  Notable Folder's directory. Order won't render them, but they have a home
  next to the note they belong to, and your other tools will find them exactly
  where you'd expect.

### Masonry layout

The Stream uses CSS Grid with `grid-auto-rows: 8px` plus a per-cell `grid-row-end:
span N` computed from the card's measured height. Reflow triggers come from
three independent sources:

- **ResizeObserver** on each `.order-card` — image loads, fullscreen, breadcrumb.
- **Per-card MutationObserver** — ProseMirror DOM mutations as you type.
- **Capturing `input` / `keyup` listener** on the grid — backstop in case MO's
  attribute filter ever misses a frame.

### Calendar interactions

- **Quick-create with title**: drag/click an empty slot, type the event title in
  the centered popup, hit Enter — the title becomes both the filename
  (`YYYY-MM-DD Title.md`) and the body's `# Title` H1. Esc cancels. Empty Enter
  still creates an untitled event so it stays a fast capture.
- **Event click → action menu** at the cursor: **Open** (switch to Stream + scroll
  to the note), **Delete** (remove the file), a row of **seven day chips** for
  that event's week (tap one to move the event to the same time on a different
  day), and a compact **Notable Folder picker** (chip when assigned, searchable
  list when opening — mirrors the card-footer FolderPicker).
- **Custom event rendering**: title-first / time-after, single-line for short
  slots so 30-minute events stay legible; FC's built-in time element is silenced
  (`displayEventTime: false`) and its ` - ` `::after` separator is
  overridden to `content: none` so there's no trailing dash. Drag-to-create
  range supported. Custom `eventContent` keeps the layout identical across event
  durations.
- **Layout refit on container resize**: a `ResizeObserver` on the calendar
  shell calls `api.updateSize()` whenever the pane width changes, so toggling
  the sidebar (or any width change that's not a full window resize) rebalances
  the grid immediately.
- **Multi-day events**: any event with an `endDate` (Obsidian Full Calendar's
  inclusive end-date) spans the full range in Day/Week/Month. The conversion to
  FullCalendar's exclusive-end model happens in `notesToEvents`
  (`addOneDayIso` for all-day spans; `endDate + endTime` for timed events that
  cross midnight). Timed events without an end date keep the simple start-only
  behavior they always had.
- **Week-view day-of-week picker**: a row of seven small day chips (S M T W
  T F S) floats over the empty right side of the week-view toolbar (drops
  inline below the toolbar on phones). Tap a chip to hide / show that
  weekday column; an `All` pill appears once anything is hidden to one-tap
  restore the full week. The leftmost visible day becomes `firstDay`, so a
  contiguous selection sits flush at the left edge of the grid. First-
  launch default is screen-aware: phones open to **yesterday / today /
  tomorrow** with today in the middle column; desktop / iOS pad sees all
  seven. The picker is week-view only — day and month remount
  `CalendarView` without it. Selection persists in localStorage
  (`order.calendar.week-hidden-days`) so it survives reloads on desktop,
  iOS, and the published viewer.

### Seasons

A **season** is a user defined date range, a sibling to Day / Week / Month /
Year in the calendar tabs. Where the other scopes fix the unit (one day, one
week, one month, one year) and let you walk through them in lockstep, a season
is your own unit: a stretch of life with a beginning and (usually) an end. Use
it for a school term, a sabbatical, a quarter at work, a baby's first six
months, the stretch between two surgeries. Order doesn't try to infer it. You
write it.

The motivation borrows from atlas journaling: the rhythms that matter to a
person are rarely a calendar's. A weekly review is too frequent to see the
shape of a project; a yearly review is too coarse to see the shape of a
season of life. The Season scope is the rhythm you actually live in.

**On disk**, a season list is a single file at the vault root, by convention
`Seasons.md`, identified by `role: seasons` in its YAML (the same shape
`Areas.md` uses with `role: areas`). The body is a bullet list of ISO 8601
ranges, one season per line:

```yaml
---
role: seasons
---
# Seasons

- 2026-01-27 - 2026-05-24 · Spring 2026
- 2026-06-01 -  · Current
```

An empty right edge means the season is open ended (the current season). The
`· name` suffix is optional; without it, the bare date range becomes the
label. The file is a plain note, so editing the ranges happens in the same
Crepe surface as any other note: a pencil button in the season header drops
you straight into it.

**The view**. The season header shows the name with the date range to its
right, sticky to the top like the year header. Below it sits a two column
Areas grid; each cell is one Area and lists the Notable Folders inside it
whose all-day events ("notable updates") fell inside the season's range,
sorted most recent first and capped at eight per cell. Each NF row expands
into nested bullets, one per all-day note in the range, with the note's title
as a tap-to-open link. Empty cells show only the Area name. The arrows step
through seasons in document order (disabled at the boundaries; no wrap); the
today button jumps to whichever season contains today's date, falling back to
the most recent past season if today sits in a gap.

The implementation is intentionally thin. A small `seasons.ts` library parses
the bullets and computes per-Area NF activity in memory over the already
loaded `calendarNotes`; the `SeasonView` component renders the grid. No new
vault APIs, no separate index, no FullCalendar coupling.

### File watching

A Rust-side `notify` watcher (debounced 500ms) observes the vault tree and
emits a `vault-changed` event on every `.md` change. The frontend listens,
coalesces with a 250ms timer, and re-runs the walk — so external edits (git
pull, Obsidian, another editor) reach the UI without a restart. Reloads
**preserve note ids by path**, so already-mounted Cards (with their Milkdown
editors, focus, scroll) keep their identity. Desktop only — iOS sandboxes the
security-scoped vault, so notify can't observe it from outside the app.

### Notable Folder sections — the newspaper template

The Stream is dynamic on purpose: it's the work surface, where thinking happens
and recency matters. But the moment you *focus* — filter to one or more Notable
Folders, or land on the home page — the dynamism falls away and a fixed,
templated layout takes over. Each filtered Notable Folder renders as a
**section**: its Main Document as a wide centered centerpiece, recent notes
orbiting in the left/right columns and below, a "Show more" to dig into older
entries, and a hairline divider before the next section.

The motivation is liturgical. A newspaper has weight — when you pick it up you're
*arriving* somewhere specific, and the sections sit in known positions every time.
A tool that filters and reflows under you can't give you that. The section
template can: you arrive at a Notable Folder and always know where things are,
because the template never changes. Two modes, each suited to its purpose — a
fluid Stream for working, a still page for reading and publishing.

(Mechanically: newspaper mode kicks in whenever ≥1 Notable Folder is filtered in
— including the default home view. Empty or exclude-only filters keep the flat
temporal Stream. `NotebookSection` is shared by the app and the web viewer so the
"page" is identical in both.)

### Pile-based navigation

Every navigation surface — sidebar tile, calendar event Open, command palette
pick, wikilink, filter-pill jump, recent-folders search — does the same thing:
the targeted Notable Folder goes on **top of the pile**. The pile is the
filter-pill stack; the Stream renders each pinned NF as a newspaper section
in pill order, so whatever you just touched sits at scrollY ~0. Other pinned
folders stay underneath, untouched.

This is the same instinct behind [PileTiddly](https://geetduggal.com/PileTiddly.html)
from 2004 (linked in the opening above) — digital space behaves like a real
desk pile. You don't "navigate" to something; you *put it on top*. Recently-
touched things float up, ignored things sink, structure follows attention. Re-clicking a folder that's
already several layers down bubbles it back to the surface; clicking the × on
any pill drops that layer out of the pile. The list is short by design — it's
a pile, not a folder tree.

Two consequences fall out for free: the scroll target is always right where
you put it (no slippage through a long flat list, especially on mobile), and
the pill stack reads as a most-recently-visited breadcrumb you can walk
backward through with the × buttons.

### Chrome

A single hovering **bottom dock** holds the everyday controls — equal-sized,
thumb-friendly, sitting above the iOS safe-area inset and identical on desktop
and phone. Left to right:

- `+` — new note (auto-folder when the filter has exactly one Notable Folder;
  opens a picker for two or more; plain capture when the filter is empty).
  Auto-flips Show to *All* when invoked under *Notable folders only* so the
  new card is always immediately visible.
- **view picker** — one button, a menu with two parallel groups:
    - *View*: Stream / Day / Week / Month / Year / Season
    - *Show*: All notes + folders / Notes only / Notable folders only
  Pick from either group changes only its own selection (a tap on "Notes only"
  doesn't force Stream view — you can be in Week + Notes-only at the same
  time). The button's icon reflects the current view at a glance.
- **home** — a button whose icon mirrors the current filter state: a
  `HomeIcon` when filtered to the home folder (coral fill, "at home"), a
  `FilterX` (muted) when no filters are active, and the neutral HomeIcon for
  any custom filter pile. The menu picks between *Home — `<folder>`* (single
  include for the home NF) and *Clear all filters* (bare stream). Single-tap
  destructive actions are explicit, never hiding behind a long-press.
- **search** — opens the centered command palette (same as `Cmd K`) for
  fuzzy folder pick. The empty-query view shows recently-opened Notable
  Folders first.
- **settings** — opens a small popover above the dock with the rest of the
  controls: publish, theme cycle, text-size `+ / −`, vault-folder picker,
  and the public/private lens (Globe / Lock — flip between *public + private*
  and *public only*).
- **sidebar toggle** — show / hide the right sidebar (rightmost so the
  motion ends where the sidebar appears).

The **right sidebar** *is* the taxonomy: drill Areas → Categories → Notable
Folders, and **add / remove / reorder** at each level — drag a tile, or use
its per-tile arrows. At the top of the sidebar sits the **filter-pill stack**
(always expanded in this slot, drag to reorder, × to remove, click to jump);
tap an Area or Category tile's check icon to filter the whole branch in one
gesture. The app opens with no folder filter; the persisted set rehydrates.
The published viewer's sidebar is read-only.

Each card carries its own top-right controls (left to right: copy-permalink 🔗,
fullscreen ⤢, trash 🗑, filter-remove ×) that fade up on hover. Below the body
sits a small **frontmatter strip** — every YAML key/value rendered inline in a
compact mono+sans pair, with wikilinks and URLs clickable (wikilinks navigate
the Stream; URLs open in the system browser via Tauri's shell). The strip
**starts collapsed** to a single `{ }` toggle for any note whose body has
substantial content; cards whose body is essentially empty (a calendar event
with just a title, say) expand the strip by default so the YAML reads at a
glance. The card footer holds a public/private pill, an Area › Category
breadcrumb, and the filename.

**Defaults**:
- Desktop / iOS app: View = *Week*, Show = *All notes + folders*. The
  calendar is the resting surface; the recency stream is one tap away.
- Published web viewer: View = *Stream*, Show = *Notes only*, filtered to
  the home Notable Folder. A first-time visitor lands on the home page
  reading actual writing, not on a flat recency timeline.

### Theming

A single rail button cycles the theme; the choice persists (applied before first
paint to avoid a flash) and carries into the published viewer:

- **Light / Dark / OLED black** — the everyday set; black takes every surface to
  true `#000` for OLED screens.
- **WordPerfect 5.1** — DOS-blue field, all-Menlo monospace (editor included).
- **America** — white field, pure blue + red accents, red card borders.
- **Christmas** — pine-green field, candy-cane red + bright green.
- **LCARS** — *Star Trek* console: pitch-black panels, amber text, orange + lilac
  accents, all-caps condensed sans.

Each theme is just a set of CSS custom properties (`--bg`, `--ink`, `--royal`,
`--coral`, …) on `:root[data-theme="…"]`; surfaces follow automatically, so
adding one is a dozen lines.

### Keyboard

- `Cmd +/−/0` — grow / shrink / reset note text. Scales via a `--text-scale`
  font-size variable — deliberately *not* CSS `zoom` or native webview zoom,
  which throw ProseMirror's click-to-caret hit-testing off (and the native path
  isn't available on iOS). The size persists.
- `Cmd N` — new note. `Cmd D / W / M / Y / S` — switch to Day / Week / Month /
  Year / Season. The active view persists across launches; first launch
  defaults to **Day on phones** (viewport ≤640px) and **Week on desktop**.
  Stream isn't on its own letter; reach it via the dock's Home button (or
  `Cmd R` to toggle home / clear).
- `Cmd Ctrl ← / →` — back / forward by the active view's unit. In **Stream**
  it cycles the single-folder include filter through `notableFolders`; in
  **Day / Week / Month** it calls FullCalendar's `prev` / `next`; in **Year**
  it decrements / increments the year; in **Season** it steps through the
  `Seasons.md` ranges in document order. (Both modifiers are required so plain
  Cmd+←/→ keep their browser-style word-jump behaviour inside the Milkdown
  editor.)
- `Cmd T` — cycle theme. `Cmd '` — clear all filters. `?` — toggle the
  keyboard-shortcut cheat sheet (bare key; suppressed while typing in an
  input / note).
- `Cmd O` — open the right sidebar (one-way; pair with `Cmd ;` to toggle).
- `Cmd ;` — toggle the right sidebar.
- `Cmd K` — open the centered command palette to toggle folder filters.
- `Cmd P` — open the Publish panel (also reachable from the dock's
  settings popover).

---

## Publishing

Order keeps one vault for two lives. Every note carries `public: true` or it
doesn't, and that single boolean is the only thing separating a private journal
entry from a published article. No separate blog, no draft folder, no second
system to copy content into — you can draft in the open marked private and flip it
public when it's ready, with public and private notes living side by side, shaped
by the same thinking and the same hierarchy. The vault stays a record of one
continuous mind, partially exposed and partially private, never split into two
selves.

A Notable Folder marked with `home: "<github user>/<repo>/<path>"` in its
YAML becomes the publish root. Hit the Upload icon (or `Cmd+P`), confirm
the target, and Order:

1. Walks the vault, collects every note flagged `public: true`, and emits a
   `data.json` snapshot (notes + frontmatter + bodies + chain taxonomy).
2. Prerenders a static permalink page for every public note
   (`/<slug>/index.html`) — wikilinks rewritten to permalink anchors, images
   to root-absolute URLs — so a direct link (or a `curl`) returns just that
   note's content rather than an empty JS shell, then boots the SPA seeded
   to that note.
3. Hands `data.json`, the prerendered pages, and a pre-built React bundle
   (`dist-viewer/`) to the Rust side (`publish_site`), which clones — or
   pulls — the target GitHub repo, wipes the chosen path, copies the bundle,
   any legacy root-level `Attachments/` dir from the vault, and each public
   note's same-folder images (placed next to that note's page so direct
   image URLs resolve), then `git commit && git push origin <branch>`. Auth
   uses the local git credential helper or SSH key; no new login flow.

### Permalinks

Every public note gets a permalink at `/<slug>/`. The slug is pinned in the
note's frontmatter the first time it publishes and never changes after — so
even if you rename the file or move it between Notable Folders, the URL
stays put. Inbound links from the web, Slack, email, and unfurlers don't
break the moment you reorganize the vault.

The slug is a human-readable URL fragment derived from the title (Order
strips punctuation, lowercases, and dasherizes). It deliberately doesn't
encode the chain — there's no `/<area>/<category>/<folder>/<note>/` route.
Two reasons:

1. **Folder paths are an editorial detail, not an identity.** A note's
   *meaning* doesn't change when you move it from `Selfish Spaces/Books`
   to `Selfish Projects/Reading List`, but a path-based URL would 404 the
   moment you did. The slug pins the note's identity to the note itself.
2. **Flat URLs read like a magazine, not a filesystem.** `/cal-newport/`
   and `/2026-living-room-refresh/` are immediately legible; the chain
   beats them by zero on shareability and costs everything in stability.

The mechanism. Each public note carries `slug: "<kebab-case>"` in its
frontmatter, written on its first publish. `publish_site` emits a static
HTML file at `<pubPath>/<slug>/index.html` containing the prerendered
content (so `curl` and link unfurlers see real prose, not a JS shell),
plus a `<script>` boot that hydrates the SPA filtered to that note. A
top-level `slugMap: { slug → ref }` in `data.json` lets the SPA resolve
arbitrary `/<slug>/` URLs back to the underlying note when a visitor
clicks around — same component graph as the desktop app, same NF-on-top
pile-based navigation, just with one URL per public note as the front
door.

The home Notable Folder is special-cased: its prerendered page is written
to **both** `index.html` (so `/` lands on it) and `<slug>/index.html` (so
the home note's own permalink still resolves). Same content, two paths,
no duplication of effort.

A small gift falls out of this design: drafting in the open. A note
marked `public: false` (the default) participates in the same Stream, the
same Cmd+K palette, the same calendar — but no permalink is emitted and
nothing reaches the published copy. Flip the boolean and the next publish
adds the page; flip it back and the page disappears on the publish after
that. One vault, two lives, one switch.

### The web viewer

The published site is **the same React components as Order**, just in read-only
mode. There's no static-site generator in between, no separate template that
quietly diverges from what you authored — what you arranged in the app while
working on the home page is exactly what a visitor lands on. The publish button
doesn't *transform* anything; it just makes a copy other people can reach. That's
the WYSIWYG promise kept all the way to the published artifact:

- `Card` accepts `initialBody` + `initialFrontmatter` and skips the Tauri
  disk read entirely. With `readOnly` set, Crepe runs as a read-only
  ProseMirror, save / rename / delete are short-circuited, and the
  edit-only chrome (trash, dismiss-pair) hides while navigation
  affordances (×-remove from filter, fullscreen) stay.
- The viewer's `StreamView` renders `<Card>` for every published note —
  same masonry, same sort (NF Main Docs pinned, then by date), same
  list-of-lists expansion, same folder-color border tint.
- Base-block lists in the viewer use the same `smartMerge` /
  `sortByBase` as the desktop: published notes carry their source
  directory (`dir`) and timestamps in the payload, so `file.folder`
  filters and `file.mtime` / `file.ctime` sorts work identically.
  Sort values are normalized (Date instances and ISO date strings
  treated as the same epoch ms) so a vault rendered in both surfaces
  reads in the same order.
- `useGridLayout` (the row-span hook) lives in `src/lib/grid-layout.ts`
  and is imported by both the desktop CardGrid and the viewer's
  StreamView. One source of truth for the masonry.
- All hash routes (`#/note/X`, `#/folder/X`, `#/stream?folders=…`)
  resolve to a single stream view with the appropriate filter set —
  the published site has exactly one screen, same as the app. Each public
  note additionally has a prerendered permalink page at `/<slug>/` that
  serves static HTML of just that note (real content for `curl` and link
  unfurlers) and then hydrates into the SPA focused on it.
- `Cmd+K` palette, Week / Month / Year calendar views, and the right
  sidebar all work; calendar move/create handlers are wired to no-ops.
- The theme switcher and the notes-only filter work in the viewer too;
  everything that would mutate the vault — editing, add / remove, and
  drag-reorder — is disabled, so the published page is fully read-only.
- The viewer's bottom dock is identical to the app's — view picker
  (Stream / Day / Week / Month / Year) and Show picker (All /
  Notes only / Folders only) in one popover, a state-aware Home button
  (HomeIcon when filtered to the home folder, FilterX when there's no
  filter, neutral HomeIcon otherwise) whose menu picks between *Home* and
  *Clear all filters*. A visitor lands with View = Stream and Show =
  Notes only on the home folder, and can fan out to Week or Year with
  one tap.

Build the viewer bundle once with `pnpm build:viewer` before the first
publish; subsequent publishes reuse it.

---

## First launch

See [Build from source](#build-from-source) for setup. Once Order is running, it
walks **every** `.md` file recursively — depth is arbitrary, since the chain
encodes the hierarchy.
Areas.md and the per-level directories (with their Main Docs) are written on
first run if absent; otherwise a one-shot migration generates the Areas /
Categories / Notable Folder files from any notes with `category:` set and the
legacy `order.taxonomy` localStorage key. Any other `.md` files you drop into a
Notable Folder show up on the next scan.

---

## A note on disk

```yaml
---
folder: "[[Books]]"
author: Susan Sontag
rating: 4.5
date: "2026-05-13"
startTime: "08:15"
---

# On Photography

A meditation on the camera's relationship to the world.
```

A note becomes a **Notable Folder Main Document** when its YAML has a `category`
field. A list folder additionally carries `list: cards` (or `lines`) and its
body holds the wikilink bullets that the card grid renders. Notes opt into
publishing by adding `public: true` to their frontmatter.

## Testing

```bash
pnpm test:e2e        # Playwright suite — real app, mocked Tauri IPC
pnpm test:e2e:ui     # same, with the Playwright inspector
ORDER_VAULT=~/path/to/vault pnpm test:e2e consistency   # lint any vault
```

The browser tests boot the unmodified app in Chromium against an
in-memory vault; the consistency tests double as a structural linter
for real vaults (chain integrity, attachment locality, todo.txt sync).
See `tests/e2e/` and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing).

## Releasing

`scripts/` holds one script per artifact — see
[docs/RELEASING.md](docs/RELEASING.md) for the full flow including App
Store submission:

```bash
scripts/build-desktop.sh   # signed .app + .dmg via tauri build
scripts/build-ios.sh       # .ipa via tauri ios build
scripts/release.sh v0.1.0  # tag + upload binaries to the GitHub release
```

## License

MIT.
