# Spacetime convention

Spacetime is Order's canonical data format: a minimal map of where your work lives
(space) and when things happen (time). It is the single source of truth for the vault's
hierarchy and schedule.

Order has two surface formats for Spacetime: a Markwhen-based plain-text format
(`spacetime.mw`) and a YAML dialect (`spacetime.yml`). They represent the same
information, but they are **not** co-equal: `spacetime.mw` is the canonical source of
truth, and `spacetime.yml` is a derived mirror Order keeps current for external/YAML
readers. Edit the mw; the yml follows. (The Markdown reference below describes the
same `# Space` / `# Time` structure the `.mw` file uses.) See **Sync model** for how
hand-edits to `spacetime.mw` are reviewed before they restructure the vault.

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
    - {date: 2026-06-15, title: Order v0.1.0 Release, folder: Order Build, allDay: true}
    - {date: 2026-06-16, title: Team standup,          folder: Frontend,   time: 09:00, endTime: 09:30}
    - {date: 2026-07-01, title: Summer trip,           folder: Board Games, endDate: 2026-07-05}
    - {date: 2026-08-20, title: Medium deadline,       folder: Order Build, time: 17:00}
```

### spacetime.md

```markdown
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

2026-06-15              : Order v0.1.0 Release  #[Order Build]
2026-06-16 09:00-09:30  : Team standup          #[Frontend]
2026-07-01 / 2026-07-05 : Summer trip           #[Board Games]
2026-08-20 17:00        : Medium deadline       #[Order Build]
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

## Markdown format reference

### Space

Top-level `# Space` section. Areas are `##` headings. Categories are unindented list
items (`- Category`). Notable Folders are 2-space-indented items (`  - Folder`).

```markdown
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

```markdown
# Time

## Events

2026-06-15              : All-day event         #[Order Build]
2026-06-16 09:00-09:30  : Timed event           #[Frontend]
2026-07-01 / 2026-07-05 : Multi-day event       #[Board Games]
2026-08-20 17:00        : Start-time only       #[Order Build]
2026-09-01              : No folder event
```

Date prefixes:

| Pattern | Meaning |
|---|---|
| `YYYY-MM-DD` | All-day event |
| `YYYY-MM-DD HH:MM` | Event with start time, 30-min default duration |
| `YYYY-MM-DD HH:MM-HH:MM` | Event with start and end time |
| `YYYY-MM-DD / YYYY-MM-DD` | Multi-day span (inclusive) |

As with YAML events, each event here corresponds to a backing note at
`<Notable Folder>/YYYY-MM-DD <Title>.md`. Order creates the file when the event
is new and updates it when the event changes.

### Folder tags

The canonical folder tag form is `#[Exact Folder Name]` — the folder name in
brackets, case and spaces preserved:

| Folder name | Tag |
|---|---|
| `Order Build` | `#[Order Build]` |
| `Board Games` | `#[Board Games]` |
| `Geet Duggal` | `#[Geet Duggal]` |
| `2026 Living Room Refresh` | `#[2026 Living Room Refresh]` |

The legacy hyphenated form (e.g. `#order-build`) is still accepted by the parser
for back-compatibility — files written by older versions of Order continue to
work. Order always serializes the brace form going forward. Existing `spacetime.mw`
files are migrated from kebab to brace automatically on first write.

Order resolves both tag forms back to folder names by matching against the space
tree. A tag that doesn't match any known folder is kept as-is (the bracketed name
becomes the folder name).

### Email recipients on event lines

Trailing bare email addresses on an event line mark it as a
**Google Calendar-synced event** and list who the event involves. Emails come
after the folder tag, space-separated:

```markdown
2026-06-26 09:00-09:30  : Standup    #[Acme] you@example.com
2026-06-26 14:00-15:00  : Planning   #[Acme] you@example.com dana@example.com
```

Events with no email addresses are ordinary Order events; the sync feature
never touches them. See [GCAL-SYNC.md](GCAL-SYNC.md) for how email addresses
determine the host calendar and invitees.

### Apple / system calendar tag

An `@[Calendar Name]` token assigns the event to a macOS/iOS **system calendar**;
Order creates (and updates) it there. It's the Apple counterpart to the Google
email trigger and trails the folder tag:

```markdown
2026-07-25             : Furniture day  #[Living Room Refresh] @[Home]
2026-07-20 09:00-09:30 : Sprint sync    #[Map Pipeline v2]     @[Work] you@example.com
```

The token is order-independent with the folder tag and emails; the canonical
written form is `Title #[Folder] @[Calendar] emails…`. Apple events are
invite-free (EventKit attendees are read-only); use emails for invitations. See
[APPLE-CAL.md](APPLE-CAL.md).

### Time — seasons

Under `## Seasons`.

```markdown
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

```markdown
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

```markdown
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
- Entertainment Projects
  - 2026 Living Room Refresh
```

**Archived events in a separate file:** space is not required.

```markdown
# Time

## Events
2025-12-01 : Winter planning  #[Order Build]
2025-11-15 : Q4 retrospective #[Frontend]

## Seasons
2025-10-01 / 2025-12-31: Fall Arc
```

### Invalid fragment (brood violation)

This fragment is invalid because `Work` appears with no children. If you list `Work`,
you must list all its categories.

```markdown
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
## Work
```

Order will flag this as a conflict: `Work` is declared but its brood is empty.

### Merge example

Given two files:

**entertainment.md**
```markdown
# Space
## Entertainment
- Entertainment Spaces
  - Board Games
  - Movies
- Entertainment Projects
  - 2026 Living Room Refresh
```

**work.md**
```markdown
# Space
## Work
- Work Projects
  - Order Build
- Work Teams
  - Frontend
```

Merge result (no conflicts):

```yaml
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

**work.md** — `Work Projects: [Order Build, PKM System]`  
**work-alt.md** — `Work Projects: [Order Build, New Project]`

Order surfaces:
```text
Conflict: Conflicting children at "Work/Work Projects":
  [Order Build, PKM System] in "work.md"
  [Order Build, New Project] in "work-alt.md"
```


No automatic resolution. The user must edit one file to agree with the other.

---

## Sync model

`spacetime.mw` (the Markwhen plain-text surface) at the vault root is the **single
source of truth** for the hierarchy and schedule. `spacetime.yml` is a derived mirror
of it, kept current for external/YAML readers. The on-disk directory tree
(`<Area>/<Category>/<Notable Folder>/`) is expected to match the mw's `# Space`
section exactly — the mw is authoritative, the directories follow it.

### Display is always live, restructuring is reviewed

Order draws the sidebar taxonomy and the calendar directly from the in-memory parse
of `spacetime.mw`, so any edit to the mw is reflected in the UI immediately (a live
preview). What is **not** automatic is changing the vault's files on disk.

When you hand-edit `spacetime.mw` — in Order's editor card or an external editor — and
pause, Order diffs the edit against the last-applied baseline and, if there are
structural or seasons changes, opens a **review dialog** instead of silently
restructuring the vault. The dialog itemizes exactly what would happen (collapsing to
counts past ~8 items):

- **Rename** a folder/category/area → the matching directory is renamed and inbound
  `[[wikilinks]]` / `folder:` references are rewritten.
- **New** folder/category/area → its directory is created.
- **Remove** a folder → its directory and every file in it is deleted (destructive;
  shown with a file count and an explicit `Apply (deletes N)` button).
- **Reorder** siblings → order is recorded (no files move).
- **Seasons** changes.

From the dialog you can:

- **Apply** — restructure the vault to match the mw, mirror `spacetime.yml`, and
  advance the baseline. Renames are positional (a removed name paired with an added
  name at the same parent), matching what the summary showed.
- **Keep editing** (decline) — your file edits are preserved, nothing on disk changes,
  and a subtle **"spacetime · N pending"** indicator (bottom-left) stays until you
  apply. Click it to reopen the review. The baseline is persisted per vault, so the
  pending state — and the indicator — survive an app reload.

Rules of thumb for what triggers a review:

- **Hand-edits to `spacetime.mw`** that change space or seasons → reviewed.
- **Event-only** mw edits → no disk consequence, so `spacetime.yml` is mirrored
  silently with no dialog.
- **Direct UI manipulation** (sidebar tile drag/add/remove, calendar event
  create/move/delete) → applied immediately and never reviewed; these advance the
  baseline as they write, so they never register as "pending."

### Drift flagging (disk vs. mw)

Because the mw is the source of truth, anything on disk that the mw does **not**
account for is drift. The review dialog lists, under **"On disk but not in
spacetime.mw,"** every Notable Folder directory missing from the mw space tree (for
example, a folder removed from the mw whose directory was kept, or stale cruft from
an earlier bug).

A Notable Folder is recognised **structurally**, never from frontmatter: its main
document lives at `<Area>/<Category>/<Folder>/<Folder>.md` (the file names its own
directory), and its Area + Category are read straight from that path. A note's
`area:` / `category:` frontmatter is irrelevant to placement — the directory tree and
spacetime.mw are the only authorities.

For each orphan you can:

- **Add to spacetime.mw** — the dialog pre-fills the Area and Category from the
  folder's location; edit them if you want it filed elsewhere, then add. Order
  ensures the area, category, and folder all exist in the mw and, if you changed the
  placement, moves the directory to match. No frontmatter is written.
- **Remove from disk** — delete the directory and its files (confirmed).

The pending indicator counts these alongside un-applied mw edits, so the two
representations are never allowed to silently diverge.

### Events

Events are mw-authoritative: the calendar renders straight from `spacetime.mw`, so a
backing note is not required for an event to appear. Backing notes (`<Notable
Folder>/YYYY-MM-DD <Title>.md`) are created lazily when you open an event. This avoids
the two-way create/update loop earlier versions suffered.

### Manual YAML apply

A separate **"Apply spacetime.yml…"** action in Settings still exists for the reverse
direction: it diffs a hand-edited `spacetime.yml` against the vault and applies the
plan after its own review. Day to day, prefer editing `spacetime.mw`.
