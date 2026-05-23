# Architecture

Order is a Tauri v2 app (Rust backend + React frontend). One project ships
desktop and iOS.

## Three representations

The vault data exists in three forms, with a strict ordering rule:

1. **Filesystem** — `.md` files on disk. Single source of truth.
2. **Rust process state** — minimal. Commands read and write the disk.
3. **React state** — in-memory list of loaded notes, owned by `CardGrid`.

**Write rule**: every mutation goes through a Rust IPC command (`write_text`,
`write_binary`, `rename_file`, `delete_file`). The command writes disk first;
React state updates after. If the disk write fails, React state stays
consistent with what's actually on disk.

A `notify`-backed watcher (`watcher.rs`) can emit change events; the desktop
reload path re-scans the vault.

## No global store

No Redux, Zustand, Jotai, or Context. State lives in two components:

| Component | Owns |
|---|---|
| `CardGrid` | loaded `notes[]`, the active view, filter pills, vault load/reload, folder assignment, publish trigger |
| `Card` | one note: its own body load, debounced save, auto-rename, list rendering |

`CardGrid` loads the whole vault once (`loadAndNormalizeAll` → `walkVaultMarkdown`),
then renders cards. Each `Card` re-reads its own file for body edits so views
can mutate in parallel. The read-only published viewer (`src-viewer`) reuses
the same `Card` with `readOnly` + `initialBody`, so there is one card
component across both surfaces.

## Vault layout

A note is a **Notable Folder Main Document** iff its YAML carries a `category`
field; its filename matches its directory (`Articles/Articles.md`). An
ordinary note links to its folder via `folder: "[[Name]]"` YAML and lives in
that folder's directory. Areas and Categories are list folders whose bodies
are bullets of `[[child]]` wikilinks one level down; `Areas.md` is the root.

## The editor: Milkdown Crepe

`MilkdownSurface` wraps Milkdown Crepe. The same instance backs editing in
cards, Notable Folder Main Documents, and the read-only viewer (via
`setReadonly`). On-disk markdown is the source of truth; Crepe emits markdown
on change which `Card` debounces and saves. Crepe owns its node schema via
`@milkdown/components`, which constrains custom inline content — see Wikilinks.

## Notable Folder rendering

`NotebookSection` renders a newspaper layout: the Main Document as a wide
centerpiece with its notes below. The Stream is a recency timeline; selecting
one or more folders (filter pills) switches to per-folder sections.

List folders (`list: cards` or `list: lines`) render their bullet wikilinks as
a drag-reorderable card grid (`ListCards`) or a dense line list (`ListLines`).
A `base` code block (`list-base.ts`) can auto-populate a list folder from a
filter over the vault, Obsidian Bases style; `list-resolve.ts` merges base
results with any manual bullets.

## Wikilinks

`src/lib/wikilink.ts` is the single resolver for `[[Name]]` links across the
vault. A link targets by name; resolution decides folder vs note purely by
lookup, with no visual tell in the source:

- A name matching a Notable Folder resolves to that folder (its Main
  Document); following it navigates to the folder's section.
- A name matching an ordinary note resolves to that note.
- On a collision the Notable Folder wins; `[[Folder/Note]]` disambiguates to
  the note inside that folder.
- An unresolved link is reported broken so the UI can render it muted.

The `[[Name]]` text is always the human-readable name. Ids and slugs live in
frontmatter only, never in the link syntax, which keeps the source plain-text
clean and Obsidian-compatible. `ListCards` and `ListLines` resolve their
bullets through this one resolver (`resolveNoteRef`).

On rename, `rewriteWikilinksForRename` updates every inbound `[[Old]]` (and
`[[Old|alias]]`, `[[Folder/Old]]`) to the new name, preserving alias, folder
qualifier, and Milkdown's bracket-escaping. It is wired to the ordinary
note-rename path in `CardGrid`; folder-rename rewriting awaits a dedicated
folder-rename action (Main Document filenames don't auto-rename, since the
name is the folder's identity).

## Attachments

Attachments live in `<vault>/Attachments/`. On disk, image URLs are stored
vault-relative (`Attachments/x.png`) so notes stay portable; at render time
`attachments.ts` inflates them to a runtime asset URL the webview can load,
and deflates them back on save.

## Filtering

`useFilters`-style state lives in `CardGrid`: a set of include/exclude pills.
Includes compose with OR; the home Notable Folder (YAML `home:`) seeds the
default view. Pills drive both the Stream sections and the calendar
projection.

## Calendar

`CalendarView` projects notes with `date` + `startTime` onto week/month grids;
`YearLinearView` does a linear year. Events are draggable; on drop the note's
frontmatter is patched and saved.

## Publishing

`publish.rs` clones (or fast-forwards) the target GitHub repo named in the
home folder's `home: "<user>/<repo>/<path>"` YAML, wipes and repopulates the
target subdirectory with the built viewer bundle (`dist-viewer`), a
per-publish `data.json` (the public notes + taxonomy, built by
`collectPublishedSite`), and the vault's `Attachments/`, then git
commit/push. The published site is the Order viewer running read-only over
that data. Auth uses the user's local git credentials, run non-interactively.

## Why Tauri v2 over Electron + Capacitor

- One project for desktop AND iOS (Tauri Mobile is stable).
- Rust backend, no Node runtime in production builds → smaller bundle, faster
  cold start.
- Native FS access without a separate IPC abstraction.

## What is deferred

- Wikilinks inside the Milkdown editor (autocomplete + inline rendered links):
  in progress as a ProseMirror decoration spike, kept separate because Crepe's
  node ownership makes custom inline nodes fiddly.
- Publish-time wikilink-to-slug rewrite (depends on a permalink pipeline).
- Full-text search (Notable Folder finder by name only for now).
- Audio/voice capture; webmentions; multi-window editing.
