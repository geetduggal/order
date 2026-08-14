# Filename-as-source-of-truth for event date/time

Goal: an event's **date and time live in its file name**, not YAML frontmatter. The
frontmatter date fields (`date`, `startTime`, `endTime`, `endDate`, `allDay`) are
removed; calendars, sync, and todo.txt all derive scheduling from the name.

Branch: `filename-event-truth`. Vault backed up
(`order-vault-backup-20260813-221900.tar.gz`) before any rename.

## The convention (rule)

Escalating specificity, each shape one token more than the last, no `/` or `:`:

| Shape | Name | Meaning |
| --- | --- | --- |
| Date only | `YYYY-MM-DD Title.md` | all-day event |
| Date + time | `YYYY-MM-DD HHMM Title.md` | point-in-time (defaults to 30 min on the calendar) |
| Date + time range | `YYYY-MM-DD HHMM-HHMM Title.md` | same-day span (24h) |
| Date range | `YYYY-MM-DD - YYYY-MM-DD Title.md` | multi-day all-day range |

A **timed multi-day** range is deliberately out of scope.

## Foundation (done)

- `src/lib/event-filename.ts` — the canonical parser/formatter:
  `parseEventFilename(base) → {date,time,endTime,endDate,allDay,title} | null`,
  `formatEventFilename(parts,title)`, `titleFromEventFilename`, `isEventFilename`.
  Malformed time degrades to the next-simpler shape; invalid calendar days aren't
  events. Full round-trip tests in `event-filename.test.ts` (all pass).

## Touch points (the comprehensive change)

### Read side — derive events from the NAME, not frontmatter
1. **`spacetime.ts::buildSpacetime`** — the event loop currently reads
   `fm.date/startTime/endTime/endDate/allDay`. Replace with `parseEventFilename`
   over the note's basename. Title still prefers the note's `# ` header, falling
   back to the filename label. (Seasons stay `Seasons.md` / `season:true`.)
2. **`CalendarView.tsx::notesToEvents`** — reads the same frontmatter directly.
   Route through `parseEventFilename` (needs the note's filename in `NoteMeta`).
3. **`CardGrid.tsx`** — the `isEvent` helper (~L350), the event link-map, and the
   reconciliation deriver (~L2468) all read frontmatter dates → the parser.
4. **gcal / apple import + push** already flow through the derived `SpacetimeEvent`,
   so they follow once 1–3 do; verify the natural-key identity still holds.

### Write side — create/edit an event = NAME (or RENAME) the file
5. **Create** (`createNote`, calendar drag-create): write the note at the
   convention filename; do NOT write date frontmatter.
6. **Move / resize / all-day-toggle** (calendar drop/resize, `updateNoteFrontmatter`
   for events): **rename the file** to the new schedule instead of patching YAML.
   The note keeps its body + other frontmatter; only the name changes.
7. **Invitees** stay in frontmatter (`invitees:`) — orthogonal to scheduling.

### Migration (one-time, destructive → needs the backup)
8. For every note with event frontmatter (~2419): compute the convention name from
   its frontmatter, **rename** the file (dedupe collisions with a numeric suffix),
   and **strip** `date/startTime/endTime/endDate/allDay` from the YAML. Update
   inbound `[[wikilinks]]` to the renamed files. Season notes keep their `date`
   (seasons are a separate, coarse concept — see below).

## Decision (settled): dated reference notes → NOON events

The vault has **~510 notes with a dated name but no event frontmatter** (journal/log
entries). The migration converts each to a **12:00 (noon) timed event** by renaming
`YYYY-MM-DD Title.md` → `YYYY-MM-DD 1200 Title.md`. So:

- Genuinely all-day events (had `allDay: true`) → date-only name (`YYYY-MM-DD Title`).
- Timed events → `YYYY-MM-DD HHMM …` from their `startTime` (+ `endTime`/range).
- Bare dated reference notes → `YYYY-MM-DD 1200 …` (a midday point, not an all-day
  banner), so they appear on the calendar without swamping the all-day row.

The read-side rule is unchanged (`date-only = all-day`); only the one-time migration
picks noon for these existing bare-dated notes.

Seasons are unaffected either way (they remain `Seasons.md` / `season: true`, which
still needs a `date:` — the one scheduling field that stays in frontmatter, because a
season is a coarse range, not a filename-dated event).

## Verification before merge
- Parser unit tests (done) + new tests for buildSpacetime/notesToEvents from names.
- Migration dry-run: report every rename + collision, no writes, eyeball a sample.
- On-device: calendar renders the same events; drag-move renames the file; create
  from the calendar writes a convention-named file with no date frontmatter.
