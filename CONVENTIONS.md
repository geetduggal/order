# Order conventions

Order keeps two things first class: where your work lives, and when it happens. Everything is plain text you can read and edit by hand. The structure sits on the page, not behind a database.

## Notable Folder

A Notable Folder is a filesystem folder with a main document at its center and a stream of surrounding notes.

- Main Document: `Notable Folder/Notable Folder.md`
- Note: `Notable Folder/YYYY-MM-DD-note.md`

A note behaves like a calendar event and carries minimal YAML frontmatter.

Required:

- `date: "YYYY-MM-DD"`
- `folder: "[[Folder]]"`
- `title: "note"`

Optional:

- `public: true`
- `slug: note`
- `allDay: false`

## List

A List is a markdown document in a Notable Folder whose frontmatter sets how its bullets render. `cards` and `lines` lift bullets beyond plain text into objects you can drag, reorder, and illustrate with images.

- `list: cards | lines`

## Vault

A Vault is a collection of Notable Folders in a Johnny Decimal inspired hierarchy.

- **Areas**: top-level domains. At most 10.
- **Categories**: groupings of Notable Folders. At most 10, each belonging to exactly one Area.
- Files live only inside Notable Folders.
- The **Index** is a nested markdown list of `Area / Category / Notable Folder`, kept at `Index.md` in the vault root.

```
- Area
    - Category
        - [[Notable Folder]]
        - ...
    - ...
- Area 2
    - Category 2
        - [[Notable Folder 2]]
        - ...
```

## Pile

The Pile is the open stack of Notable Folders for a working session.

- Recently accessed folders rise to the top.
- You can select and reorder the pile for quick access.
- The **Home Folder** is the one folder designated as the vault's home. It stays at the bottom of the pile by default.

## Calendar

The Calendar views every note across a set of Notable Folders in time.

- The default view is an unfiltered weekly view.
- The current pile can be added as a filter in one step.
- Day, Month, Year, and user-defined Season views are also available.
- A **Notable Update** is an all-day note belonging to a Notable Folder.
- A **Season** is a user-defined range of ISO 8601 dates with a description.

Order's core data model distills to a single plain text format: Spacetime.

# Spacetime

A single plain text format for the two dimensions a personal system runs on: where things live (space), and when things happen (time). Most tools pick one and treat the other as an attachment. Spacetime holds both as first class, in one file you can read without a manual.

## The whole format, in one example

```yaml
space:
  - Entertainment:
      - Games:
          - Board Games
          - Video Games
      - Music:
          - Jazz
          - Rock
  - Work:
      - Projects:
          - Order
          - PKM System
      - Teams:
          - Frontend
          - Firmware
time:
  seasons:
    - {date: 2026-06-01, title: Summer Building,        endDate: 2026-08-31}
    - {date: 2026-09-01, title: Community Focus,        endDate: 2026-11-30}
  events:
    - {date: 2026-06-15, title: Order v0.1.0 Release,   folder: Order,         allDay: true}
    - {date: 2026-06-16, title: Team standup,           folder: Frontend,      time: 09:00, endTime: 09:30}
    - {date: 2026-07-01, title: Summer trip,            folder: Entertainment, endDate: 2026-07-05}
    - {date: 2026-07-10, title: Company offsite,        folder: Work,          allDay: true}
    - {date: 2026-08-20, title: Medium deadline,        folder: Order,         time: 17:00}
```

Two top-level keys. Everything under them is shape you can already read.

## Why YAML

YAML is the closest thing to markdown for structured data. Indentation carries nesting, a list carries order, and a flow mapping carries a record on one line. A parser reads it cleanly and a person reads it without decoding.

## Three properties

**Composability.** The format splits across many files and rejoins to the same picture. The whole example can sit in one file, or the `Entertainment` area can live in its own (`Games` and `Music` with their folders beneath them) and merge back into place unchanged. No file is privileged.

**Completeness.** Joined, the pieces are the entire system, not a partial view to reconcile against some other source. The merged result is the truth, not a cache of it.

**Habitability.** You can live in the file: open it, edit a line, save it, and nothing breaks. Changing `Jazz` to `Bebop` or fixing a typo in `Team standup` is a one line edit, not a database migration.

## Space and time have different shapes

**Time is columnar.** Every event is the same record: a date, a title, a folder, and a few optional fields. The `Team standup` row reads `date, title, folder`, then `time: 09:00, endTime: 09:30`. Reading down the date and title columns tells you what is happening and when; the rest sits to the right, out of the way.

**Space is hierarchical.** There are no field names to invent. A name, and under it the ordered list of names beneath it. `Games` holds `Board Games` and `Video Games`; the names and their nesting are the whole definition.

## Brood

Space composes through one rule. The brood is the full set of children under a node, in order. The brood of `Games` is exactly `Board Games` and `Video Games`: you write both or neither, never just one. That makes merging deterministic, because order is always explicit, so joined files line up the same way every time. A valid space fragment is any complete brood at any depth: the full list of areas (`Entertainment`, `Work`), every category under `Work` (`Projects`, `Teams`), or every folder under `Music` (`Jazz`, `Rock`).

## Two kinds of time record

**Events** carry a date and a title, then optional fields. `folder` ties the event to its Notable Folder, as `Team standup` ties to `Frontend`. `time` and `endTime` give it a clock (`09:00` to `09:30`). `endDate` makes it span days, the way `Summer trip` runs `2026-07-01` to `2026-07-05`. `allDay` marks a full day with no clock, like `Order v0.1.0 Release`.

**Seasons** are the longer arc: a date, a title, and an endDate. `Summer Building` spans `2026-06-01` to `2026-08-31`. A season names a stretch of life rather than a moment in it.

## Canonical form and writing surface

The merged file is the canonical form: the complete, machine ready picture of space and time. You can edit it by hand, but you rarely need to. You write on the surfaces instead: a dated note, a one line event, a folder's own frontmatter. Surfaces compile down into the canonical Spacetime, so you never choose between writing fast and keeping structure.

## In one line

A plain text map of where your life is organized and when it moved. Small enough to read at a glance, composable enough to split across files, complete enough to trust as the whole picture.
