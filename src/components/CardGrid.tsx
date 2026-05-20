// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Stream masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Home as HouseIcon, ChevronsDown, ChevronsUp, Upload as UploadIcon } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { vaultRoot, walkVaultMarkdown } from "../lib/vault";
import { useGridLayout } from "../lib/grid-layout";
import { Card } from "./Card";
import { CalendarView, type NoteMeta } from "./CalendarView";
import { YearLinearView } from "./YearLinearView";
import { Sidebar, type NotableFolder } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { PublishPanel, type HomeFolder, type PublishableNote, type PublishOutcome } from "./PublishPanel";
import { collectPublishedSite } from "../lib/publish";
import { folderColor, isNotableFolder, noteFolder, parseRef } from "../lib/folders";
import { FilterPillStack } from "./FilterPillStack";
import { NotebookSection, type SectionCell } from "./NotebookSection";
import type { Filter } from "../lib/filters";
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

// Filter model (`Filter`, pill stack) is shared with the web viewer
// via ../lib/filters + ./FilterPillStack.
//
// Bumped to .v2 when the default flipped from exclude-home to
// include-home — invalidates any pre-existing persisted set one time
// so the new home-focused default seeds on next launch.
const FILTERS_KEY = "order.activeFilters.v2";

function readStoredFilters(): Filter[] | null {
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is Filter =>
        !!f && typeof f === "object"
        && (f.kind === "include" || f.kind === "exclude")
        && typeof f.ref === "string",
    );
  } catch { return null; }
}

function writeStoredFilters(filters: Filter[]): void {
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* non-fatal */ }
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
  // Walk every .md file under the vault root. Notes can sit at
  // root or nested in per-Notable-Folder directories; we don't
  // care about the OS layout — the bullet chain encodes the
  // hierarchy. SEEDS-based first-run seeding is gone: the vault is
  // the source of truth, and an empty vault is migrated into
  // shape by the chain-walk + planMigration in CardGrid's mount
  // effect.
  const entries = await walkVaultMarkdown();
  const out: LoadedNote[] = [];
  for (const { path, filename } of entries) {
    try {
      out.push(await loadOne(path, filename));
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
  /** Path of the most recently created note. The matching Card
   *  mounts with `autoFocus` so the cursor lands inside its editor
   *  the moment it appears. Cleared by the same scroll-target
   *  effect that handles the highlight pulse. */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** Toggles the left-rail jump-to-notes icon between "down" (jump
   *  to the first regular note) and "up" (jump back to the top). */
  const [jumpedDown, setJumpedDown] = useState<boolean>(false);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
  // Active filter pills. `null` until hydrated so the first-load
  // default-home-exclude effect can tell "never set" from "user
  // cleared everything".
  const [filters, setFilters] = useState<Filter[]>(() => readStoredFilters() ?? []);
  // Bumped by the home-reset to collapse every section's Show-more
  // expansion back to its first batch.
  const [collapseNonce, setCollapseNonce] = useState(0);
  // The folder whose Main Document is pinned to the top of the Stream.
  // Set by clicking a filter pill; cleared whenever the filter set
  // changes so a stale pin doesn't linger.
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  useEffect(() => { setFocusedFolder(null); }, [filters]);
  // Callback ref backed by state so layout effects re-run when the
  // .card-grid div actually mounts. A plain useRef has a stable
  // identity, so an effect with [gridRef] deps never re-fires — and
  // on initial render the grid isn't in the DOM yet (notes === null
  // short-circuits below), so .current would stay null forever.
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);

  // Include-filter refs as a Set — the Sidebar, CommandPalette, and
  // per-card × all key off "is this folder an active include filter".
  const includeSet = useMemo(
    () => new Set(filters.filter((f) => f.kind === "include").map((f) => f.ref)),
    [filters],
  );

  /** Add an include filter for `ref`. No-op if one already exists
   *  (duplicate pills are disallowed). Excludes are managed
   *  separately (only the default-home one, removable via its ×). */
  const addInclude = useCallback((ref: string) => {
    setFilters((prev) => {
      if (prev.some((f) => f.kind === "include" && f.ref === ref)) return prev;
      return [...prev, { kind: "include", ref }];
    });
  }, []);
  /** Remove a specific pill (matched by kind + ref). */
  const removeFilter = useCallback((target: Filter) => {
    setFilters((prev) => prev.filter(
      (f) => !(f.kind === target.kind && f.ref === target.ref),
    ));
  }, []);
  /** Reset to the default view: a single include pill for the home
   *  Notable Folder, AND collapse every section's Show-more
   *  expansion (via collapseNonce). The home-reset icon and the
   *  sidebar's clear-× both call this. Empty vault → no filters. */
  const resetToDefault = useCallback(() => {
    const home = homeFoldersRef.current[0];
    setFilters(home ? [{ kind: "include", ref: home }] : []);
    setCollapseNonce((n) => n + 1);
  }, []);
  /** Add an include filter AND scroll the stream to it. Bound to
   *  wikilink title-clicks in the list renders. Lives above the
   *  notes-loading early return so hook order is stable. */
  const navigateToRef = useCallback((ref: string) => {
    addInclude(ref);
    const path = notePathByRef(ref);
    if (path) setScrollTargetPath(path);
  }, [addInclude]);
  // Wikilink-to-NF clicks accumulate (same as navigateToRef now that
  // includes always compose with OR). Kept as a distinct name for the
  // list-render prop contract.
  const addFolderToFilter = navigateToRef;

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
    // Name kept for compat with existing callers — returns the vault
    // root (the "cards" subdir concept has gone away with the new
    // per-Notable-Folder directory layout).
    return vaultRoot();
  }, []);

  /** Stable view of the loaded notes for callbacks with empty deps.
   *  Used to look up the absolute path of any note by its ref so
   *  write handlers can derive the correct nested directory. */
  const notesRef = useRef<LoadedNote[] | null>(null);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  function notePathByRef(ref: string): string | null {
    const list = notesRef.current;
    if (!list) return null;
    const lower = ref.toLowerCase();
    const found = list.find((n) => n.filename.replace(/\.md$/i, "").toLowerCase() === lower);
    return found?.path ?? null;
  }

  function noteDirByRef(ref: string): string | null {
    const p = notePathByRef(ref);
    if (!p) return null;
    const i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(0, i) : null;
  }

  const reloadNotes = useCallback(async () => {
    try {
      const fresh = await loadAndNormalizeAll();
      setNotes(fresh);
    } catch (err) {
      console.error("reload failed:", err);
    }
  }, []);

  const [capWarning, setCapWarning] = useState<string | null>(null);

  /** Every Notable Folder whose YAML carries `home: "<user>/<repo>/<path>"`.
   *  Drives both the Publish panel (lets the user pick when multiple)
   *  and the new-capture catch-all (first one wins). */
  const homeFolders: HomeFolder[] = useMemo(() => {
    if (!notes) return [];
    const out: HomeFolder[] = [];
    for (const n of notes) {
      const v = n.frontmatter.home;
      if (typeof v !== "string" || !v.trim()) continue;
      const name = n.filename.replace(/\.md$/i, "");
      const titleFm = n.frontmatter.title;
      const title = typeof titleFm === "string" && titleFm.trim() ? titleFm : name;
      out.push({ name, title, target: v.trim() });
    }
    return out;
  }, [notes]);

  /** Filename (no .md) of the Notable Folder marked `home:` in its
   *  YAML. New captures default their `folder:` to this so they land
   *  in the catch-all rather than at vault root. Held as a ref so
   *  createNote can read the latest value without re-running on
   *  every notes change. */
  const homeFolderRef = useRef<string | null>(null);
  // All home Notable Folder names — resetToDefault rebuilds the
  // default exclude set from this.
  const homeFoldersRef = useRef<string[]>([]);
  useEffect(() => {
    homeFolderRef.current = homeFolders[0]?.name ?? null;
    homeFoldersRef.current = homeFolders.map((h) => h.name);
  }, [homeFolders]);

  // First-ever launch (no persisted filters) seeds an `include` pill
  // for the home Notable Folder, so Order opens focused on home (its
  // Main Doc pinned, its notes below). Runs in useLayoutEffect so it
  // lands before first paint (no flash of the unfiltered stream).
  // After the first run, the persisted set wins and the user is free
  // to add/remove pills.
  const seededDefault = useRef<boolean>(readStoredFilters() !== null);
  useLayoutEffect(() => {
    if (seededDefault.current) return;
    if (!notes) return;
    const home = homeFolders[0]?.name;
    if (!home) return;
    seededDefault.current = true;
    setFilters([{ kind: "include", ref: home }]);
  }, [notes, homeFolders]);

  // Persist pill state across launches. Gated on notes being loaded
  // so the empty initial state can't overwrite a persisted set (or
  // pre-empt the first-launch home-exclude seed) before hydration.
  useEffect(() => {
    if (!notes) return;
    writeStoredFilters(filters);
  }, [filters, notes]);

  /** Build the static bundle and hand it to the Rust side for the
   *  clone → write → commit → push dance. Called by PublishPanel
   *  when the user confirms. Resolves with the Rust outcome (errors
   *  string-flow back to the panel which surfaces them inline). */
  const handlePublish = useCallback(async (home: HomeFolder): Promise<PublishOutcome> => {
    if (!notes) throw "Notes not loaded";
    // Re-read every note fresh from disk before building the payload.
    // CardGrid's in-memory `notes[].body` is only set at load time —
    // Card edits write to disk but don't flow back into this array, so
    // using it here would publish stale (often empty) bodies for any
    // note created or edited this session.
    const fresh = await loadAndNormalizeAll();
    setNotes(fresh);
    const site = collectPublishedSite({
      vaultNotes: fresh.map((n) => ({ filename: n.filename, frontmatter: n.frontmatter, body: n.body })),
      home,
    });
    const dataJson = JSON.stringify(site);
    const vault = await vaultRoot();
    // Viewer bundle path: in dev this is <project>/dist-viewer. The
    // user must `pnpm build:viewer` once before publishing. A
    // production build would resolve via Tauri resource_dir; the
    // hardcoded dev path stays for now.
    const home_root = await homeDir();
    const viewerBundlePath = await join(home_root, "Documents", "Dropbox", "order", "src", "dist-viewer");
    return invoke<PublishOutcome>("publish_site", {
      input: {
        home_target: home.target,
        vault_path: vault,
        viewer_bundle_path: viewerBundlePath,
        data_json: dataJson,
      },
    });
  }, [notes]);

  /** Notes flagged `public: true` in YAML — the set that ships with
   *  the next Publish action. */
  const publishableNotes: PublishableNote[] = useMemo(() => {
    if (!notes) return [];
    return notes
      .filter((n) => n.frontmatter.public === true)
      .map((n) => ({
        filename: n.filename.replace(/\.md$/i, ""),
        title: (typeof n.frontmatter.title === "string" && n.frontmatter.title)
          || n.filename.replace(/\.md$/i, ""),
        folderRef: noteFolder(n.frontmatter) ?? null,
        path: n.path,
      }));
  }, [notes]);
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
   *  Area file doesn't exist yet, create it inside <vault>/<Area>/
   *  per the nested chain layout and also add the Area to Areas.md.
   *  Caps at 10. */
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
    // Locate (or create) the Area file. Existing layout: lookup via
    // loaded notes. Brand new Area: place at <vault>/<Area>/<Area>.md.
    let areaPath = notePathByRef(trimmedArea);
    if (!areaPath) {
      areaPath = await join(subdir, trimmedArea, `${trimmedArea}.md`);
      const body = `# ${trimmedArea}\n`;
      await invoke("write_text", { path: areaPath, content: joinFrontmatter({ list: "cards" }, body) });
    }
    // Append category bullet to the Area file.
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

  const handleRemoveCategory = useCallback(async (_name: string, areaName: string) => {
    const areaPath = notePathByRef(areaName);
    if (!areaPath) return;
    await mutateBullets(
      areaPath,
      (p) => invoke<string>("read_text", { path: p }),
      (p, c) => invoke("write_text", { path: p, content: c }),
      (items) => items.filter((i) => i.ref.toLowerCase() !== _name.toLowerCase()),
    );
    await reloadNotes();
  }, [reloadNotes]);

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
  const [publishOpen, setPublishOpen] = useState(false);
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
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        setPublishOpen((open) => !open);
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
          const subdir = await vaultRoot();
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
  }, [gridEl, notes, filters, view]);

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
      // Query the document, not a single grid — newspaper mode renders
      // many per-section grids, so the flat `gridEl` is null there.
      const cell = document.querySelector<HTMLElement>(
        `.card-grid-cell[data-path="${CSS.escape(target)}"]`,
      );
      if (cell) {
        cell.scrollIntoView({ behavior: "smooth", block: "start" });
        cell.classList.add("is-target");
        setTimeout(() => cell.classList.remove("is-target"), 1400);
      }
      setScrollTargetPath(null);
      // Drop the autoFocus flag once the Card has had time to
      // consume it; otherwise re-renders far in the future would
      // still re-fire focus on the same card.
      setFocusPath(null);
    }, 120);
    return () => clearTimeout(timer);
  }, [view, scrollTargetPath]);

  const createNote = useCallback(async (patch: Frontmatter): Promise<void> => {
    const root = await vaultRoot();
    // Defaults match the auto-inject path: notes get allDay=false unless
    // the caller explicitly says otherwise (Year + Month all-day clicks).
    const frontmatter: Frontmatter = { allDay: false, ...patch };
    // Catch-all: a new capture with no explicit folder lands in the
    // home Notable Folder (the one whose YAML carries `home: "..."`).
    // Empty vaults skip this and the file just goes at root.
    if (!frontmatter.folder && homeFolderRef.current) {
      frontmatter.folder = `[[${homeFolderRef.current}]]`;
    }
    // New note's directory = the linked folder's directory in the
    // chain (e.g., Creative/Creative Spaces/Geet Duggal/). We find
    // it via the loaded notes; if the folder ref doesn't resolve,
    // fall back to vault root.
    const folderRef = parseRef(frontmatter.folder);
    const writeDir = folderRef && noteDirByRef(folderRef) || root;
    const content = joinFrontmatter(frontmatter, "");
    const title = typeof patch.title === "string" ? patch.title : "Untitled";
    const date = typeof frontmatter.date === "string" ? frontmatter.date : undefined;
    const basename = basenameForEvent(date, title);
    const path = await uniqueWrite(writeDir, basename, content);
    const filename = path.split("/").pop() ?? basename;
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: filename.replace(/\.md$/, ""), body: "" },
    ]);
    // Land focus + scroll on the new note. Both Stream and the
    // calendar views consume scrollTargetPath; the Card itself
    // picks up autoFocus on mount.
    setFocusPath(path);
    setScrollTargetPath(path);
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

  /** Toggle the note's `public: true` flag. Public = opted into the
   *  static site bundle the Publish button generates. Absence of the
   *  field means private; we strip the key on toggle-off so YAML
   *  stays clean. */
  const handleTogglePublic = useCallback(async (path: string, makePublic: boolean) => {
    const raw = await invoke<string>("read_text", { path });
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    if (makePublic) next.public = true;
    else delete next.public;
    await invoke("write_text", { path, content: joinFrontmatter(next, body) });
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  /** Create a new Notable Folder Main Document for the given area +
   *  category. With the nested chain layout the file lives at
   *  <vault>/<Area>/<Category>/<Name>/<Name>.md and the Category's
   *  bullet list gains a [[Name]] entry. */
  const handleCreateFolder = useCallback(async (name: string, areaName: string, categoryName: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Locate the Category file via the loaded notes; the NF dir
    // sits next to it inside the Category's directory.
    const catDir = noteDirByRef(categoryName);
    if (!catDir) {
      flashCap(`Couldn't find ${categoryName} on disk — add the Category first.`);
      return;
    }
    // Cap on-disk folder names at 78 chars so we don't bump into
    // path-length limits and so the filesystem stays browsable. The
    // bullet ref + filename track each other (the resolver matches
    // by filename); the full original goes to `title:` so the card
    // label and list rows can render the pretty form.
    const safe = trimmed.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();
    const frontmatter: Frontmatter = {
      category: categoryName,
      area: areaName,
      list: "cards",
      ...(safe !== trimmed ? { title: trimmed } : {}),
    };
    const body = `# ${trimmed}\n`;
    const content = joinFrontmatter(frontmatter, body);
    const nfDir = await join(catDir, safe);
    const path = await uniqueWrite(nfDir, `${safe}.md`, content);
    const filename = path.split("/").pop() ?? `${safe}.md`;
    // Bullet ref = the on-disk basename (safe) so the resolver finds
    // the file; without this the parent's list would point at a name
    // that no .md file matches.
    const bulletRef = filename.replace(/\.md$/i, "");
    const catPath = notePathByRef(categoryName);
    if (catPath) {
      await mutateBullets(
        catPath,
        (p) => invoke<string>("read_text", { path: p }),
        (p, c) => invoke("write_text", { path: p, content: c }),
        (items) => items.some((i) => i.ref.toLowerCase() === bulletRef.toLowerCase())
          ? items
          : [...items, { ref: bulletRef }],
      );
    }
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: trimmed, body },
    ]);
  }, [flashCap]);

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

  // Category → Area map derived from the on-disk chain (Areas.md
  // walk). Lets us fill in a Notable Folder's missing `area:` from
  // the structure rather than requiring every NF YAML to repeat it.
  const areaByCategory = new Map<string, string>();
  for (const a of vaultTaxonomy.areas) {
    for (const c of a.categories) areaByCategory.set(c.ref, a.ref);
  }

  function inferredArea(n: LoadedNote): string {
    const yaml = parseRef(n.frontmatter.area);
    if (yaml) return yaml;
    const cat = parseRef(n.frontmatter.category);
    if (cat) return areaByCategory.get(cat) ?? "";
    return "";
  }

  // Notable Folder Main Documents — notes whose YAML carries `category`.
  // Their title comes from the filename minus the .md (which is also
  // the slug other notes use to point at them via `folder: [[Name]]`).
  const notableFolders: NotableFolder[] = notes
    .filter((n) => isNotableFolder(n.frontmatter))
    .map((n) => ({
      name: n.filename.replace(/\.md$/, ""),
      area: inferredArea(n),
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
    body: n.body,
  }));

  // Hide intermediate Area / Category list files from the Stream.
  // They're navigation infrastructure; the Sidebar drill is the
  // surface for editing them.
  const streamCandidates = notes.filter((n) => {
    const ref = n.filename.replace(/\.md$/, "");
    return !vaultTaxonomy.hiddenRefs.has(ref);
  });

  // Does this note belong to `ref` — either it IS that folder's Main
  // Document, or it links to that folder via `folder: [[ref]]`.
  const belongsTo = (n: LoadedNote, ref: string): boolean => {
    if (n.filename.replace(/\.md$/, "") === ref) return true;
    return noteFolder(n.frontmatter) === ref;
  };

  // Filter semantics:
  //   - include pills compose with OR — a note survives if it belongs
  //     to ANY include. With zero includes, everything passes the
  //     include stage.
  //   - exclude pills then drop any note belonging to an excluded
  //     folder.
  const includeRefs = filters.filter((f) => f.kind === "include").map((f) => f.ref);
  const excludeRefs = filters.filter((f) => f.kind === "exclude").map((f) => f.ref);
  const filterMatches = (n: LoadedNote): boolean => {
    if (includeRefs.length > 0 && !includeRefs.some((r) => belongsTo(n, r))) return false;
    if (excludeRefs.some((r) => belongsTo(n, r))) return false;
    return true;
  };

  const filteredNotes = (includeRefs.length > 0 || excludeRefs.length > 0)
    ? streamCandidates.filter(filterMatches)
    : streamCandidates;

  // Single-folder mode = exactly one include filter. In this mode the
  // folder reads like a "page": its Main Document gets the full-width
  // cover treatment at the top, its notes below. Any other state
  // (multiple includes, or none) treats Notable Folders as ordinary
  // cards in a flat recency timeline.
  const singleFolderMode = includeRefs.length === 1;

  // The Stream is one recency-ordered timeline (newest first), keyed
  // off the note's date + startTime frontmatter.
  const sortKey = (n: LoadedNote): string => {
    const d = typeof n.frontmatter.date === "string" ? n.frontmatter.date : "0000-00-00";
    const t = typeof n.frontmatter.startTime === "string" ? n.frontmatter.startTime : "00:00";
    return `${d} ${t}`;
  };
  // In single-folder mode, pin that folder's Main Document to the very
  // top (its cover). Driven by the include, or by an explicit pill
  // click (focusedFolder) which only matters in single mode.
  const pinnedRef = singleFolderMode
    ? (focusedFolder ?? includeRefs[0])
    : null;
  const isPinnedMain = (n: LoadedNote): boolean =>
    pinnedRef !== null
    && isNotableFolder(n.frontmatter)
    && n.filename.replace(/\.md$/, "") === pinnedRef;
  const sortedNotes = [...filteredNotes].sort((a, b) => {
    const am = isPinnedMain(a);
    const bm = isPinnedMain(b);
    if (am !== bm) return am ? -1 : 1;
    return sortKey(b).localeCompare(sortKey(a));
  });

  // Render one note as a <Card>. Shared by the temporal flat grid and
  // the newspaper sections; capHeight is only set in newspaper mode.
  const cardNode = (n: LoadedNote, capHeight?: number) => {
    const isMain = isNotableFolder(n.frontmatter);
    const ref = n.filename.replace(/\.md$/, "");
    const folderName = isMain ? ref : noteFolder(n.frontmatter);
    const c = folderName ? folderColor(folderName) : undefined;
    const inFilter = includeSet.has(ref);
    return (
      <Card
        path={n.path}
        color={c}
        area={isMain ? inferredArea(n) ?? undefined : undefined}
        category={isMain ? parseRef(n.frontmatter.category) ?? undefined : undefined}
        currentFolder={isMain ? undefined : (noteFolder(n.frontmatter) ?? null)}
        availableFolders={isMain ? undefined : availableFolderRefs}
        onAssignFolder={isMain ? undefined : (name) => handleAssignFolder(n.path, name)}
        onTogglePublic={(makePublic) => handleTogglePublic(n.path, makePublic)}
        isPublic={n.frontmatter.public === true}
        vaultNotes={vaultNotesIndex}
        onNavigate={navigateToRef}
        onAddFilter={addFolderToFilter}
        onRemoveFromFilter={inFilter ? () => removeFilter({ kind: "include", ref }) : undefined}
        autoFocus={focusPath === n.path}
        capHeight={capHeight}
        onRenamed={(newPath) => handleCardRenamed(n.id, newPath)}
        onTitleChanged={(t) => handleCardTitleChanged(n.id, t)}
        onDelete={(path) => handleCardDelete(n.id, path)}
      />
    );
  };

  // Newspaper mode: active whenever ≥1 Notable Folder is filtered IN
  // (this includes the default single home-include view). Each
  // included folder becomes a section — its Main Document as the
  // centerpiece, its notes orbiting below, newest first. An empty or
  // exclude-only filter falls through to the flat temporal stream.
  const MAIN_CAP = 1400;
  const NOTE_CAP = 440;
  const newspaperMode = includeRefs.length >= 1;
  // A single section (the home page, or one folder filtered in) shows
  // its Main Document uncapped so the page reads uninterrupted. With
  // several stacked sections, cap each Main Doc to keep visual weight
  // even.
  const mainCap = includeRefs.length > 1 ? MAIN_CAP : undefined;
  const sections = newspaperMode
    ? includeRefs.map((ref) => {
        const mainNote = filteredNotes.find(
          (n) => isNotableFolder(n.frontmatter) && n.filename.replace(/\.md$/, "") === ref,
        );
        const sectionNotes = filteredNotes
          .filter((n) => !isNotableFolder(n.frontmatter) && noteFolder(n.frontmatter) === ref)
          .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
        const centerpiece: SectionCell | null = mainNote
          ? { key: mainNote.id, dataPath: mainNote.path, node: cardNode(mainNote, mainCap) }
          : null;
        const noteCells: SectionCell[] = sectionNotes.map((n) => ({
          key: n.id, dataPath: n.path, node: cardNode(n, NOTE_CAP),
        }));
        return { ref, centerpiece, noteCells };
      })
    : [];

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
          // New captures key off the INCLUDE filters only (excludes
          // like the default-home one don't imply a capture target).
          // 1 include → auto-assign; 0 → plain note (lands in home);
          // 2+ → picker.
          const sel = [...includeSet];
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

      <button
        type="button"
        className="jump-to-notes"
        onClick={() => {
          // Toggle between jumping down to the first non-NF note in
          // the active filter and jumping back to the top of the
          // grid. The icon flips to match the next action.
          if (jumpedDown) {
            const grid = gridEl;
            grid?.scrollIntoView({ behavior: "smooth", block: "start" });
            window.scrollTo({ top: 0, behavior: "smooth" });
            setJumpedDown(false);
            return;
          }
          const firstNote = sortedNotes.find((n) => !isNotableFolder(n.frontmatter));
          if (firstNote) {
            setView("stream");
            setScrollTargetPath(firstNote.path);
            setJumpedDown(true);
          }
        }}
        title={jumpedDown ? "Back to top" : "Jump to notes"}
        aria-label={jumpedDown ? "Back to top" : "Jump to notes for this folder"}
      >
        {jumpedDown
          ? <ChevronsUp size={13} strokeWidth={1.8} />
          : <ChevronsDown size={13} strokeWidth={1.8} />}
      </button>

      <button
        type="button"
        className="publish-fab"
        onClick={() => setPublishOpen((o) => !o)}
        title="Publish (Cmd+P)"
        aria-label="Publish"
      >
        <UploadIcon size={13} strokeWidth={1.8} />
      </button>

      {creatorOpen && (
        <div className="new-note-picker" role="menu">
          {[...includeSet].map((name) => {
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

      <button
        type="button"
        className="home-reset"
        onClick={() => { resetToDefault(); setJumpedDown(false); }}
        title="Reset filters (home view)"
        aria-label="Reset filters to the default home view"
      >
        <HouseIcon size={13} strokeWidth={1.8} />
      </button>

      <FilterPillStack
        filters={filters}
        onRemove={removeFilter}
        onJump={(ref) => {
          // Focus this folder: pin its Main Document to the top of the
          // Stream (without changing the filter set), then scroll to
          // it. (× on the pill removes the filter.)
          setView("stream");
          setFocusedFolder(ref);
          const path = notePathByRef(ref);
          if (path) setScrollTargetPath(path);
        }}
      />

      <main className="pane-main">
        {view === "stream" && (
          newspaperMode ? (
            <div className="nf-sections">
              {sections.map((s) => (
                <NotebookSection
                  key={s.ref}
                  sectionRef={s.ref}
                  centerpiece={s.centerpiece}
                  notes={s.noteCells}
                  collapseSignal={collapseNonce}
                />
              ))}
            </div>
          ) : (
            <div className="card-grid" ref={setGridEl}>
              {sortedNotes.map((n) => (
                <div className="card-grid-cell" data-path={n.path} key={n.id}>
                  {cardNode(n)}
                </div>
              ))}
            </div>
          )
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
          // Sidebar is pure navigation now: clicking a folder ADDS an
          // include pill (never toggles). `selected` only drives the
          // visual checkmark for orientation. Clear resets to default.
          selected={includeSet}
          onToggle={addInclude}
          onClear={resetToDefault}
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
          selected={includeSet}
          onToggle={addInclude}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {publishOpen && (
        <PublishPanel
          homes={homeFolders}
          publishableNotes={publishableNotes}
          onPublish={handlePublish}
          onClose={() => setPublishOpen(false)}
        />
      )}

      {capWarning && (
        <div className="cap-warning" role="status">{capWarning}</div>
      )}
    </div>
  );
}

