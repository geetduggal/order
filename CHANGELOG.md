# Changelog

All notable changes to Order are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-07-27

The **Weekly Hub** turns the Week view into a two-zone "one stop shop" — your
pinned folder's live document stacked above the week grid. Around it this release
adds a weekend app-icon badge, prominent "high bits" and next-event auto-scroll
in the calendar, Apple/system-calendar import, Johnny-Decimal auto-numbering,
full-text search from the palette, raw-source note editing, and much more.

### Added

- **Weekly Hub, front and center.** See below — a Notable Folder's Main Document
  now lives above the week grid as an editable, independently-scrolling zone.
- **"High bits" for the day.** All-day events in the Weekly Hub folder render as a
  prominent, contrasting card in the Day / Week all-day band (larger, bolder
  title) so the day's headline events read first.
- **Auto-scroll to the next event.** Opening Day / Week lands you just above the
  next upcoming event instead of a fixed now-centered position (desktop + iOS).
- **Full-text search from the command palette.** A subtle button on the `Cmd+K`
  input bar opens search across note *contents* — snippets, keyboard nav, jump to
  the note.
- **Edit source.** The `⋯` menu flips any markdown note — including list folders
  and your home folder — to a raw-markdown editor over the on-disk file, and back.
- **Paste an image into a masonry card,** and calendar imports (Google or the
  system calendar) now default to the **Weekly Hub folder**, with a per-event
  notable-folder override in the review.
- **Dated HTML notes render as cards.** A dated `.html` file (e.g. `2026-07-28
  Report.html`) dropped into a folder shows up in its pile as a card that renders
  the page itself in a sandboxed frame — filling the card, and expanding to the
  whole screen in fullscreen, so you see at a glance what it contains.
- **Masonry lists fill the width.** A balanced JS layout now packs each card into
  the shortest column, so cards stagger *and* use the full horizontal space
  (reflowing as the Week-hub zone or window resizes) instead of piling into a few
  columns with a blank gutter — and a tall image is never split across columns.
- **List / masonry card text scales with the app Zoom** (`Cmd +/−` / the rail
  buttons), matching the rest of the note text.
- **Drag list items ↔ the Week calendar** (move, not copy). Drag a card (masonry
  / lines / cards) onto a week time slot → a 30-min event there, removed from the
  list; drag a timed event onto the list → removed from the calendar, added as a
  card. A target-slot ghost and a list-zone highlight show where the drop lands.
- **Imported events keep their location/room.** Apple- and Google-calendar
  imports capture the event location into YAML and show it as a subtle chip in
  the card, beside the URL link.
- **HTML report cards zoom with the app text scale** (injected at serve time, so
  even a cross-origin report grows/shrinks with `Cmd +/−`), and fill the card /
  fullscreen edge-to-edge.
- **Rapid add in masonry:** pressing Enter in a card's Add box creates it and
  keeps the box open + focused for the next one.

### Added

- **Saturday app-icon badge (iOS / macOS).** Opt-in (Settings → "Saturday
  badge"): the Order icon shows how many events fall on the upcoming (or
  current) Saturday in the **Week Hub folder** — a glance at your weekend load.
  Computed from spacetime (no parallel store), updated while the app runs (on
  event/hub changes plus a foreground + 5-min tick for the Saturday rollover),
  and written natively via `UNUserNotificationCenter`.
- **New events default to the Week Hub folder** (then the home folder) instead
  of always the home folder — the pinned weekly folder becomes the natural home
  for quick calendar entries.

- **Edit a drawing in the card, without fullscreen.** A small frosted toggle in
  the corner of a `view: drawing` card flips its Excalidraw preview to an
  editable canvas (toolbars + interaction) in place, and back — a lightweight
  alternative to the fullscreen detour for quick edits.

- **`Cmd+Shift+H` hides the dock.** Toggles the bottom control dock for a
  distraction-free surface; the choice persists across reloads.

- **Multi-cell copy / cut / paste in the spreadsheet.** Select a range and
  `Cmd/Ctrl+C`, `X`, or `V` — copy and cut serialize the whole selection to TSV
  (so it round-trips with Excel / Numbers / Sheets and within Order, formulas
  included); paste drops a copied block at the selection's top-left (growing the
  sheet as needed), and a single copied value fills a selected range. Order takes
  the clipboard events itself (capture-phase, only when the sheet is focused and
  not mid-edit) so it's reliable and preserves the cell model, rather than
  relying on react-spreadsheet's focus-gated built-in.

- **Weekly hub in the Week view.** A configured Notable Folder's Main Document
  now sits above the week grid as a two-zone "one stop shop": the top zone is the
  real, editable Milkdown card (saving to the folder's doc exactly like anywhere
  else — no parallel store), the bottom zone is the existing week grid, unchanged.
  Each zone scrolls independently; a draggable divider (touch-friendly) resizes
  the split and the ratio persists across reloads (≈⅓ doc on desktop, ¼ on phone,
  and the grid can never be fully hidden). Pick the folder in Settings → Weekly
  hub; with none set, a compact prompt sits above a full-height grid. Fixed-folder
  mode ships now, with a clean seam (`lib/week-hub.ts`) for a future per-week
  resolver.

- **Johnny-Decimal Mode auto-numbers new folders.** Creating a folder while JD
  Mode is on gives it the next free id in its category (`52 Creative Projects` →
  `52.15 …`); its Main-Doc H1 stays the clean name so lists/links render pretty
  while the sidebar shows the id. Settings → JD Mode also gained an **Assign
  missing IDs** button that numbers any folder currently lacking an id (next free
  NN in its category) without renumbering the ones that already have one.
- **Create a folder from the command palette.** In `Cmd+K`, typing a name that
  doesn't match an existing folder now offers "Create folder …"; pick an
  Area → Category (prefilled, with autocomplete) and it's created and focused —
  no drilling into the sidebar first.
- **Edit a calendar event's time from its menu.** Clicking an event now shows a
  start/end time pair and an all-day toggle alongside the title and move-to-day
  chips. Changes write through spacetime (the source of truth) and sync the
  backing note's frontmatter / todo.txt line.
- **Moving/renumbering a folder in spacetime relocates its directory.** When you
  move a Notable Folder to a different Area/Category in `spacetime.md` — with or
  without renumbering it (e.g. `41 People › 41.01 Readwise` → `43 Spaces ›
  43.01 Readwise`) — the "spacetime changed" review now shows a **Move** item and
  **Apply** physically moves/renames the directory, renames its Main Document,
  syncs its title, and rewrites inbound wikilinks. Previously such a move left
  the old directory orphaned while an empty stub was created at the new id.
  Folders are paired by their Johnny-Decimal-stripped name; an unambiguous match
  moves automatically, and those already-moved folders no longer also nag as
  orphans. If the destination already holds an **empty stub** (from an older
  add-instead-of-move apply), it's replaced by the real content rather than
  blocking the move. And the folder-materialize step no longer creates a stub for
  a folder whose content already lives under a differently-named/numbered on-disk
  folder — the exact bug that produced empty `43.*` placeholders beside orphaned
  `41.*` content.
- **Rename a folder to match spacetime (manual fallback).** For the residual case
  where a folder's human name *also* changed (so it can't be auto-paired), the
  reconcile dialog's "On disk but not in spacetime" rows gained an editable
  folder-name field (autocompleting the unplaced spacetime folders) plus a
  "Rename to match" action that does the same directory rename/move + link fix.
- **Drag files into a note.** Dragging files from Finder onto a note card imports
  them into that note's Notable Folder and inserts links — images as `![[img]]`,
  other files as `[name](name)`. (Tauri strips the browser drop event, so this
  uses the OS drag-drop path.)
- **Fullscreen image viewer for embedded images.** Click an image in a note to
  open the zoom viewer, which now also has a **Copy** button.
- **Open attached files in the system viewer.** Clicking a note's link to a local
  file (a dropped PDF, etc.) opens it in the OS default app.
- **Wikilinks labeled by header.** In the Milkdown editor, a `[[Note]]` wikilink
  displays the target note's first major header (`# Title`) instead of the raw
  filename, and reveals the editable source when the caret enters it. (Explicit
  `[[Name|Alias]]` and the sidebar folder names are unchanged.)

### Added

- **Edit spacetime.md from the sidebar.** An "Edit spacetime.md" toggle in the
  sidebar opens the same raw-text editor the pile view uses, expanded to fill the
  sidebar for a clean, roomy edit. Saving goes through the usual path — structural
  changes light the "spacetime · pending" review just like a pile hand-edit.

- **Apple / system calendar (EventKit).** Pick which macOS/iOS system calendars
  to include (Settings → Apple Calendar), import a day's events into spacetime
  via the per-day import button (same review modal as Google), and create events
  on a calendar by tagging a spacetime line with `@[Calendar Name]`. Native — a
  single permission grant, no accounts or OAuth. Identity is the natural key; no
  EventKit IDs stored. Invitations route through Google, since Apple's EventKit
  attendees are read-only. See `docs/APPLE-CAL.md`.

### Changed

- **Calendar view shortcuts now require Shift** — `Cmd+Shift+D/W/M/Y/S` for
  Day / Week / Month / Year / Season. Plain `Cmd+W` (and `Cmd+Shift+[` / `]`)
  are left to the browser/OS as tab-management keys instead of being captured
  as view switches.
- Card toolbar: the close / "remove from view" button is now a visible inline
  toolbar button (previously only in the "⋯" menu), and the spreadsheet /
  drawing flip buttons moved into the "⋯" menu, so the inline row stays to
  fullscreen, close, and "⋯".

### Changed

- **Tighter, more immersive Day / Week / Month margins.** Trimmed the calendar
  shell padding (especially the big vertical gaps) and the top chrome so the grid
  reads closer to edge-to-edge.
- **Subtler current-day marker.** The today column is no longer a loud wash — the
  date text itself goes coral + bold; calendar grid lines are softened; event
  cards get a hover lift; and note links carry a faint always-on underline.

### Fixed

- **Deep links no longer hijack the app (iOS).** An external link — including the
  "Watch on YouTube" / playlist links inside an embedded player — opens in the OS
  app instead of loading over Order's own WebView and replacing your note. A
  navigation guard hands any external `http(s)` navigation to the system.
- **Copying part of a list item no longer grabs the bullet.** Selecting a few
  words inside a bullet (or heading / quote) and copying now yields exactly the
  highlighted text, not `- …`; whole-item selections keep their markdown.
- **Smoother Milkdown typing.** Each keystroke no longer re-renders the whole
  card (a write-only state update was forcing it); the editor stays responsive
  in long / control-heavy notes.
- **`.sheet.html` renders as a spreadsheet,** not the raw HTML sidecar (sheet
  sidecars are excluded from the HTML card surface).
- **Terminal / frontmatter panels stay inside the card.** Their full-bleed
  rectangle no longer pokes past the card's rounded border.
- **Week view no longer scrolls the whole page.** The Week hub fills the viewport
  and the document scroll is locked while it's open, so only the two zones (the
  doc and the week grid) scroll — no stray page scrollbar stacked on top of them
  (especially awkward on phone). Every other view keeps its normal page scroll.
- **Invisible input fields in dark themes.** Reconcile-dialog, palette
  create-folder, and event-time inputs used an undefined `--paper` var that fell
  back to white, so their text (`--ink`, light on dark themes) vanished. `--paper`
  is now defined once as a theme-adaptive tint of the ink color, readable on
  every theme.
- **Section titles cut off in the monospace themes.** In WordPerfect / Terminal /
  Typewriter (where `--sans` is monospace and wider), a short list heading like
  "Articles" was squeezed to an ellipsis by the same-row description. Section
  headings now reserve their natural width and let the description truncate
  instead.
- **Navigating away from a fullscreen note exits fullscreen.** Following a
  wikilink, opening the folder palette, or jumping to another note while a card
  is fullscreen now collapses it so you land on the destination instead of
  staying stuck on the old note. (View switches already exited via unmount.)
- **Calendar event titles follow the note's first `# ` header** instead of a
  possibly-stale frontmatter `title:`, matching the card / list / wikilink
  renders. Notes without an H1 keep the frontmatter/filename fallback. (This
  regenerates event titles in `spacetime.mw`/`.yml` once, with no file renames.)
- Copying from a note now mirrors the on-disk markdown: inflated `vaultasset://`
  image/video URLs are deflated back to `![[file]]` / `![](Attachments/…)` on
  copy, instead of pasting the runtime asset URL.
- Apple/system calendar on macOS: added the Hardened Runtime calendar entitlement
  (`com.apple.security.personal-information.calendars`) and merged the calendar
  usage `Info.plist`, which were missing from the signed bundle — the cause of the
  "XPC error communicating with calaccessd" and the permission prompt never
  appearing. Also falls back to the pre-macOS-14 access API and surfaces the real
  reason when a request is declined.
- Spreadsheet text now scales with the zoom buttons / ⌘± (it previously stayed
  a fixed size). react-spreadsheet sizes cells in `em`, so a scaled font-size on
  the grid grows the text and the cells together.
- Drawing card view now zooms-to-fit on first render, so a wide diagram shows in
  full inside the minimal card instead of being cropped to its centre (it already
  re-fit on the fullscreen toggle, just not on initial mount).
- The card's date / frontmatter chip no longer overlaps the first row of a
  spreadsheet in the minimal card view — the preview grid gets top clearance.

## [0.1.2] - 2026-07-19

This release turns a note card into a canvas: flip it to a **spreadsheet** or a
**drawing**, lay a list out as a **masonry** wall, and switch on **Johnny-Decimal
Mode** to put explicit ids on your whole hierarchy.

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
- **Masonry list layout.** A third list mode (`list: masonry`) beside cards and
  lines: items render as variable-height "cards on a card" flowed into CSS
  columns, sized by their content — for text-forward lists. Item text renders
  inline `[[wikilinks]]`, `[markdown links](url)`, and `![[images]]` as live
  links/images; cards reorder by dragging anywhere on them, and fullscreen opens
  an immersive centered gallery. Selecting `list:` in the frontmatter inspector
  switches the render live (splitting the body's bullets into items, or folding
  them back into the editor when set to "(none)").
- **Johnny-Decimal Mode.** A Settings toggle that prefixes every Area, Category,
  and Notable Folder with a Johnny.Decimal id — Areas as ranges (`10-19`),
  Categories as numbers (`11`), Notable Folders as `11.01` — rewriting
  `spacetime.md` and renaming the matching directories (inbound wikilinks and
  event tags are updated to match). Turning it off strips the ids back off.
- **Cell drag (spreadsheet).** An opt-in "Cell drag" toggle in the sheet dock:
  select a cell or range and drag the move grip on it to relocate the block; the
  cells it lands on are displaced back into the vacated slots (a swap) rather
  than overwritten.
- **Card "⋯" menu.** Secondary card actions (home, copy, terminal, to-pile,
  refolder, fold, delete, …) collapse behind a "⋯" more-actions menu, keeping
  the control row uncrowded.
- **Auto theme.** A new default "Auto" theme follows the operating system's
  light/dark setting and reacts live when the OS flips — in both the desktop/iOS
  app and the published page (the published site now follows each visitor's OS
  instead of always landing in light). Any explicit theme is still an override,
  and Auto sits first in the rail toggle / ⌘T cycle.

### Fixed

- **iOS images & video.** Attachment images and videos (served via the
  `vaultasset://` scheme) now load in the card on iOS — WKWebView won't reach the
  custom scheme from an `<img>`/`<video>`, so on iOS Order fetches the bytes over
  the IPC bridge and swaps in a `blob:` URL. Desktop is untouched.
- Sheet and drawing card views are editable again (minimal): type values inline
  in a sheet, move/edit shapes in a drawing — the full toolset stays in
  fullscreen.
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
