# Spacetime

A single plain text format for the two dimensions a personal system actually runs on: where things live, and when things happen. Space is the hierarchy you keep. Time is the record of what moved through it. Most tools pick one and bolt the other on as an afterthought. A calendar app treats your folders as a dumb attachment. A note vault treats dates as just another field. Spacetime holds both as first class, in one file you can read without a manual.

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

That is the entire surface. Two top level keys. Everything below them is shape you can already read.

## Why plain text, and why YAML

Markdown earned its place by making one thing true: you can open the file and work in it, with no machine standing between you and the words. The structure is right there on the page. Spacetime wants the same property for structured data. YAML is the closest thing to markdown for hierarchy and records. Indentation carries nesting. A list carries order. A flow mapping carries a record on a single line. You get a format that a parser reads cleanly and a person reads without decoding.

## The three properties it has to satisfy

**Composability.** The format can be split across many files and rejoined. Your whole world can sit in one file, or your entertainment area can live in its own file, or a single category can. When you union the pieces, you get the same picture every time. No file is privileged. No file is incomplete in a way that breaks the merge.

**Completeness.** When the pieces are joined, they represent the entire system, not a partial view that needs reconciling against some other source. The merged result is the truth, not a cache of it.

**Habitability.** You can live in the file. Open it, read it, edit a line, save it, and nothing breaks. This is the hardest property and the one that kills most formats. The moment a format turns into a glorified database, the keys multiply, the nesting deepens, and you stop wanting to touch it by hand. Spacetime stays habitable by keeping the common case short and the structure visible.

## Space and time have different shapes, on purpose

The two dimensions are not symmetric, and the format does not pretend they are.

**Time is columnar.** Every event is the same kind of record: a date, a title, a folder, and a few optional fields for time and range. This is exactly what a calendar wants and exactly what a table wants. Reading down the column of dates and titles tells you what is happening and when, at a glance. The supplementary fields sit to the right and stay out of the way.

**Space is hierarchical.** There are no field names to invent. The most concise representation of a hierarchy is the hierarchy itself. A name, and under it an ordered list of the names beneath it. The structure carries the meaning. You are not describing the tree. You are drawing it.

## Brood: the unit of composable space

Space composes through one rule. The unit is the **brood**: the full set of children under a single node, in order. When you write a node's children, you write all of them. You never list a partial set.

This is what makes merging unambiguous. Order lives in the list, and a list is only meaningful when it is complete. If two files each defined half of an area's categories, there would be no honest way to decide their order when joined. By requiring the whole brood, order is always explicit and the merge is always deterministic.

A valid space fragment is therefore any complete brood at any depth. The full list of areas. Or every category under one area. Or every notable folder under one category. Each is a clean slice you can keep in its own file.

## Time is two kinds of record

Under `time` there are two lists.

**Events** carry a `date` and a `title`, then optional fields. `folder` ties the event to the notable folder it belongs to. `time` and `endTime` give it a clock. `endDate` makes it span days. `allDay` marks it as a full day with no clock. The first two fields are the anchor you read by. The rest is detail.

**Seasons** are the longer arc: a `date`, a `title`, and an `endDate`. A season is the wide shot of the same timeline the events draw up close. It names a stretch of life rather than a moment in it.

## Canonical form and writing surface are not the same job

The merged file is the canonical form: the complete, machine ready picture of space and time. It is honest, but it is not where you are meant to do your daily writing. You can edit it by hand, and nothing stops you, but there is rarely a reason to.

Where you actually write is the surface, and the surface can be friendlier than the canonical form. A dated journal entry. A one line event the way todo.txt taught us to write one. A notable folder's own markdown file carrying its events in its frontmatter. These surfaces compile down into the canonical Spacetime, which means the format never forces you to choose between writing fast and keeping structure. You write where it feels good. The structure assembles underneath.

## What it is, in one line

A plain text map of where your life is organized and when it moved, small enough to read at a glance, composable enough to split across files, and complete enough to trust as the whole picture.
