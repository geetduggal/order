# Changelog

All notable changes to Order are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Masonry list layout.** A third list mode (`list: masonry`) beside cards and
  lines: items render as variable-height boxes flowed into CSS columns, sized by
  their content — for text-forward lists. Selectable from the inspector `list`
  dropdown / the list cycle.
- **Cell drag (spreadsheet).** An opt-in "Cell drag" toggle in the sheet dock:
  press-and-drag a cell or selection to move it; cells it lands on are displaced
  back into the vacated slots (a swap) rather than overwritten.
- **Offline drawings.** Excalidraw fonts now ship with the app instead of its
  CDN, so drawings render without a network connection.

### Fixed

- **iOS images.** Attachment images/videos (served via the `vaultasset://`
  scheme) now load in the card on iOS — WKWebView needed the asset response to
  be CORS-permitted for a cross-scheme `<img>`; desktop WebViews didn't.
- Sheet and drawing card views are editable again (minimal): type values inline
  in a sheet, move/edit shapes in a drawing — the full toolset stays in
  fullscreen.

### Added

- **Sheet & Drawing views.** A note card can now flip between its markdown
  editor and two others via icons next to the terminal icon: a spreadsheet
  (react-spreadsheet, stored as `<Name>.sheet.html`) and a drawing (Excalidraw,
  stored as `<Name>.excalidraw`). The active view persists in the note's `view:`
  frontmatter; sidecar files are created on first flip and stay attached to the
  note (never their own card). The card is a minimal, centered preview; the full
  editor opens in fullscreen. The spreadsheet does real spreadsheet-style text
  overflow (text always foreground, stops at the first cell with content),
  supports formulas, theme-adaptive cell fills + a custom color picker, and
  right-click row/column insert & delete. See `docs/SHEET-DRAWING.md`.
- **Card "⋯" menu.** Secondary card actions (home, copy, terminal, to-pile,
  refolder, fold, delete, …) collapse behind a "⋯" more-actions menu, keeping
  the control row uncrowded.
- **Auto theme.** A new default "Auto" theme follows the operating system's
  light/dark setting and reacts live when the OS flips — in both the desktop/iOS
  app and the published page (the published site now follows each visitor's OS
  instead of always landing in light). Any explicit theme is still an override,
  and Auto sits first in the rail toggle / ⌘T cycle.

### Fixed

- Connecting a Google account no longer fails with "the specified item already
  exists in the keychain" when a stale duplicate token lingers from a previous
  build: the store now loop-deletes reachable items and retries.

## [0.1.1] - 2026-06-25

The headline of this release is **Google Calendar curated sync** — push and import
individual events between `spacetime.mw` and Google Calendar, keeping the
plain-text, no-hidden-IDs conventions intact — plus a readable **`#[Exact Name]`
folder-tag syntax** for spacetime event lines.

### Added

- **Google Calendar curated per-event sync.** Sync specific events between Order
  and Google Calendar, with invites, from a plain-text source of truth. See
  [`docs/GCAL-SYNC.md`](docs/GCAL-SYNC.md).
  - **Email-recipient model.** A `spacetime.mw` event line can carry trailing
    bare emails (e.g. `… : Standup #[Acme] you@example.com dana@example.com`).
    An email matching a connected account is the host calendar; the rest are
    invitees. An event syncs only if it carries at least one email. Identity is
    the natural key `(date, time, title)` — no stored Google event IDs.
  - **Account management** in Settings → Google Calendar: connect, list, set
    default, and disconnect Google accounts using your own Google Cloud OAuth
    client, with an in-app "how to get these credentials" helper. Refresh tokens
    are stored only in the OS Keychain.
  - **Push (Order → Google).** Google-syncable events that are new or edited this
    session surface in the bottom-left "spacetime · N pending" reconciliation
    indicator; its review dialog's "Sync to Google" section creates/updates them
    on the host calendar (matched by natural key) and sends invitations.
  - **Import (Google → Order).** A per-day download icon in the Day/Week calendar
    headers opens a review modal of that day's Google events (new pre-checked,
    already-present unchecked); accepted events become spacetime events in a
    chosen folder, carrying the source account, any guests, and the event
    description.
  - **iOS support.** Connect a Google account on iPhone via a custom-scheme
    deep-link OAuth flow (Settings has an iOS-only "Google iOS Client ID" field);
    push and import then work from the phone.
  - **Recipients from the calendar.** The event action menu gained a Recipients
    section to add/remove an event's emails (with autocomplete from emails
    already in `spacetime.mw`), writing them straight back to the source file.
  - **Multi-day events** round-trip through the Google bridge in both directions
    (spacetime's inclusive `endDate` ↔ Google's exclusive all-day end), for both
    all-day spans and timed spans that end on a later day.
- **`#[Exact Name]` brace folder-tag syntax** for `spacetime.mw` event lines
  (e.g. `#[Geet Duggal]`). Exact, legible, multi-word-safe. The parser still
  accepts legacy `#kebab` tags; existing files migrate automatically.

### Changed

- `spacetime.mw` event lines now serialize folder tags in the canonical
  `#[Exact Name]` form (case and spacing preserved); legacy `#kebab` tags are
  still parsed for back-compat.
- Sync results are shown via an inline toast instead of native OS dialogs.
- The macOS bundle is signed with a stable Apple Development identity, so the
  Keychain keeps releasing saved Google tokens across rebuilds.
- Settings' Google Calendar section adapts to platform: the desktop OAuth
  client fields are hidden on iOS (which uses the iOS Client ID instead), and the
  Settings panel scrolls and respects iOS safe areas.

### Fixed

- Reconnecting a Google account self-heals a stale Keychain entry after an app
  rebuild/re-sign, and a failed token read now says "reconnect in Settings"
  instead of a cryptic platform error.
- The Settings panel no longer runs off-screen on iPhone.
- Google import isolates per-note failures (one bad note no longer aborts the
  whole import) and guards an empty selection.
- Google OAuth/sync robustness: request the `openid email` scope so the account
  email resolves; distinguish DST gap vs. overlap when formatting event times;
  skip calendar list items lacking a start field; harden the desktop loopback
  redirect; clear the in-flight auth slot on every exit path.
- `cetl` iPhone detection matches the `available (paired)` device state (and no
  longer mis-matches `unavailable`).

## [0.1.0] - 2026-06-23

- Initial release: local-first notebook over an Obsidian-compatible vault —
  in-place markdown cards, the Area → Category → Notable Folder hierarchy,
  Day/Week/Month/Year/Season calendar views over the same notes, todo.txt sync,
  Seasons, File Piles, and `spacetime` (`spacetime.yml` + `spacetime.mw`) as the
  canonical map of space and time. One Tauri codebase ships desktop and iOS.

[Unreleased]: https://github.com/geetduggal/order/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/geetduggal/order/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/geetduggal/order/releases/tag/v0.1.0
