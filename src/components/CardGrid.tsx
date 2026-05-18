// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Stream masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { readDir } from "@tauri-apps/plugin-fs";
import { Card } from "./Card";
import { CalendarView, type NoteMeta } from "./CalendarView";
import { YearLinearView } from "./YearLinearView";
import { Sidebar, type NotableFolder } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { folderColor, isNotableFolder, noteFolder, parseRef } from "../lib/folders";
import {
  AREAS_FILENAME,
  buildVaultTaxonomy,
  mutateBullets,
  planMigration,
  readStoredTaxonomy,
} from "../lib/taxonomy";
import { extractBaseBlock } from "../lib/list-base";
import type { ListItem, ListNoteRef } from "../lib/list-folder";

const SIDEBAR_OPEN_KEY = "order.sidebar.open";
function readSidebarOpen(): boolean {
  // Closed by default — only opens after the user explicitly toggles it.
  try { return localStorage.getItem(SIDEBAR_OPEN_KEY) === "1"; } catch { return false; }
}
function writeSidebarOpen(open: boolean): void {
  try { localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0"); } catch { /* non-fatal */ }
}
import {
  basenameForEvent,
  isoDate,
  isoTime,
  joinFrontmatter,
  splitFrontmatter,
  suggestCalendarPatch,
  type Frontmatter,
} from "../lib/frontmatter";

/** Try writing the seed at `<dir>/<basename>`; if a file already exists
 *  at that name, append ` 2`, ` 3`, … to the stem until we find an
 *  unused slot. Returns the resolved path. */
async function uniqueWrite(dir: string, basename: string, content: string): Promise<string> {
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const ext = dot > 0 ? basename.slice(dot) : "";
  let candidate = basename;
  let n = 2;
  // Cap the retry loop so a runaway directory full of "Untitled"
  // siblings can't spin forever — 999 collisions is already absurd.
  for (let i = 0; i < 999; i++) {
    const path = await join(dir, candidate);
    try {
      await invoke<string>("read_text", { path });
      // File exists — bump and retry.
      candidate = `${stem} ${n}${ext}`;
      n++;
    } catch {
      // Read failed → assume the file doesn't exist; safe to write.
      await invoke("write_text", { path, content });
      return path;
    }
  }
  throw new Error(`Couldn't find a unique name for ${basename}`);
}

const SEEDS: { filename: string; seed: string }[] = [
  {
    filename: "01-quick-log.md",
    seed:
`Cold this morning. Light came in at a low angle through the kitchen and made the cream paper of the journal almost glow.`,
  },
  {
    filename: "02-publish-thought.md",
    seed:
`What if **publish** is just a checkbox in the YAML drawer, no other ceremony?

That's the whole loop: write, check, save. Static rebuild handles the rest.`,
  },
  {
    filename: "03-on-photography.md",
    seed:
`From [On Photography](#): *"To collect photographs is to collect the world."*

Same for notes — collecting them is the cheap part. The hard part is rereading them later and finding the ones that earned their place.`,
  },
  {
    filename: "04-order-essay.md",
    seed:
`# Notes that age well

If a note still makes sense to me a year from now without context, it earned its place. Most don't, and that's fine — Log absorbs the rest.

## The constraint

The 10-box constraint isn't just a discipline — it's a *visual* promise. Empty slots are part of the design.

## What I keep

- Things I'll reread
- Ideas that fight back when I try to refine them
- Drafts in motion

The rest goes to Log, where time decides.`,
  },
  {
    filename: "05-code-snippet.md",
    seed:
`Tried this little debounce wrapper today:

\`\`\`ts
function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
\`\`\`

Clean enough. The trailing-call semantics are good for autosave but bad for search-as-you-type.`,
  },
  {
    filename: "06-slow.md",
    seed:
`Kundera: the pleasure of slowness is the inverse of forgetfulness.

> Speed forgets; slowness remembers.

I want a tool that lets me be slow without feeling guilty about it.`,
  },
  {
    filename: "07-walk.md",
    seed:
`Sat afternoon. Up the ridge, all the way to the cell tower, and back along the creek. The light through the new leaves did the thing it does in late spring — that translucent green that looks like the leaves are lit from inside.

Stopped at the bench by the bend. Made a note about the trail being washed out from the storm last week. Three blowdowns since I was here last.

Home in time to make dinner.`,
  },
  {
    filename: "08-design-doc.md",
    seed:
`# Order — design doc (excerpt)

Order is a specialized note app. **Thinking, browsing, and publishing happen in one constrained surface** — a workspace, an explorer, and a publish space sharing the same screen.

It is deliberately *not* an all-in-one: Readwise still handles your highlights, Obsidian still hosts your vault, your camera roll is still your camera roll. Order's specific job is **in-place editing and exploration within a constrained three-level hierarchy** (Areas → Categories → Notable Folders).

## What this looks like

1. Cards in a stream
2. Notable Folder sections below
3. Right sidebar for navigation
4. Same surface for reading and writing

That's the whole product.`,
  },
  // Notable Folder Main Documents — these get the special role because
  // their frontmatter carries a `category` field. They drive the right
  // sidebar's hierarchy. Type: list / cards / prose.
  {
    filename: "Books.md",
    seed:
`---
category: Reading
area: Personal
type: list
---

# Books

A running list of what I'm reading, what I want to read, and what landed.

- [[On Photography]] · Susan Sontag · ★★★★½
- [[Slowness]] · Milan Kundera · ★★★★
- [[The Artist's Way]] · Julia Cameron · ★★★★
- [[A Field Guide to Getting Lost]] · Rebecca Solnit · ★★★★★
- [[Ways of Seeing]] · John Berger · ★★★★★
- [[Tao Te Ching]] · Le Guin (trans.) · ★★★★★`,
  },
  {
    filename: "On Photography.md",
    seed:
`---
folder: "[[Books]]"
author: Susan Sontag
rating: 4.5
description: A meditation on the camera's relationship to the world.
---

# On Photography

A meditation on the relationship between photography, ethics, and the world.`,
  },
  {
    filename: "Slowness.md",
    seed:
`---
folder: "[[Books]]"
author: Milan Kundera
rating: 4
description: A novel on speed, memory, and forgetting.
---

# Slowness

A short novel that braids two stories — one from the 18th century, one from the present — around the relationship between speed and memory.`,
  },
  {
    filename: "The Artist's Way.md",
    seed:
`---
folder: "[[Books]]"
author: Julia Cameron
rating: 4
description: A twelve-week course on recovering creative agency.
---

# The Artist's Way

A twelve-week program centered on morning pages and artist dates.`,
  },
  {
    filename: "Walks.md",
    seed:
`---
category: Health
area: Personal
type: prose
---

# Walks

Notes from walks — light, weather, trail conditions, what was in my head.`,
  },
  {
    filename: "Tech Habits.md",
    seed:
`---
category: Habits
area: Projects
type: prose
icon: code
---

# Tech Habits

Small, durable engineering practices worth keeping. Defaults that pay back over years.`,
  },
];

const GRID_ROW_PX = 8;

type View = "stream" | "week" | "month" | "year";

interface LoadedNote {
  /** Stable id across renames — used as React key so the Card never
   *  remounts when its filename changes. */
  id: string;
  path: string;
  filename: string;
  frontmatter: Frontmatter;
  /** Best-guess title for the calendar event chip: first h1 stripped of `#`,
   *  else first non-empty line truncated. */
  title: string;
  /** Raw body (without frontmatter). The taxonomy chain walk reads
   *  bullets from this; the Card editor re-reads its own body
   *  separately on mount. */
  body: string;
}

let nextNoteId = 0;
function newNoteId(): string { return `n${nextNoteId++}`; }

function deriveTitle(body: string, fallback: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("#")) return t.replace(/^#+\s*/, "");
    return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }
  return fallback;
}

async function loadOne(path: string, filename: string, seed?: string): Promise<LoadedNote> {
  let raw: string;
  try {
    raw = await invoke<string>("read_text", { path });
  } catch {
    if (seed === undefined) throw new Error(`read failed and no seed for ${path}`);
    await invoke("write_text", { path, content: seed });
    raw = seed;
  }
  let { frontmatter, body } = splitFrontmatter(raw);
  const patch = suggestCalendarPatch(frontmatter, body);
  if (patch) {
    frontmatter = { ...frontmatter, ...patch };
    const next = joinFrontmatter(frontmatter, body);
    try {
      await invoke("write_text", { path, content: next });
    } catch (err) {
      console.warn("Failed to inject calendar metadata for", path, err);
    }
  }
  return {
    id: newNoteId(),
    path,
    filename,
    frontmatter,
    title: deriveTitle(body, filename.replace(/\.md$/, "")),
    body,
  };
}

async function loadAndNormalizeAll(): Promise<LoadedNote[]> {
  const dir = await documentDir();
  const subdir = await join(dir, "Dropbox", "order", "cards");
  const out: LoadedNote[] = [];
  const seen = new Set<string>();

  // First pass: ensure each seed file exists on disk and load it.
  for (const { filename, seed } of SEEDS) {
    const path = await join(subdir, filename);
    out.push(await loadOne(path, filename, seed));
    seen.add(filename);
  }

  // Second pass: load any other .md files the user has created since.
  // Without this, every user-created note disappears after restart
  // because only SEEDS were ever read back.
  let entries: { name: string; isFile?: boolean }[] = [];
  try {
    entries = await readDir(subdir);
  } catch (err) {
    console.warn("Could not scan cards directory:", err);
  }
  for (const entry of entries) {
    if (!entry.name?.endsWith(".md")) continue;
    if (seen.has(entry.name)) continue;
    const path = await join(subdir, entry.name);
    try {
      out.push(await loadOne(path, entry.name));
    } catch (err) {
      console.warn("Failed to load card", path, err);
    }
  }

  return out;
}

export function CardGrid() {
  const [notes, setNotes] = useState<LoadedNote[] | null>(null);
  const [view, setView] = useState<View>("stream");
  const [scrollTargetPath, setScrollTargetPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
  const [folderFilter, setFolderFilter] = useState<Set<string>>(new Set());
  // Callback ref backed by state so layout effects re-run when the
  // .card-grid div actually mounts. A plain useRef has a stable
  // identity, so an effect with [gridRef] deps never re-fires — and
  // on initial render the grid isn't in the DOM yet (notes === null
  // short-circuits below), so .current would stay null forever.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);

  const toggleFolderFilter = useCallback((name: string) => {
    setFolderFilter((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);
  const clearFolderFilter = useCallback(() => setFolderFilter(new Set()), []);

  // Walk the chain rooted at Areas.md to produce Areas → Categories
  // → Folder refs. Sidebar consumes this as flat arrays so it can
  // keep its existing drill UI without further refactor.
  const vaultTaxonomy = useMemo(() => {
    if (!notes) return { areas: [], hiddenRefs: new Set<string>() };
    return buildVaultTaxonomy(notes.map((n) => ({
      filename: n.filename,
      frontmatter: n.frontmatter,
      body: n.body,
    })));
  }, [notes]);

  const cardsSubdir = useCallback(async (): Promise<string> => {
    const dir = await documentDir();
    return join(dir, "Dropbox", "order", "cards");
  }, []);

  const reloadNotes = useCallback(async () => {
    try {
      const fresh = await loadAndNormalizeAll();
      setNotes(fresh);
    } catch (err) {
      console.error("reload failed:", err);
    }
  }, []);

  const [capWarning, setCapWarning] = useState<string | null>(null);
  const flashCap = useCallback((msg: string) => {
    setCapWarning(msg);
    setTimeout(() => setCapWarning((c) => (c === msg ? null : c)), 2500);
  }, []);

  /** Add an Area = append a bullet to Areas.md. Caps at 10. */
  const handleAddArea = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const subdir = await cardsSubdir();
    const path = await join(subdir, AREAS_FILENAME);
    const ok = await mutateBullets(
      path,
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => {
        if (items.some((i) => i.ref.toLowerCase() === trimmed.toLowerCase())) return items;
        if (items.length >= 10) { flashCap("Areas full (10 / 10) — remove one to add another."); return null; }
        return [...items, { ref: trimmed }];
      },
    );
    if (ok) await reloadNotes();
  }, [cardsSubdir, reloadNotes, flashCap]);

  const handleRemoveArea = useCallback(async (name: string) => {
    const subdir = await cardsSubdir();
    const path = await join(subdir, AREAS_FILENAME);
    await mutateBullets(
      path,
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => items.filter((i) => i.ref.toLowerCase() !== name.toLowerCase()),
    );
    await reloadNotes();
  }, [cardsSubdir, reloadNotes]);

  /** Add a Category to an Area = append a bullet to <Area>.md. If the
   *  Area file doesn't exist yet, create it and also add the Area to
   *  Areas.md. Caps at 10. */
  const handleAddCategory = useCallback(async (name: string, areaName: string) => {
    const trimmed = name.trim();
    const trimmedArea = areaName.trim();
    if (!trimmed || !trimmedArea) return;
    const subdir = await cardsSubdir();
    // Ensure Area is in Areas.md
    await mutateBullets(
      await join(subdir, AREAS_FILENAME),
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => {
        if (items.some((i) => i.ref.toLowerCase() === trimmedArea.toLowerCase())) return items;
        if (items.length >= 10) { flashCap("Areas full (10 / 10) — remove one to add another."); return null; }
        return [...items, { ref: trimmedArea }];
      },
    );
    // Ensure Area file exists; create if missing.
    const areaPath = await join(subdir, `${trimmedArea}.md`);
    try { await invoke<string>("read_text", { path: areaPath }); }
    catch {
      const body = `# ${trimmedArea}\n`;
      await invoke("write_text", { path: areaPath, content: joinFrontmatter({ list: "cards" }, body) });
    }
    // Append category bullet
    const ok = await mutateBullets(
      areaPath,
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => {
        if (items.some((i) => i.ref.toLowerCase() === trimmed.toLowerCase())) return items;
        if (items.length >= 10) { flashCap(`${trimmedArea} full (10 / 10 categories) — remove one to add another.`); return null; }
        return [...items, { ref: trimmed }];
      },
    );
    if (ok) await reloadNotes();
  }, [cardsSubdir, reloadNotes, flashCap]);

  const handleRemoveCategory = useCallback(async (name: string, areaName: string) => {
    const subdir = await cardsSubdir();
    const areaPath = await join(subdir, `${areaName}.md`);
    await mutateBullets(
      areaPath,
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => items.filter((i) => i.ref.toLowerCase() !== name.toLowerCase()),
    );
    await reloadNotes();
  }, [cardsSubdir, reloadNotes]);

  // Shape Sidebar's existing API expects.
  const storedAreas = vaultTaxonomy.areas.map((a) => a.ref);
  const storedCategories = vaultTaxonomy.areas.flatMap((a) =>
    a.categories.map((c) => ({ area: a.ref, name: c.ref })),
  );

  // Popover state for the new-note picker (shows when multiple
  // folders are selected and the user clicks the + FAB).
  const [creatorOpen, setCreatorOpen] = useState(false);
  useEffect(() => {
    if (!creatorOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".new-note-fab, .new-note-picker")) setCreatorOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [creatorOpen]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      writeSidebarOpen(next);
      return next;
    });
  }, []);

  // Sidebar search focus (Cmd+O) and centered command palette (Cmd+K).
  // The signal is a bumped counter so the Sidebar effect re-fires even
  // when the sidebar was already open.
  const [searchFocusSignal, setSearchFocusSignal] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        if (!sidebarOpen) {
          setSidebarOpen(true);
          writeSidebarOpen(true);
        }
        setSearchFocusSignal((n) => n + 1);
        return;
      }
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.key === ";") {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, toggleSidebar]);

  // One-shot migration to the unified list model. Generates Areas.md
  // + per-Area + per-Category files from the legacy localStorage
  // taxonomy and existing Notable Folder Main Docs, and rewrites NF
  // YAML to use `list: cards` instead of `type: list`. Runs only if
  // no Areas.md (or equivalent role:areas note) is present.
  const migratedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let loaded = await loadAndNormalizeAll();
        if (cancelled) return;

        const hasAreas = loaded.some(
          (n) => n.filename === AREAS_FILENAME || n.frontmatter.role === "areas",
        );
        if (!hasAreas && !migratedRef.current) {
          migratedRef.current = true;
          // Re-read bodies for migration planning — loaded notes only
          // carry frontmatter.
          const withBody = await Promise.all(loaded.map(async (n) => {
            const raw = await invoke<string>("read_text", { path: n.path });
            const { body } = splitFrontmatter(raw);
            return { filename: n.filename, path: n.path, body, frontmatter: n.frontmatter };
          }));
          const stored = readStoredTaxonomy();
          const plan = planMigration(withBody, stored);
          const dir = await documentDir();
          const subdir = await join(dir, "Dropbox", "order", "cards");
          for (const f of plan.newFiles) {
            const p = await join(subdir, f.filename);
            await invoke("write_text", { path: p, content: f.content });
          }
          for (const r of plan.rewrites) {
            await invoke("write_text", { path: r.path, content: r.content });
          }
          loaded = await loadAndNormalizeAll();
          if (cancelled) return;
        }
        setNotes(loaded);
      } catch (err) {
        console.error("Could not load cards:", err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useGridLayout(gridEl);

  // Safety-net relayout for async content (Milkdown init, font load,
  // late image fetch). Fires a few times after any notes / filter /
  // view change. Measures the .order-card child's natural height
  // rather than the cell — clearing-then-remeasuring the cell would
  // collapse it to 1 row (8px) and bake in that wrong reading.
  useEffect(() => {
    const grid = gridEl;
    if (!grid || !notes) return;
    const timeouts = [50, 200, 600, 1500].map((ms) =>
      setTimeout(() => {
        const styles = getComputedStyle(grid);
        const rowGap = parseFloat(styles.rowGap || styles.gap || "0");
        grid.querySelectorAll<HTMLElement>(":scope > .card-grid-cell").forEach((cell) => {
          const child = cell.firstElementChild as HTMLElement | null;
          if (!child) return;
          const rows = Math.max(1, Math.ceil((child.offsetHeight + rowGap) / (GRID_ROW_PX + rowGap)));
          cell.style.gridRowEnd = `span ${rows}`;
        });
      }, ms),
    );
    return () => timeouts.forEach(clearTimeout);
  }, [gridEl, notes, folderFilter, view]);

  const handleEventClick = useCallback((path: string) => {
    setView("stream");
    setScrollTargetPath(path);
  }, []);

  // After switching to Stream with a target set, scroll the matching
  // card into view and pulse a highlight on it. We wait long enough
  // for the masonry layout effect to compute row spans (otherwise the
  // cell's final Y is wrong) and then for the smooth scroll to start.
  // Clearing scrollTargetPath happens INSIDE the timeout so the effect's
  // cleanup doesn't cancel the timer mid-flight.
  useEffect(() => {
    if (view !== "stream" || !scrollTargetPath) return;
    const target = scrollTargetPath;
    const timer = setTimeout(() => {
      const grid = gridEl;
      if (grid) {
        const cell = grid.querySelector<HTMLElement>(
          `.card-grid-cell[data-path="${CSS.escape(target)}"]`,
        );
        if (cell) {
          cell.scrollIntoView({ behavior: "smooth", block: "center" });
          cell.classList.add("is-target");
          setTimeout(() => cell.classList.remove("is-target"), 1400);
        } else {
          console.warn("scroll target cell not found:", target);
        }
      }
      setScrollTargetPath(null);
    }, 120);
    return () => clearTimeout(timer);
  }, [view, scrollTargetPath]);

  const createNote = useCallback(async (patch: Frontmatter): Promise<void> => {
    const dir = await documentDir();
    const subdir = await join(dir, "Dropbox", "order", "cards");
    // Defaults match the auto-inject path: notes get allDay=false unless
    // the caller explicitly says otherwise (Year + Month all-day clicks).
    const frontmatter: Frontmatter = { allDay: false, ...patch };
    const content = joinFrontmatter(frontmatter, "");
    const title = typeof patch.title === "string" ? patch.title : "Untitled";
    const date = typeof frontmatter.date === "string" ? frontmatter.date : undefined;
    const basename = basenameForEvent(date, title);
    const path = await uniqueWrite(subdir, basename, content);
    const filename = path.split("/").pop() ?? basename;
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: filename.replace(/\.md$/, ""), body: "" },
    ]);
    // Stay in whichever view triggered the create — calendar views
    // re-render with the new event at its date/time; Stream sorts it
    // into place by date+startTime.
  }, []);

  const handleCardRenamed = useCallback((id: string, newPath: string) => {
    const newFilename = newPath.split("/").pop() ?? newPath;
    setNotes((prev) =>
      prev?.map((n) =>
        n.id === id
          ? { ...n, path: newPath, filename: newFilename, title: newFilename.replace(/\.md$/, "") }
          : n,
      ) ?? null,
    );
  }, []);

  const handleCardTitleChanged = useCallback((id: string, newTitle: string) => {
    setNotes((prev) =>
      prev?.map((n) => (n.id === id ? { ...n, title: newTitle } : n)) ?? null,
    );
  }, []);

  const handleCardDelete = useCallback(async (id: string, path: string) => {
    try {
      await invoke("delete_file", { path });
    } catch (err) {
      console.error("delete_file failed:", err);
      throw err;
    }
    setNotes((prev) => prev?.filter((n) => n.id !== id) ?? null);
  }, []);

  /** Assign (or clear) a regular note's Notable Folder. Writes the
   *  `folder: [[Name]]` field into the file's YAML, then mirrors the
   *  change into local state so the chip + filtering reflect it. */
  const handleAssignFolder = useCallback(async (path: string, folderName: string | null) => {
    const raw = await invoke<string>("read_text", { path });
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    if (folderName) next.folder = `[[${folderName}]]`;
    else delete next.folder;
    await invoke("write_text", { path, content: joinFrontmatter(next, body) });
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  /** Create a new Notable Folder Main Document for the given area +
   *  category. Writes <Name>.md with seed YAML (+ optional numeric
   *  suffix if the name already exists), then adds it to state. */
  const handleCreateFolder = useCallback(async (name: string, areaName: string, categoryName: string) => {
    const dir = await documentDir();
    const subdir = await join(dir, "Dropbox", "order", "cards");
    const trimmed = name.trim();
    if (!trimmed) return;
    const frontmatter: Frontmatter = {
      category: categoryName,
      area: areaName,
      type: "prose",
    };
    const body = `# ${trimmed}\n`;
    const content = joinFrontmatter(frontmatter, body);
    const basename = `${trimmed.replace(/[\\/:*?"<>|]/g, "-")}.md`;
    const path = await uniqueWrite(subdir, basename, content);
    const filename = path.split("/").pop() ?? basename;
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: trimmed, body },
    ]);
  }, []);

  const updateNoteFrontmatter = useCallback(async (path: string, patch: Frontmatter) => {
    const raw = await invoke<string>("read_text", { path });
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    // Patch protocol: `undefined` removes a key, anything else assigns.
    // Lets CalendarView drop startTime/endTime when an event is dragged
    // into the all-day strip.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    await invoke("write_text", { path, content: joinFrontmatter(next, body) });
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  if (notes === null) {
    return <div className="card-grid-empty">Preparing cards…</div>;
  }

  // Notable Folder Main Documents — notes whose YAML carries `category`.
  // Their title comes from the filename minus the .md (which is also
  // the slug other notes use to point at them via `folder: [[Name]]`).
  const notableFolders: NotableFolder[] = notes
    .filter((n) => isNotableFolder(n.frontmatter))
    .map((n) => ({
      name: n.filename.replace(/\.md$/, ""),
      area: parseRef(n.frontmatter.area) ?? "",
      category: parseRef(n.frontmatter.category) ?? "",
      frontmatter: n.frontmatter,
      path: n.path,
    }));

  // Flat list of folder names + their deterministic colors, fed to the
  // folder picker in each non-Notable card's footer.
  const availableFolderRefs = notableFolders.map((f) => ({
    name: f.name,
    color: folderColor(f.name, f.frontmatter.color),
  }));

  // Minimal vault index for resolving `- [[Name]]` bullets and
  // evaluating `base` blocks. `folder` is the dirname's last segment
  // so file.folder.contains("X") works against the literal directory
  // name; ctime/mtime are left undefined until we plumb fs.stat
  // through the load path.
  const vaultNotesIndex: ListNoteRef[] = notes.map((n) => ({
    filename: n.filename,
    frontmatter: n.frontmatter,
    folder: n.path.split("/").slice(-2, -1)[0] ?? "",
  }));

  // Hide intermediate Area / Category list files from the Stream.
  // They're navigation infrastructure; the Sidebar drill is the
  // surface for editing them.
  const streamCandidates = notes.filter((n) => {
    const ref = n.filename.replace(/\.md$/, "");
    return !vaultTaxonomy.hiddenRefs.has(ref);
  });

  // Filter: if any folders are selected, only notes that belong to one
  // of them survive. Notable Folder Main Documents themselves count as
  // "belonging to" their own folder so they're always pinned at top.
  const filteringActive = folderFilter.size > 0;
  const filterMatches = (n: LoadedNote): boolean => {
    if (!filteringActive) return true;
    const main = isNotableFolder(n.frontmatter)
      ? n.filename.replace(/\.md$/, "")
      : null;
    if (main && folderFilter.has(main)) return true;
    const f = noteFolder(n.frontmatter);
    return f !== null && folderFilter.has(f);
  };

  const filteredNotes = filteringActive ? streamCandidates.filter(filterMatches) : streamCandidates;

  // Stream view sorts chronologically (newest first). With filters
  // active we hoist the matched Main Documents to the top of the list,
  // then the rest below by date desc.
  const sortKey = (n: LoadedNote): string => {
    const d = typeof n.frontmatter.date === "string" ? n.frontmatter.date : "0000-00-00";
    const t = typeof n.frontmatter.startTime === "string" ? n.frontmatter.startTime : "00:00";
    return `${d} ${t}`;
  };
  const sortedNotes = filteringActive
    ? [
        ...filteredNotes.filter((n) => isNotableFolder(n.frontmatter)),
        ...filteredNotes
          .filter((n) => !isNotableFolder(n.frontmatter))
          .sort((a, b) => sortKey(b).localeCompare(sortKey(a))),
      ]
    : [...filteredNotes].sort((a, b) => sortKey(b).localeCompare(sortKey(a)));

  // Calendar events carry their folder's color so Week/Month/Year
  // events read at a glance.
  const calendarNotes: NoteMeta[] = filteredNotes.map((n) => {
    const f = noteFolder(n.frontmatter);
    return {
      path: n.path,
      filename: n.filename,
      title: n.title,
      frontmatter: n.frontmatter,
      color: f ? folderColor(f) : undefined,
    };
  });

  return (
    <div className={"shell" + (sidebarOpen ? " sidebar-open" : " sidebar-closed")}>
      <button
        type="button"
        className="new-note-fab"
        onClick={() => {
          const sel = [...folderFilter];
          // No filter active → plain new note. Exactly one folder
          // selected → auto-assign it. 2+ selected → open the
          // lightweight picker.
          if (sel.length === 1) {
            void createNote({
              date: isoDate(), startTime: isoTime(), allDay: false,
              folder: `[[${sel[0]}]]`,
            });
          } else if (sel.length === 0) {
            void createNote({ date: isoDate(), startTime: isoTime(), allDay: false });
          } else {
            setCreatorOpen((prev) => !prev);
          }
        }}
        title="New note"
        aria-label="New note"
      >
        +
      </button>

      {creatorOpen && (
        <div className="new-note-picker" role="menu">
          {[...folderFilter].map((name) => {
            const color = folderColor(name);
            return (
              <button
                type="button"
                key={name}
                className="new-note-picker-item"
                onClick={() => {
                  setCreatorOpen(false);
                  void createNote({
                    date: isoDate(), startTime: isoTime(), allDay: false,
                    folder: `[[${name}]]`,
                  });
                }}
              >
                <span className="new-note-picker-swatch" style={{ background: color }} />
                <span>{name}</span>
              </button>
            );
          })}
        </div>
      )}

      <button
        type="button"
        className="sidebar-toggle"
        onClick={toggleSidebar}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      >
        {sidebarOpen ? "›" : "‹"}
      </button>

      <main className="pane-main">
        {view === "stream" && (
          <div className="card-grid" ref={setGridEl}>
            {sortedNotes.map((n) => {
              const isMain = isNotableFolder(n.frontmatter);
              const folderName = isMain
                ? n.filename.replace(/\.md$/, "")
                : noteFolder(n.frontmatter);
              const c = folderName ? folderColor(folderName) : undefined;
              return (
                <div
                  className={"card-grid-cell" + (isMain ? " is-full-width" : "")}
                  data-path={n.path}
                  key={n.id}
                >
                  <Card
                    path={n.path}
                    color={c}
                    area={isMain ? parseRef(n.frontmatter.area) ?? undefined : undefined}
                    category={isMain ? parseRef(n.frontmatter.category) ?? undefined : undefined}
                    currentFolder={isMain ? undefined : (noteFolder(n.frontmatter) ?? null)}
                    availableFolders={isMain ? undefined : availableFolderRefs}
                    onAssignFolder={isMain ? undefined : (name) => handleAssignFolder(n.path, name)}
                    vaultNotes={isMain ? vaultNotesIndex : undefined}
                    onRenamed={(newPath) => handleCardRenamed(n.id, newPath)}
                    onTitleChanged={(t) => handleCardTitleChanged(n.id, t)}
                    onDelete={(path) => handleCardDelete(n.id, path)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {view === "week" && (
          <CalendarView
            key="week"
            notes={calendarNotes}
            initialView="timeGridWeek"
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={createNote}
          />
        )}
        {view === "month" && (
          <CalendarView
            key="month"
            notes={calendarNotes}
            initialView="dayGridMonth"
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={createNote}
          />
        )}
        {view === "year" && (
          <YearLinearView
            key="year"
            notes={calendarNotes}
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={createNote}
          />
        )}
      </main>

      {sidebarOpen && (
        <Sidebar
          view={view}
          onSelectView={setView}
          folders={notableFolders}
          selected={folderFilter}
          onToggle={toggleFolderFilter}
          onClear={clearFolderFilter}
          onCreateFolder={handleCreateFolder}
          storedAreas={storedAreas}
          storedCategories={storedCategories}
          onAddArea={handleAddArea}
          onRemoveArea={handleRemoveArea}
          onAddCategory={handleAddCategory}
          onRemoveCategory={handleRemoveCategory}
          focusSearchSignal={searchFocusSignal}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={notableFolders}
          selected={folderFilter}
          onToggle={toggleFolderFilter}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {capWarning && (
        <div className="cap-warning" role="status">{capWarning}</div>
      )}
    </div>
  );
}

function useGridLayout(grid: HTMLDivElement | null) {
  useEffect(() => {
    if (!grid) return;

    function relayoutCell(cell: HTMLElement) {
      const styles = getComputedStyle(grid as HTMLElement);
      const rowGap = parseFloat(styles.rowGap || styles.gap || "0");
      const child = cell.firstElementChild as HTMLElement | null;
      if (!child) return;
      const rows = Math.max(1, Math.ceil((child.offsetHeight + rowGap) / (GRID_ROW_PX + rowGap)));
      cell.style.gridRowEnd = `span ${rows}`;
    }
    function relayoutAll() {
      const cells = grid?.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
      cells?.forEach((c) => relayoutCell(c));
    }

    // Observe each .order-card. RO catches size changes from images
    // loading, font swaps, fullscreen toggles, breadcrumb appearing.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const target = e.target as HTMLElement;
        const cell = target.closest(".card-grid-cell");
        if (cell instanceof HTMLElement) relayoutCell(cell);
      }
    });

    // Per-card MutationObservers catch ProseMirror's internal DOM
    // changes when the user types — RO alone is unreliable here
    // because ProseMirror's incremental DOM updates don't always
    // produce a measurable layout change in the same frame.
    const cardMOs = new WeakMap<Element, MutationObserver>();

    function attachCardObservers(cell: HTMLElement) {
      const card = cell.firstElementChild;
      if (!(card instanceof HTMLElement)) return;
      ro.observe(card);
      if (cardMOs.has(card)) return;
      const cmo = new MutationObserver(() => relayoutCell(cell));
      cmo.observe(card, {
        childList: true, subtree: true, characterData: true, attributes: true,
      });
      cardMOs.set(card, cmo);
    }

    function reattachAndRelayout() {
      if (!grid) return;
      ro.disconnect();
      const cells = grid.querySelectorAll<HTMLElement>(":scope > .card-grid-cell");
      cells.forEach(attachCardObservers);
      relayoutAll();
    }
    reattachAndRelayout();

    // MutationObserver on the grid catches cell add/remove (filter
    // toggles, create-note, delete) — those don't trigger RO either.
    const mo = new MutationObserver(reattachAndRelayout);
    mo.observe(grid, { childList: true });

    // Belt-and-suspenders: any keystroke in an editor inside a cell
    // triggers an immediate relayout of that cell. Capturing phase so
    // we see it before the editor processes it.
    function onInput(e: Event) {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const cell = t.closest(".card-grid-cell");
      if (cell instanceof HTMLElement) {
        requestAnimationFrame(() => relayoutCell(cell));
      }
    }
    grid.addEventListener("input", onInput, true);
    grid.addEventListener("keyup", onInput, true);

    window.addEventListener("resize", relayoutAll);
    return () => {
      ro.disconnect();
      mo.disconnect();
      grid.removeEventListener("input", onInput, true);
      grid.removeEventListener("keyup", onInput, true);
      window.removeEventListener("resize", relayoutAll);
    };
  }, [grid]);
}
