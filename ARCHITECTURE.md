# Architecture

Order is a Tauri v2 app (Rust backend + React frontend). Same project ships
desktop and iOS. The structure follows Tolaria's "root-owned hooks" pattern.

## Three representations

The vault data exists in three forms, with a strict ordering rule:

1. **Filesystem** — `.md` files on disk. Single source of truth.
2. **Rust process state** — none, by design. Each command reads from disk.
3. **React state** — in-memory list of `Note` objects, owned by `useVault`.

**Write rule**: every mutation goes through a Rust IPC command (`save_note`,
`set_frontmatter`, `delete_note`). The command writes to disk first; React
state updates after. If the disk write fails, React state stays consistent
with what's actually on disk.

A `notify`-backed filesystem watcher emits `vault-changed` events when files
change from outside the app (git pull, external editor). `useVault` debounces
and re-scans on these events.

## No global store

No Redux, Zustand, Jotai, or Context. State lives in `App.tsx` plus a few
custom hooks:

| Hook | Owns |
|---|---|
| `useVault` | `notes[]`, `vaultPath`, write methods, `dirty` count, `publish` |
| `useFilters` | `selected: Set<string>` — which Notable Folders are on the page |
| `useEditor` | `editingPath` and the debounced save queue |

`App.tsx` calls each hook once and passes the state and methods down as props.
Updates flow back via callbacks. For Order's shallow tree this is enough; if
deep prop-drilling becomes painful, swap a single hook for a Context — it's a
local refactor.

## CodeMirror cursor-line reveal

`src/lib/markdown.ts` defines a `ViewPlugin` that builds a `DecorationSet`:

- Walks the `@lezer/markdown` syntax tree for `HeaderMark`, `EmphasisMark`,
  `CodeMark`, `LinkMark`, `URL`.
- Scans each line for wikilink brackets `[[...]]` via regex (not in the
  standard grammar).
- For every match whose line is **not** the cursor's current line, applies a
  `Decoration.replace({})` that hides the marker visually.

Result: raw markdown is visible only on the line your cursor is on. Off-cursor
lines render as clean prose. Same instance is used inside note cards and
Notable Folder sections.

Save is debounced 800ms via `useEditor.queueSave`.

## Recent grid

CSS Grid, 6-column base. Each card defaults to `span 2` (one-third width).
`grid-auto-rows: 8px` + `align-self: start` lets cards size to content;
`RecentGrid.layout()` measures `offsetHeight` and sets `gridRowEnd: span N`
per card.

NYT-style dividers are per-card pseudo-elements:
- `border-top: 1px solid var(--rule-soft)` → horizontal hairline above
- `::before` at `left: -14px` → vertical hairline in the column gap

`layout()` also tags first-row/first-col cards so leading hairlines are
suppressed. Runs on every layout change (load, edit, resize) so dividers
move with the cards.

## Notable Folder rendering

A note is a Notable Folder Main Document iff its YAML has a `category` field.
`NotableSection` renders it full-width below the recent grid. A tiny inline
markdown renderer (`renderMarkdown` in `NotableSection.tsx`) handles read
mode; CodeMirror takes over on double-click for edit mode.

This is intentional duplication — the read renderer is ~30 lines and avoids
the CM mount cost for every section on every page load.

## Calendar

`CalendarView` projects notes with `date` + `startTime` onto a week grid.
Events are `draggable`; drop targets are hour cells. On drop, the Rust
`save_note` runs with the patched frontmatter.

Day/Month/Year views are out of MVP scope but the model is identical — only
the projection function changes.

## Publishing

`publish_public` (Rust) walks the vault, copies notes with `public: true`
into `<vault>/public/`, then `git add`/`commit`/`push` if the vault is a git
repo. The static site generator (Astro/Eleventy) runs in GitHub Actions on
push. Pipeline never blocks the UI; failure leaves the dirty counter set so
the user can retry.

## Why Tauri v2 over Electron + Capacitor

- One project for desktop AND iOS (Tauri Mobile is stable).
- Rust backend, no Node runtime in production builds → smaller bundle, faster
  cold start.
- Native FS access without a separate IPC abstraction.
- Same crates that work on desktop (`notify`, `walkdir`) work on iOS.

## What was deferred from MVP

- Audio/voice capture
- Webmentions / commenting
- Full-text search (Notable Folder finder by name only for MVP)
- Multi-window note editing
- Bases-style auto card grid (`base` code block) inside Main Documents
- Areas/Categories 10-box grid in the sidebar — replaced by a flat folder list

Each is reachable without architectural changes.
