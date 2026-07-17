# Order — a guided tour of the codebase

This is the long, friendly version of [ARCHITECTURE.md](ARCHITECTURE.md). That
document is a terse reference for people who already know the system. **This one
assumes you're new** — new to this codebase, and maybe new to some of the
technologies it's built on. It explains not just *what* the pieces are but *why*
they exist and *how they fit together*, with special attention to the thing that
trips people up most: **how the layout works, in both the React code and the CSS.**

Read it top to bottom once and you'll be able to find your way around anything.

---

## Table of contents

1. [The one big idea](#1-the-one-big-idea)
2. [The technology, in plain terms](#2-the-technology-in-plain-terms)
3. [Where everything lives](#3-where-everything-lives)
4. [The data model on disk](#4-the-data-model-on-disk)
5. [How the app boots and how data flows](#5-how-the-app-boots-and-how-data-flows)
6. [The frontend, component by component](#6-the-frontend-component-by-component)
7. [**The layout system (code + CSS)**](#7-the-layout-system-code--css) ← the big one
8. [Spacetime and taxonomy](#8-spacetime-and-taxonomy)
9. [The Rust backend](#9-the-rust-backend)
10. [Publishing and the read-only viewer](#10-publishing-and-the-read-only-viewer)
11. [Building and running](#11-building-and-running)
12. [Mental models to keep](#12-mental-models-to-keep)
13. [Glossary](#13-glossary)

---

## 1. The one big idea

Order is a notebook, a calendar, and a personal website — but under the hood it is
**one idea applied over and over:**

> **Plain-text files are the database, and every screen is just a different way of
> reading the same files.**

There is no hidden database, no proprietary format, no cloud you're locked into.
Your "data" is a folder of Markdown (`.md`) files on your disk — the kind you could
open in any text editor, sync with Dropbox, or read in fifty years. Order reads that
folder and *presents* it: as a grid of cards, as a month calendar, as a published
website. When you edit something, Order writes plain text back to a file.

Everything else in this document is really about **how that one idea survives contact
with a vault of tens of thousands of files** without becoming slow or messy.

Two consequences worth internalizing right away:

- **The files are the truth.** If a screen and a file disagree, the file wins. The
  UI is disposable; the folder is precious.
- **There is almost no "state" in the traditional sense.** Most apps have a big
  in-memory model that the UI mutates. Order mostly just re-reads the files and
  re-derives everything (the calendar, the sidebar tree, the seasons) on each render.
  Fewer moving parts, fewer ways to drift out of sync.

---

## 2. The technology, in plain terms

If you already know these, skip ahead. If not, here's the whole stack in one breath,
each piece with a plain-English "what it does for us."

| Layer | What it is | What it does for Order |
|---|---|---|
| **Tauri v2** | A framework for building desktop/mobile apps where the *shell* is written in **Rust** and the *UI* is a web page. | Gives us native file access and a real app window (or iOS app) while letting us write the interface with normal web tech. Binaries are tiny (~10 MB) because it uses the operating system's built-in browser instead of shipping one. |
| **Rust** | A fast, memory-safe systems language. | Everything that touches the filesystem, watches for changes, indexes text for search, or talks to Google Calendar lives here. It's the "backend," except it runs locally on your machine. |
| **The WebView** | The OS's built-in browser engine (WKWebView on macOS/iOS). | Renders our React app. This is why the same UI code runs on Mac and iPhone. |
| **React 19 + TypeScript** | The industry-standard library for building UIs out of reusable "components," plus a typed flavor of JavaScript. | Our entire interface. TypeScript catches mistakes before they run. |
| **Vite** | A build tool / dev server. | Bundles the app and gives instant hot-reload while developing. |
| **Milkdown (Crepe)** | A WYSIWYG Markdown editor built on ProseMirror. | The rich text editor *inside each card*. You see formatted text, it saves Markdown. |
| **FullCalendar v6** | A calendar-rendering library. | The Day/Week/Month views. (Year and Season are hand-built.) |

The mental picture:

```
        ┌─────────────────────────────────────────────┐
        │                Tauri app window             │
        │  ┌─────────────────────────────────────────┐│
        │  │   WebView (OS browser engine)           ││
        │  │   → runs our React + TypeScript UI      ││
        │  └───────────────▲─────────────────────────┘│
        │                  │  "invoke" bridge (IPC)   │
        │  ┌───────────────┴─────────────────────────┐│
        │  │   Rust backend                          ││
        │  │   → reads/writes files, watches vault,  ││
        │  │     search index, Google Calendar sync  ││
        │  └───────────────▲─────────────────────────┘│
        └──────────────────┼──────────────────────────┘
                           │ real filesystem
                    ┌──────┴───────┐
                    │  your vault  │  ← a plain folder of .md files
                    └──────────────┘
```

The React side never touches the disk directly. It **asks** the Rust side to do
file things by calling named commands (this is Tauri's `invoke` mechanism — think of
it as calling a function that happens to run in Rust). All of those calls are
wrapped for us in one file, `src/lib/vault-fs.ts`, so from the UI's perspective the
filesystem is just a handful of async functions.

---

## 3. Where everything lives

A whirlwind tour of the repository so you know where to look.

```
order/
├── src/                      ← the React app (the UI)
│   ├── main.tsx              app entry point (mounts React)
│   ├── App.tsx               the outermost component + global keyboard shortcuts
│   ├── styles.css            ★ ALL the CSS lives here (one big file)
│   ├── components/           one file per UI piece
│   │   ├── CardGrid.tsx      ★ the hub — owns the data and routes everything
│   │   ├── Card.tsx          one note = one card
│   │   ├── LazyCell.tsx      "only render cards you can see" wrapper
│   │   ├── NotebookSection.tsx  the "newspaper" layout for a folder
│   │   ├── Sidebar.tsx       the Areas → Categories → Folders drill-down
│   │   ├── CalendarView.tsx  Day/Week/Month (FullCalendar)
│   │   ├── SeasonView.tsx / YearLinearView.tsx   hand-built calendars
│   │   ├── CommandPalette.tsx / FtsOverlay.tsx   ⌘K / ⌘F overlays
│   │   └── …surfaces (Milkdown/RawText/List/Terminal) and panels
│   └── lib/                  non-visual logic (parsing, syncing, helpers)
│       ├── spacetime.ts      ★ the canonical map: parse/serialize/mutate
│       ├── taxonomy.ts       builds the Areas→Categories→Folders tree
│       ├── grid-layout.ts    ★ the masonry engine (card heights)
│       ├── publish.ts / prerender.ts   the website generator
│       ├── vault-fs.ts       the wrapper around every Rust file command
│       └── …calendar, filters, frontmatter, theme, slug, etc.
│
├── src-viewer/               ← the published website (a second, read-only app)
│   ├── ViewerApp.tsx         reuses the SAME components as the main app
│   └── viewer.css            imports styles.css, adds a few tweaks
│
├── src-tauri/                ← the Rust backend
│   └── src/
│       ├── lib.rs            registers all the commands
│       ├── vault_fs.rs       read/write/walk/rename/remove files
│       ├── watcher.rs        notices external file changes
│       ├── fts.rs            full-text search index
│       ├── gcal.rs           Google Calendar
│       └── publish.rs        pushes the generated site to GitHub Pages
│
├── docs/                     ← you are here
├── tests/e2e/                Playwright tests
└── scripts/                  build helpers (cetl.sh etc.)
```

The two `★` files to understand first are **`CardGrid.tsx`** (the brain) and
**`spacetime.ts`** (the map). Almost everything else orbits those two.

---

## 4. The data model on disk

Here is what a vault actually looks like on disk. Understand this and you understand
90% of the app, because — remember — the files *are* the database.

```
<vault>/
├── spacetime.md              the canonical space + time map (human-editable)
├── spacetime.yml             the same map, machine-readable (auto-generated mirror)
├── todo.txt                  one-line calendar events (optional)
└── <Area>/                   e.g. "Work", "Personal", "Creative"
    └── <Category>/           e.g. "Creative Projects"
        └── <Notable Folder>/  e.g. "Tech Habits - Life without Order"
            ├── <Notable Folder>.md    the "Main Document"
            ├── 2026-07-03 Some note.md  a dated note / calendar event
            └── image.jpg              attachments live WITH their note
```

Four things to notice:

**1. The three-level hierarchy: Area → Category → Notable Folder.**
Everything you make lives inside a **Notable Folder** (NF for short) — a project, a
topic, a person. NFs are grouped into **Categories**, which are grouped into
**Areas**. Membership is decided by **where a file sits in the folder tree**, not by
any tag inside the file. A note is "in" an NF because its path is
`Area/Category/NF/2026-07-03 note.md` — exactly four path segments deep.

**2. Every NF has one "Main Document."**
Inside `Tech Habits - Life without Order/` there is a file named
`Tech Habits - Life without Order.md` — same name as the folder. That's the folder's
front page, its lead article. The other `.md` files in the folder are dated notes.

**3. Dated notes are calendar events.**
A file named `2026-07-03 Some note.md` shows up on July 3rd in the calendar. The date
lives in the *filename*. (There's frontmatter for finer detail like start time, but
the filename date is the authority — a deliberate rule, so renaming/frontmatter can
never silently move an event.)

**4. `spacetime.md` / `spacetime.yml` are the source of truth for *structure*.**
The folder tree tells you where files are, but the *order* of Areas, the *order* of
Categories, which folders are "seasons," and so on — that's recorded in
`spacetime.md`. Think of it as the table of contents for the whole vault. It's
written in a compact plain-text format called **Markwhen** (a `# Space` section for
the hierarchy, a `# Time` section for events and seasons). `spacetime.yml` is the
exact same information in YAML, kept perfectly in sync so machines have an easy-to-parse
copy. Edit either one and Order updates the other. (See [SPACETIME.md](SPACETIME.md)
for the full format.)

> **A note on the naming.** This file used to be called `spacetime.mw` (`.mw` =
> Markwhen). It's now `spacetime.md` so ordinary Markdown editors open it nicely, but
> the *format inside* is still Markwhen. The code detects all of `spacetime.md`,
> `*.spacetime.md`, and legacy `.mw` via one helper, `isSpacetimeFile()` in
> `spacetime.ts`. You'll see the old `.mw` name lingering in some code comments — same
> file, old name.

### Frontmatter

Many files start with a little YAML block between `---` fences:

```markdown
---
title: Tech Habits - Life Without Order
category: Creative Projects
public: true
url: https://medium.com/@geetduggal/…
---
# The actual note starts here
```

This is **frontmatter** — metadata about the note. `public: true` means "publish this
to my website." `url:` links back to an original source. `category:` records which
category an NF's Main Document belongs to. The code that splits this off from the body
lives in `src/lib/frontmatter.ts`.

---

## 5. How the app boots and how data flows

Here's the life cycle of the app, start to finish.

**Boot.** When the app opens, `CardGrid` asks Rust to walk the entire vault and hand
back **just the metadata** for every file — its path, its frontmatter, its size, its
modification time, but *not its body text*. This is the single most important
performance decision in the app: a vault can have tens of thousands of files, and
reading every body on boot would be unbearably slow. So we read the cheap stuff for
everyone and defer the expensive stuff (the actual text) until a card is on screen.

That metadata becomes an array called **`notes[]`**, which lives in `CardGrid`. This
array is the closest thing Order has to a "database in memory." Everything else is
*derived* from it.

**Derivation.** From `notes[]`, `CardGrid` computes (using React `useMemo`, which just
means "recompute this only when its inputs change"):

- the **taxonomy** — the Areas → Categories → Folders tree that drives the sidebar,
- the **calendar events** — which notes fall on which days,
- the **season grids**, the **pile** of cards currently on screen, and so on.

Nothing is stored twice. There's no separate "calendar store" that could drift out of
sync with the notes — the calendar is *literally a function of `notes[]`*.

**Reading a body.** When a card scrolls into view (more on how we detect that in the
layout section), it asks Rust for that one file's text and shows it.

**Writing.** When you type in a card, Order waits until you pause (a 600-millisecond
"debounce," so we're not writing on every keystroke), then does:

```
split off frontmatter → apply your edit → glue frontmatter back → ask Rust to save
```

Every save also stamps a short-lived "I just wrote this" marker so the file watcher
(next paragraph) doesn't turn around and reload the card you're actively editing.

**The watcher.** Rust watches the vault for changes made *outside* Order — a Dropbox
sync, a `git pull`, you editing a file in another app. When it sees one, it tells the
UI, which re-walks the metadata and updates `notes[]`. Cards are matched back up by
their file path, so an editor you had open keeps its cursor even though the data
underneath just refreshed.

The whole thing, in one diagram:

```
  Rust walks vault (metadata only)
            │
            ▼
   notes[]  ────────────────►  derived: taxonomy, calendar, seasons, pile
   (in CardGrid)                        │
        ▲                               ▼
        │                        the UI renders
   watcher tells us         (cards load their bodies lazily)
   about outside edits              │
        │                           ▼
        └────────  you type  ──►  debounced save  ──►  Rust writes the file
```

---

## 6. The frontend, component by component

The UI has one clear hub and a ring of specialized components around it.

### `CardGrid.tsx` — the hub

This is a big file (~4,000 lines) on purpose. It **owns** the important state:
`notes[]`, which **view** you're in (grid / calendar / list / year / season), and the
**filters** (which folders you've drilled into). It routes every mutation — creating a
note, renaming, deleting, moving — through itself and down to Rust. There's
deliberately **no Redux, no Zustand, no global Context.** State that matters lives
here; everything else is passed down as props or recomputed. This keeps the data flow
one-directional and easy to trace: if you're hunting for "where does X happen," it's
almost always in `CardGrid`.

### `LazyCell.tsx` — "only render what you can see"

Rendering a rich Markdown editor is expensive. Rendering hundreds of them at once
would melt the machine. `LazyCell` wraps each card in an **IntersectionObserver** — a
browser feature that tells you when an element scrolls into (or out of) view. Cells
that are off-screen render a cheap placeholder of the right height; only when a cell
nears the viewport does the real `Card` (with its editor) mount. This is what lets a
folder with hundreds of notes scroll smoothly.

### `Card.tsx` — one note, one card

A `Card` is the visual container for a single file. Based on the file type it mounts a
different **surface** inside itself:

- **`MilkdownSurface`** — the rich WYSIWYG editor, for normal `.md` notes.
- **`RawTextSurface`** — a plain monospace textarea, for `.txt`, `.yml`, and the
  `spacetime.md` file (you want to see those raw, not prettified).
- **`SheetSurface` / `DrawingSurface`** — flip a note to a spreadsheet
  (react-spreadsheet, `<Name>.sheet.html`) or an Excalidraw drawing
  (`<Name>.excalidraw`); the active view lives in the note's `view:`
  frontmatter. Lazy-loaded. See [SHEET-DRAWING.md](SHEET-DRAWING.md).
- **`ListCards` / `ListLines`** — special renderings for list-style notes.
- **`NotableFolderBackside`** — flip a folder card over and you get a file browser +
  drag-and-drop.
- **`OrderTerminal`** — yes, there's a real terminal (xterm.js) you can open inside a
  card.

`Card` also handles the "chrome": the title, the fullscreen toggle, the frontmatter
inspector (which auto-opens when the frontmatter contains a clickable URL), and saving.

### `Sidebar.tsx` — the drill-down

The collapsible right-hand panel. It shows the Areas → Categories → Folders tree
(built from the taxonomy) and lets you filter the pile down to one folder. Clicking a
folder adds a **filter pill**; the pile then shows only that folder's notes.

### The overlays and calendars

- **`CommandPalette.tsx`** (⌘K / ⌘O) — fuzzy folder/file picker.
- **`FtsOverlay.tsx`** (⌘F) — full-text search, backed by the Rust index.
- **`CalendarView.tsx`** — Day/Week/Month via FullCalendar.
- **`YearLinearView.tsx`** — a hand-built 12-months-×-37-slots strip.
- **`SeasonView.tsx`** — Areas laid out across a date range.

### `App.tsx` — the outer wrapper

The topmost component. It renders `CardGrid` and installs a few **global behaviors**
that have to work everywhere:

- `useExternalLinks` — intercepts clicks on any `<a>` and opens them in the real OS
  browser instead of navigating the app's WebView away from itself.
- `useTextZoomShortcuts` — ⌘+ / ⌘- / ⌘0 to scale text.

---

## 7. The layout system (code + CSS)

This is the section the rest of the doc was leading up to. Order's layout looks simple
but has several clever moving parts. We'll build it up one layer at a time. **All the
CSS quoted here is in `src/styles.css`**; line numbers are given so you can jump
straight there.

### 7.0 The three-layer mental model

From outermost to innermost, the layout nests like this:

```
.shell                     ← the whole window: [ content | sidebar ]
└── .pane-main             ← the scrolling content column
    └── .card-grid         ← the masonry grid of cards
        └── .card-grid-cell  ← one slot; holds one .order-card
```

Plus one sibling of `.pane-main`:

```
.shell
├── .pane-main   (the content)
└── .pane-right  (the sidebar)
```

Keep that nesting in your head; every rule below hangs off one of those four class
names.

### 7.1 The shell — content beside a collapsible sidebar

The outermost layout is a **CSS Grid with two columns**: the content on the left, the
sidebar on the right. Here's the actual rule (styles.css:1604):

```css
.shell {
  display: grid;
  grid-template-columns: 1fr 0;      /* content takes everything; sidebar is 0 wide */
  transition: grid-template-columns 180ms var(--ease-out);
  width: 100%;
  min-height: 100vh;
}
.shell.sidebar-open { grid-template-columns: 1fr 360px; }
```

Read that slowly, because it's a lovely little trick:

- `grid-template-columns: 1fr 0` means "two columns: the first takes **1 fraction** of
  the leftover space (i.e. *all* of it), the second is **0 pixels** wide." So by
  default the sidebar is collapsed to nothing and the content fills the window.
- When you open the sidebar, we add the class `sidebar-open`, which changes the second
  column to `360px`. The content column, still `1fr`, automatically shrinks to make
  room.
- Because there's a `transition` on `grid-template-columns`, the sidebar **slides**
  open and closed over 180ms instead of snapping.

That's the entire open/close mechanism: one class toggling a column width. No JS
animation, no measuring.

### 7.2 The card grid — responsive columns for free

Inside the content pane sits the star of the show, `.card-grid` (styles.css:441):

```css
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(420px, 100%), 1fr));
  grid-auto-rows: 8px;
  grid-auto-flow: row dense;
  column-gap: 12px;
  row-gap: 12px;
}
```

The magic is that one `grid-template-columns` line. Let's unpack it piece by piece,
because it's doing a lot and it's the kind of CSS that looks like noise until it
clicks:

- **`repeat(auto-fill, …)`** — "make as many columns as fit." We don't hard-code a
  column count. The browser fits as many as it can.
- **`minmax(X, 1fr)`** — each column is "at least `X` wide, but allowed to stretch up
  to `1fr`" (an equal share of the row). So columns never get narrower than `X`, and
  when there's spare width they grow to fill it evenly.
- **`min(420px, 100%)`** — this is the `X`. It means "420px, *unless* 420px is wider
  than the whole container, in which case just use 100%." Why the `min()`? On a phone
  the container might be 380px wide. Without the guard, the column would demand 420px
  and overflow the screen sideways. With it, a narrow screen collapses cleanly to a
  single full-width column.

Put together: **widen the window and another column appears the instant one more
~420px slot fits; narrow it and columns drop away; on a phone you get exactly one.**
No media queries, no JavaScript, no breakpoints to maintain. The grid negotiates its
own column count against the available width. (Text zoom works too, because zooming
changes the logical viewport width, which the grid reacts to naturally.)

The two remaining lines — `grid-auto-rows: 8px` and `grid-auto-flow: row dense` — are
the setup for the masonry trick, which is next.

### 7.3 The masonry trick — why cards of different heights pack tightly

Here's the problem. Cards have wildly different heights: a one-line note is tiny, a
long article is tall. A naive grid would make every cell in a row as tall as the
tallest card in that row, leaving ugly gaps under the short ones. What we want is
**masonry** — the Pinterest look, where each card is its natural height and the next
card slots up right below it, columns packing independently.

CSS doesn't have real masonry yet (it's coming, but not reliably shippable). So Order
fakes it with a well-known technique, and this is where those two leftover lines earn
their keep:

**Step 1 — make the rows very short.** `grid-auto-rows: 8px` says every implicit grid
row is just 8 pixels tall. A card isn't one row tall — it spans *many* short rows. By
choosing how many rows a card spans, we can size it to any height in 8px increments
(fine enough that you never notice the quantization).

**Step 2 — measure each card and tell it how many rows to span.** That's the job of
`useGridLayout` in `src/lib/grid-layout.ts`. It's small enough to quote the heart of:

```ts
const GRID_ROW_PX = 8;

function relayoutCell(cell) {
  const rowGap = parseFloat(getComputedStyle(grid).rowGap);
  const child = cell.firstElementChild;                 // the .order-card
  const rows = Math.max(
    1,
    Math.ceil((child.offsetHeight + rowGap) / (GRID_ROW_PX + rowGap)),
  );
  cell.style.gridRowEnd = `span ${rows}`;               // ← the whole trick
}
```

In words: measure the card's real pixel height (`offsetHeight`), divide by the 8px row
unit (plus the gap), round up, and set `grid-row-end: span N`. Now the cell occupies
exactly enough short rows to fit its card. Do this for every card and — combined with
`grid-auto-flow: row dense`, which tells the grid to backfill gaps — the columns pack
tightly like real masonry.

**Step 3 — keep it correct as things change.** Card heights aren't static: you type
into an editor, an image loads, the window resizes. `useGridLayout` watches for all of
these so the span stays right:

- a **`ResizeObserver`** on each card re-measures when its height changes,
- a **`MutationObserver`** catches DOM changes (e.g. ProseMirror rewriting its
  contents) that the ResizeObserver might miss,
- listeners on `input`/`keyup` re-measure the card you're typing in on the next frame,
- a `window` resize listener re-lays-out everything.

One subtle CSS partner to this, at styles.css:456:

```css
.card-grid-cell {
  align-self: start;   /* pin the card to the TOP of its row-span block */
  min-width: 0;
}
```

`align-self: start` matters because otherwise the card would stretch to fill all the
rows we gave it, and then `offsetHeight` would measure the *stretched* height, not the
card's intrinsic height — a feedback loop. Pinning it to the top means the measurement
always reflects the true content height.

### 7.4 Full-width Main Documents

A folder's Main Document (its lead article) shouldn't sit in one skinny column — it's
the headline. So its cell gets a modifier class (styles.css:477):

```css
.card-grid-cell.is-full-width {
  grid-column: 1 / -1;   /* span from the first grid line to the last */
}
```

`grid-column: 1 / -1` is CSS shorthand for "span every column." The masonry row-span
math still applies on the vertical axis; only the horizontal span changes.

### 7.5 The newspaper layout — `.nf-grid`

When you drill into a single folder, Order doesn't show a flat grid. It shows a
**newspaper**: the Main Document as a big centerpiece in the middle, with the folder's
notes "orbiting" it in narrower side columns. This is `NotebookSection.tsx` rendering
a grid with the class `.nf-grid`.

`.nf-grid` **is a `.card-grid`** — it inherits all the masonry machinery above — but on
wide screens it swaps the auto-fitting columns for a fixed three-column newspaper
layout (styles.css:5358):

```css
@media (min-width: 1080px) {
  .nf-grid {
    grid-template-columns: 1fr 1.9fr 1fr;   /* narrow | WIDE centre | narrow */
  }
  .nf-grid .is-centerpiece {
    grid-column: 2;                          /* Main Document sits in the middle */
  }
}
```

So on a desktop:

```
 ┌────────┬───────────────────┬────────┐
 │ note   │                   │ note   │
 ├────────┤   MAIN DOCUMENT   ├────────┤   ← centre column is 1.9fr: nearly
 │ note   │   (centerpiece)   │ note   │     twice as wide as each side
 ├────────┤                   ├────────┤
 │ note   │   …article body…  │ note   │
 └────────┴───────────────────┴────────┘
        the side notes "orbit" the lead
```

`grid-auto-flow: row dense` (inherited) is what lets the orbiting notes flow into the
left/right gaps beside the tall centerpiece and then continue below it. Below 1080px
the fixed columns are dropped and the centerpiece just becomes a full-width lead
(`grid-column: 1 / -1`) with notes flowing beneath — the responsive fallback.

There's also a set of rules (styles.css:5378+) that shrink heading sizes *inside*
newspaper cards, so a note's big `# H1` doesn't tower over the section — modestly on
the centerpiece, more on the orbiting notes. Fullscreen reading restores the normal
scale.

### 7.6 The sidebar-open reflow — the subtle one

This is the trickiest interaction in the whole layout, and it went through a few wrong
turns before landing, so it's worth understanding precisely.

**The goal**, in the user's words: opening the sidebar should feel like the sidebar
*becomes* the rightmost column — the pile drops its right column and the cards reflow
left — **without** shrinking the cards that remain, and **without** shrinking the
Main Document you're reading.

The naive approach — "the content pane got narrower, so everything inside just
reflows" — fails, because both our grids stretch to fill their container (`1fr`). Make
the container narrower and every column shrinks proportionally; nothing gets *dropped*,
everything just gets *squished*. That's the opposite of what we want.

The fix is **two targeted rules**, one for each kind of grid.

**Flat piles** (the temporal pile, *not* a newspaper) get their `1fr` stretch removed
and replaced with a *fixed* column width (styles.css:1619):

```css
.shell.sidebar-open .card-grid:not(.nf-grid) {
  grid-template-columns: repeat(auto-fill, minmax(min(440px, 100%), 440px));
  justify-content: start;
}
```

The key difference from the normal grid rule is the second `minmax` argument: it's
`440px`, not `1fr`. Columns are now a **fixed 440px** instead of stretchy. So when the
sidebar eats 360px of width, the grid can't stretch to compensate — instead it simply
**fits one fewer 440px column** and `justify-content: start` packs the survivors to the
left. Cards keep their size; the rightmost column vanishes; the rest reflow left.
Exactly the "the sidebar became the third column" feeling.

**Newspaper sections** need their own rule, because a `.nf-grid` *is* a `.card-grid` —
without the `:not(.nf-grid)` exclusion above, the flat rule would clobber the
newspaper's `1fr 1.9fr 1fr` and squish the centerpiece. Instead (styles.css:5368):

```css
@media (min-width: 1080px) {
  .shell.sidebar-open .nf-grid {
    grid-template-columns: 1fr 1.9fr;   /* drop the RIGHT column; keep wide centre */
  }
}
```

We drop the *right* orbit column (3 columns → 2) and keep the wide `1.9fr` centre, so
**the Main Document you're reading doesn't change width at all** — its orbiting notes
just reflow into the remaining left column (row-dense again). This was verified by
measuring the centerpiece before/after: it stays put.

The lesson worth remembering: *`.nf-grid` is a `.card-grid`, so any rule you write for
`.card-grid` hits newspaper sections too unless you exclude them.*

### 7.7 Responsive breakpoints

Two breakpoints matter:

- **`min-width: 1080px`** — the desktop newspaper. Above it, `.nf-grid` is the
  three-column layout; below it, folders fall back to a single-column lead + flow.
- **`max-width: 640px`** — phone mode (styles.css:5473). Here the sidebar can't take a
  360px slice of a tiny screen, so it stops being a grid column and instead
  **overlays** the content as a fixed panel that slides in from the right:

```css
@media (max-width: 640px) {
  .shell.sidebar-open { grid-template-columns: 1fr 0; }   /* sidebar is NOT a column */
  .pane-right {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: min(86vw, 320px);
    z-index: 120;                                          /* floats over the content */
    box-shadow: -8px 0 24px rgba(20,20,20,0.12);
  }
}
```

Note the shell goes back to `1fr 0` on a phone — the sidebar is no longer a real
column; it's a floating overlay. The same block also tightens grid padding and gaps so
the content uses nearly the full width.

### 7.8 The scrolling panes and the sticky sidebar

Two more rules complete the shell. The content pane (styles.css:1624):

```css
.pane-main {
  min-width: 0;
  overflow-x: clip;                 /* stop horizontal bleed WITHOUT making it scroll */
  padding-top: env(safe-area-inset-top);       /* dodge the iOS notch */
  padding-bottom: calc(76px + env(safe-area-inset-bottom));  /* clear the bottom dock */
}
```

Two things a novice should note here. `env(safe-area-inset-*)` are iOS values for the
notch and home indicator — using them is how the same CSS looks right on a phone.
And the comment on `overflow-x: clip` is load-bearing: using `overflow-x: hidden`
would secretly turn the pane into its own scroll container, which would break
`position: sticky` elsewhere. `clip` prevents sideways bleed without that side effect.

The sidebar (styles.css:1640) is **sticky** so it stays in place while the pile
scrolls:

```css
.pane-right {
  position: sticky; top: 0;
  height: 100vh;
  overflow: hidden auto;            /* the sidebar scrolls independently if it's tall */
  border-left: 1px solid var(--rule);
}
```

### 7.9 One CSS gotcha worth its own heading: no transforms on the cell

There's an emphatic comment at styles.css:467 warning: **never put
`transform`/`animation`/`will-change` on `.card-grid-cell`.** Here's why, because it's
a genuinely surprising bit of CSS.

When a card goes fullscreen, it becomes `position: fixed` so it can cover the viewport.
But a fixed element is only "fixed to the viewport" if none of its ancestors have a
`transform` (or a few similar properties). Any ancestor with a transform creates a new
"containing block," and the fixed element gets trapped inside *that* ancestor instead
of escaping to the whole screen. So the mount animation lives on the `.order-card`
*child* (styles.css:488), never on the cell. If you ever add a hover-scale or a slide
to a cell and fullscreen mysteriously breaks, this is why.

### 7.10 Recap of the layout in one picture

```
.shell  (grid: 1fr | 0→360px)
├── .pane-main
│   └── .card-grid          columns = auto-fill minmax(min(420,100%), 1fr)
│       │                   rows    = 8px each; flow = row dense  → masonry
│       ├── .card-grid-cell  ← grid-row-end: span N  (set by useGridLayout)
│       │   └── .order-card
│       └── .card-grid-cell.is-full-width  → grid-column: 1 / -1
│
│   …or when drilled into a folder…
│   └── .nf-grid            ≥1080px: columns = 1fr 1.9fr 1fr
│       ├── .is-centerpiece → grid-column: 2   (the Main Document)
│       └── orbiting notes  → flow into side columns (row dense)
│
└── .pane-right (sticky sidebar; overlay on phones)

sidebar-open changes:
  • flat pile   → columns become fixed 440px  → drop a column, reflow left
  • newspaper   → columns 1fr 1.9fr 1fr → 1fr 1.9fr  → drop right, keep centre
```

---

## 8. Spacetime and taxonomy

We touched `spacetime.md` in the data-model section; here's how it flows through the
code.

### The parser/serializer

`src/lib/spacetime.ts` is the in-memory model of the map: a tree of `SpaceNode`s
(the Areas/Categories/Folders), a list of `SpacetimeEvent`s, and `SpacetimeSeason`s.
It knows how to:

- **parse** the Markwhen text (`parseMarkwhenFormat`) and the YAML (`parseSpacetime`),
- **serialize** back to both (`serializeMarkwhen`, `serializeSpacetime`),
- **mutate** the tree (`applySpaceMutation` — add/remove/reorder an Area etc.),
- **merge** multiple spacetime sources (a vault can have several `*.spacetime.md`
  files that compose into one map, via `mergeSpacetimes`).

### The mirror (keeping `.md` and `.yml` in sync)

A continuous effect in `CardGrid` regenerates the spacetime files whenever `notes[]`
changes: it preserves the existing space + seasons, regenerates the events from note
frontmatter, and writes both `spacetime.yml` and `spacetime.md`. A guard
(`lastSpacetimeRef` / `lastMarkwhenRef`) holds off that write if the on-disk file was
hand-edited since the last mirror write — so your manual edits in the raw-text card or
an external editor are never silently clobbered. Edits flow **both** directions: edit
the `.md`, it's parsed and pushed to `.yml` (and vice-versa), which re-derives the
taxonomy on the next render.

### The taxonomy

`src/lib/taxonomy.ts:buildVaultTaxonomy()` turns the parsed map into the
`VaultTaxonomy` that drives the sidebar and the pile. If `spacetime` carries a
non-empty `space` tree, that *is* the taxonomy (order and all). If not — an
un-migrated vault — it falls back to reading the older `Areas.md` chain files, so
nothing breaks.

> **A hard-won rule lives here:** structural files must **only** ever be
> `spacetime.md`/`spacetime.yml`. An old migration path used to scatter chain-index
> `.md` files at the vault root when it couldn't find `Areas.md`; that polluted the
> vault and is now guarded against (a `hasSpacetime` check). If you touch migration
> code, never let it create loose index files.

### Piles and filters

The "pile" is the scrolling stack of cards you see. The **filters** decide what's in
it. Click a folder in the sidebar → a filter pill is added → the pile narrows to that
folder and renders as a newspaper section. With no filter, the pile is a flat,
paginated (capped at ~60 cards) temporal stream. All of this is state on `CardGrid`
and logic in `src/lib/filters.ts` + the pile-building code.

---

## 9. The Rust backend

Everything filesystem-y or OS-y lives in `src-tauri/src/`. From the UI you never see
Rust directly — you call the wrappers in `lib/vault-fs.ts`, which `invoke()` the
matching Rust command. The commands are registered in `lib.rs`. The important ones:

| File | Responsibility |
|---|---|
| `vault_fs.rs` | The core file bridge: walk metadata, read/write text, rename, remove, backup. |
| `watcher.rs` | Watches the vault (the `notify` crate, 500ms debounce) and emits a `vault-changed` event when files change outside the app. |
| `fts.rs` | Builds and queries a full-text search index in Rust (fast even on huge vaults). |
| `gcal.rs` | Google Calendar: OAuth, pull events, push events/invites. |
| `publish.rs` | Pushes the generated static site to GitHub Pages. |
| `terminal.rs` | Spawns a real PTY for the in-card terminal. |
| `lib.rs` / `main.rs` | Wire everything together; register commands. |

Two backend concepts worth knowing:

- **The `vaultasset://` scheme.** Images and video in your notes are served to the
  WebView through a custom URL scheme that streams bytes from disk with HTTP Range
  support. That's why a note can embed a 4K photo or a video and it just works, without
  copying files into a web server.
- **The metadata walk is the performance backbone.** `vault_walk_metadata` returns one
  small struct per file (frontmatter string, body byte-length, mtime) and *no bodies*.
  This is what makes boot fast on a huge vault; bodies come later, per card, via
  `vault_read_text`.

---

## 10. Publishing and the read-only viewer

Order can publish your `public: true` notes as a static website — and it does so
**without a second UI codebase.** The published site reuses the very same React
components, in read-only mode. This is a deliberate anti-drift decision: there's no
separate "web template" that could fall out of sync with the app.

The pipeline, in three stages:

1. **Collect** — `src/lib/publish.ts:collectPublishedSite()` gathers every `public`
   note, the home page, a slug map (pretty URLs), and a **taxonomy built from the
   publicly-visible subset of spacetime** (so the published sidebar shows exactly the
   Areas/Categories/Folders that contain public notes — nothing private leaks). The
   output is one JSON blob, `data.json`.

2. **Prerender** — `src/lib/prerender.ts:prerenderPages()` turns each note into static
   HTML (via `marked`) so the site works and is indexable even before JavaScript runs.
   Each public NF gets a clean permalink.

3. **Serve** — the viewer SPA in `src-viewer/` (`ViewerApp.tsx`, `main.tsx`,
   `viewer.css`) loads `data.json` and renders the site by reusing `NotebookSection`,
   `Card`, the sidebar, the masonry — all of it — with the same `styles.css`. Rust's
   `publish_site` command pushes the result to GitHub Pages.

Because the viewer shares the layout code, everything in Section 7 applies to the
website too: the newspaper sections, the masonry, the sidebar reflow, the responsive
breakpoints. A permalink deep-links straight to one focused article (with a guard so
it doesn't also glue the home page beneath it).

---

## 11. Building and running

Common workflows (see also [RELEASING.md](RELEASING.md) and
[ios-build-notes.md](ios-build-notes.md)):

- **Dev server (web):** `pnpm dev` — Vite with hot reload. Fastest loop for UI work.
- **Desktop app:** built with `scripts/cetl.sh 1`. `cetl.sh` is the build dispatcher —
  `1` = desktop, `2` = iOS, `3` = push, `4` = release. This is how the desktop binary is
  produced for real testing.
- **iOS build:** source the cargo environment first, then build without extra args:
  ```
  source "$HOME/.cargo/env"
  pnpm tauri ios build --export-method debugging
  ```
  Install the resulting `.ipa` (`src-tauri/gen/apple/build/arm64/Order.ipa`) to the
  device with `xcrun devicectl device install app`.
- **Tests:** `pnpm test:e2e` runs Playwright against the real app in Chromium with a
  mocked Tauri bridge; the `tests/e2e/*.spec.ts` node specs cover spacetime
  serialization, sync planning, and migration.

---

## 12. Mental models to keep

A handful of invariants that, once internalized, prevent most bugs:

- **The files are the database.** When in doubt, look at what's on disk. The UI is a
  view; the folder is the truth.
- **`notes[]` in `CardGrid` is the in-memory hub.** Almost everything is derived from
  it with `useMemo`. There is no second store to keep in sync.
- **Structure = spacetime, membership = path.** A note's Area/Category/Folder is
  decided by *where its file sits* (4 path segments). Ordering and seasons live in
  `spacetime.md`/`.yml`. Never write loose index files to the vault.
- **Filename date is the authority for events**, not frontmatter. Renaming or editing
  frontmatter must never silently move an event.
- **`.nf-grid` is a `.card-grid`.** Any `.card-grid` CSS rule hits newspaper sections
  unless you add `:not(.nf-grid)`.
- **No `transform` on `.card-grid-cell`** — it traps the fullscreen card. Animate the
  `.order-card` child instead.
- **The viewer reuses the app's components.** Fix a layout bug once and it's fixed in
  both the app and the published site — but also, break one and you break both.
- **Quote your dates** in YAML (`date: "2026-07-03"`) — unquoted, they parse as Date
  objects.

---

## 13. Glossary

- **Vault** — the root folder that holds all your notes. The whole "database."
- **Area / Category / Notable Folder (NF)** — the three-level hierarchy. An NF is a
  project/topic/person; it lives at `Area/Category/NF/`.
- **Main Document** — the file named after its folder (`NF/NF.md`); the folder's lead
  article / front page.
- **spacetime.md / spacetime.yml** — the canonical map of structure (Areas order,
  seasons) + events. `.md` is human-editable Markwhen; `.yml` is the machine mirror;
  they're kept in sync. (Formerly `spacetime.mw`.)
- **Frontmatter** — the `--- … ---` YAML metadata block at the top of a note.
- **Pile** — the scrolling stack of cards currently on screen.
- **Filter pill** — a chip representing an active folder filter narrowing the pile.
- **Masonry** — the Pinterest-style layout where variable-height cards pack tightly.
  Order fakes it with `grid-auto-rows: 8px` + a per-card row-span (`useGridLayout`).
- **Newspaper section (`.nf-grid`)** — a drilled-into folder rendered as a big
  centerpiece with orbiting notes.
- **Surface** — the editing component inside a card (Milkdown / RawText / List /
  Terminal), chosen by file type.
- **The bridge** — `lib/vault-fs.ts` on the JS side + the Rust commands it `invoke()`s;
  the only path between the UI and the disk.
- **WebView** — the OS browser engine that renders the React app inside the Tauri
  shell.
- **Tauri** — the Rust-shell + web-UI app framework that lets one codebase ship macOS
  and iOS.

---

*This guide is a companion to the terse [ARCHITECTURE.md](ARCHITECTURE.md). When the
code and this doc disagree, the code wins — but please fix the doc.*
