# Order

*Your notes, at home at last.*

A local-first notebook where **plain markdown files are the database**
and every surface — stream, calendar, seasons, todo.txt — is a
different read of the same files. Obsidian-compatible vault. One Tauri
codebase ships desktop and iOS.

![Order — a Notable Folder rendered as a newspaper section: the Main Document centered, recent notes orbiting it](img/stream.png)

## What you get

- **Edit in place** — WYSIWYG markdown cards (Milkdown Crepe). No modes, no preview pane.
- **A real hierarchy** — Areas → Categories → Notable Folders, capped Johnny-Decimal style at 10×10, stored as plain files.
- **A calendar that *is* your notes** — Day / Week / Month / Year / Season views over the same frontmatter Obsidian Full Calendar reads.
- **todo.txt, always in sync** — every calendar event mirrored as one readable line; hand-added lines show up on the calendar too.
- **Seasons** — name your own date ranges and see each one as a grid of what actually happened, by Area.
- **Publish from the same vault** — flip `public: true`, push, done. The site runs the same components read-only.

## Build & run

```bash
git clone https://github.com/geetduggal/order.git && cd order
pnpm install
pnpm tauri:dev        # desktop, hot reload
pnpm tauri:ios:dev    # iOS simulator (after tauri:ios:init)
pnpm test:e2e         # Playwright suite
```

Prereqs: Node 20+, pnpm 9+, Rust 1.77+; Xcode 15+ for iOS. First
launch reads `~/Documents/Dropbox/Home/` (change it in Settings).

**Using the prebuilt .app from a release?** macOS quarantines
non-notarized downloads and claims the app "is damaged." It isn't:

```bash
xattr -cr ~/Downloads/Order.app && open ~/Downloads/Order.app
```

## A vault at a glance

```
<vault>/
├── Areas.md                      lists the Areas        (role: areas)
├── Seasons.md                    your named date ranges (role: seasons)
├── todo.txt                      one-line calendar events
└── Craft/                        an Area
    ├── Craft.md                  lists its Categories
    └── Craft Projects/           a Category
        ├── Craft Projects.md     lists its Notable Folders
        └── Map Pipeline v2/      a Notable Folder
            ├── Map Pipeline v2.md       the Main Document
            ├── 2026-06-12 Standup.md    a note (also a calendar event)
            └── diagram.png              attachments live WITH their notes
```

Five frontmatter keys carry all structure:

| Key | Makes a note… |
|---|---|
| `role: areas` / `seasons` | one of the two vault-root index files |
| `list: cards` \| `lines` | render its bullets as a visual list |
| `category: <Category>` | a Notable Folder's Main Document |
| `folder: "[[NF]]"` | a member of that Notable Folder |
| `date` + `startTime` / `allDay` | a calendar event |

Everything opens unchanged in Obsidian: same wikilinks, same
`![[image.png]]` embeds, same files.

## The surfaces

**Stream.** A masonry of editable cards, newest first. Focus on a
Notable Folder and it becomes a *newspaper section* — Main Document as
the centerpiece, recent notes orbiting it. Navigation is a pile: the
folder you touch goes on top.

**Lists.** Give a note `list: cards` or `list: lines` and its body
bullets render as a visual list instead of prose — a reading list, a
tools index, a wishlist. Each item is a markdown bullet:

- `cards` is a drag-reorderable grid: an image cover when the item (or
  its linked note) has one, otherwise a large text-relevant icon so
  mixed image/non-image lists still read as one cohesive grid.
- `lines` is a dense table: aligned title and description columns,
  drag to reorder, click a cell to edit.

Add an item at the top or bottom. Typing is **plain text by default**;
type `[[` and a folder/note autocomplete opens — pick one and the item
becomes a wikilink that navigates on click. (Same `[[`-trigger you get
inside the editor.) Paste or drop an image to add it as a cover.

**Terminal.** Every Notable Folder's Main Document card has a terminal
button next to its folder-flip button. Click it (or press `⌘4` on the
focused folder) and the card front becomes a real terminal rooted in
that folder — a true PTY, so `vim`, `htop`, colors, and line editing all
work. It paints in the active Order theme and follows your text-size
zoom. `⌘4` again, the close button, or full-screen all toggle it back to
the note. Desktop only.

**Calendar.** Day / Week / Month / Year. Drag to create, drag to move,
click for an action popup (rename inline, move to a day, reassign the
folder, open, delete). Events are just notes with a `date:`.

![Week view — events colored by Notable Folder, Season next to Year in the view switcher](img/calendar-week.png)

**Seasons.** List your own date ranges in `Seasons.md`:

```
- 2026-02-15 - 2026-04-30 · Spring Builds
- 2026-05-01 -            · Frontier
```

The Season view clusters every notable update (all-day event) by Area
over the range — which projects went well, which Areas were quiet, at
a glance. Arrows step between seasons like they step between weeks.

**todo.txt.** Flip one toggle in Settings and Order keeps a single
text file in sync with every calendar event — one line each:

```
due:2026-06-13 07:30  Long run +weekly-hub end:09:30
due:2026-06-13 15:00  Ship Issue 22 +wide-margins end:17:00
due:2026-06-13        Ship to prod +map-pipeline-v2
```

`+project` fuzzy-matches a Notable Folder (kebab / camel / snake).
Events Order creates are markdown files (the durable truth — sync
conflicts can never lose them); lines you add by hand in any editor
render on the calendar too. Identity `(date, start, title)` binds the
two backings so each event renders exactly once.

**Publish.** Notes with `public: true` build into a static site +
hydrated SPA (`Cmd+P`). Permalinks pin to the note, not its path, so
reorganizing the vault never breaks a link.

## Keyboard

| Keys | Action |
|---|---|
| `⌘N` | new note (title popup in calendar views) |
| `⌘D / W / M / Y / S` | Day / Week / Month / Year / Season |
| `⌘⌃ ← / →` | back / forward by the view's unit |
| `⌘O` · `⌘K` | folder palette (folders + todo.txt) |
| `⌘F` · `/` | full-text search |
| `⌘R` | home ⇄ clear-filters toggle |
| `⌘4` | toggle the in-card terminal for the focused folder (`$` lives on the 4) |
| `⌘;` | sidebar · `⌘'` clear filters · `⌘T` theme · `⌘P` publish |
| `⌘+ / − / 0` | note text size |
| `?` | shortcut overlay |

The dock mirrors the essentials: **+** (new note in the home folder),
show-mode cycle, home ⇄ calendar toggle, search, settings, sidebar.

Nine themes (`⌘T`): light, dark, OLED black, WordPerfect, Terminal,
Typewriter, America, Christmas, LCARS — each ~15 lines of CSS variables.

## Going deeper

| Doc | What's in it |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the mental model: code map, data flows, invariants |
| [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) | why it's shaped this way — piles, constraints, one vault two lives |
| [docs/RELEASING.md](docs/RELEASING.md) | building binaries, refreshing releases, App Store |
| `tests/e2e/` | Playwright suite + reusable vault linter (`ORDER_VAULT=… pnpm test:e2e consistency`) |

## Principles, in one breath each

1. **Plain text forever** — the files outlive the tool.
2. **Portable conventions** — the vault opens cleanly in Obsidian.
3. **Edit in place** — authoring and the finished thing are one surface.
4. **Constraint as clarity** — 10 Areas max, and that's the point.
5. **Workspace is presentation space** — publish ships what you see.
6. **Structure follows attention** — recently touched floats up.
7. **Speed matters** — every interaction budgeted under a second.

## License

MIT.
