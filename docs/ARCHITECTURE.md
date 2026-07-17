# Order — architecture

The whole app is one idea applied repeatedly: **plain text files are the database,
and every surface is a different read of the same files.** If you understand the
file conventions, you understand the app. The rest of this doc is how that idea
survives contact with a vault of tens of thousands of files.

## The data model (on disk)

```
<vault>/
├── spacetime.yml             canonical space + time map (YAML)
├── spacetime.mw              canonical space + time map (Markwhen)
├── todo.txt                  one-line calendar events (optional)
└── <Area>/
    └── <Category>/
        └── <NF>/
            ├── <NF>.md             the Main Document (category: <Category>)
            ├── 2026-06-12 Note.md  a note / calendar event
            └── diagram.png         attachments live WITH their notes
```

`spacetime.yml` and `spacetime.mw` are the source of truth for the vault's
**structure** (the Areas → Categories → Notable Folders hierarchy and its order)
and **seasons**. Both files are kept in sync; editing either one updates the
other. See [SPACETIME.md](SPACETIME.md) for the full format specification.

## Tech stack — what each layer is for

| Layer | Choice | Why this one |
|---|---|---|
| Shell | **Tauri v2** (Rust) | native file IO + system webview; one codebase ships macOS and iOS. ~10 MB binaries |
| UI | **React 19 + TypeScript**, Vite | one SPA rendered into the webview; HMR in dev |
| Editor | **Milkdown Crepe** (ProseMirror) | WYSIWYG CommonMark, uncontrolled after mount |
| Calendar | **FullCalendar v6** | drag/resize/select; Year and Season are hand-rolled |
| YAML | js-yaml | frontmatter parse/dump, `noRefs` + quoted strings |
| Watcher | notify (Rust), 500 ms debounce | external edits reach the UI without polling |
| Assets | `vaultasset://` URI scheme | images/video stream through native fetch with HTTP Range |

State management is deliberately primitive: **no Redux, no Zustand, no Context**.
`CardGrid.tsx` (~4k lines) owns `notes[]`, the view, and the filter pile;
everything derives per render.

```
CardGrid ── owns notes[], view, filters; routes every mutation
├── Sidebar           Areas → Categories → NFs drill + filter pills
├── LazyCell[] → Card per note: load → edit → debounced save
│   ├── MilkdownSurface   Crepe wrapper: paste, links, wikilinks
│   ├── RawTextSurface    monospace textarea for .txt/.yml/.mw files
│   ├── SheetSurface / DrawingSurface   flip a note to a spreadsheet / drawing (sidecar files)
│   ├── ListCards / ListLines   list: cards/lines rendering
│   ├── NotableFolderBackside   flip side: folder browser + OS drag-drop
│   └── OrderTerminal    in-card PTY (xterm.js), ⌘4 / button toggle
├── CalendarView      Day / Week / Month (FullCalendar)
├── YearLinearView    Year — 12×37 strip
├── SeasonView        Season — Areas grid over a date range
└── CommandPalette    ⌘O/⌘K folder picker · FtsOverlay ⌘F search
```

## File operations — everything goes through one bridge

The frontend never touches a filesystem API. Every operation calls a Rust command
via `lib/vault-fs.ts`, with **vault-relative paths**.

| Command | Used for |
|---|---|
| `vault_walk_metadata` | boot: every file's frontmatter, no bodies |
| `vault_read_text` / `vault_write_text` | note load on demand / debounced save |
| `vault_rename` / `vault_remove` | rename note, delete |
| `vault_backup` | timestamped full-vault snapshot to `.order-legacy/backup-<ts>/` |
| `fts_build_index` / `fts_search` | full-text search, Rust-side index |
| `terminal_open` / `_write` / `_resize` / `_close` | real PTY per in-card terminal |

The walk filter includes `.md`, `.txt`, `.yml`, `.yaml`, and `.mw` so
`spacetime.yml`, `spacetime.mw`, and `todo.txt` flow through the same load/reload
pipeline as markdown notes.

**The write path.** Card edits debounce 600 ms, then:
`splitFrontmatter → mutate → joinFrontmatter → vault_write_text`.
Every write stamps a 6-second **self-write marker** so the watcher doesn't reload
the card being typed in.

**The external-edit path.** notify (Rust, 500 ms debounce) → `vault-changed` event
→ JS coalesces 250 ms → metadata re-walk → notes matched by path so mounted editors
keep their cursor through a `git pull` happening underneath.

## Spacetime: the canonical map

`lib/spacetime.ts` is the heart of the data model. It owns the in-memory
representation (`SpaceNode[]` + `SpacetimeEvent[]` + `SpacetimeSeason[]`),
the YAML serializer/parser, the Markwhen serializer/parser, and the space-tree
mutation helpers.

### The mirror

A continuous `useEffect` in CardGrid regenerates `spacetime.yml` and `spacetime.mw`
on every notes change:

```
notes[] + vaultTaxonomy + parsedSpacetime
  → buildSpacetime()         preserves existing space+seasons from yml/mw,
  → serializeSpacetime()       regenerates events from note frontmatter
  → writeVault("spacetime.yml")
  → serializeMarkwhen()
  → writeVault("spacetime.mw")
```

A don't-clobber guard (`lastSpacetimeRef`) holds off the mirror write if the
on-disk file has been hand-edited since the last mirror write, so edits made in
the raw-text card or an external editor are never silently overwritten.

### Bidirectional sync

Both `spacetime.yml` and `spacetime.mw` are sources of truth:

- **spacetime.yml edit** → `parsedSpacetime` useMemo re-derives → taxonomy and
  seasons update on the next render cycle.
- **spacetime.mw edit** → `lastMarkwhenRef` guard detects the change →
  `parseMarkwhenFormat()` extracts space + seasons → written to `spacetime.yml`
  → triggers the taxonomy/seasons update. New events in `.mw` materialize as
  backing `.md` notes.

### Space mutations

All structure mutations (add/remove/reorder area, category, folder from the
sidebar or the apply-sync flow) call `applySpaceMutation()` in `lib/spacetime.ts`
and write the result to `spacetime.yml`. This replaces the old chain-file bullet
writes (`Areas.md`, `<Area>.md`, `<Category>.md`).

### Apply to vault

`lib/spacetime-sync.ts` diffs the on-disk file against the vault into a plan
(event create/update/delete, season change, folder add/remove/reorder). The plan
surfaces in a confirm dialog before any write; destructive ops are itemized.

### Vault migration

Settings → **"Migrate to spacetime…"** runs `lib/vault-migrate.ts`:
1. Full vault backup (`vault_backup` Rust command).
2. Plan: strip event YAML frontmatter from all event notes; archive `Areas.md`,
   `Seasons.md`, and category index files to `.order-legacy/chain/`.
3. Confirm dialog.
4. Execute.

After migration, `spacetime.yml` / `spacetime.mw` are the only structural records.

## Taxonomy

`lib/taxonomy.ts:buildVaultTaxonomy()` produces the `VaultTaxonomy` that drives
the sidebar and pile. When `spacetime.yml` carries a non-empty `space` tree, that
becomes the taxonomy. Otherwise it falls back to the chain index files, so
un-migrated vaults keep working without any change.

## Calendar events have two backings

An event is either a `.md` file (frontmatter `date`/`startTime`/`allDay`) or
one line in `todo.txt` (`due:YYYY-MM-DD HH:MM Title +project`). Identity is
`(date, startTime, normalized title)` — the calendar renders each once, `.md`
wins when both exist.

## Scaling to tens of thousands of files

1. **Metadata-only boot.** `vault_walk_metadata` ships one small struct per file
   — frontmatter YAML string, body byte-length, mtime. Bodies load lazily per Card.
2. **Lazy editor mounting.** `LazyCell` wraps each cell in an IntersectionObserver;
   offscreen cells render a placeholder.
3. **Pagination.** Unfiltered pile caps at 60 cards.
4. **Masonry without layout thrash.** CSS Grid with per-card ResizeObserver.
5. **Derived state, no caches.** Taxonomy tree, calendar events, season grids — all
   `useMemo` derivations over `notes[]`. No secondary store to drift.

## Invariants

- Quoted dates. `date: "2026-06-12"` — unquoted dates parse as YAML Date objects.
- Attachments live next to their note. Moving a note drags its images along.
- Wikilinks resolve by name, not path, so moving folders never rewrites links.
- The published web viewer reuses the same components read-only — no template drift.
- Structure mutations write `spacetime.yml` / `spacetime.mw` only — no chain files.

## Testing

`pnpm test:e2e` runs Playwright against the real app in Chromium with a mocked Tauri
IPC layer. Pure-node spec files (`tests/e2e/*.spec.ts`) cover spacetime serialization,
sync planning, space mutations, and vault migration planning.
