# Google Calendar ⇄ spacetime: multi-day events

## Problem

`endDate` is dropped at every layer of the Google bridge, both directions.
The internal model already supports it (`SpacetimeEvent.endDate`, mw/yml
round-trip, calendar rendering); only the gcal push/import path loses it.

## Representation

| shape | spacetime | Google |
| --- | --- | --- |
| all-day, 1 day | `{date, allDay}` | `start.date`, `end.date = date+1` |
| all-day, multi-day | `{date, endDate, allDay}` (endDate inclusive) | `start.date`, `end.date = endDate+1` (exclusive) |
| timed, same day | `{date, time, endTime}` | `start/end.dateTime` same date |
| timed, multi-day | `{date, time, endDate, endTime}` | `start.dateTime` on date, `end.dateTime` on endDate |

The one subtlety: Google's all-day `end.date` is **exclusive** (day after the
last day). spacetime `endDate` is **inclusive**. So push adds a day, import
subtracts a day.

## Push (spacetime → Google)

Thread `endDate` through the existing layers; no new layers.

1. `gcal-push.ts buildPushIntents` — carry `ev.endDate` onto the intent.
2. `PushIntent` (gcal-push.ts) + `PushEventInput` (gcal-accounts.ts) — add `endDate?: string`.
3. Rust `PushEventInput` — add `end_date: Option<String>`.
4. Rust `gcal_push_event` — build `end` from `end_date` when present:
   - all-day: `end = AllDay { date: next_day(end_date.unwrap_or(date)) }`
   - timed:   `end = Timed { date_time: local_rfc3339(end_date.unwrap_or(date), et) }`

   (start unchanged; the natural-key lookup already keys on start date/time.)

## Import (Google → spacetime)

1. Rust `ImportedEvent` — add `end_date: Option<String>`.
2. Rust `parse_day_events`:
   - all-day: read `end.date`; set `end_date = prev_day(end.date)` only when it
     is a real span (`prev_day(end.date) > start date`), else omit (single day).
   - timed: read `end.dateTime`'s date; set `end_date` only when it differs from
     the start date, else omit.
3. `gcal-import.ts ImportedEvent` — add `endDate?: string`. Identity key stays
   `date|time|title` (start-based; a span doesn't change start identity).
4. Import apply (CardGrid `applyImport`) — carry `endDate` onto both the backing
   note frontmatter and the `mwAddEvent` call.

## New Rust helper

`prev_day(date)` — mirror of the existing `next_day`, for the exclusive →
inclusive all-day conversion.

## Out of scope

No change to event identity/matching, recurrence, or timezones. Single-day
behavior is byte-for-byte unchanged (endDate simply absent).

## Tests (light)

- Rust: `gcal_push_event` payload for an all-day span and a timed span; round-trip
  a multi-day all-day event through `parse_day_events` (exclusive→inclusive).
- TS: `buildPushIntents` carries `endDate`.
