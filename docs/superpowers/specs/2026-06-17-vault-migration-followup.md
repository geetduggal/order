# Vault migration follow-up

Logged 2026-06-17. After the `spacetime-source-of-truth` branch ships and
the vault is stable, these are the remaining cleanup steps.

## What's already done

- `spacetime.yml` and `spacetime.mw` are the source of truth for space + seasons.
- All structure mutations (add/remove/reorder area/category/folder) write to
  `spacetime.yml`/`.mw`; chain files are no longer written to.
- The migration button (Settings → "Migrate to spacetime…") backs up the vault and
  strips event frontmatter + archives chain index files.
- Vault was cleaned of 222+ duplicate numbered `.md` files created by the mw sync
  bug (fixed). spacetime.yml + spacetime.mw deleted and regenerated clean.

## Remaining steps (in order)

### 1. Verify the build is stable

Before touching the vault:
- Run Order with the `spacetime-source-of-truth` build for a few days.
- Confirm no new duplicate events appear in `spacetime.mw` or the filesystem.
- Confirm sidebar structure matches what's in `spacetime.yml` space section.
- Confirm seasons display correctly from `spacetime.yml`.

### 2. Scan for any remaining duplicate notes

```bash
# Check for any remaining numbered-suffix duplicate event notes
find "$VAULT" -name "* [0-9]*.md" | while read f; do
  base=$(basename "$f" .md | sed 's/ [0-9][0-9 ]*$//')
  dir=$(dirname "$f")
  orig="$dir/$base.md"
  # If the original also exists and this file has no real body, it's a duplicate
  if [ -f "$orig" ]; then echo "POSSIBLE DUP: $f (original: $orig)"; fi
done
```

### 3. Run the vault migration

Settings → **"Migrate to spacetime…"**

This will:
- Take a full vault backup to `.order-legacy/backup-<ts>/`
- Strip event YAML frontmatter (date/startTime/endTime/allDay/endDate/folder/title)
  from all event notes — they become plain content files
- Archive chain index files (Areas.md, Category.md files, Seasons.md) to
  `.order-legacy/chain/`

After migration, `spacetime.yml` and `spacetime.mw` are the only structural
records. Event notes become pure content (no calendar frontmatter).

### 4. Validate post-migration

- Open Order and confirm the sidebar still shows all Areas/Categories/NFs
- Open the calendar and confirm events still show (they should — spacetime.yml
  still has the events; the calendar reads from spacetime.yml events after migration)
- Open a few former event notes and confirm they're clean (no frontmatter or only
  non-event frontmatter like `public:`)

### 5. Format convergence decision

Currently evaluating `spacetime.yml` vs `spacetime.mw` as the primary editing
surface. Criteria:
- **Composability**: can a vault be split across multiple Spacetime files and
  merged back cleanly? (brood rule must hold across files)
- **Habitability**: can a human edit one line without knowing the format?
- **Readability at a glance**: does a new viewer understand the file cold?
- **Alignment**: do temporal records read as a table without extra tooling?

Current lean: Markwhen (`.mw`). Once decided, the non-canonical format becomes
read-only / display-only and the other is the sole edit target.

### 6. Code cleanup (post-decision)

Once the format decision is made:
- Remove the bidirectional sync for the non-canonical format (simplifies a lot
  of CardGrid)
- Remove the chain-file fallback in `buildVaultTaxonomy` (no longer needed once
  all vaults are migrated)
- Remove `Seasons.md` read path in `buildSpacetime`
- Remove `Areas.md` / chain-walking code from `taxonomy.ts`
- Remove the `mutateBullets` chain-writing code from CardGrid handlers (already
  redirected to spacetime, but the helpers are still there)
