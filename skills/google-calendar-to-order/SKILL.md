---
name: google-calendar-to-order
description: "Import events from Google Calendar into the user's Order vault as Obsidian Full Calendar-style markdown notes. Walks each event interactively to confirm title, time, and which Notable Folder it lands in before writing."
triggers:
  - "import my google calendar"
  - "import calendar to order"
  - "gcal to order"
  - "bring my meetings into order"
  - "sync google calendar to my vault"
  - "google calendar to order"
---

# Google Calendar → Order

Pull events from the user's Google Calendar (via the claude.ai Google
Calendar MCP server) and write them into the Order vault as one
markdown note per event, using the Obsidian Full Calendar YAML shape
Order parses.

Every event is confirmed interactively before it lands on disk — no
silent batch imports.

## When to use

The user says things like:
- "import my google calendar to Order for this week"
- "bring my work meetings into my vault"
- "sync Tuesday's events to my notable folder"
- "gcal → order, just the personal stuff"

## Inputs to confirm up front

Before fetching anything, get answers to these three with a single
`AskUserQuestion` (one question, three sub-questions):

1. **Date range.** Default to the current week (Mon→Sun in the user's
   local TZ). Other common choices: "today only", "this weekend",
   "next 14 days", custom.
2. **Calendar source.** Default to the primary calendar. If the user
   wants a non-default, call
   `mcp__claude_ai_Google_Calendar__list_calendars` and offer the
   list. Skip cancelled / declined calendars.
3. **Routing.** "Suggest a Notable Folder for each event" (the default —
   skill proposes based on title / attendees / description and the
   user accepts or overrides) vs. "Always ask explicitly".

## Workflow

### 1. Inspect the vault structure

Find the vault root first:
- Look at the user's CLAUDE.md for a vault hint.
- Common roots: `~/Development/Dropbox/Home/`, `~/Development/Dropbox/OrderDemoVault/`.
- If still ambiguous, ask.

Walk the vault to collect the available Notable Folders. A Notable
Folder Main Doc is a `.md` file whose YAML has a `category:` key —
the **filename without `.md` is the folder name** the wikilink
points at.

Cheap walk:
```bash
find <vault-root> -name '*.md' -maxdepth 5 \
  | xargs grep -l '^category:' 2>/dev/null
```

Build an in-memory list of `{ name, parentDir }` so we can:
- propose a folder for each event,
- write the new event file inside the right NF directory.

### 2. Fetch the events

Call `mcp__claude_ai_Google_Calendar__list_events` with the
confirmed range. If the user picked a non-default calendar, pass its
`calendarId`. Drop events that are cancelled, all-day birthdays from
contacts that already exist in the vault, and anything the user
explicitly excluded.

### 3. Map each event to Order's shape

For each Google event, build a proposal:

**Filename** — `YYYY-MM-DD Title.md`, with `/:*?"<>|` replaced by `-`.
This is the Obsidian Full Calendar convention; do NOT use the
Google event ID.

**Frontmatter** — minimal, only the keys Order needs:

```yaml
---
title: <event summary>
type: single
allDay: <true|false>
date: <YYYY-MM-DD of start, local TZ>
startTime: "HH:MM"   # 24-hour, omit when allDay
endTime: "HH:MM"     # 24-hour, omit when allDay
endDate: <YYYY-MM-DD> # only for multi-day spans
folder: "[[<NF name>]]" # the chosen Notable Folder
---
```

**Body** — start with an H3 title, then the Google event description
if present, lightly cleaned (drop trackers, drop the "Join with
Google Meet" boilerplate unless the user explicitly wants it).

```markdown
### <title>

<description>
```

### 4. Propose a folder, then confirm

The skill suggests a Notable Folder using these heuristics, in
order:

1. **Attendee match** — if the event has an attendee whose name
   matches a Notable Folder filename (e.g. an NF for that person
   exists), route there.
2. **Title keyword** — match the event title against NF names
   (case-insensitive, substring). "Sprint planning" → "Map
   Pipeline v2" if the project's NF is named that.
3. **Recurring + work-flagged** — recurring meetings during business
   hours → the user's day-job space NF.
4. **Fallback** — if a home NF exists (its YAML has `home:`), use it;
   else ask.

Use `AskUserQuestion` per event (or per group of related events) to
confirm the mapping. The question should show a one-line preview
including filename, folder, and time range:

> `2026-06-10 Sprint standup.md   →  [[Map Pipeline v2]]   10:00–10:30`

Offer choices like:
- ✓ Accept as proposed
- Pick a different folder (multi-select list of candidate NFs)
- Edit title / filename
- Skip this event entirely
- Skip all remaining (abort the run)

When multiple events share a clean routing (e.g. three Sprint events
all → Map Pipeline v2), batch-confirm them in a single question to
keep the back-and-forth short.

### 5. Avoid collisions

Before writing a file, check whether `<vault>/<NF dir>/<filename>`
already exists. If so, either:
- skip it (default — assume the user already has that event in the
  vault), or
- append a suffix (`-2`, `-3`) if the user explicitly says merge.

Mention any skipped collisions in the final summary.

### 6. Write the files

Use the `Write` tool for each confirmed event, placing the file
inside the chosen NF directory.

### 7. Report

End with a short summary:
- N events imported, M skipped, K already existed
- Per-NF breakdown (`Map Pipeline v2: 4, Household: 2, Wide Margins: 1`)
- Any events the user explicitly edited from the proposal

## YAML shapes Order recognizes

**Timed event**
```yaml
---
title: Sprint standup
type: single
allDay: false
date: 2026-06-08
startTime: "10:00"
endTime: "10:30"
folder: "[[Map Pipeline v2]]"
---
### Sprint standup

Quick sync. Goal for the week: ship per-shard view to staging by Thursday.
```

**All-day event**
```yaml
---
title: Mom's birthday
type: single
allDay: true
date: 2026-06-11
folder: "[[Household]]"
---
### Mom's birthday
```

**Multi-day span**
```yaml
---
title: Cabin week
type: single
allDay: true
date: 2026-06-27
endDate: 2026-07-04
folder: "[[Cabin Week]]"
---
### Cabin week
```

## Gotchas

- **Quoting times.** Times MUST be quoted (`"09:00"` not `09:00`),
  otherwise YAML parses them as base-60 numbers and the calendar
  view drops the event silently.
- **Local timezone.** Use the user's local TZ (the same one Google
  Calendar returned), not UTC. Don't convert.
- **All-day shape.** Either `allDay: true` AND no `startTime`/`endTime`,
  OR `allDay: false` WITH both. Mixing the two breaks rendering.
- **Folder must exist.** The `folder:` wikilink must match the
  filename of an existing NF Main Doc (without `.md`). If the
  user wants an event in a folder that doesn't exist yet, offer
  to create the NF as part of the import (a `<Name>.md` with
  minimal YAML — `category: <parent>` only — in the right dir).
- **Don't escape brackets.** Write `folder: "[[Foo]]"` literally.
  No `\[\[` escapes.
- **One H3, then body.** Order expects `### <title>` as the first
  body line, then content. Earlier conventions used H1 — H3 is
  current.
- **Filename safety.** Strip `/:*?"<>|` from the event title for
  the filename. Replace with `-`.
