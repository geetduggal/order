# Order

*Your notes, at home at last.*

A specialized, local-first note app. One screen for thinking, browsing, and
publishing. Markdown files with YAML frontmatter as the single source of truth,
an Obsidian-compatible vault, built on Tauri v2 — the same codebase ships desktop
today and iOS next.

![Order — a Notable Folder rendered as a newspaper section: the Main Document as a wide centerpiece with recent notes orbiting around it](img/order-home.png)

**Demo videos:** [Basics](https://drive.google.com/file/d/1H2Yv9Jf59Og1bimFuDhJmIlOvjCA4iDp/view?usp=sharing) · [Lists](https://drive.google.com/file/d/1TdWU6fPFFOTDnodDT3AWenjyuuMRjffg/view?usp=sharing)

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
6. **Subtle UI.** Two accents only — royal blue `#4169E1` and coral `#FF7F50`.
   Sans-serif for chrome, serif for prose. Whitespace and hairlines do the work of
   borders. The aim is *sehaj* — an intuitive equipoise where the layout asks
   nothing of you; you don't navigate it, you inhabit it.
7. **Speed matters.** Startup, scan, filter, edit, save — all optimized for flow.

---

## The hierarchy

- **Area** — broadest level, max 10 per vault (e.g. *Personal*, *Projects*).
- **Category** — within an Area, max 10 (e.g. *Reading* within *Personal*).
- **Notable Folder** — within a Category. A note whose YAML carries `category:`.
  Holds a Main Document (long-form prose, a curated list, or an auto-grid) plus
  any number of regular notes that link to it via `folder: "[[Folder Name]]"`.

Areas and Categories are derived from the Notable Folders themselves (no separate
storage). Names you've explicitly added are persisted in `localStorage` under
`order.taxonomy` so empty Areas / Categories survive a vault scan.

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

### Stack

- **Tauri v2** — Rust shell, system webview. Native window, native file IO, ships
  desktop today (`pnpm tauri:dev`) and iOS from the same codebase.
- **React 19 + TypeScript** — single-page app rendered into the webview.
- **Vite** — dev server with HMR on `localhost:1420`.
- **[Milkdown Crepe](https://milkdown.dev/)** — ProseMirror-based WYSIWYG markdown
  editor. One instance per Card; uncontrolled after mount.
- **[FullCalendar v6 React](https://fullcalendar.io/)** — Week and Month calendars.
  Year is a hand-rolled linear strip (`YearLinearView.tsx`) ported from a fork
  of `obsidian-full-calendar`.
- **js-yaml** — frontmatter parse / dump on the JS side.

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
├── Attachments/                        pasted / dropped images
├── Creative/
│   ├── Creative.md                     list: cards (the Area file)
│   ├── Creative Spaces/                Category dir
│   │   ├── Creative Spaces.md
│   │   ├── Articles/                   Notable Folder
│   │   │   └── Articles.md
│   │   └── Geet Duggal/                NF — home Notable Folder
│   │       ├── Geet Duggal.md          (home: "<gh user>/<repo>/<path>")
│   │       └── 2024-07-22 - First Geet.md
│   └── Creative Projects/              every published article as its own NF
│       └── Tech Habits — …/
└── Craft/
    ├── Craft.md
    ├── Craft Spaces/{Tools, Academic}/
    └── Craft Projects/                 every tool & paper as its own NF
```

Every level of the chain is a directory on disk — Areas, Categories, and
Notable Folders each get their own folder, with a Main Document inside
named after the folder. Image uploads write to `Attachments/`. The
markdown on disk stores **relative** paths (`Attachments/foo.png`) for
portability; at edit time those paths are inflated to absolute `asset://`
URLs so the webview can render them, and deflated back on save. PDF and
other non-image attachment links go through the OS opener (Tauri
`open_path`) so they launch in the user's default app.

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
├── CalendarView         # Week / Month
├── YearLinearView       # Year — 12 rows × 37 cells
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

![List folder — Books rendered as a basecard grid below the editor](img/list-folder-grid.png)

Both renders share the same operations: drag-reorder with insertion-point
preview + FLIP-animated nudge, click-to-edit title and meta inline, hover-×
to delete, "+ New" tile/row to append. Pointer events end-to-end — Tauri's
webview intercepts HTML5 drag-drop at the OS layer so `drop` never reaches
in-page handlers.

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
- **`Attachments/`** at the vault root holds pasted and dropped images, plus
  any other binary attachments, following the Obsidian convention.

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

### Chrome

A thin left rail of icon buttons sits in the top-left:

- `+` — new note (auto-folder if the filter has exactly one chip; opens a
  picker for two or more; plain capture when the filter is empty).
- `home` — reset the filter to the home Notable Folder.
- `⇊ / ⇈` — jump past pinned NF Main Documents to the first regular note;
  flips to `⇈` after one press and scrolls back to top.
- `↑` — open the Publish panel.

The right edge holds a `›/‹` sidebar toggle only. Each card carries its own
top-right controls (fullscreen ⤢, filter-remove ×, trash 🗑) and a subtle
footer status bar (public pill, breadcrumb / folder chip, filename) that
fades up on hover.

### Keyboard

- `Cmd +/-/0` — webview zoom (uses Tauri's native setZoom, not CSS, so caret
  hit-testing stays correct).
- `Cmd O` — open the right sidebar and focus the folder search.
- `Cmd K` — open the centered command palette to toggle folder filters.
- `Cmd ;` — toggle the right sidebar.
- `Cmd P` — open the Publish panel.

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
2. Hands `data.json` + a pre-built React bundle (`dist-viewer/`) to the
   Rust side (`publish_site`), which clones — or pulls — the target GitHub
   repo, wipes the chosen path, copies the bundle + the vault's
   `Attachments/`, and `git commit && git push origin <branch>`. Auth uses
   the local git credential helper or SSH key; no new login flow.

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
- `useGridLayout` (the row-span hook) lives in `src/lib/grid-layout.ts`
  and is imported by both the desktop CardGrid and the viewer's
  StreamView. One source of truth for the masonry.
- All hash routes (`#/note/X`, `#/folder/X`, `#/stream?folders=…`)
  resolve to a single stream view with the appropriate filter set —
  the published site has exactly one screen, same as the app.
- `Cmd+K` palette, Week / Month / Year calendar views, and the right
  sidebar all work; calendar move/create handlers are wired to no-ops.

Build the viewer bundle once with `pnpm build:viewer` before the first
publish; subsequent publishes reuse it.

---

## Run it

**Prereqs**
- Node 20+, pnpm
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Xcode + command-line tools (for iOS)

**Desktop**
```bash
pnpm install
pnpm tauri:dev      # dev window with HMR
pnpm tauri:build    # signed app bundle
```

**iOS**
```bash
pnpm tauri:ios:init   # one-time; generates the Xcode project
pnpm tauri:ios:dev    # opens iOS Simulator
pnpm tauri:ios:build  # device build
```

First launch reads `~/Documents/Dropbox/Home/` (the vault root) and walks
**every** `.md` file recursively — depth is arbitrary, since the chain
encodes the hierarchy. Areas.md and the per-level directories (with their
Main Docs) are written on first run if absent; otherwise a one-shot
migration generates the Areas / Categories / Notable Folder files from
any notes with `category:` set and the legacy `order.taxonomy`
localStorage key. Any other `.md` files you drop into a Notable Folder
show up on the next scan.

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

## License

MIT.
