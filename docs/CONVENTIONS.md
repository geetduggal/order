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

The main document is just a markdown file with the same name as the directory. Notes
live alongside it. No special database — the directory shape is the whole convention.

## Vault

A Vault is a collection of Notable Folders in a Johnny Decimal inspired hierarchy:

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

---

# Spacetime

Order's data model distills to a single unified format: **Spacetime**. It holds both
dimensions a personal system runs on — where things live (space) and when they happen
(time) — in one file you can read without a manual.

## The design space

Order is currently in an exploratory phase, evaluating two candidate formats for
Spacetime: a hand-rolled YAML format (`spacetime.yml`) and a Markwhen-derived format
(`spacetime.mw`). Both files live at the vault root and are kept in sync; Order reads
from either and writes to both. The goal is to converge on whichever format proves
more habitable across the key criteria below — particularly composability, which will
determine whether splitting a vault across multiple Spacetime files stays ergonomic
as a vault grows.

**Criteria under evaluation:**
- **Composability** — can a brood be split across files and rejoined cleanly?
- **Habitability** — can you live in the file, edit one line, and save without
  knowing the rules?
- **Readability at a glance** — does a new viewer understand the file cold?
- **Alignment** — do temporal records read as a table without extra tooling?

Current lean: Markwhen. The heading-and-list structure maps cleanly to the brain's
spatial model, and the date-first event lines read as a timeline without any markup
knowledge. But the evaluation is live and both formats remain first class.

---

## spacetime.yml

A hand-rolled, column-aligned YAML dialect. Two top-level keys: `space` (the
hierarchy as nested block lists) and `time` (seasons and events as flow mappings
with `date` and `title` leading every record).

### Full example

```yaml
space:
  - Entertainment:
      - Entertainment Spaces:
          - Board Games
          - Movies
          - Shows
      - Entertainment Projects:
          - 2026 Living Room Refresh
  - Work:
      - Work Projects:
          - Order Build
          - PKM System
      - Work Teams:
          - Frontend
          - Firmware
time:
  seasons:
    - {date: 2026-06-01, title: Summer Building,    endDate: 2026-08-31}
    - {date: 2026-09-01, title: Community Focus,    endDate: 2026-11-30}
  events:
    - {date: 2026-06-15, title: Order v0.1.0 Release, folder: Order Build,  allDay: true}
    - {date: 2026-06-16, title: Team standup,          folder: Frontend,     time: 09:00, endTime: 09:30}
    - {date: 2026-07-01, title: Summer trip,           folder: Entertainment Spaces, endDate: 2026-07-05}
    - {date: 2026-08-20, title: Medium deadline,       folder: Order Build,  time: 17:00}
```

### Space

The hierarchy is nested block lists. A name with children gets a colon and its
children indented beneath it. A leaf (a Notable Folder) is a plain list item.
Three levels: Area → Category → Notable Folder.

### Time

**Events** carry a date and a title, then optional fields:
- `folder` — ties the event to its Notable Folder
- `time` / `endTime` — clock span (`09:00` to `09:30`)
- `endDate` — multi-day span (`2026-07-01` to `2026-07-05`)
- `allDay` — full-day flag (no clock)

**Seasons** carry a date, a title, and an optional endDate. They name a stretch of
life rather than a moment in it.

Records are column-aligned: `date` and `title` lead, everything else sits to the
right, out of the way.

### Brood

Space composes through one rule. The **brood** is the full ordered list of children
under a node. You write all children or none — never just some. This makes merging
deterministic: two files that each declare a complete brood for different nodes
join without ambiguity. A valid Spacetime fragment can be any complete brood at
any depth.

---

## spacetime.mw

A Markwhen-inspired plain-text format. Two top-level `#` sections: `# Space` (the
hierarchy as nested markdown lists under `##` area headings) and `# Time` (seasons
and events as date-prefixed lines under `##` subsections).

### Full example

```
# Space

## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
  - Shows
- Entertainment Projects
  - 2026 Living Room Refresh

## Work
- Work Projects
  - Order Build
  - PKM System
- Work Teams
  - Frontend
  - Firmware

# Time

## Seasons

2026-06-01 / 2026-08-31: Summer Building
2026-09-01 / 2026-11-30: Community Focus

## Events

2026-06-15          : Order v0.1.0 Release  #order-build
2026-06-16 09:00-09:30: Team standup          #frontend
2026-07-01 / 2026-07-05: Summer trip          #entertainment-spaces
2026-08-20 17:00    : Medium deadline         #order-build
```

### Space

Areas are `## Headings`. Categories are unindented list items (`- Category`).
Notable Folders are two-space-indented items (`  - Folder`). The nesting is
visual; no colons or mapping syntax required.

### Time

**Seasons** follow a simple date-range prefix:
```
2026-06-01 / 2026-08-31: Summer Building
2026-06-01             : Open-ended season
```

**Events** extend the same idea with optional clock times:
```
2026-06-15                  : All-day event      #folder-tag
2026-06-16 09:00-09:30      : Timed event        #folder-tag
2026-07-01 / 2026-07-05     : Multi-day event    #folder-tag
2026-08-20 17:00            : Start-time only    #folder-tag
```

### Folder tags

Notable Folder names translate to hyphenated lowercase tags for the `.mw` format:

| Folder name              | Tag                    |
|--------------------------|------------------------|
| `Board Games`            | `#board-games`         |
| `2026 Living Room Refresh` | `#2026-living-room-refresh` |
| `Frontend`               | `#frontend`            |

Order resolves tags back to folder names by matching against the space tree.

### Column alignment

Both formats align their columns. In `.mw`, date prefixes are padded to the width
of the longest prefix so all titles start in the same column — the file reads as a
table without any actual table markup.

---

## Sync and source of truth

`spacetime.yml` and `spacetime.mw` are kept in sync automatically:

- The app regenerates both files continuously as notes change. `space` and `seasons`
  are preserved from whichever file was most recently hand-edited; only `time.events`
  is regenerated (because events are still note-backed — each event is a real `.md`
  file with content).
- Editing either file by hand (in Order's raw-text card or an external editor)
  triggers a re-parse that writes the changes to the other format and updates the
  taxonomy and seasons immediately.
- New events added to either file materialize as backing `.md` notes in the
  appropriate Notable Folder.

The vault migration (Settings → "Migrate to spacetime…") strips the legacy chain
index files (`Areas.md`, category files, `Seasons.md`) and event YAML frontmatter
once `spacetime.yml`/`.mw` become the acknowledged source of truth. A full vault
backup is taken before any file is touched.
