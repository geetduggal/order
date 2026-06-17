# Spacetime as source of truth — design

**Goal.** Make `spacetime.yml` the authoritative store for the vault's
**structure + order** (`space`: Areas → Categories → Notable Folders) and
for **seasons** (`time.seasons`). The chain index files (`Areas.md`, each
`list: cards` `<Area>.md` / `<Category>.md`) and `Seasons.md` become
redundant and move to safe storage. Notable Folder Main Documents and
notes are unaffected — they remain the truth for everything else.

## What stays note-backed (NOT inverted)

- **Events** (`time.events`): each event is a real content note (`.md`
  with date frontmatter + a body). Notes remain the truth; `spacetime.yml`
  events stay a projection of note frontmatter.
- **NF Main Documents** and **notes**: real content, untouched.

## What inverts

- **`space`**: the Areas/Categories/Notable-Folder hierarchy AND its order.
  Today it is read from the chain files. After: read from `spacetime.yml`.
- **`time.seasons`**: today read from `Seasons.md`. After: read from
  `spacetime.yml`.

## The circularity, resolved

Today: chain files → `buildVaultTaxonomy` → `spacetime.yml.space`. If the
taxonomy reads from `spacetime.yml`, the mirror can no longer *generate*
`space` (it would feed itself). Resolution:

- The mirror regenerates **`time.events` only**, and **preserves** the
  existing `space` and `time.seasons` already in `spacetime.yml`.
- `space` and `time.seasons` change only through explicit edits (the
  editable card, the sidebar, the season editor) which write
  `spacetime.yml` directly.

## Components to change

1. **`buildVaultTaxonomy`** (`lib/taxonomy.ts`): add a path that builds the
   taxonomy from a parsed `spacetime.yml.space` instead of walking the
   chain. NF refs still resolve to their Main Doc directories via the note
   walk. Areas/Categories are labels from `space`; their directories are
   reconstructed by name (`<vault>/<Area>/<Category>/`).
2. **The mirror** (`CardGrid`): read the current `spacetime.yml`, replace
   only `time.events`, keep `space` + `time.seasons`, rewrite. (No longer
   derives `space` from the chain.)
3. **Structure mutations** (add/remove/rename/reorder area, category,
   folder; sidebar drag): edit `spacetime.yml.space` and create/delete the
   physical NF directory + Main Doc as needed — instead of writing chain
   bullets.
4. **Seasons**: `SeasonView` + the season editor read/write
   `spacetime.yml.time.seasons` instead of `Seasons.md`.
5. **Reverse sync** ("Apply spacetime.yml"): with `spacetime.yml` already
   authoritative for space/seasons, the apply collapses to event note
   create/update/delete + materializing folder directories that exist in
   `space` but not on disk. Folder *order* no longer needs an apply (it is
   the source of truth).

## Migration (run last, after the new build is installed)

Move to `<vault>/.order-legacy/` (recoverable, not deleted):
- `Areas.md`
- every `list: cards` `<Area>.md` and `<Category>.md` index file
- `Seasons.md`

Leave NF Main Docs, notes, and attachments in place. Seed `spacetime.yml`
from the current chain + Seasons.md just before the move so nothing is
lost.

## Risks / open questions

- The current installed build reads the chain. Moving the index files
  before the new build ships shows an empty taxonomy. **Order: ship + install
  the new code first, migrate the vault second.**
- Directory ↔ name coupling: reconstructing Area/Category directory paths
  from `space` names assumes the on-disk nesting matches the names. True
  today by convention; rename handling must rename the directory too.
- Not unit-testable end to end (vault mutation); the taxonomy-from-spacetime
  builder and the mirror's space/seasons preservation ARE unit-testable.

## Phasing

- **A. Read path (non-destructive):** taxonomy + seasons can read from
  `spacetime.yml` when its `space`/`seasons` are present, else fall back to
  the chain / `Seasons.md`. Mirror preserves `space` + `seasons`. Ship +
  install. Vault still has the chain, so nothing breaks.
- **B. Write path:** structure + season mutations write `spacetime.yml`.
- **C. Migration:** move the legacy index files to `.order-legacy/`.
