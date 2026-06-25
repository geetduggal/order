# Google Calendar Per-Event Curated Sync — Design

**Status:** Approved in brainstorming; pending written-spec review.

**Goal:** Sync individual, hand-picked events between Order's spacetime and Google Calendar — in both directions — through the existing spacetime reconciliation (review-before-apply) flow. The killer idea is **curation**: you are *not* mirroring whole calendars, you are choosing specific events to push out (with invites) and specific events to pull in, to shape your own plan.

**Guiding principle:** stay plain-text and readable. An event's identity is **what's written** (its date + time + title), not a hidden UUID. No id columns, no sidecar state files. The cost of that choice is accepted explicitly (see Identity).

---

## Scope

**In v1:**
- Connect one or more Google accounts in Settings (OAuth), pick a default.
- **Push:** a curated spacetime event carrying email(s) is created/updated/deleted on a Google calendar through reconciliation, with invitees.
- **Import:** a per-day GUI action pulls a chosen account's events for that day into spacetime, into a folder you choose.
- Cross-platform (macOS + iOS).

**Deferred (explicitly out of v1):**
- Named contacts / reusable groups (`@team` shorthand). v1 uses literal emails.
- Recurring-event modeling — v1 imports recurrence *instances* flatly; no series editing.
- Multiple calendars per account — v1 uses each account's **primary** calendar.
- Attendee import — v1 import brings the event onto your calendar but does not import its remote attendee list.
- True in-place edit propagation — edits are a human-confirmed remove+add (see Identity).
- `ASWebAuthenticationSession` polished iOS sheet — v1 uses the system browser; this is a later UX upgrade.

---

## Concepts

**Connected account** — a Google account you've authenticated in Settings (OAuth). Its tokens live in the OS Keychain, never in the vault. One connected account is the **default**. The `.mw` file never declares which emails are yours; Order knows from Settings at sync time.

**Email recipient** — a bare email address written on an event line. It is the marker (the `@` is intrinsic to the email). Emails never appear in the `# Space` hierarchy — Spaces stay human-named folders only.

**Host vs invite rule** — for an event line carrying one or more emails:
- An email that **matches a connected account** → that account's calendar is the **host** (where the event lives); it is *not* invited (it's you).
- An email that **matches no connected account** → an **invitee**.
- If **no** email matches a connected account → host = your **default** account, and every email is an invitee.

**Google-synced event** — any spacetime event whose line carries ≥1 email. Events with no email are ordinary Order events, never touched by this feature.

**Natural-key identity** — an event is identified by `(date, time, title)` — the same key Order already uses for dedup. No Google event id is stored anywhere.

**Description** — a Google event's description maps to the spacetime event's **backing note body**. Push sends the note body as the event description; import writes the fetched description into the new note's body. This is what "update the description if it changed" refers to in both directions.

---

## Syntax & parser changes

An event line gains optional trailing email tokens, after the folder tag:

```
2026-06-25 09:00-09:15 : Standup #[Acme] you@example.com
2026-06-25 11:00-11:30 : Dana 1:1 #[Acme] dana@example.com
2026-06-25 14:00-14:30 : Planning #[Acme] you@example.com dana@example.com sam@example.com
```

Parser rule (`parseMarkwhenFormat`, events section): after extracting the existing trailing folder tag, **peel any trailing whitespace-separated email-shaped tokens** (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`) as the event's `emails: string[]`. What remains is the title. Emails come **after** the folder tag so the tag delimits title from recipients and the parser never confuses a title word with a recipient.

`SpacetimeEvent` gains `emails?: string[]`. `serializeMarkwhen`/`spliceMwEvents` append the emails (space-separated) after the tag when present. Round-trip is exact.

(Folder tags themselves are unchanged by this feature — bare `#tag` today, `#[Bracket]` if/when that separate enhancement lands. Either works.)

---

## Push — Order → Google

Driven entirely through reconciliation (the existing review-before-apply surface). When the user opens the spacetime review (or a dedicated "Sync to Google" action), Order computes, for each **Google-synced** event in scope:

- Resolve host account (host/invite rule) and attendee emails.
- Search the host calendar (`events.list` over a window around the event) for a Google event matching the natural key `(date, time, title)`:
  - **none found** → propose **Create** (event with attendees + note-body description).
  - **found** → since date/time/title already match, compare **attendees** (the line's emails) and **description** (the note body); if either differs → propose **Update** (`events.patch`).
  - the user removed the emails / the event → propose nothing (it simply stops being synced; we do not chase orphans on Google in v1).

Each proposal is a checkbox row grouped Create / Update, with a one-line summary ("Create on you@example.com · invite dana@…, bob@…"). Nothing is sent without confirm. On apply, Order calls the Calendar API (`events.insert` / `events.patch`) on the host calendar.

**Edit = swap (accepted limitation):** because identity is the natural key, editing an event's time or title in spacetime breaks the link — Order can no longer match it to the previously-created Google event. The review surfaces this as a **Create** of the new version; the stale Google event is the user's to delete (the dialog can hint "a previous version may remain on Google"). Re-pushing an **unchanged** event is always a no-op (the key matches). This keeps the model plain-text with no stored handle, at the cost that edits aren't magic in-place updates.

---

## Import — Google → Order

A per-day, GUI-first, curated pull.

**Entry point:** an **import icon on each day** in the Day and Week views.

**Flow:**
1. Click the day's import icon → choose which **connected account** to pull from.
2. Order fetches that account's **primary calendar** events for that day (timezone-converted to local), via `events.list` (timeMin/timeMax bounding the day).
3. A **review dialog** lists the day's events. Each row is a checkbox:
   - pre-**checked** if it has no `(date, time, title)` match in spacetime (new),
   - pre-**unchecked** if it already matches (you already have it).
4. The user picks a **target folder** (default: the home NF; any NF selectable) and checks which events to accept.
5. **Apply** writes the accepted events as spacetime events in the target folder — each carrying the **source account's email** so it's recognized as that calendar's event (host, no invite) and round-trips cleanly. The Google event's **description becomes the backing note's body**. Recurrence instances are written as flat standalone events.

**Re-import** is just the same flow again: already-present events come pre-unchecked (natural-key match); a remotely **edited** event appears as a new row (you reconcile by eye); a remotely **deleted** event is **not** flagged — it stays in spacetime until you remove it. These are the deliberate costs of the no-id model and are acceptable because every import is human-reviewed.

---

## OAuth & authentication (cross-platform)

**Flow:** OAuth 2.0 Authorization Code + **PKCE** (no client secret embedded). Scope: `https://www.googleapis.com/auth/calendar.events` (create/update/delete events + attendees; narrower than full calendar). Access tokens refreshed via the stored refresh token.

**Redirect capture — the only platform-specific part:**
- **Desktop (macOS):** loopback redirect — a throwaway local listener on `http://127.0.0.1:<port>` catches the code. Pure Rust (`ureq` for the token exchange, std net for the listener).
- **iOS:** custom URL scheme (`com.geetduggal.order://oauth`) via **`tauri-plugin-deep-link`**, opening the **system browser** for consent (Google forbids embedded webviews; the system browser is compliant). **No bespoke Swift in v1.** `ASWebAuthenticationSession` (a polished in-app secure sheet, Swift-only) is a later UX upgrade with identical token logic underneath.

**Token storage:** refresh tokens (long-lived secrets) in the **OS Keychain** (`keyring` crate or equivalent), never in the vault. Keyed by account email. Multi-account = one token per email.

**Google Cloud setup (developer, once):** project + Calendar API enabled + OAuth consent screen (testing mode with your own accounts as test users — no Google verification needed for personal use) + OAuth client IDs (Desktop type for loopback; iOS type for the scheme).

**Portability note:** the `.mw` is portable but auth is per-device. Opening a file on a device where `you@example.com` isn't connected makes that email read as an invitee (you'd invite yourself). Accepted for v1.

---

## Settings UI

A new **Google Accounts** section in `SettingsPanel`:
- "Connect Google account" → runs the OAuth flow → adds the account (email) to a connected list.
- List shows connected accounts; one is the **default** (radio/star); disconnect removes the account + its Keychain token.
- Connected accounts drive the host/invite classification and the import account picker.

---

## Components & boundaries (high-level; the plan will decompose)

- `src/lib/spacetime.ts` — parser/serializer: `emails?: string[]` on `SpacetimeEvent`; peel/emit trailing emails.
- `src-tauri/src/gcal.rs` (new) — OAuth (PKCE, refresh), Keychain storage, and Calendar API calls (`events.list/insert/patch/delete`) via `ureq`. One module, clear interface (`connect_account`, `list_events(account, day)`, `push_event(...)`).
- iOS deep-link wiring — `tauri-plugin-deep-link` + Info.plist scheme.
- `src/lib/gcal.ts` (new) — TS bridge: account state, host/invite resolution, push diff, import diff (natural-key).
- `SettingsPanel.tsx` — Google Accounts section.
- Reconciliation surface — push proposals (Create/Update) folded into the existing review.
- `CalendarView.tsx` / `CardGrid.tsx` — per-day import icon + the import review dialog.

---

## Error handling

- **Token expired / revoked:** refresh; on failure, mark the account disconnected and surface a "reconnect" prompt in Settings; never silently drop events.
- **Network/API errors on apply:** per-row failure reported in the review result; partial success is fine (each event is independent). No partial-write corruption of the `.mw` — spacetime writes only reflect what the user accepted locally; Google calls are separate and idempotent enough (natural-key) to retry.
- **Ambiguous host (multiple connected-account emails on one line):** use the first; flag in the proposal summary.
- **No default account set but an event needs one:** block with a clear "set a default account" message.

---

## Testing

- **Pure logic (unit, `tsx` script style):**
  - parser: peel trailing emails, title separation, round-trip serialize (incl. multiple emails, none, email-looking title words).
  - host/invite resolution given a connected-accounts set (host = connected; others = invitees; none-connected → default + all invited).
  - push diff and import diff by natural key (new/already-have/changed-as-new).
- **Rust (gcal.rs):** token refresh and request building unit-tested with a mock agent; live calls validated manually against a test Google account.
- **Manual:** connect account; push a curated event (verify on Google, invite received); re-push unchanged (no dup); import a day into a folder; re-import (pre-unchecked); desktop + iOS auth round-trip.

---

## Open risks
- iOS deep-link round-trip is the highest-uncertainty piece; isolated in the auth module so it can't destabilize the rest. Desktop path de-risks the token/API logic first.
- Google OAuth consent-screen friction for sensitive scopes (mitigated by testing-mode + test users for personal use).
- Natural-key edits leaving stale Google events — accepted, surfaced in review, documented for the user.
