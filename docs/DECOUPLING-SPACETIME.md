# Decoupling Order from spacetime.md — status & plan

Goal (per the vault note "2026-08-10 Decoupling Order from spacetime.md"): the
**filesystem + per-file YAML frontmatter** is the single source of truth. Hierarchy
comes purely from physical directory placement; dates/events/invitees come from a
file's own frontmatter; `spacetime.md` becomes an **optional, generated view**, never
a write target. The gcal/gmail sync keeps working (it reads the derived events).

Branch: `decouple-spacetime`. Vault backed up before any change.

## Key finding from the analysis

Much of the model was already file-first:

- **A note's Notable Folder is already its physical parent directory** (`folderOf` in
  `spacetime.ts` — "placement is structural, no `folder:` YAML").
- **Calendar events are already regenerated from note frontmatter** (`buildSpacetime`
  reads `date` / `startTime` / `endTime` / `endDate` / `allDay`).

What was still coupled to `spacetime.md`:

1. The **Area → Category → Notable-Folder taxonomy tree** was built from
   `spacetime.space` (or the `Areas.md` chain), NOT from physical directories.
2. **Invitees** were carried as `emails` on the spacetime event line, not in frontmatter.
3. **Structure edits** (sidebar folder rename / reorder / move) write to `spacetime.md`.
4. `spacetime.md` / `.yml` / `.mw` are read as sources of truth in several places.

## Done on this branch (read-side foundation; compiles, existing tests pass)

- `taxonomy.ts::taxonomyFromPaths(notes)` — derives the full Area/Category/NF tree
  purely from physical paths (`Area/Category/NotableFolder/file`), JD-numeric ordered.
- `buildVaultTaxonomy` now **prefers physical placement** and only falls back to the
  spacetime `space` tree / `Areas.md` chain when no deep paths exist.
- `CardGrid` passes each note's `path` into the taxonomy builder.
- `buildSpacetime` now reads **invitees from frontmatter** (`invitees` canonical, or
  `recipients` / `emails`) and `appleCalendar` into the derived event, so gcal/apple
  sync works off frontmatter instead of a spacetime line.

## Write-side progress (this pass; compiles, tests pass)

- **Folder rename is now pure filesystem.** `handleRenameNotableFolder` already
  renamed the directory + main doc + inbound refs; its redundant `spacetime.mw`
  write (the old "source of truth" step) is removed. The taxonomy re-derives from the
  renamed directory.
- **Invitees now write to frontmatter.** Event creation (`createNote`) keeps invitees
  in the note's own frontmatter as `invitees` (was: deleted from YAML and written to a
  spacetime line). `handleSetEmails` (edit an event's invitees) now writes `invitees:`
  into the event note's frontmatter. `buildSpacetime` reads them back for gcal/apple.

## `buildSpacetime` is now a pure derivation (this pass)

`buildSpacetime` no longer reads `.mw` / `.yml` as truth — it derives everything from
the filesystem + frontmatter, so it doubles as the "generate the spacetime view" path:

- **`space`** (Area → Category → Notable Folder) = the physical taxonomy (`tax`, itself
  derived from directory placement).
- **Seasons** (see below) = the `Seasons.md` note + any `season: true` frontmatter notes.
- Events already came from note frontmatter; invitees now read from frontmatter too.

## Seasons

A season is a coarse dated *range* (a semester, a life phase), not a per-day event.
Handled two ways, both file-native, never spacetime.md:

1. **`Seasons.md`** (a real note with `role: seasons`, a `- START - END · Name` bullet
   list). Kept deliberately: seasons are rare and coarse, so one hand-editable,
   scannable ledger still fits the "minimal but functional" ethos, and it's already a
   normal file — not the spacetime.md source-of-truth being removed.
2. **Frontmatter-native seasons:** any note with `season: true` plus a `date` (and
   optional `endDate`) in its own YAML is picked up as a season. This is the fully
   file-first option for anyone who'd rather a season be its own note.

`buildSpacetime` merges both, sorted by start date.

## Remaining work (write-side + migration + view) — NOT yet done

1. **Reorder / move folder → directory operations.** Rename is done. Folder *move*
   (reparent) and *reorder* still flow through `patchSpacetimeSpace` + the reconcile
   effect (Effect 2). In the JD/filesystem model, order = numeric prefix, so reorder
   becomes a JD renumber and move becomes a directory move. Needs on-device verification
   (touches `Sidebar.tsx`, `CardGrid.tsx` handlers, Rust vault move).
2. Remove the now-redundant `spacetime.mw` **event write** on creation once `gcal-push`
   reads the frontmatter-derived events (invitees are already frontmatter-sourced).
3. **`spacetime.md` as a generated view.** Add a Settings action "Generate spacetime.md"
   that compiles the current filesystem+frontmatter into a spacetime-format file on
   demand; stop auto-writing it and stop reading it as truth (keep the compact syntax as
   an INPUT grammar for CLI/agent commands only).
4. **Vault migration (one-time):** move any invitee emails currently living on
   spacetime lines into each event note's frontmatter; then the spacetime.md/.yml/.mw
   files can be archived. A dry-run + backup are required (vault already backed up).
5. **Prune the now-dead read paths** (mwSources merge for taxonomy, `spacetime.yml`
   space authority) once 1–4 are verified.

## Verification checklist before merging to main

- Sidebar shows the same Area/Category/NF tree as before, from disk.
- Renaming/moving a Notable Folder in the sidebar moves the directory and updates
  everything downstream with no spacetime write.
- Creating/editing a calendar event with invitees stores them in frontmatter and still
  pushes to Google/Apple.
- "Generate spacetime.md" produces a correct derived file; nothing else writes it.
- Full e2e suite + on-device (iPhone) smoke test.
