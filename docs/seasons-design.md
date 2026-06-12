# Seasons

A Season is a new top-level calendar scope, sitting after Year. It is a user defined date range. When selected, the calendar surface is replaced by a full-screen Areas grid where each Area cell lists its Notable Folders that had an all-day event inside the season's range, sorted by recency.

## On-disk format

A vault-root file named `Seasons.md` with YAML `role: seasons`. Detection mirrors `Areas.md`: any note whose frontmatter has `role: seasons`, with the filename fallback `Seasons.md` at the vault root. Only the first match by walk order is honored.

Body is a chronological bullet list:

```
- 2026-01-27 - 2026-05-24 · Spring 2026
- 2026-06-01 -  · Current
```

Each bullet parses to `{ start, end?, name? }`. An empty end means the season is open ended (current).

## View enum and tabs

`View` in `src/components/CardGrid.tsx` gains `"season"`. The scope tabs in `src/components/CalendarView.tsx` gain a Season tab after Year and route through the same `onSelectView` callback. No URL persistence (matches the other scopes).

## Data layer

A new `src/lib/seasons.ts`:

```ts
type Season = { start: string; end: string | null; name?: string }
parseSeasons(body: string): Season[]
isSeasonsFile(fm: Frontmatter, filename: string): boolean
findSeasonForDate(seasons: Season[], today: string): Season | null
```

The view query runs in memory over the already loaded `calendarNotes`. For each Area in `vaultTaxonomy.areas` it:

1. filters notes where `allDay === true` with a parseable `date`,
2. resolves each note's `folder: [[NF]]` to a known Notable Folder in that area,
3. keeps notes whose `date` falls inside `[start, end ?? today]`,
4. groups by NF, computes `{ count, mostRecent }`, sorts by `mostRecent` desc,
5. truncates to the top 8 per Area cell.

NFs with zero matches in the range are omitted.

## Layout

A new `SeasonView` component owns the content area when `view === "season"`. CSS grid, `grid-template-columns: repeat(2, 1fr)`, wrapping to as many rows as Areas dictate. With six Areas this naturally renders 3×2. Each cell is one Area:

- header: Area name (click navigates to its main doc).
- body: a vertical list of NF rows. Each row shows the NF name and a small update count (e.g. `Free Will · 3`). Click navigates to that NF's main doc. Empty cells show only the header.

The season header above the grid shows the season name (or the bare date range if unnamed) with prev, next, and today controls.

## Navigation

Prev and next step through `Season[]` in document order. Disabled at the boundaries (no wrap, no jump). Today navigates to the season containing today's date, else the most recent past season, else an empty state pointing at `Seasons.md`.

## Out of scope

No in-view editing of `Seasons.md` (regular note editing). No FullCalendar (`SeasonView` is plain React). No new vault APIs.
