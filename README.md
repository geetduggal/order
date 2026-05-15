# Order

*Your notes, at home at last.*

A specialized note app. Thinking, browsing, and publishing in one constrained
surface. Local markdown files. Built with Tauri v2 (desktop + iOS from the
same codebase).

## Run it

**Prereqs**
- Node 20+, pnpm
- Rust toolchain (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- Xcode + command-line tools (for iOS)

**Desktop**
```bash
pnpm install
pnpm tauri:dev      # dev window with hot reload
pnpm tauri:build    # signed app bundle
```

**iOS**
```bash
pnpm tauri:ios:init   # one-time; generates the Xcode project
pnpm tauri:ios:dev    # opens iOS Simulator
pnpm tauri:ios:build  # device build / App Store archive
```

First launch: pick a vault directory. Order reads `.md` files from it.

## What it does

- **Recent grid** at the top — a 2D card grid of recent notes. Double-click a card to edit inline.
- **Notable Folder sections** below — full-width content of each selected folder (Wikipedia-style for main documents, list-style for collections).
- **Right sidebar** — Log + Public pins, and a folder list. Click a folder to toggle it on the page.
- **Top tabs** — scroll-anchors that jump to the selected folder's section.
- **Calendar view** — week view with drag-to-move events.
- **Publish** — one button in the topbar; pushes public-flagged notes to `vault/public/` and commits/pushes via git.

## What a note looks like

```yaml
---
title: "Notes that age well"
folder: "[[Tech Habits]]"
public: true
date: "2026-05-13"
startTime: "08:15"
---

Your markdown here. `[[wikilinks]]` to other folders, **bold**, _italic_, headings,
lists. CodeMirror reveals raw syntax only on the cursor line (Typora-style).
```

A note becomes a **Notable Folder Main Document** when its YAML has a `category` field.

## Where things live

```
src/                React + TypeScript
├── App.tsx         root, owns hooks
├── hooks/          useVault, useFilters, useEditor — state slices
├── components/     Topbar, RecentGrid, NotableSection, Sidebar, CalendarView, CMEditor
└── lib/            markdown.ts (CodeMirror reveal plugin), types.ts

src-tauri/          Rust backend
└── src/
    ├── vault.rs    scan, read, save, set_frontmatter, delete
    ├── watcher.rs  notify-based fs watcher → emits `vault-changed`
    └── publish.rs  copy public/, git commit & push
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions.

## License

MIT.
