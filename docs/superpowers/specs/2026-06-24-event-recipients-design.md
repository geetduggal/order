# Event Recipients — associate emails with a calendar event (design)

## Goal

Let the user add/edit an event's Google-sync **recipient emails directly from the
Calendar view's event menu**, with autocomplete from emails already used in
`spacetime.mw` — and write them back to `spacetime.mw`. This "closes the loop":
the whole Google-sync workflow (curate recipients → push with invites) becomes
doable from the calendar, with no hand-editing of the `.mw` file.

## Background / what already exists

- A spacetime event line can carry trailing recipient emails (Plan 1): bare
  emails after the folder tag. `SpacetimeEvent.emails?: string[]` is parsed and
  serialized by `src/lib/spacetime.ts`.
- `mwUpdateEvent(mw, date, title, patch)` merges a `Partial<SpacetimeEvent>` and
  re-serializes — it **already** round-trips an `emails` patch (setting
  `{ emails: [...] }` writes them; `{ emails: [] }` clears them). **No
  `spacetime.ts` change is required.**
- The calendar event menu is `EventActionMenu` (rename, folder picker,
  move-to-day, open, delete), opened from a chip click in every view. CardGrid
  holds an `eventMenu` state and an `eventChipRef` map (`path → { ev, notePath }`)
  with the authoritative `SpacetimeEvent` (including `emails`).
- Folder assignment already follows the pattern this feature mirrors:
  `onAssignFolder(name)` → `applyMwEdit(mw => mwUpdateEvent(mw, date, title, { folder }))`.
- Once an event's emails change, the existing push pending-tracking (attendee
  signature) re-flags it in the bottom-left "spacetime · N pending" indicator;
  Sync pushes it to Google with invites. **That half is done — this feature only
  adds the editing UI + the mw write.**

## Scope (this spec)

In: a **Recipients** section in `EventActionMenu` to view/add/remove an event's
emails, with datalist autocomplete sourced from existing `spacetime.mw` emails,
writing changes to `spacetime.mw`. Shown in **every** view's event menu
(day, week, month, year) — unconditionally, unlike the view-gated move-to-day
chips.

Out: any change to push/import, time/Google-event-update logic, email→folder
inference, or contact lookup beyond the in-`.mw` emails. Emails remain purely
recipients (an email matching a connected account = host; others = invitees, per
Plan 1).

## Components & data flow

### 1. `distinctEmails(events)` — pure helper (new, unit-tested)
Added to `src/lib/gcal-recipients.ts` (the existing email/recipient module):
`export function distinctEmails(events: SpacetimeEvent[]): string[]` — every
email across all events, de-duplicated case-insensitively (lowercased), sorted,
for the autocomplete list. Pure; unit-tested in `src/lib/gcal-recipients.test.ts`.

### 2. `EventActionMenu` — add a Recipients section
- New props: `emails: string[]` (the event's current recipients),
  `knownEmails: string[]` (autocomplete suggestions), and
  `onSetEmails(emails: string[]): void`.
- UI: current emails as **removable chips** (✕ removes one); an **add input**
  bound to a `<datalist>` of `knownEmails`; Enter or a "+" button commits a
  typed/selected address. Light validation: the value must match a basic email
  shape (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`, lowercased) before it's added; invalid
  input is ignored (no crash). Each add/remove calls `onSetEmails` with the new
  full list.
- The section renders unconditionally (all views).

### 3. CardGrid wiring
- `eventMenu` state gains `emails: string[]`, populated when the menu opens from
  `eventChipRef.current.get(path)?.ev.emails ?? []`.
- Compute `knownEmails = distinctEmails(mwEvents)` (memoized) and pass to the menu.
- `onSetEmails(emails)` → `applyMwEdit(mw => mwUpdateEvent(mw, date, title, { emails }))`
  using the event's `date`/`title` from `eventChipRef` (same source the folder/
  rename handlers use), then let the existing refresh repaint. Keep the menu open
  after an email edit (so the user can add several), unlike folder-assign which
  closes — OR close on each edit; **decision: keep open** so multiple recipients
  can be added in one pass.

## Error handling
- Invalid email input: silently ignored (not added); no error modal.
- `mwUpdateEvent` no-ops if the (date,title) key isn't found (event deleted
  meanwhile) — harmless.
- Empty list (`onSetEmails([])`) clears all recipients from the line; the event
  then drops out of the Google-sync pending set, as expected.

## Testing
- Unit (tsx): `distinctEmails` — de-dups case-insensitively, sorts, handles
  events with no emails.
- Build/type gates: `tsc --noEmit`, `pnpm build`.
- Manual click-through: open an event's menu in each view → add an email (with
  autocomplete) → it persists to `spacetime.mw`, the chip/menu reflects it, and
  the bottom-left pending indicator picks it up for Sync; remove an email →
  line updates; clear all → recipients gone.

## Why this is the right shape
- One editing surface (`EventActionMenu`) already owns per-event actions; adding
  recipients there keeps the gesture consistent and avoids a redundant modal.
- The pure `distinctEmails` helper is the only logic worth isolating/testing; the
  rest is wiring that reuses `mwUpdateEvent` + `applyMwEdit`.
- No source-of-truth change: emails live on the `.mw` line, exactly where push
  already reads them — the loop closes with zero new state.
