# Order

*Your notes, at home at last.*

A specialized note app. One screen for thinking, browsing, and (eventually) publishing.
Local markdown files, YAML frontmatter as the source of truth, Obsidian-compatible vault.
Built with Tauri v2 — same codebase ships desktop today and iOS next.

---

## Principles

1. **Local-first.** Files live on your machine as plain `.md` with YAML frontmatter.
   No proprietary store, no cloud lock-in. Sync is whatever you already use
   (Dropbox, iCloud, git).
2. **Portable conventions.** The vault opens cleanly in Obsidian. Same files, same
   YAML, same wikilinks. Order is a different surface on the same data.
3. **Edit in place.** Every interaction — capture, browse, refine — happens on the
   same surface. No modals, no editor/viewer toggle. Double-click and type.
4. **Constraint as clarity.** Johnny Decimal limits: max 10 Areas, max 10 Categories
   per Area. The 10-box grid makes the limit visible. No tags, no plugins, no graph
   view — structure is a forcing function for better thinking.
5. **Workspace is presentation space.** What you see while editing is what your
   reader sees. There's no separate "article view."
6. **Subtle UI.** Two accents only — royal blue `#4169E1` and coral `#FF7F50`.
   Sans-serif for chrome, serif for prose. Whitespace and hairlines do the work
   of borders.
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

```
<vault root>/
├── cards/                 *.md notes — events, prose, Notable Folder Main Docs
└── Attachments/           pasted / dropped images, Obsidian convention
```

Image uploads write here. The markdown on disk stores **relative** paths
(`Attachments/foo.png`) for portability; at edit time those paths are inflated to
absolute `asset://` URLs so the webview can render them, and deflated back on save.

### State

No Redux / Zustand / Context. `CardGrid` is the top-level component and owns the
loaded `notes[]`, the current view, the folder filter set, and the right-sidebar
open state. Cards manage their own load + debounced save lifecycle and call
parents back via props when their path / title / frontmatter changes.

```
CardGrid                 # top: loads notes, owns view + filter state
├── Sidebar              # drill: Areas → Categories → Notable Folders
├── Card[]               # Stream view; each card owns its file
│   ├── MilkdownSurface  # editor
│   └── ListCards        # for type: list Main Docs only
├── CalendarView         # Week / Month
├── YearLinearView       # Year — 12 rows × 37 cells
└── CommandPalette       # Cmd+K folder picker
```

### List folders

A Notable Folder Main Document with `type: list` in its YAML is rendered as a
basecard grid below the prose editor. The bullet list of wikilinks
(`- [[Book Name]] · author · ★★★★`) is the source of truth on disk; on load
we split it out into structured `ListItem[]` state so the editor only sees the
prose, and on save we serialize it back. The grid supports:

- **Drag to reorder**, with FLIP-animated reflow. Pointer events end-to-end —
  HTML5 drag-drop is intercepted by Tauri's webview layer so the standard `drop`
  event never fires in-page.
- **Inline meta edit**, **hover-× delete**, **+ New** tile to append.
- Cards resolve their cover image / author / description from the linked note's
  YAML; fallback is a Lucide icon over an alternating royal / coral wash.

### Masonry layout

The Stream uses CSS Grid with `grid-auto-rows: 8px` plus a per-cell `grid-row-end:
span N` computed from the card's measured height. Reflow triggers come from
three independent sources:

- **ResizeObserver** on each `.order-card` — image loads, fullscreen, breadcrumb.
- **Per-card MutationObserver** — ProseMirror DOM mutations as you type.
- **Capturing `input` / `keyup` listener** on the grid — backstop in case MO's
  attribute filter ever misses a frame.

### Keyboard

- `Cmd +/-/0` — webview zoom (uses Tauri's native setZoom, not CSS, so caret
  hit-testing stays correct).
- `Cmd O` — open the right sidebar and focus the folder search.
- `Cmd K` — open the centered command palette to toggle folder filters.
- `Cmd ;` — toggle the right sidebar.

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

First launch reads `~/Documents/Dropbox/order/cards/`. Notable Folder Main Docs and
seed notes are written on first run if absent; any other `.md` files you drop into
that directory show up on next scan.

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
field. A list folder additionally carries `type: list` and its body holds the
wikilink bullets that the card grid renders.

## License

MIT.
