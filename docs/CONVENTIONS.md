# Order conventions

Order keeps two things first class: where your work lives, and when it happens.
Everything is plain text you can read and edit by hand. The structure sits on the
page, not behind a database.

## Notable Folder

A Notable Folder is a filesystem directory with a main document at its center and
a stream of surrounding notes.

```
Board Games/
├── Board Games.md              ← Main Document (same name as the directory)
├── 2026-06-01 Game night.md    ← a note / calendar event
├── 2026-06-08 Wishlist.md      ← another note
└── box-art.png                 ← attachment (lives next to its note)
```

Two naming conventions carry the whole structure:

**Main Document** — `<Notable Folder>/<Notable Folder>.md`. The file has the same
name as the directory. Order recognises it by this match; no special frontmatter
required.

**Notes and events** — `<Notable Folder>/YYYY-MM-DD <Title>.md`. The date prefix
places the note on the calendar; the rest of the filename is the event or note
title. Notes live flat in the directory alongside the Main Document. Attachments
(images, PDFs) live next to the note that references them, in the same directory.

## Vault

A Vault is a collection of Notable Folders in a Johnny Decimal hierarchy:

- **Areas** — top-level domains. At most 10.
- **Categories** — groupings of Notable Folders. At most 10 per Area.
- Notable Folders live inside Categories; all files live inside Notable Folders.

**Johnny-Decimal Mode** (Settings toggle) makes the ids explicit: it prefixes
every Area, Category, and Notable Folder with its id — Areas as ranges
(`10-19 Self-Care`), Categories as numbers (`11 Selfish Projects`), Notable
Folders as `AC.ID` (`11.01 Living Room Refresh`). It rewrites `spacetime.md`
and renames the matching directories, updating inbound `[[wikilinks]]` and event
tags to match. Turning it off strips the ids back off. The setting is
per-machine; the ids computed from the current hierarchy order, so it is
idempotent.

## List modes

A Notable Folder Main Document (or any note) with a `list:` frontmatter key
renders its bullet items as a list instead of prose. Three modes:

- `list: cards` — icon-cover cards in a responsive grid (the default for
  reference collections).
- `list: lines` — a dense one-per-row layout with inline meta.
- `list: masonry` — variable-height "cards on a card" flowed into columns and
  sized by their content, for text-forward lists. Item text renders inline
  wikilinks, markdown links, and images; cards drag-reorder from anywhere and
  open an immersive gallery in fullscreen.

Switching `list:` in the frontmatter inspector re-renders live. Items are the
body's bullets; setting `list:` lifts them out of the editor, and clearing it
folds them back in as a normal markdown list.

## Pile

The Pile is the open stack of Notable Folders for a working session. Recently touched
folders rise to the top; the Home Folder stays anchored at the bottom. Navigation is
a pile: the folder you touch goes on top.

## Calendar

Notes become calendar events by carrying a date. A **Notable Update** is an all-day
note belonging to a Notable Folder. A **Season** is a user-defined date range with a
name — a stretch of life rather than a moment in it.

## Spacetime

Order's data model distills to a single format: **Spacetime**. It holds both
dimensions a personal system runs on — where things live (space) and when things
happen (time) — in one file you can read without a manual.

Two candidate formats are under active evaluation:

- `spacetime.yml` — machine-precise YAML
- `spacetime.mw` — human-habitable Markwhen-derived plain text

Both live at the vault root and are kept in sync. The decision of which to converge
on is pending; the evaluation criteria are **composability** (can a vault be split
across files and merged cleanly?) and **habitability** (can you live in the file,
edit one line, and save without knowing the rules?). Current lean: Markwhen.

See **[docs/SPACETIME.md](SPACETIME.md)** for the complete format specification:
field reference, examples, composability rules, and the brood invariant.
