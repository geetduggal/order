// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Stream masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Upload as UploadIcon, Settings as SettingsIcon, Files, FileText, ZoomIn, ZoomOut, Moon, MoonStar, Sun, Monitor, Flag, TreePine, Rocket, Globe, Lock, Folder as FolderIcon } from "lucide-react";
import { useTextScale, stepTextScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_STEP } from "../lib/text-scale";
import { useTheme, toggleTheme, nextTheme, themeLabel } from "../lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { vaultRoot, walkVaultMarkdown, setVaultOverride, toVaultRel, isIos, isIosSync, syncVaultRoot } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import { useGridLayout } from "../lib/grid-layout";
import { Card } from "./Card";
import { CalendarView, type NoteMeta } from "./CalendarView";
import { YearLinearView } from "./YearLinearView";
import { Sidebar, type NotableFolder } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { PublishPanel, type HomeFolder, type PublishableNote, type PublishOutcome } from "./PublishPanel";
import { SettingsPanel } from "./SettingsPanel";
import { collectPublishedSite } from "../lib/publish";
import { folderColor, isNotableFolder, noteFolder, parseRef } from "../lib/folders";
import { rewriteWikilinksForRename } from "../lib/wikilink";
import { slugify, dedupeSlug } from "../lib/slug";
import { prerenderPages } from "../lib/prerender";
import { vaultDir, embeddedImageFiles } from "../lib/attachments";
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
  // The sidebar always starts CLOSED — it's never open by default. The
  // toggle (›/‹ or Cmd+;) controls it per session.
  return false;
}
function writeSidebarOpen(open: boolean): void {
  try { localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0"); } catch { /* non-fatal */ }
}

// "Notes only" filter: when on, the Stream hides Notable-Folder cards and
// shows ordinary notes only. Persists across sessions.
const NOTES_ONLY_KEY = "order.notesOnly";
function readNotesOnly(): boolean {
  try { return localStorage.getItem(NOTES_ONLY_KEY) === "1"; } catch { return false; }
}
function writeNotesOnly(on: boolean): void {
  try { localStorage.setItem(NOTES_ONLY_KEY, on ? "1" : "0"); } catch { /* non-fatal */ }
}

// Persist the active view across sessions, with a viewport-aware default
// (Day on phones, Week on desktop) on first launch.
const VIEW_KEY = "order.view";
function readInitialView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "stream" || v === "day" || v === "week" || v === "month" || v === "year") return v;
  } catch { /* non-fatal */ }
  // Touch-sized viewport (≤640px wide) starts in Day; everything else
  // gets Week — the same breakpoint the layout collapses at.
  try {
    if (window.matchMedia("(max-width: 640px)").matches) return "day";
  } catch { /* non-fatal */ }
  return "week";
}
function writeView(v: View): void {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* non-fatal */ }
}

// "Public only" filter: when on, the Stream shows only notes flagged
// `public: true`. Off (default) shows public + private together.
const PUBLIC_ONLY_KEY = "order.publicOnly";
function readPublicOnly(): boolean {
  try { return localStorage.getItem(PUBLIC_ONLY_KEY) === "1"; } catch { return false; }
}
function writePublicOnly(on: boolean): void {
  try { localStorage.setItem(PUBLIC_ONLY_KEY, on ? "1" : "0"); } catch { /* non-fatal */ }
}

// Filter model (`Filter`, pill stack) is shared with the web viewer
// via ../lib/filters + ./FilterPillStack.
//
// Bumped to .v2 when the default flipped from exclude-home to
// include-home, then .v3 to clear a stale empty-set a transient build
// could persist (which suppressed the home seed) — each bump
// invalidates the pre-existing persisted set once so the home-focused
// default re-seeds on next launch.
const FILTERS_KEY = "order.activeFilters.v3";

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
// All file ops route through the vault-relative bridge. These wrap an
// (absolute on desktop, relative on iOS) path with toVaultRel so callers
// don't care which form they hold.
const readVault = (p: string) => vaultFs.readText(toVaultRel(p));
const writeVault = (p: string, content: string) => vaultFs.writeText(toVaultRel(p), content);

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
      await readVault(path);
      // File exists — bump and retry.
      candidate = `${stem} ${n}${ext}`;
      n++;
    } catch {
      // Read failed → assume the file doesn't exist; safe to write.
      await writeVault(path, content);
      return path;
    }
  }
  throw new Error(`Couldn't find a unique name for ${basename}`);
}


/** Derive the published base URL from a home target "user/repo/path".
 *  A `<user>.github.io` repo is served at its root; other repos live
 *  under /<repo>/. (A custom domain still resolves the github.io URL.)
 *  Used to build a copyable permalink for a public note on desktop. */
function publicBaseUrl(target: string): string | null {
  const parts = target.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [user, repo, ...rest] = parts;
  const path = rest.join("/");
  const host = repo.toLowerCase() === `${user.toLowerCase()}.github.io`
    ? repo
    : `${user}.github.io/${repo}`;
  return `https://${host}/${path ? `${path}/` : ""}`;
}

const GRID_ROW_PX = 8;

type View = "stream" | "day" | "week" | "month" | "year";

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

/** Strip the markdown syntax most likely to appear in a note's first line
 *  so the derived title reads as plain text — leading list markers and
 *  task checkboxes, wikilinks (including Milkdown's backslash-escaped
 *  form), markdown links, inline code, emphasis, and backslash escapes
 *  of markdown specials. Conservative: pure text passes through. */
function stripMarkdownInline(s: string): string {
  let t = s;
  // Leading list marker: `-`, `*`, `+`, or `N.`
  t = t.replace(/^([-*+]|\d+\.)\s+/, "");
  // Leading task checkbox: `[ ]`, `[x]`, `[X]`
  t = t.replace(/^\[[\sxX]\]\s+/, "");
  // Wikilinks: `[[Page]]` → Page, `[[Page|Alias]]` → Alias. Allow optional
  // backslash escapes around the brackets (Milkdown emits `\[\[…\]\]`).
  t = t.replace(/\\?\[\\?\[\s*([^\]|]+?)(?:\s*\|\s*([^\]]+?))?\s*\\?\]\\?\]/g,
    (_m, page, alias) => (alias ?? page).trim());
  // Markdown links: `[text](url)` → text
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Inline code
  t = t.replace(/`([^`]+)`/g, "$1");
  // Emphasis (display-grade — good enough for a one-line title)
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1").replace(/_([^_]+)_/g, "$1");
  // Strip remaining backslash escapes of markdown specials
  t = t.replace(/\\([\[\]()*_`#~|<>!])/g, "$1");
  return t.trim();
}

function deriveTitle(body: string, fallback: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const raw = t.startsWith("#") ? t.replace(/^#+\s*/, "") : t;
    const cleaned = stripMarkdownInline(raw);
    if (!cleaned) continue; // a heading that was pure syntax — try next line
    return cleaned.length > 60 ? cleaned.slice(0, 57) + "…" : cleaned;
  }
  // No usable H1: fall back to the filename, stripping any
  // `YYYY-MM-DD ` / `YYYY-MM-DD - ` date prefix so calendar / card titles
  // read as "Untitled" rather than "2026-05-26 Untitled".
  return fallback.replace(/^\d{4}-\d{2}-\d{2}\s*-?\s*/, "") || fallback;
}

async function loadOne(path: string, filename: string, seed?: string): Promise<LoadedNote> {
  let raw: string;
  try {
    raw = await readVault(path);
  } catch {
    if (seed === undefined) throw new Error(`read failed and no seed for ${path}`);
    await writeVault(path, seed);
    raw = seed;
  }
  let { frontmatter, body } = splitFrontmatter(raw);
  const patch = suggestCalendarPatch(frontmatter, body);
  if (patch) {
    frontmatter = { ...frontmatter, ...patch };
    const next = joinFrontmatter(frontmatter, body);
    try {
      await writeVault(path, next);
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
  const [view, setView] = useState<View>(readInitialView);
  // Persist every view change so a relaunch resumes the same calendar/stream
  // (and so the viewport-default only applies on the very first launch).
  useEffect(() => { writeView(view); }, [view]);
  const [scrollTargetPath, setScrollTargetPath] = useState<string | null>(null);
  /** Path of the most recently created note. The matching Card
   *  mounts with `autoFocus` so the cursor lands inside its editor
   *  the moment it appears. Cleared by the same scroll-target
   *  effect that handles the highlight pulse. */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
  // Note text size — shared with the Cmd± shortcuts in App via the
  // text-scale module (font-size scaling, not page zoom, so the editor
  // caret stays aligned). The rail +/- buttons step it.
  const textScale = useTextScale();
  // Light/dark theme — rail moon/sun button toggles it.
  const theme = useTheme();
  // Active filter pills. `null` until hydrated so the first-load
  // default-home-exclude effect can tell "never set" from "user
  // cleared everything".
  const [filters, setFilters] = useState<Filter[]>(() => readStoredFilters() ?? []);
  // Bumped by the home-reset to collapse every section's Show-more
  // expansion back to its first batch.
  const [collapseNonce, setCollapseNonce] = useState(0);
  // The folder whose Main Document is pinned to the top of the Stream.
  // Set by clicking a filter pill or picking one in the command
  // palette. Cleared only when that folder is no longer an active
  // include — so adding it (which changes `filters`) doesn't wipe the
  // focus we just set.
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  useEffect(() => {
    setFocusedFolder((cur) =>
      cur && filters.some((f) => f.kind === "include" && f.ref === cur) ? cur : null,
    );
  }, [filters]);
  // "Notes only" toggle: hide Notable-Folder cards from the Stream and
  // show ordinary notes only. Persisted; survives filter changes.
  const [notesOnly, setNotesOnly] = useState<boolean>(readNotesOnly);
  // "Public only" toggle: show only `public: true` notes in the Stream
  // (off = public + private together). Persisted; survives filter changes.
  const [publicOnly, setPublicOnly] = useState<boolean>(readPublicOnly);
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
    // No more home-folder seeding: clearing filters clears them. The
    // calendar / Stream then show everything in scope (subject to the
    // notes-only / public-only toggles).
    setFilters([]);
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
  /** Pick a folder from the command palette: switch to the Stream,
   *  add it as an include, pin its Main Document, and scroll to it —
   *  so Cmd+K lands you ON that page. */
  const focusFolder = useCallback((ref: string) => {
    setView("stream");
    addInclude(ref);
    setFocusedFolder(ref);
    const path = notePathByRef(ref);
    if (path) setScrollTargetPath(path);
  }, [addInclude]);

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

  /** Absolute path of the loaded Areas note. Prefer the path the note was
   *  loaded from (always under the active vault root, including the iOS
   *  security-scoped bookmark) over reconstructing it from vaultRoot(),
   *  which on iOS resolves to the wrong default home-dir path and makes
   *  area writes silently miss. Returns null only when no Areas note
   *  exists yet (a fresh vault), in which case callers fall back. */
  function areasNotePath(): string | null {
    const list = notesRef.current ?? [];
    const found =
      list.find((n) => n.frontmatter?.role === "areas") ??
      list.find((n) => n.filename === AREAS_FILENAME);
    return found?.path ?? null;
  }

  // iOS only: true when no vault folder has been picked yet (no stored
  // bookmark), so the UI prompts to choose one instead of showing empty.
  const [iosNeedsVault, setIosNeedsVault] = useState(false);

  const reloadNotes = useCallback(async () => {
    try {
      // On iOS an empty root means no vault bookmark yet — prompt a pick
      // rather than rendering an empty vault.
      const root = await syncVaultRoot();
      if (!root && (await isIos())) {
        setIosNeedsVault(true);
        setNotes([]);
        return;
      }
      setIosNeedsVault(false);
      const fresh = await loadAndNormalizeAll();
      // Stable identity across reloads: when a note's path still exists,
      // reuse its previous id so React keys don't change. This keeps
      // mounted Cards (with their Milkdown editors, focus, scroll) from
      // remounting on every chain mutation or watcher-driven reload.
      // New paths keep their freshly-minted ids; removed paths fall out.
      const prevById = new Map<string, string>();
      for (const n of notesRef.current ?? []) prevById.set(n.path, n.id);
      const stable = fresh.map((n) => {
        const prevId = prevById.get(n.path);
        return prevId ? { ...n, id: prevId } : n;
      });
      setNotes(stable);
    } catch (err) {
      console.error("reload failed:", err);
    }
  }, []);

  // Live file watching: start the Rust-side notify watcher once we know
  // the vault root, then reload on each debounced `vault-changed` event
  // so external edits (git pull, Obsidian, an editor in another window)
  // show up without restarting the app. The Rust side already debounces
  // raw fs events at 500ms; we add a small JS-side coalesce so a burst
  // of multi-path notifications only triggers one reload.
  //
  // iOS is sandboxed and our vault lives behind a security-scoped
  // bookmark — notify doesn't reliably observe it from outside the app,
  // and our own writes go through the bridge which already updates state
  // optimistically. Watcher is desktop-only.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleReload() {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; void reloadNotes(); }, 250);
    }
    async function start() {
      if (await isIos()) return;
      const root = await syncVaultRoot();
      if (!root || cancelled) return;
      try {
        await invoke("start_watcher", { path: root });
        unlisten = await listen<string[]>("vault-changed", () => scheduleReload());
      } catch (err) {
        console.error("watcher start failed:", err);
      }
    }
    void start();
    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      if (unlisten) unlisten();
    };
  }, [reloadNotes]);

  /** iOS: present the native folder picker; on selection the bookmark is
   *  persisted, so a reload restores + opens it for the session. */
  const pickVaultIos = useCallback(async () => {
    try {
      const v = await vaultFs.pickFolder();
      if (v.path) {
        setIosNeedsVault(false);
        await reloadNotes();
      }
    } catch (err) {
      console.error("pick vault failed:", err);
    }
  }, [reloadNotes]);

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
  // Default at app open: no folder filter. The calendar shows everything
  // dated; the Stream shows the full recency timeline. Used to seed the
  // home folder as an include on first launch (and force it on every iOS
  // launch) — that's gone now, in line with letting the calendar be the
  // default landing surface and lazy-loading bodies. The persisted set
  // (if any) is still restored below by the storage-bound effect.
  useLayoutEffect(() => { seededDefault.current = true; }, []);

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

    // Pin a stable slug into every public note that lacks one, so
    // permalinks never derive from (mutable) titles. Writes frontmatter
    // to disk; runs before collect so the payload carries the slugs.
    const publicNotes = fresh.filter((n) => n.frontmatter.public === true);
    const taken = new Set<string>();
    for (const n of publicNotes) {
      if (typeof n.frontmatter.slug === "string" && n.frontmatter.slug) taken.add(n.frontmatter.slug);
    }
    for (const n of publicNotes) {
      if (typeof n.frontmatter.slug === "string" && n.frontmatter.slug) continue;
      const title = typeof n.frontmatter.title === "string" && n.frontmatter.title.trim()
        ? n.frontmatter.title : n.filename.replace(/\.md$/i, "");
      const slug = dedupeSlug(slugify(title), taken);
      taken.add(slug);
      const raw = await readVault(n.path);
      const { frontmatter, body } = splitFrontmatter(raw);
      frontmatter.slug = slug;
      await writeVault(n.path, joinFrontmatter(frontmatter, body));
      n.frontmatter.slug = slug; // reflect into the fresh copy collect reads
    }

    const sub = home.target.split("/").slice(2).join("/");
    const { site, assets } = collectPublishedSite({
      vaultNotes: fresh.map((n) => ({
        filename: n.filename,
        dir: vaultDir(toVaultRel(n.path)),
        frontmatter: n.frontmatter,
        body: n.body,
      })),
      home,
      sub,
    });
    const dataJson = JSON.stringify(site);
    const pages = prerenderPages(site, sub);
    const vault = await vaultRoot();
    return invoke<PublishOutcome>("publish_site", {
      input: {
        home_target: home.target,
        vault_path: vault,
        // Rust resolves the viewer bundle (dev build dir, or the
        // Tauri resource dir in production) — nothing to send here.
        viewer_bundle_path: "",
        data_json: dataJson,
        pages,
        // Same-folder images to copy next to each note's published page.
        assets,
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
    const path = areasNotePath() ?? (await join(subdir, AREAS_FILENAME));
    const ok = await mutateBullets(
      path,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
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
    const path = areasNotePath() ?? (await join(subdir, AREAS_FILENAME));
    await mutateBullets(
      path,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
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
      areasNotePath() ?? (await join(subdir, AREAS_FILENAME)),
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
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
      await writeVault(areaPath, joinFrontmatter({ list: "cards" }, body));
    }
    // Create the Category note nested under the Area's directory so the
    // on-disk layout mirrors Area → Category → Notable Folder. If a note
    // with this name already exists, reuse it. The bullet ref tracks the
    // on-disk filename so the chain resolver finds it.
    let catRef = trimmed;
    if (!notePathByRef(trimmed)) {
      const areaDir = areaPath.slice(0, areaPath.lastIndexOf("/"));
      const safeCat = (trimmed.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim()) || trimmed;
      const catContent = joinFrontmatter(
        { list: "cards", ...(safeCat !== trimmed ? { title: trimmed } : {}) },
        `# ${trimmed}\n`,
      );
      const catPath = await uniqueWrite(await join(areaDir, safeCat), `${safeCat}.md`, catContent);
      catRef = (catPath.split("/").pop() ?? `${safeCat}.md`).replace(/\.md$/i, "");
    }
    // Append category bullet to the Area file.
    const ok = await mutateBullets(
      areaPath,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
      (items) => {
        if (items.some((i) => i.ref.toLowerCase() === catRef.toLowerCase())) return items;
        if (items.length >= 10) { flashCap(`${trimmedArea} full (10 / 10 categories) — remove one to add another.`); return null; }
        return [...items, { ref: catRef }];
      },
    );
    if (ok) await reloadNotes();
  }, [cardsSubdir, reloadNotes, flashCap]);

  const handleRemoveCategory = useCallback(async (_name: string, areaName: string) => {
    const areaPath = notePathByRef(areaName);
    if (!areaPath) return;
    await mutateBullets(
      areaPath,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
      (items) => items.filter((i) => i.ref.toLowerCase() !== _name.toLowerCase()),
    );
    await reloadNotes();
  }, [reloadNotes]);

  // Reorder a bullet within its list file by one slot (up = earlier).
  // Returns silently if the item is missing or already at the edge.
  const reorderIn = useCallback(async (path: string | null, ref: string, dir: "up" | "down") => {
    if (!path) return;
    const ok = await mutateBullets(
      path,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
      (items) => {
        const i = items.findIndex((it) => it.ref.toLowerCase() === ref.toLowerCase());
        if (i < 0) return null;
        const j = dir === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= items.length) return null;
        const next = [...items];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
      },
    );
    if (ok) await reloadNotes();
  }, [reloadNotes]);

  const handleReorderArea = useCallback(async (name: string, dir: "up" | "down") => {
    await reorderIn(areasNotePath() ?? (await join(await cardsSubdir(), AREAS_FILENAME)), name, dir);
  }, [reorderIn, cardsSubdir]);

  const handleReorderCategory = useCallback(async (name: string, areaName: string, dir: "up" | "down") => {
    await reorderIn(notePathByRef(areaName), name, dir);
  }, [reorderIn]);

  const handleReorderFolder = useCallback(async (name: string, _areaName: string, categoryName: string, dir: "up" | "down") => {
    await reorderIn(notePathByRef(categoryName), name, dir);
  }, [reorderIn]);

  // Remove a Notable Folder from a Category: drop its bullet AND clear the
  // note's area/category YAML so it leaves the chain (the note itself is
  // kept — non-destructive, matching area/category removal).
  const handleRemoveFolder = useCallback(async (name: string, _areaName: string, categoryName: string) => {
    const catPath = notePathByRef(categoryName);
    if (catPath) {
      await mutateBullets(
        catPath,
        (p) => readVault(p),
        (p, c) => writeVault(p, c),
        (items) => items.filter((i) => i.ref.toLowerCase() !== name.toLowerCase()),
      );
    }
    const nfPath = notePathByRef(name);
    if (nfPath) {
      const raw = await readVault(nfPath);
      const { frontmatter, body } = splitFrontmatter(raw);
      const next: Frontmatter = { ...frontmatter };
      delete next.category;
      delete next.area;
      await writeVault(nfPath, joinFrontmatter(next, body));
    }
    await reloadNotes();
  }, [reloadNotes]);

  // Rewrite a list file's bullets into the given ref order (drag-reorder).
  // Refs not present are appended in their original order; no-op if the
  // order is unchanged.
  const reorderToIn = useCallback(async (path: string | null, names: string[]) => {
    if (!path) return;
    const ok = await mutateBullets(
      path,
      (p) => readVault(p),
      (p, c) => writeVault(p, c),
      (items) => {
        const byRef = new Map(items.map((it) => [it.ref.toLowerCase(), it]));
        const out: ListItem[] = [];
        for (const n of names) {
          const it = byRef.get(n.toLowerCase());
          if (it) { out.push(it); byRef.delete(n.toLowerCase()); }
        }
        for (const it of byRef.values()) out.push(it);
        const same = out.length === items.length && out.every((it, i) => it === items[i]);
        return same ? null : out;
      },
    );
    if (ok) await reloadNotes();
  }, [reloadNotes]);

  const handleReorderAreasTo = useCallback(async (names: string[]) => {
    await reorderToIn(areasNotePath() ?? (await join(await cardsSubdir(), AREAS_FILENAME)), names);
  }, [reorderToIn, cardsSubdir]);

  const handleReorderCategoriesTo = useCallback(async (areaName: string, names: string[]) => {
    await reorderToIn(notePathByRef(areaName), names);
  }, [reorderToIn]);

  const handleReorderFoldersTo = useCallback(async (_areaName: string, categoryName: string, names: string[]) => {
    await reorderToIn(notePathByRef(categoryName), names);
  }, [reorderToIn]);

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

  // Cmd+O opens the sidebar; Cmd+K opens the centered command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** Change (or reset) the vault folder from Settings: persist the
   *  choice, re-seed the home filter for the new vault, and reload. */
  const handleChangeVault = useCallback(async (path: string | null) => {
    setVaultOverride(path);
    seededDefault.current = false;
    setFilters([]);
    setFocusedFolder(null);
    await reloadNotes();
  }, [reloadNotes]);
  // Forward-ref to createNote so Cmd+N can invoke it from the keyboard
  // useEffect above the declaration site without a TS forward-ref error.
  const createNoteRef = useRef<((p: Frontmatter) => Promise<void>) | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        if (!sidebarOpen) {
          setSidebarOpen(true);
          writeSidebarOpen(true);
        }
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
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        void createNoteRef.current?.({ date: isoDate(), startTime: isoTime(), allDay: false });
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        setView("stream");
        return;
      }
      if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        setView("day");
        return;
      }
      if (e.key === "w" || e.key === "W") {
        e.preventDefault();
        setView("week");
        return;
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setView("month");
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        setView("year");
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
        // iOS with no vault bookmark yet → prompt a pick instead of
        // loading (and skip migration, which would write to a bogus
        // desktop path). setNotes([]) so we leave the "Preparing…" state.
        const root = await syncVaultRoot();
        if (!root && (await isIos())) {
          if (cancelled) return;
          setIosNeedsVault(true);
          setNotes([]);
          return;
        }

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
            const raw = await readVault(n.path);
            const { body } = splitFrontmatter(raw);
            return { filename: n.filename, path: n.path, body, frontmatter: n.frontmatter };
          }));
          const stored = readStoredTaxonomy();
          const plan = planMigration(withBody, stored);
          // Vault-relative writes (writeVault resolves against the root),
          // so this works on desktop and iOS without joining an absolute
          // root that doesn't exist on iOS.
          for (const f of plan.newFiles) {
            await writeVault(f.filename, f.content);
          }
          for (const r of plan.rewrites) {
            await writeVault(r.path, r.content);
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

  // Calendar event click opens a small popup at the cursor (Open / Delete /
  // move-to-day chips / change-folder picker) instead of jumping straight
  // to the note.
  const [eventMenu, setEventMenu] = useState<
    { path: string; title: string; x: number; y: number; date: string | null; folder: string | null } | null
  >(null);
  const handleEventClick = useCallback((path: string, coords?: { x: number; y: number }) => {
    const note = notesRef.current?.find((n) => n.path === path);
    const d = note && typeof note.frontmatter.date === "string" ? note.frontmatter.date : null;
    const f = note ? noteFolder(note.frontmatter) ?? null : null;
    setEventMenu({
      path,
      title: note?.title ?? "Untitled",
      x: coords?.x ?? window.innerWidth / 2,
      y: coords?.y ?? window.innerHeight / 2,
      date: d,
      folder: f,
    });
  }, []);
  const openEventNote = useCallback((path: string) => {
    setView("stream");
    setScrollTargetPath(path);
  }, []);
  const deleteEventNote = useCallback(async (path: string) => {
    const note = notesRef.current?.find((n) => n.path === path);
    if (!note) return;
    await handleCardDelete(note.id, path);
  }, []);
  /** Rewrite a calendar event's date to `newDate` (YYYY-MM-DD), keeping the
   *  startTime / endTime / allDay flag untouched — "move to same time on
   *  another day." Forward-ref so the action menu (declared earlier) can
   *  invoke the latest version once updateNoteFrontmatter is in scope. */
  const moveEventToDayRef = useRef<((path: string, newDate: string) => Promise<void>) | null>(null);

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

  // Calendar-create title prompt. The calendar views call promptCreate
  // (instead of createNote directly) so the user can name the event in a
  // tiny popup without having to open the note. Enter creates with the
  // typed title (becomes both the filename and the body's H1); Enter on
  // an empty input still creates (untitled) so it stays a fast capture;
  // Esc cancels.
  const [titlePrompt, setTitlePrompt] = useState<{ patch: Frontmatter } | null>(null);
  const promptCreate = useCallback(async (patch: Frontmatter): Promise<void> => {
    setTitlePrompt({ patch });
  }, []);

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
    const title = typeof patch.title === "string" ? patch.title.trim() : "";
    // Seed the body with an H1 when a title was supplied (calendar create
    // popups send one). Empty title = blank body, as before.
    const seedBody = title ? `# ${title}\n` : "";
    const content = joinFrontmatter(frontmatter, seedBody);
    const titleForName = title || "Untitled";
    const date = typeof frontmatter.date === "string" ? frontmatter.date : undefined;
    const basename = basenameForEvent(date, titleForName);
    const path = await uniqueWrite(writeDir, basename, content);
    const filename = path.split("/").pop() ?? basename;
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: title || "Untitled", body: seedBody },
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
  // Keep the forward-ref in sync so the keyboard handler (Cmd+N), which
  // sits earlier in this component, can invoke the latest createNote.
  useEffect(() => { createNoteRef.current = createNote; }, [createNote]);

  /** Rewrite every inbound `[[OldName]]` across the vault to `NewName`
   *  when a target is renamed, so source links stay valid (Obsidian
   *  behaviour). Reads each candidate fresh from disk before rewriting.
   *  NOTE: wired to the note-rename path below; Notable Folder Main Docs
   *  don't auto-rename today (their filename is their identity), so
   *  folder-rename rewriting awaits a dedicated folder-rename action. */
  const rewriteInboundWikilinks = useCallback(async (oldName: string, newName: string) => {
    if (!oldName || oldName === newName) return;
    const list = notesRef.current;
    if (!list) return;
    const target = oldName.toLowerCase();
    for (const n of list) {
      if (n.filename.replace(/\.md$/i, "") === newName) continue; // the renamed file itself
      try {
        const raw = await readVault(n.path);
        const { frontmatter, body } = splitFrontmatter(raw);
        // Cheap filter before the rewrite pass.
        if (!body.toLowerCase().includes(target)) continue;
        const nextBody = rewriteWikilinksForRename(body, oldName, newName);
        if (nextBody === body) continue;
        await writeVault(n.path, joinFrontmatter(frontmatter, nextBody));
        setNotes((prev) => prev?.map((x) => (x.id === n.id ? { ...x, body: nextBody } : x)) ?? null);
      } catch (err) {
        console.warn("inbound wikilink rewrite skipped for", n.path, err);
      }
    }
  }, []);

  const handleCardRenamed = useCallback((id: string, newPath: string) => {
    const newFilename = newPath.split("/").pop() ?? newPath;
    const oldName = notesRef.current?.find((n) => n.id === id)?.filename.replace(/\.md$/i, "") ?? null;
    const newName = newFilename.replace(/\.md$/i, "");
    setNotes((prev) =>
      prev?.map((n) =>
        n.id === id
          ? { ...n, path: newPath, filename: newFilename, title: newFilename.replace(/\.md$/, "") }
          : n,
      ) ?? null,
    );
    // Keep inbound links pointing at the new name.
    if (oldName && oldName !== newName) void rewriteInboundWikilinks(oldName, newName);
  }, [rewriteInboundWikilinks]);

  const handleCardTitleChanged = useCallback((id: string, newTitle: string) => {
    setNotes((prev) =>
      prev?.map((n) => (n.id === id ? { ...n, title: newTitle } : n)) ?? null,
    );
  }, []);

  const handleCardDelete = useCallback(async (id: string, path: string) => {
    try {
      await vaultFs.remove(toVaultRel(path));
    } catch (err) {
      console.error("delete_file failed:", err);
      throw err;
    }
    setNotes((prev) => prev?.filter((n) => n.id !== id) ?? null);
  }, []);

  /** Assign (or clear) a regular note's Notable Folder. Writes the
   *  `folder: [[Name]]` field into the file's YAML AND moves the file
   *  into that folder's directory on disk so the layout matches the
   *  YAML (mirrors where createNote places new notes). Clearing a
   *  folder just rewrites YAML and leaves the file where it is. */
  const handleAssignFolder = useCallback(async (path: string, folderName: string | null) => {
    const raw = await readVault(path);
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    if (folderName) next.folder = `[[${folderName}]]`;
    else delete next.folder;
    const content = joinFrontmatter(next, body);

    // Move into the target folder's directory when it resolves and
    // differs from where the file currently lives. write-new + delete-
    // old (via uniqueWrite) handles name collisions in the target.
    const targetDir = folderName ? noteDirByRef(folderName) : null;
    const curDir = path.slice(0, path.lastIndexOf("/"));
    if (targetDir && targetDir !== curDir) {
      const filename = path.split("/").pop() ?? "note.md";
      const newPath = await uniqueWrite(targetDir, filename, content);
      await vaultFs.remove(toVaultRel(path));
      // Move the note's same-folder images along with it so the ![[…]]
      // embeds keep resolving from the new folder.
      for (const file of embeddedImageFiles(body)) {
        try {
          await vaultFs.rename(toVaultRel(`${curDir}/${file}`), toVaultRel(`${targetDir}/${file}`));
        } catch { /* missing or already present — skip */ }
      }
      setNotes((prev) => prev?.map((n) =>
        n.path === path
          ? { ...n, path: newPath, filename: newPath.split("/").pop() ?? n.filename, frontmatter: next }
          : n) ?? null);
      return;
    }

    await writeVault(path, content);
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  /** Toggle the note's `public: true` flag. Public = opted into the
   *  static site bundle the Publish button generates. Absence of the
   *  field means private; we strip the key on toggle-off so YAML
   *  stays clean. */
  const handleTogglePublic = useCallback(async (path: string, makePublic: boolean) => {
    const raw = await readVault(path);
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    if (makePublic) next.public = true;
    else delete next.public;
    await writeVault(path, joinFrontmatter(next, body));
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
    // A Notable Folder is a plain main document (a `category` makes it an
    // NF) — NOT a list folder, so no `list:` key here. The directory is
    // created by writing the main doc inside it below.
    const frontmatter: Frontmatter = {
      category: categoryName,
      area: areaName,
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
        (p) => readVault(p),
        (p, c) => writeVault(p, c),
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
    const raw = await readVault(path);
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    // Patch protocol: `undefined` removes a key, anything else assigns.
    // Lets CalendarView drop startTime/endTime when an event is dragged
    // into the all-day strip.
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    await writeVault(path, joinFrontmatter(next, body));
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);
  // Bind moveEventToDay (declared earlier via forward-ref) to the live
  // updateNoteFrontmatter so the event action menu can move an event to
  // another day without touching its time-of-day fields.
  useEffect(() => {
    moveEventToDayRef.current = async (path: string, newDate: string) => {
      await updateNoteFrontmatter(path, { date: newDate });
    };
  }, [updateNoteFrontmatter]);

  if (iosNeedsVault) {
    return (
      <div className="vault-pick">
        <h1>Choose your vault</h1>
        <p>Pick the folder that holds your notes (e.g. your Dropbox or iCloud vault). Order remembers it.</p>
        <button type="button" className="vault-pick-btn" onClick={() => { void pickVaultIos(); }}>
          Choose folder
        </button>
      </div>
    );
  }

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

  // Notes can only live in Notable Folders, so the new-note folder picker
  // (and the single-filter auto-assign) only offers notable include
  // filters — areas/categories/other includes are not valid targets.
  const notableNames = new Set(notableFolders.map((f) => f.name));
  const notableIncludes = [...includeSet].filter((name) => notableNames.has(name));

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

  const filteredNotes = ((includeRefs.length > 0 || excludeRefs.length > 0)
    ? streamCandidates.filter(filterMatches)
    : streamCandidates)
    // "Notes only": drop Notable-Folder cards (covers + folder tiles).
    .filter((n) => !notesOnly || !isNotableFolder(n.frontmatter))
    // "Public only": drop notes without `public: true` in YAML.
    .filter((n) => !publicOnly || n.frontmatter.public === true);

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
    // Permalink only for a public note whose slug is pinned (after a
    // publish) and when a home target exists to build the URL from.
    const slug = typeof n.frontmatter.slug === "string" ? n.frontmatter.slug : "";
    const base = homeFolders[0]?.target ? publicBaseUrl(homeFolders[0].target) : null;
    const permalink =
      n.frontmatter.public === true && slug && base ? `${base}${slug}/` : undefined;
    return (
      <Card
        path={n.path}
        permalink={permalink}
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
          const sel = notableIncludes;
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
        className="publish-fab"
        onClick={() => setPublishOpen((o) => !o)}
        title="Publish (Cmd+P)"
        aria-label="Publish"
      >
        <UploadIcon size={14} strokeWidth={2.1} />
      </button>

      <button
        type="button"
        className={"notes-only-fab" + (notesOnly ? " is-on" : "")}
        onClick={() => setNotesOnly((v) => { writeNotesOnly(!v); return !v; })}
        title={notesOnly ? "Notes only — click to include notable folders" : "Notes + notable folders — click for notes only"}
        aria-label={notesOnly ? "Showing notes only" : "Showing notes and notable folders"}
        aria-pressed={notesOnly}
      >
        {notesOnly
          ? <FileText size={14} strokeWidth={2.1} />
          : <Files size={14} strokeWidth={2.1} />}
      </button>

      <button
        type="button"
        className={"public-only-fab" + (publicOnly ? " is-on" : "")}
        onClick={() => setPublicOnly((v) => { writePublicOnly(!v); return !v; })}
        title={publicOnly ? "Public only — click to include private notes" : "Public + private — click for public only"}
        aria-label={publicOnly ? "Showing public notes only" : "Showing public and private notes"}
        aria-pressed={publicOnly}
      >
        {publicOnly
          ? <Globe size={14} strokeWidth={2.1} />
          : <Lock size={14} strokeWidth={2.1} />}
      </button>

      <button
        type="button"
        className="zoom-in-fab"
        onClick={() => stepTextScale(TEXT_SCALE_STEP)}
        disabled={textScale >= TEXT_SCALE_MAX}
        title={`Larger text (${Math.round(textScale * 100)}%)`}
        aria-label="Larger text"
      >
        <ZoomIn size={14} strokeWidth={2.1} />
      </button>

      <button
        type="button"
        className="zoom-out-fab"
        onClick={() => stepTextScale(-TEXT_SCALE_STEP)}
        disabled={textScale <= TEXT_SCALE_MIN}
        title={`Smaller text (${Math.round(textScale * 100)}%)`}
        aria-label="Smaller text"
      >
        <ZoomOut size={14} strokeWidth={2.1} />
      </button>

      <button
        type="button"
        className="theme-fab"
        onClick={() => toggleTheme()}
        title={`Theme: ${themeLabel(theme)} — next: ${themeLabel(nextTheme(theme))}`}
        aria-label={`Theme ${themeLabel(theme)}, switch to ${themeLabel(nextTheme(theme))}`}
      >
        {(() => {
          const Icon = { light: Sun, dark: Moon, black: MoonStar, wordperfect: Monitor, america: Flag, christmas: TreePine, lcars: Rocket }[theme];
          return <Icon size={14} strokeWidth={2.1} />;
        })()}
      </button>

      <button
        type="button"
        className="settings-fab"
        onClick={() => setSettingsOpen(true)}
        title="Settings"
        aria-label="Settings"
      >
        <SettingsIcon size={14} strokeWidth={2.1} />
      </button>

      {creatorOpen && (
        <div className="new-note-picker" role="menu">
          {notableIncludes.map((name) => {
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

      <FilterPillStack
        filters={filters}
        onRemove={removeFilter}
        onReorder={setFilters}
        onClear={resetToDefault}
        onSearch={() => setPaletteOpen(true)}
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
        {view === "day" && (
          <CalendarView
            key="day"
            notes={calendarNotes}
            initialView="timeGridDay"
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={promptCreate}
          />
        )}
        {view === "week" && (
          <CalendarView
            key="week"
            notes={calendarNotes}
            initialView="timeGridWeek"
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={promptCreate}
          />
        )}
        {view === "month" && (
          <CalendarView
            key="month"
            notes={calendarNotes}
            initialView="dayGridMonth"
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={promptCreate}
          />
        )}
        {view === "year" && (
          <YearLinearView
            key="year"
            notes={calendarNotes}
            onMoveEvent={updateNoteFrontmatter}
            onEventClick={handleEventClick}
            onCreate={promptCreate}
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
          onCreateFolder={handleCreateFolder}
          storedAreas={storedAreas}
          storedCategories={storedCategories}
          onAddArea={handleAddArea}
          onRemoveArea={handleRemoveArea}
          onAddCategory={handleAddCategory}
          onRemoveCategory={handleRemoveCategory}
          onReorderArea={handleReorderArea}
          onReorderCategory={handleReorderCategory}
          onReorderFolder={handleReorderFolder}
          onReorderAreas={handleReorderAreasTo}
          onReorderCategories={handleReorderCategoriesTo}
          onReorderFolders={handleReorderFoldersTo}
          onRemoveFolder={handleRemoveFolder}
          order={vaultTaxonomy.areas}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={notableFolders}
          selected={includeSet}
          onToggle={focusFolder}
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

      {settingsOpen && (
        <SettingsPanel
          onChangeVault={handleChangeVault}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {capWarning && (
        <div className="cap-warning" role="status">{capWarning}</div>
      )}

      {titlePrompt && (
        <CreateEventPrompt
          onSubmit={async (title) => {
            const patch = titlePrompt.patch;
            setTitlePrompt(null);
            await createNote(title ? { ...patch, title } : patch);
          }}
          onCancel={() => setTitlePrompt(null)}
        />
      )}

      {eventMenu && (
        <EventActionMenu
          title={eventMenu.title}
          x={eventMenu.x}
          y={eventMenu.y}
          // Show "move to day" chips when we know the event's date and the
          // view is one where moving to a different day makes sense (Week
          // primarily, but also Day/Year — Month already exposes drag).
          eventDate={view === "week" || view === "day" || view === "year" ? eventMenu.date : null}
          // Notable Folder picker: current + the same list the card-footer
          // picker uses, so the gesture is consistent with what's in the
          // Stream's notes.
          currentFolder={eventMenu.folder}
          availableFolders={availableFolderRefs}
          onOpen={() => { openEventNote(eventMenu.path); setEventMenu(null); }}
          onDelete={() => { void deleteEventNote(eventMenu.path); setEventMenu(null); }}
          onMoveToDay={(iso) => {
            void moveEventToDayRef.current?.(eventMenu.path, iso);
            setEventMenu(null);
          }}
          onAssignFolder={async (name) => {
            await handleAssignFolder(eventMenu.path, name);
            setEventMenu(null);
          }}
          onCancel={() => setEventMenu(null)}
        />
      )}
    </div>
  );
}

/** Small popup at the cursor for a clicked calendar event. Open switches
 *  to Stream and scrolls to the note; Delete removes the file. Backdrop
 *  click or Esc dismisses. */
function EventActionMenu({
  title, x, y, eventDate, currentFolder, availableFolders,
  onOpen, onDelete, onMoveToDay, onAssignFolder, onCancel,
}: {
  title: string;
  x: number;
  y: number;
  /** ISO date (YYYY-MM-DD) of the event being acted on. When set, the
   *  menu renders a row of 7 chips for the event's week so the user can
   *  tap a day to move the event there (same time-of-day). */
  eventDate: string | null;
  /** Current Notable Folder ref ("[[…]]" stripped), or null. Shown as the
   *  active chip in the folder picker. */
  currentFolder: string | null;
  /** Notable Folder picker options, mirroring the card-footer picker. */
  availableFolders: { name: string; color: string }[];
  onOpen: () => void;
  onDelete: () => void;
  onMoveToDay: (iso: string) => void;
  onAssignFolder: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [folderQuery, setFolderQuery] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (folderOpen) folderInputRef.current?.focus(); }, [folderOpen]);
  const folderMatches = (folderQuery.trim()
    ? availableFolders.filter((f) => f.name.toLowerCase().includes(folderQuery.toLowerCase()))
    : availableFolders
  ).slice(0, 6);
  const currentFolderColor = currentFolder
    ? availableFolders.find((f) => f.name === currentFolder)?.color
    : undefined;
  // Move-day chips: 7 days of the week containing `eventDate`. Compute the
  // week start as Sunday (firstDay=0, matching CalendarView's firstDay).
  const weekDays = (() => {
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return [];
    const [y, m, d] = eventDate.split("-").map((s) => parseInt(s, 10));
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay(); // 0 = Sunday
    const sunday = new Date(y, m - 1, d - dow);
    const fmtIso = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return Array.from({ length: 7 }, (_, i) => {
      const c = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + i);
      const iso = fmtIso(c);
      return { iso, label: labels[i], day: c.getDate(), isToday: iso === eventDate };
    });
  })();
  // Menu is taller when chips / folder picker are present.
  const menuH = (weekDays.length > 0 ? 170 : 120) + (availableFolders.length > 0 ? (folderOpen ? 220 : 56) : 0);
  const menuW = (weekDays.length > 0 || availableFolders.length > 0) ? 280 : 200;
  const left = Math.min(Math.max(x, 8), window.innerWidth - menuW);
  const top = Math.min(Math.max(y, 8), window.innerHeight - menuH);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="event-action-overlay" onMouseDown={onCancel}>
      <div
        className="event-action-menu"
        style={{ left: `${left}px`, top: `${top}px` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="event-action-menu-title">{title}</div>
        {weekDays.length > 0 && (
          <div className="event-action-days" role="group" aria-label="Move to day">
            {weekDays.map((d) => (
              <button
                key={d.iso}
                type="button"
                className={"event-action-day" + (d.isToday ? " is-current" : "")}
                onClick={() => onMoveToDay(d.iso)}
                title={`Move to ${d.label} (${d.iso})`}
                aria-label={`Move to ${d.label} ${d.day}`}
              >
                <span className="event-action-day-name">{d.label}</span>
                <span className="event-action-day-num">{d.day}</span>
              </button>
            ))}
          </div>
        )}
        {availableFolders.length > 0 && (
          <div className="event-action-folder">
            {folderOpen ? (
              <>
                <input
                  ref={folderInputRef}
                  className="event-action-folder-input"
                  value={folderQuery}
                  placeholder="Move to folder…"
                  onChange={(e) => setFolderQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") { e.preventDefault(); setFolderOpen(false); setFolderQuery(""); }
                    if (e.key === "Enter" && folderMatches[0]) {
                      e.preventDefault();
                      void onAssignFolder(folderMatches[0].name);
                    }
                  }}
                />
                {folderMatches.length > 0 && (
                  <ul className="event-action-folder-list">
                    {folderMatches.map((f) => (
                      <li key={f.name}>
                        <button
                          type="button"
                          className={"event-action-folder-option" + (f.name === currentFolder ? " is-current" : "")}
                          onClick={() => { void onAssignFolder(f.name); }}
                        >
                          <span className="event-action-folder-swatch" style={{ background: f.color }} />
                          {f.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <button
                type="button"
                className="event-action-folder-chip"
                style={currentFolderColor ? { color: currentFolderColor, borderColor: currentFolderColor + "55" } : undefined}
                onClick={() => setFolderOpen(true)}
                title={currentFolder ? `Change folder — currently ${currentFolder}` : "Assign folder"}
              >
                <FolderIcon size={11} strokeWidth={2} />
                <span className="event-action-folder-name">{currentFolder ?? "Assign folder…"}</span>
              </button>
            )}
          </div>
        )}
        <button type="button" className="event-action-btn" onClick={onOpen}>Open</button>
        <button type="button" className="event-action-btn is-delete" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

/** Centered title prompt shown after picking a calendar slot/range. Enter
 *  commits (even on an empty title, so it stays a fast capture); Esc and
 *  clicking the backdrop cancel. */
function CreateEventPrompt({ onSubmit, onCancel }: {
  onSubmit: (title: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <div className="event-prompt-overlay" onMouseDown={onCancel}>
      <div className="event-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="event-prompt-input"
          value={title}
          placeholder="Event title (Enter to create, Esc to cancel)"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void onSubmit(title.trim()); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
        />
      </div>
    </div>
  );
}

