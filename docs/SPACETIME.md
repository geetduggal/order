# Spacetime specification

Spacetime is Order's canonical data format: a minimal map of where your work lives
(space) and when things happen (time). It is the single source of truth for the vault's
hierarchy and schedule.

Order is currently evaluating two surface formats for Spacetime — a YAML dialect
(`spacetime.yml`) and a Markwhen-derived plain-text format (`spacetime.mw`). Both
represent the same information; Order keeps them in sync. The goal is to converge on
whichever proves more habitable as a vault scales, particularly for composability.

---

## Concepts

**Space** — the Areas → Categories → Notable Folders hierarchy. Defines where things
live and in what order.

**Time** — events and seasons. Events are dated moments tied to a Notable Folder.
Seasons are named date ranges.

**Brood** — the complete, ordered list of children under one parent node. The brood
is the unit of composability: a valid Spacetime fragment is any complete brood at
any depth. Writing a brood means writing ALL its children — never a partial list.

**Area** — a top-level domain. At most 10 per vault.

**Category** — a grouping of Notable Folders. At most 10 per Area.

**Notable Folder** — a leaf node: a directory with a Main Document and associated
notes. Events can only belong to Notable Folders, never to Areas or Categories.

**Merge conflict** — two sources that define the same parent's children differently,
or an event referencing a folder that doesn't exist in the merged space.

---

## Formats side by side

The same vault in both formats:

### spacetime.yml

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
    - {date: 2026-06-15, title: Order v0.1.0 Release, folder: Order Build,         allDay: true}
    - {date: 2026-06-16, title: Team standup,          folder: Frontend,            time: 09:00, endTime: 09:30}
    - {date: 2026-07-01, title: Summer trip,           folder: Entertainment Spaces, endDate: 2026-07-05}
    - {date: 2026-08-20, title: Medium deadline,       folder: Order Build,         time: 17:00}
```

### spacetime.mw

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

2026-06-15              : Order v0.1.0 Release  #order-build
2026-06-16 09:00-09:30  : Team standup          #frontend
2026-07-01 / 2026-07-05 : Summer trip           #entertainment-spaces
2026-08-20 17:00        : Medium deadline       #order-build
```

---

## YAML format reference

### Space

Nested block lists. A parent node gets a colon; its children are indented beneath it.
Leaves (Notable Folders) are plain list items. Three levels only: Area → Category →
Notable Folder.

```yaml
space:
  - Area:
      - Category:
          - Notable Folder
          - Another Folder
      - Empty Category:      # category with no folders yet
  - Another Area:
      - Its Category:
          - Folder
```

### Time — events

Flow mappings, one per line. `date` and `title` lead every record; optional fields
follow in any order.

```yaml
time:
  events:
    - {date: 2026-06-15, title: All-day event,    folder: Order Build,  allDay: true}
    - {date: 2026-06-16, title: Timed event,       folder: Frontend,     time: 09:00, endTime: 09:30}
    - {date: 2026-07-01, title: Multi-day event,   folder: Board Games,  endDate: 2026-07-05}
    - {date: 2026-08-20, title: Start-time only,   folder: Order Build,  time: 17:00}
    - {date: 2026-09-01, title: No folder event}
```

| Field | Required | Description |
|---|---|---|
| `date` | yes | `YYYY-MM-DD` |
| `title` | yes | Event name |
| `folder` | recommended | Notable Folder name (space-separated). Events without a folder appear on the calendar but are unassigned. |
| `time` | no | Start time `HH:MM` (24h) |
| `endTime` | no | End time `HH:MM`. If omitted, Order uses a 30-minute default. |
| `endDate` | no | Inclusive end date for multi-day events |
| `allDay` | no | `true` for all-day events (no clock) |

**Implicit file location.** An event defined in Spacetime corresponds to a backing
note at `<Notable Folder>/YYYY-MM-DD <Title>.md`. When Order materialises a new
event it creates this file; when it reads the vault it derives the event from this
file's date prefix and frontmatter. The folder name in Spacetime determines which
directory the file lives in.

### Time — seasons

```yaml
time:
  seasons:
    - {date: 2026-06-01, title: Summer Building,  endDate: 2026-08-31}
    - {date: 2026-09-01, title: Community Focus,  endDate: 2026-11-30}
    - {date: 2026-12-01, title: Open season}       # no end date — ongoing
```

| Field | Required | Description |
|---|---|---|
| `date` | yes | Start date `YYYY-MM-DD` |
| `title` | yes | Season name |
| `endDate` | no | End date. Absent = open-ended. |

---

## Markwhen format reference

### Space

Top-level `# Space` section. Areas are `##` headings. Categories are unindented list
items (`- Category`). Notable Folders are 2-space-indented items (`  - Folder`).

```
# Space

## Area Name
- Category Name
  - Notable Folder
  - Another Folder
- Another Category
  - Folder
```

### Time — events

Under `## Events`. Each line is a date prefix, a colon, a title, and an optional
`#folder-tag`.

```
# Time

## Events

2026-06-15              : All-day event         #order-build
2026-06-16 09:00-09:30  : Timed event           #frontend
2026-07-01 / 2026-07-05 : Multi-day event       #board-games
2026-08-20 17:00        : Start-time only       #order-build
2026-09-01              : No folder event
```

Date prefixes:

| Pattern | Meaning |
|---|---|
| `YYYY-MM-DD` | All-day event |
| `YYYY-MM-DD HH:MM` | Event with start time, 30-min default duration |
| `YYYY-MM-DD HH:MM-HH:MM` | Event with start and end time |
| `YYYY-MM-DD / YYYY-MM-DD` | Multi-day span (inclusive) |

As with YAML events, each `.mw` event corresponds to a backing note at
`<Notable Folder>/YYYY-MM-DD <Title>.md`. Order creates the file when the event
is new and updates it when the event changes.

### Folder tags

Notable Folder names translate to hyphenated lowercase `#tags`:

| Folder name | Tag |
|---|---|
| `Order Build` | `#order-build` |
| `Board Games` | `#board-games` |
| `2026 Living Room Refresh` | `#2026-living-room-refresh` |

Order resolves tags back to folder names by matching against the space tree. A tag
that doesn't match any folder in the merged space is flagged as a conflict.

### Time — seasons

Under `## Seasons`.

```
## Seasons

2026-06-01 / 2026-08-31: Summer Building
2026-09-01 / 2026-11-30: Community Focus
2026-12-01             : Open season
```

Seasons do not take a folder tag. The format is `DATE [/ END]: Title`.

### Column alignment

Event date prefixes are padded to the width of the longest prefix so all titles
start at the same column — the file reads as a table without actual table markup.
Order produces aligned output automatically; hand-editing may leave lines unaligned,
which is fine — the parser ignores whitespace.

---

## Composability

A Spacetime file need not contain the whole vault. Any complete brood at any depth
is a valid Spacetime fragment that can live in its own file and be merged with others.

### The brood rule

> Write all children of a node or write none. A partial list is invalid.

If you define a node's children in a file, you must list ALL of them. If another file
also defines the same node's children, both lists must agree (order may differ). If
they disagree, Order surfaces a conflict rather than silently resolving it.

### Valid fragments (legal broods)

**Complete vault in one file:** the ordinary case.

```
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
## Work
- Work Projects
  - Order Build
```

**One area as a separate file:** defines only the Entertainment sub-tree.
Another file can define Work without any conflict.

```
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
- Entertainment Projects
  - 2026 Living Room Refresh
```

**Archived events in a separate file:** space is not required.

```
# Time

## Events
2025-12-01 : Winter planning  #order-build
2025-11-15 : Q4 retrospective #frontend

## Seasons
2025-10-01 / 2025-12-31: Fall Arc
```

### Invalid fragment (brood violation)

This fragment is invalid because `Work` appears with no children. If you list `Work`,
you must list all its categories.

```
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
## Work
```

Order will flag this as a conflict: `Work` is declared but its brood is empty.

### Merge example

Given two files:

**entertainment.mw**
```
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
- Entertainment Projects
  - 2026 Living Room Refresh
```

**work.mw**
```
# Space
## Work
- Work Projects
  - Order Build
- Work Teams
  - Frontend
```

Merge result (no conflicts):

```
space:
  Entertainment:
    Entertainment Spaces: [Board Games, Movies]
    Entertainment Projects: [2026 Living Room Refresh]
  Work:
    Work Projects: [Order Build]
    Work Teams: [Frontend]
```

### Conflict example

Two files both define `Work Projects` with different children:

**work.mw** — `Work Projects: [Order Build, PKM System]`  
**work-alt.mw** — `Work Projects: [Order Build, New Project]`

Order surfaces:
```
Conflict: Conflicting children at "Work/Work Projects":
  [Order Build, PKM System] in "work.mw"
  [Order Build, New Project] in "work-alt.mw"
```

No automatic resolution. The user must edit one file to agree with the other.

---

## Sync model

- Order regenerates `spacetime.yml` and `spacetime.mw` at the vault root continuously
  as notes change. These root files always reflect the full merged vault state.
- Editing either root file by hand triggers a re-parse that updates the taxonomy
  and seasons immediately without needing an explicit "apply" step.
- Additional `.mw` files anywhere in the vault are included in the vault-wide merge.
  Adding or editing them updates the merged state after the file watcher fires.
- Events are always note-backed. Each event is a real `.md` file with content.
  Spacetime files carry the schedule; the notes carry the substance.
- New events added to `.mw` files materialize as backing `.md` notes in the
  appropriate Notable Folder.
- The "Apply to vault…" button in Settings pushes structural changes (add/remove/
  reorder folders, edit events) from `spacetime.yml` into the vault's note files
  after a review step.
