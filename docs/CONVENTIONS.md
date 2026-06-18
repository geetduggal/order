# Order conventions

Order keeps two things first class: where your work lives, and when it happens.
Everything is plain text you can read and edit by hand. The structure sits on the
page, not behind a database.

## Notable Folder

A Notable Folder is a filesystem directory with a main document at its center and
a stream of surrounding notes.

```
Board Games/
├── Board Games.md        ← Main Document
├── 2026-06-01 Game night.md
└── wishlist.md
```

The main document is a markdown file with the same name as the directory. Notes live
alongside it. No special database — the directory shape is the whole convention.

## Vault

A Vault is a collection of Notable Folders in a Johnny Decimal hierarchy:

- **Areas** — top-level domains. At most 10.
- **Categories** — groupings of Notable Folders. At most 10 per Area.
- Notable Folders live inside Categories; all files live inside Notable Folders.

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
