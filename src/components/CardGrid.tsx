// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Stream masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Upload as UploadIcon, Settings as SettingsIcon, Files, FileText, ZoomIn, ZoomOut, Moon, MoonStar, Sun, Monitor, Flag, TreePine, Rocket, Globe, Lock, Folder as FolderIcon, ChevronsRight, Search as SearchIcon, PanelRight, Home as HomeIcon, Calendar as CalendarIcon, CalendarDays, CalendarRange, CalendarClock, X as XCircle, Check } from "lucide-react";
import { useTextScale, stepTextScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_STEP } from "../lib/text-scale";
import { useTheme, toggleTheme, nextTheme, themeLabel } from "../lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { vaultRoot, walkVaultMarkdown, setVaultOverride, toVaultRel, isIos, isIosSync, syncVaultRoot } from "../lib/vault";
import { vaultFs, consumeSelfWrite } from "../lib/vault-fs";
import { useGridLayout } from "../lib/grid-layout";
import { Card, FolderPicker } from "./Card";
import { CalendarView, type CalendarViewHandle, type NoteMeta } from "./CalendarView";
import { YearLinearView, type YearLinearViewHandle } from "./YearLinearView";
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

// Stream membership filter — three states, cycled by the prominent
// FAB on the left rail. Persists across sessions.
//   - "all":     ordinary notes AND Notable-Folder cards (default in-app)
//   - "notes":   ordinary notes only
//   - "folders": Notable-Folder main docs only (default for published home)
export type StreamMode = "all" | "notes" | "folders";
const STREAM_MODE_KEY = "order.streamMode";
function readStreamMode(): StreamMode {
  try {
    const v = localStorage.getItem(STREAM_MODE_KEY);
    if (v === "notes" || v === "folders" || v === "all") return v;
  } catch { /* non-fatal */ }
  return "all";
}
function writeStreamMode(m: StreamMode): void {
  try { localStorage.setItem(STREAM_MODE_KEY, m); } catch { /* non-fatal */ }
}
function nextStreamMode(m: StreamMode): StreamMode {
  // Cycle: all → notes → folders → all.
  return m === "all" ? "notes" : m === "notes" ? "folders" : "all";
}

// Every launch picks a viewport-aware default — Day on phones (≤640px,
// the same breakpoint the layout collapses at), Week on desktop. We
// deliberately do NOT persist the active view: the calendar surface is
// the home base, and a single accidental Stream / Day / Month switch
// shouldn't quietly change "what Order opens on" forever.
function readInitialView(): View {
  try {
    if (window.matchMedia("(max-width: 640px)").matches) return "day";
  } catch { /* non-fatal */ }
  return "week";
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

// Recently-opened Notable Folder refs, most recent first, capped at 20.
// The command palette uses this to show "Recent" entries on an empty
// query — the search button doubles as a back-history.
const RECENT_FOLDERS_KEY = "order.recentFolders";
const RECENT_FOLDERS_MAX = 20;
function readRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_FOLDERS_MAX);
  } catch { return []; }
}
function writeRecentFolders(list: string[]): void {
  try { localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(list.slice(0, RECENT_FOLDERS_MAX))); }
  catch { /* non-fatal */ }
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
import yaml from "js-yaml";

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
  /** Last-modified time (Unix ms). Used by base-block `file.mtime` sort. */
  mtime: number;
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

/** Light frontmatter parse from the YAML string the Rust metadata walker
 *  returns. Mirrors splitFrontmatter's parse step without rebuilding the
 *  `---\nyaml\n---\n` envelope. Returns {} on parse failure (matches the
 *  permissive behavior of splitFrontmatter). */
function parseYaml(yamlText: string): Frontmatter {
  if (!yamlText) return {};
  try {
    const parsed = (yaml as { load: (s: string) => unknown }).load(yamlText);
    return parsed && typeof parsed === "object" ? (parsed as Frontmatter) : {};
  } catch { return {}; }
}

/** Lightweight "is this a chain / list file?" check. Used to decide which
 *  notes need their body pre-loaded at startup so the sidebar taxonomy can
 *  parse bullets immediately. Everything else (leaves) loads its body on
 *  Card mount via vault_read_text. */
function needsBodyUpfront(fm: Frontmatter): boolean {
  if (fm.role === "areas") return true;
  if (typeof fm.category === "string" && fm.category) return true;
  if (typeof fm.list === "string" && fm.list) return true;
  return false;
}

async function loadAndNormalizeAll(): Promise<LoadedNote[]> {
  // Frontmatter-only walk in Rust — bodies stay on disk, so the bridge
  // payload at 10^4 notes drops from "every body" to "every frontmatter
  // YAML string." Chain files (Areas / Categories / NF Main Docs / list
  // folders) need their bodies for the sidebar taxonomy + list bullet
  // rendering, so we read those up front; leaves keep body="" and Card
  // fills it via vault_read_text on mount.
  const meta = await vaultFs.walkMetadata();
  const out: LoadedNote[] = [];
  for (const m of meta) {
    try {
      let frontmatter = parseYaml(m.frontmatterYaml);
      let body = "";
      const filename = m.filename;
      if (needsBodyUpfront(frontmatter)) {
        // Chain / list files: full read + splitFrontmatter so any
        // calendar-frontmatter migration runs (suggestCalendarPatch)
        // — same behaviour the old loadOne provided.
        const raw = await readVault(m.path);
        const split = splitFrontmatter(raw);
        frontmatter = split.frontmatter;
        body = split.body;
        const patch = suggestCalendarPatch(frontmatter, body);
        if (patch) {
          frontmatter = { ...frontmatter, ...patch };
          try { await writeVault(m.path, joinFrontmatter(frontmatter, body)); }
          catch (err) { console.warn("calendar migration failed:", m.path, err); }
        }
      } else {
        // Leaf: try to migrate calendar frontmatter even without a body
        // (body stays empty in memory until Card mounts). suggestCalendarPatch
        // only reads frontmatter for the date/time fields it injects.
        // Guard against YAML parse failures (Readwise summaries with bad
        // indentation, etc.): if the on-disk frontmatter block is non-empty
        // but parsed to {}, treat the note as having authored frontmatter
        // and skip the auto-stamp.
        const hasAuthoredFrontmatter = !!m.frontmatterYaml && m.frontmatterYaml.trim().length > 0;
        if (!hasAuthoredFrontmatter) {
          const patch = suggestCalendarPatch(frontmatter, "");
          if (patch) frontmatter = { ...frontmatter, ...patch };
        }
      }
      out.push({
        id: newNoteId(),
        path: m.path,
        filename,
        frontmatter,
        title: deriveTitle(body, filename.replace(/\.md$/, "")),
        body,
        mtime: m.mtimeMs,
      });
    } catch (err) {
      console.warn("Failed to load metadata entry", m.path, err);
    }
  }
  return out;
}

export function CardGrid() {
  const [notes, setNotes] = useState<LoadedNote[] | null>(null);
  const [view, setView] = useState<View>(readInitialView);
  // Wipe any persisted view from earlier builds — Order now always opens
  // on the viewport-default (Week on desktop, Day on phones).
  useEffect(() => { try { localStorage.removeItem("order.view"); } catch { /* non-fatal */ } }, []);
  // Imperative handles for Cmd+arrow nav inside the active calendar view.
  // Only one of the two is "live" at a time (the mounted view sets it; the
  // other stays null), so the key handler can blindly call .current.
  const calendarHandleRef = useRef<CalendarViewHandle | null>(null);
  const yearHandleRef = useRef<YearLinearViewHandle | null>(null);
  const [scrollTargetPath, setScrollTargetPath] = useState<string | null>(null);
  /** Path of the most recently created note. The matching Card
   *  mounts with `autoFocus` so the cursor lands inside its editor
   *  the moment it appears. Cleared by the same scroll-target
   *  effect that handles the highlight pulse. */
  const [focusPath, setFocusPath] = useState<string | null>(null);
  /** Path of the card the user is currently focused on. Sticky:
   *  navigation (sidebar / calendar / palette / wikilink / new) sets
   *  it; an external file change to a DIFFERENT path doesn't disturb
   *  it (used in the React key to suppress remounts of the focused
   *  card mid-edit). Cleared when the user picks a different card or
   *  the focused note is gone (deleted / out of view). */
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(readSidebarOpen);
  // Recently-opened Notable Folders — surfaced by the command palette
  // on an empty query so the search button doubles as a back-history.
  const [recentFolders, setRecentFolders] = useState<string[]>(readRecentFolders);
  const markFolderRecent = useCallback((ref: string) => {
    if (!ref) return;
    setRecentFolders((prev) => {
      const next = [ref, ...prev.filter((r) => r !== ref)].slice(0, RECENT_FOLDERS_MAX);
      writeRecentFolders(next);
      return next;
    });
  }, []);
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
  // Drop the pinned focus when its note disappears (delete, rename
  // away from the loaded set, or a vault switch).
  useEffect(() => {
    if (!focusedPath || !notes) return;
    if (!notes.some((n) => n.path === focusedPath)) setFocusedPath(null);
  }, [notes, focusedPath]);
  // "Notes only" toggle: hide Notable-Folder cards from the Stream and
  // show ordinary notes only. Persisted; survives filter changes.
  const [streamMode, setStreamMode] = useState<StreamMode>(readStreamMode);
  // "Public only" toggle: show only `public: true` notes in the Stream
  // (off = public + private together). Persisted; survives filter changes.
  const [publicOnly, setPublicOnly] = useState<boolean>(readPublicOnly);
  // Stream pagination: cap initial Card mounts when nothing is filtered.
  // Card mounts ProseMirror per note, so unbounded Streams at 10^4 notes
  // are dead on arrival. `streamLimit = N` shows the N most-recent notes;
  // a "Show more" tile bumps it. null = unbounded (e.g., the user clicked
  // "Show more" enough to get there, or a filter is active).
  const STREAM_PAGE_SIZE = 60;
  const [streamLimit, setStreamLimit] = useState<number | null>(STREAM_PAGE_SIZE);
  useEffect(() => { setStreamLimit(STREAM_PAGE_SIZE); }, [filters]);
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
  // Forward-ref binding for Cmd+' (declared earlier in the component).
  useEffect(() => { resetToDefaultRef.current = resetToDefault; }, [resetToDefault]);
  /** Scroll the stream to a card and pin focus on it. Single entry
   *  point used by every navigation surface (sidebar tile, calendar
   *  Open, command palette, wikilink, filter-pill jump) so the
   *  "click → focused card" guarantee holds uniformly.
   *
   *  Side effect: additively include the note's Notable Folder in
   *  the filter set. This narrows the Stream to the section that
   *  contains the note — newspaper mode kicks in, the NF main doc
   *  lands at the top, and the scroll target has far less mass
   *  around it to drift through. Side benefit: it doubles as a
   *  navigation breadcrumb ("you're inside Cal Newport now") that
   *  the user can dismiss with the pill's ×. */
  const navigateAndFocus = useCallback((path: string) => {
    setView("stream");
    const note = notesRef.current?.find((n) => n.path === path);
    if (note) {
      const ownRef = note.filename.replace(/\.md$/i, "");
      const targetFolder = isNotableFolder(note.frontmatter)
        ? ownRef
        : (noteFolder(note.frontmatter) ?? null);
      if (targetFolder) {
        // Pin the target NF at the FRONT of the include set so its
        // newspaper section renders at the top of the Stream. Any
        // existing entry is moved to the front so a re-click also
        // bubbles the section back up — the include set acts as a
        // most-recently-visited stack. The just-pinned section sits
        // at scrollY ~0, so the scroll target has almost no mass
        // around it to drift through (no slippage on mobile).
        setFilters((prev) => [
          { kind: "include", ref: targetFolder },
          ...prev.filter((f) => !(f.kind === "include" && f.ref === targetFolder)),
        ]);
        setFocusedFolder(targetFolder);
        markFolderRecent(targetFolder);
      }
    }
    setScrollTargetPath(path);
    setFocusPath(path);
    setFocusedPath(path);
  }, [markFolderRecent]);
  /** Add an include filter AND scroll the stream to it. Bound to
   *  wikilink title-clicks in the list renders. Lives above the
   *  notes-loading early return so hook order is stable. */
  const navigateToRef = useCallback((ref: string) => {
    const path = notePathByRef(ref);
    if (path) {
      // navigateAndFocus pins the target NF to the front of the
      // include set; no separate addInclude needed.
      navigateAndFocus(path);
    } else {
      // Unresolved ref (no on-disk note) — fall back to a bare
      // additive include so the user still sees a pill they can
      // remove. Front-pinned to match the new visibility rule.
      setFilters((prev) => [
        { kind: "include", ref },
        ...prev.filter((f) => !(f.kind === "include" && f.ref === ref)),
      ]);
    }
  }, [navigateAndFocus]);
  // Wikilink-to-NF clicks accumulate (same as navigateToRef now that
  // includes always compose with OR). Kept as a distinct name for the
  // list-render prop contract.
  const addFolderToFilter = navigateToRef;
  /** Pick a folder from the command palette: switch to the Stream,
   *  add it as an include, pin its Main Document, and scroll to it —
   *  so Cmd+K lands you ON that page. */
  const focusFolder = useCallback((ref: string) => {
    setFocusedFolder(ref);
    const path = notePathByRef(ref);
    if (path) {
      // Route through navigateAndFocus so the pinning rule (move
      // the just-clicked NF to the front of the include set) is
      // applied uniformly. No need to call addInclude separately.
      navigateAndFocus(path);
    } else {
      // No Main Document — just bubble the bare include to the front.
      setFilters((prev) => [
        { kind: "include", ref },
        ...prev.filter((f) => !(f.kind === "include" && f.ref === ref)),
      ]);
      setView("stream");
    }
  }, [navigateAndFocus]);
  /** Jump to the home Notable Folder — the one whose YAML carries
   *  `home: "<user>/<repo>/<path>"`. Sets the filter to ONLY that
   *  folder (clearing any other includes/excludes), so the user lands
   *  on the home newspaper section as if Order had just opened.
   *  Falls back to plain reset if no home folder exists. */
  const goHome = useCallback(() => {
    setView("stream");
    setCollapseNonce((n) => n + 1);
    const home = homeFolderRef.current;
    if (!home) { setFilters([]); return; }
    setFilters([{ kind: "include", ref: home }]);
    setFocusedFolder(home);
    const path = notePathByRef(home);
    if (path) navigateAndFocus(path);
  }, [navigateAndFocus]);

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

  // Per-path "external change" version counter. Bumped when the watcher
  // (or the polling fallback) reports a file changed and the change was
  // NOT one of our own writes (see consumeSelfWrite). Cards include this
  // counter in their React `key` so a true external edit force-remounts
  // the Card — Milkdown is uncontrolled after mount, so a state change
  // alone wouldn't refresh the rendered prose, but a remount will.
  const [externalChangeVersion, setExternalChangeVersion] = useState<Record<string, number>>({});
  const bumpExternal = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setExternalChangeVersion((prev) => {
      const next = { ...prev };
      for (const p of paths) next[p] = (next[p] ?? 0) + 1;
      return next;
    });
  }, []);

  // Live file watching: start the Rust-side notify watcher once we know
  // the vault root, listen for `vault-changed`, filter out paths that
  // we just wrote ourselves (else autosaves remount the editor mid-key),
  // and treat what's left as external changes — reload the index AND
  // bump per-path external counters so any mounted Card whose file
  // changed remounts with fresh content.
  //
  // iOS: notify's reliability under the sandbox + security-scoped
  // bookmark is mixed, so we ALSO run a mtime poller as a safety net
  // (also runs on desktop, harmlessly). The poller uses the lightweight
  // metadata walker so it doesn't pull bodies over the bridge.
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    const lastMtime = new Map<string, number>();
    /** Read the file and compare to the in-memory body for that path —
     *  return true only if the content actually differs. mtime-only
     *  signals are very noisy on cloud-synced vaults (Dropbox / iCloud
     *  touch files during sync without changing content), and bumping
     *  externalChangeVersion on every touch makes the Stream "jump
     *  around" every few seconds as cards remount and masonry rejiggers.
     *  Errors are conservatively treated as "no change" so we don't
     *  thrash on transient read failures. */
    async function bodyActuallyChanged(path: string): Promise<boolean> {
      try {
        const raw = await vaultFs.readText(toVaultRel(path));
        const inMem = notesRef.current?.find((n) => n.path === path);
        if (!inMem) return true; // new file the index doesn't know yet
        const split = splitFrontmatter(raw);
        return split.body !== inMem.body;
      } catch {
        return false;
      }
    }
    async function reportExternal(paths: string[]) {
      if (cancelled) return;
      // Drop our own writes from the change set; anything remaining is
      // a genuine external mtime change.
      const external: string[] = [];
      for (const p of paths) if (!consumeSelfWrite(p)) external.push(p);
      if (external.length === 0) return;
      // Content-aware filter: only paths whose bodies actually
      // differ get a version bump (which would remount the Card).
      // Pure mtime touches from Dropbox / iCloud sync (the dominant
      // source of churn on a cloud-synced vault) drop here.
      const changed: string[] = [];
      for (const p of external) {
        if (await bodyActuallyChanged(p)) changed.push(p);
        if (cancelled) return;
      }
      if (changed.length === 0) return;
      // Only reload when real content changed. The old path scheduled
      // a reload on every mtime touch — which on iOS, where the bridge
      // is slow and the reload re-reads every note body, produced a
      // visible jump every poll cycle even when nothing changed.
      bumpExternal(changed);
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; void reloadNotes(); }, 250);
    }
    /** Force a reload regardless of content-change status — for the
     *  add / remove case where the file list itself shifted, not just
     *  mtimes on existing files. */
    function scheduleReload() {
      if (cancelled) return;
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => { reloadTimer = null; void reloadNotes(); }, 250);
    }
    async function startWatcher() {
      const root = await syncVaultRoot();
      if (!root || cancelled) return;
      try {
        await invoke("start_watcher", { path: root });
        unlisten = await listen<string[]>("vault-changed", (e) => {
          // OS-level event from the notify watcher: handle content
          // changes via the content-aware path AND force an index
          // reload so brand-new / deleted files reach the Stream.
          // (The watcher doesn't distinguish create/delete from
          // modify; reload is cheap relative to body re-reads, and
          // happens at most once per 250ms via the timer.)
          const paths = e.payload ?? [];
          void reportExternal(paths);
          scheduleReload();
        });
      } catch (err) {
        // Non-fatal: poller below still gives us a freshness signal.
        console.warn("watcher start failed (poller will cover):", err);
      }
    }
    async function pollOnce() {
      try {
        const meta = await vaultFs.walkMetadata();
        const changed: string[] = [];
        const seen = new Set<string>();
        let added = false;
        for (const m of meta) {
          seen.add(m.path);
          const prev = lastMtime.get(m.path);
          if (prev === undefined) {
            lastMtime.set(m.path, m.mtimeMs);
            // The very first sighting after mount just seeds the
            // table — that's the bootstrap pass, not a real "add".
            // A second-or-later pass that finds a NEW path means a
            // file actually appeared in the vault.
            if (!firstPoll) added = true;
          } else if (m.mtimeMs !== prev) {
            lastMtime.set(m.path, m.mtimeMs);
            changed.push(m.path);
          }
        }
        let removed = false;
        for (const p of [...lastMtime.keys()]) {
          if (!seen.has(p)) { lastMtime.delete(p); removed = true; }
        }
        // Reload only when the file set itself shifted; pure mtime
        // touches go through the content-aware reportExternal path,
        // which on iOS no longer triggers a heavy reload-every-cycle
        // when Dropbox / iCloud touches a file without changing it.
        if (added || removed) scheduleReload();
        if (changed.length > 0) void reportExternal(changed);
        firstPoll = false;
      } catch { /* sleep + retry */ }
      // Slow poll on iOS: 15s instead of 4s. iOS walk is much more
      // expensive (security-scoped bookmark + sandboxed FS) and the
      // content-aware filter already absorbs cloud-sync noise, so a
      // longer cycle costs nothing perceptually while saving battery
      // and stopping the every-few-seconds index churn the user saw.
      if (!cancelled) pollTimer = setTimeout(pollOnce, isIosSync() ? 15000 : 4000);
    }
    let firstPoll = true;
    async function start() {
      const root = await syncVaultRoot();
      if (!root || cancelled) return;
      void startWatcher();
      void pollOnce();
    }
    void start();
    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      if (pollTimer) clearTimeout(pollTimer);
      if (unlisten) unlisten();
    };
  }, [reloadNotes, bumpExternal]);

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
  // Refs the Cmd+arrow keyboard handler reads — it sits in a useEffect
  // with an empty-ish dep array, so the latest filters / notable-folder
  // order need to flow in via a mutable ref.
  const notableFoldersRef = useRef<string[]>([]);
  /** Live mirrors of the current Notable-Folder filter set so the
   *  empty-deps `createNote` callback can ask "what folder is the
   *  user currently filtered to?" without a stale closure. */
  const notableIncludesRef = useRef<string[]>([]);
  const includeSetRef = useRef<Set<string>>(new Set());
  const filtersRef = useRef<Filter[]>([]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

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

    // Bodies for leaves are lazy at load-time (the metadata walker leaves
    // body="" for non-chain files). Publish needs every public note's
    // body — warm them by reading the file once each here so collect can
    // serialize and prerender. Bounded by the count of public notes, not
    // the whole vault.
    for (const n of publicNotes) {
      if (n.body) continue;
      try {
        const raw = await readVault(n.path);
        n.body = splitFrontmatter(raw).body;
      } catch (err) { console.warn("publish: body read failed", n.path, err); }
    }
    const sub = home.target.split("/").slice(2).join("/");
    const { site, assets } = collectPublishedSite({
      vaultNotes: fresh.map((n) => ({
        filename: n.filename,
        dir: vaultDir(toVaultRel(n.path)),
        frontmatter: n.frontmatter,
        body: n.body,
        mtime: n.mtime,
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
  // Cmd+O opens the sidebar; Cmd+K opens the centered command palette.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  // Dock-view picker — pick a stream sub-mode or a calendar view
  // from a menu instead of cycling through them by repeated taps.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // Home button menu — pick the home folder OR clear all filters.
  const [homeMenuOpen, setHomeMenuOpen] = useState(false);

  useEffect(() => {
    if (!creatorOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-new, .new-note-picker")) setCreatorOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [creatorOpen]);

  // Dock tools popup — same outside-click-to-close pattern.
  useEffect(() => {
    if (!toolsMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-settings, .dock-tools-popup")) setToolsMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [toolsMenuOpen]);

  useEffect(() => {
    if (!viewMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-view, .dock-view-popup")) setViewMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!homeMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-home, .dock-home-popup")) setHomeMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [homeMenuOpen]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => {
      const next = !prev;
      writeSidebarOpen(next);
      return next;
    });
  }, []);

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
  const promptCreateRef = useRef<((p: Frontmatter) => Promise<void>) | null>(null);
  // Forward-ref so the keyboard handler (declared above resetToDefault)
  // can invoke the latest version for Cmd+'.
  const resetToDefaultRef = useRef<(() => void) | null>(null);
  // Shortcuts overlay — toggled by bare `?` outside text input.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return true;
      return t.isContentEditable; // covers Milkdown / ProseMirror
    }
    function onKey(e: KeyboardEvent) {
      // Bare-key shortcuts only fire when no input / editor has focus,
      // so typing "?" inside a note doesn't pop the help overlay.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "?" && !isTyping(e.target)) {
          e.preventDefault();
          setHelpOpen((o) => !o);
          return;
        }
        return;
      }
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
        const patch: Frontmatter = { date: isoDate(), startTime: isoTime(), allDay: false };
        // In a calendar view, present the title prompt first (same UX
        // as drag-to-create on a slot) so the event lands with a name
        // without having to open the note. Stream goes straight to the
        // editor as before.
        if (view !== "stream") void promptCreateRef.current?.(patch);
        else void createNoteRef.current?.(patch);
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
      // Cmd+T cycles through the theme set.
      if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        toggleTheme();
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
      // Cmd+Ctrl+arrow navigation: forward/back by the active view's
      // unit. Stream cycles single-folder focus through notableFolders.
      // Requires both Cmd and Ctrl so plain Cmd+← / → keep their
      // browser-style text-editing behaviour inside the Milkdown editor.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.metaKey && e.ctrlKey) {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (view === "stream") {
          const list = notableFoldersRef.current;
          if (list.length === 0) return;
          e.preventDefault();
          const cur = filtersRef.current.find((f) => f.kind === "include")?.ref ?? null;
          const idx = cur ? list.findIndex((n) => n === cur) : -1;
          const next = list[((idx < 0 ? 0 : idx + dir) + list.length) % list.length];
          setFilters([{ kind: "include", ref: next }]);
          return;
        }
        e.preventDefault();
        if (view === "year") {
          if (dir > 0) yearHandleRef.current?.next(); else yearHandleRef.current?.prev();
        } else {
          if (dir > 0) calendarHandleRef.current?.next(); else calendarHandleRef.current?.prev();
        }
        return;
      }
      if (e.key === ";") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      // Cmd+' clears all active filters (mirrors the rail clear-all
      // icon). Apostrophe is a key that no system shortcut owns, so
      // it stays out of the macOS-menu fight zone.
      if (e.key === "'") {
        e.preventDefault();
        resetToDefaultRef.current?.();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, toggleSidebar, view]);

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
    navigateAndFocus(path);
  }, [navigateAndFocus]);
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
    let cleanedUp = false;
    const cleanups: Array<() => void> = [];
    const addCleanup = (fn: () => void) => cleanups.push(fn);
    const teardown = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      while (cleanups.length) cleanups.pop()!();
    };

    // Initial settle wait: Crepe / ProseMirror mounts and the masonry
    // remeasure schedule each take ~150-200 ms before card heights
    // are remotely final. Wait long enough for the *first* good
    // measurement; the observer below catches everything after.
    const settleTimer = setTimeout(() => {
      // Query the document, not a single grid — newspaper mode renders
      // many per-section grids, so the flat `gridEl` is null there.
      const cell = document.querySelector<HTMLElement>(
        `.card-grid-cell[data-path="${CSS.escape(target)}"]`,
      );
      if (!cell) {
        teardown();
        return;
      }
      const viewportH = () => window.innerHeight || document.documentElement.clientHeight;
      const targetScrollFor = (el: HTMLElement) => {
        const rect = el.getBoundingClientRect();
        const cellTopAbs = window.scrollY + rect.top;
        return Math.max(0, cellTopAbs - viewportH() / 2);
      };
      // Land the TOP of the card at the vertical center of the
      // viewport so the user sees the title/start of the note with
      // breathing room above and the body unfurling below.
      window.scrollTo({ top: targetScrollFor(cell), behavior: "smooth" });
      cell.classList.add("is-target");
      const pulseTimer = setTimeout(() => cell.classList.remove("is-target"), 1400);
      addCleanup(() => clearTimeout(pulseTimer));
      // Imperatively focus the editor — covers cards that were
      // already mounted (autoFocus prop alone won't re-fire on the
      // same React instance).
      const pm = cell.querySelector<HTMLElement>(".ProseMirror");
      pm?.focus({ preventScroll: true });

      // Stick-to-target: instead of polling every 100ms and bailing
      // on touchmove (iOS momentum bounce fires synthetic touchmove
      // events well after the finger lifts — that was killing the
      // lock on mobile), observe what actually moves the card:
      //   - ResizeObserver on the cell  → its own height changing as
      //                                    Milkdown finishes, images
      //                                    load, fonts settle
      //   - MutationObserver on the grid → masonry row-span writes,
      //                                    sibling cards growing
      // Recenter whenever the cell's top drifts > 80px (absolute,
      // not a viewport fraction — a small card on a tall phone needs
      // the same threshold as a tall card on a desktop).
      let userScrolled = false;
      let pointerDownAt: { x: number; y: number } | null = null;
      const PT_THRESHOLD = 8;
      let lastMutationAt = performance.now();
      const onPointerDown = (e: PointerEvent) => {
        pointerDownAt = { x: e.clientX, y: e.clientY };
      };
      const onPointerMove = (e: PointerEvent) => {
        if (!pointerDownAt) return;
        const dx = e.clientX - pointerDownAt.x;
        const dy = e.clientY - pointerDownAt.y;
        if (dx * dx + dy * dy > PT_THRESHOLD * PT_THRESHOLD) {
          userScrolled = true;
        }
      };
      const onPointerUp = () => { pointerDownAt = null; };
      const onWheel = () => { userScrolled = true; };
      const onKeyDown = (e: KeyboardEvent) => {
        // Arrow / page / space / home / end — anything that scrolls.
        // Plain keystrokes inside the focused editor don't, and
        // shouldn't kill the lock.
        if (/Arrow|Page|Home|End|Space/.test(e.code)) userScrolled = true;
      };
      window.addEventListener("wheel", onWheel, { passive: true });
      window.addEventListener("pointerdown", onPointerDown, { passive: true });
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp, { passive: true });
      window.addEventListener("pointercancel", onPointerUp, { passive: true });
      window.addEventListener("keydown", onKeyDown, { passive: true });
      addCleanup(() => window.removeEventListener("wheel", onWheel));
      addCleanup(() => window.removeEventListener("pointerdown", onPointerDown));
      addCleanup(() => window.removeEventListener("pointermove", onPointerMove));
      addCleanup(() => window.removeEventListener("pointerup", onPointerUp));
      addCleanup(() => window.removeEventListener("pointercancel", onPointerUp));
      addCleanup(() => window.removeEventListener("keydown", onKeyDown));

      let recenterRaf: number | null = null;
      const scheduleRecenter = () => {
        if (userScrolled || !cell.isConnected) return;
        if (recenterRaf !== null) return;
        recenterRaf = requestAnimationFrame(() => {
          recenterRaf = null;
          if (userScrolled || !cell.isConnected) return;
          const rect = cell.getBoundingClientRect();
          const drift = Math.abs(rect.top - viewportH() / 2);
          if (drift > 80) {
            window.scrollTo({ top: targetScrollFor(cell), behavior: "auto" });
          }
        });
      };

      // Watch the cell's own size.
      const ro = new ResizeObserver(() => {
        lastMutationAt = performance.now();
        scheduleRecenter();
      });
      ro.observe(cell);
      addCleanup(() => ro.disconnect());

      // Watch the grid for new cells / row-span attribute writes
      // (masonry layout). MutationObserver on the parent catches
      // sibling height changes that affect this cell's position.
      const grid = cell.closest(".card-grid") ?? cell.parentElement;
      const mo = grid
        ? new MutationObserver(() => {
            lastMutationAt = performance.now();
            scheduleRecenter();
          })
        : null;
      mo?.observe(grid!, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
      addCleanup(() => mo?.disconnect());

      // Hard ceiling: stop watching after 3 s of no observed mutations.
      // 6 s absolute cap so we never run forever even on a janky page.
      const start = performance.now();
      const idleCheck = setInterval(() => {
        const now = performance.now();
        const idle = now - lastMutationAt;
        if (userScrolled || idle > 3000 || now - start > 6000) {
          clearInterval(idleCheck);
          teardown();
        }
      }, 250);
      addCleanup(() => clearInterval(idleCheck));
      if (recenterRaf !== null) addCleanup(() => cancelAnimationFrame(recenterRaf!));

      setScrollTargetPath(null);
      // Drop the autoFocus flag once the Card has had time to
      // consume it; otherwise re-renders far in the future would
      // still re-fire focus on the same card.
      setFocusPath(null);
    }, 250);
    addCleanup(() => clearTimeout(settleTimer));
    return teardown;
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
    // Folder resolution priority:
    //   1. caller supplied `folder` (calendar quick-create from a
    //      pinned section, dock new-note picker, etc.)
    //   2. exactly one Notable Folder is active in the include filter
    //      — drop the new note there so it shows up under the filter
    //      the user is currently looking at, instead of landing in
    //      home and disappearing
    //   3. home Notable Folder
    // Empty vault skips all three and the file just goes at root.
    if (!frontmatter.folder) {
      const activeIncludes = notableIncludesRef.current;
      if (activeIncludes.length === 1) {
        frontmatter.folder = `[[${activeIncludes[0]}]]`;
      } else if (homeFolderRef.current) {
        frontmatter.folder = `[[${homeFolderRef.current}]]`;
      }
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
      { id: newNoteId(), path, filename, frontmatter, title: title || "Untitled", body: seedBody, mtime: Date.now() },
    ]);
    // Visibility safety net: if a filter is active and the new note's
    // folder isn't part of the include set, additively add it so the
    // card lands on screen instead of being hidden behind a filter
    // the user just authored under. Keeps the user's existing filter
    // intent intact (doesn't clear) — additive, like a wikilink click.
    if (folderRef && includeSetRef.current.size > 0 && !includeSetRef.current.has(folderRef)) {
      setFilters((prev) => [...prev, { kind: "include", ref: folderRef }]);
    }
    // Land focus + scroll on the new note. Both Stream and the
    // calendar views consume scrollTargetPath; the Card itself
    // picks up autoFocus on mount.
    setFocusPath(path);
    setScrollTargetPath(path);
    setFocusedPath(path);
    // Stay in whichever view triggered the create — calendar views
    // re-render with the new event at its date/time; Stream sorts it
    // into place by date+startTime.
  }, []);
  // Keep the forward-ref in sync so the keyboard handler (Cmd+N), which
  // sits earlier in this component, can invoke the latest createNote.
  useEffect(() => { createNoteRef.current = createNote; }, [createNote]);
  useEffect(() => { promptCreateRef.current = promptCreate; }, [promptCreate]);

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
    const prevNote = notesRef.current?.find((n) => n.id === id);
    const oldPath = prevNote?.path ?? null;
    const oldName = prevNote?.filename.replace(/\.md$/i, "") ?? null;
    const newName = newFilename.replace(/\.md$/i, "");
    setNotes((prev) =>
      prev?.map((n) =>
        n.id === id
          ? { ...n, path: newPath, filename: newFilename, title: newFilename.replace(/\.md$/, "") }
          : n,
      ) ?? null,
    );
    // The card we just renamed may be the user's currently-focused
    // editor — if its OLD path is in any of our path-tracking refs,
    // forward them to the NEW path so the cleanup effect doesn't
    // clear focusedPath (which would change the React key and
    // remount the Card, dropping the user out of edit mode).
    if (oldPath) {
      setFocusedPath((p) => (p === oldPath ? newPath : p));
      setFocusPath((p) => (p === oldPath ? newPath : p));
      setScrollTargetPath((p) => (p === oldPath ? newPath : p));
    }
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
      // Forward path-tracking state so the focused card's React key
      // stays stable across the move (otherwise edit mode is lost).
      setFocusedPath((p) => (p === path ? newPath : p));
      setFocusPath((p) => (p === path ? newPath : p));
      setScrollTargetPath((p) => (p === path ? newPath : p));
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
      { id: newNoteId(), path, filename, frontmatter, title: trimmed, body, mtime: Date.now() },
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
  notableFoldersRef.current = notableFolders.map((f) => f.name);

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
  notableIncludesRef.current = notableIncludes;
  includeSetRef.current = includeSet;

  // Minimal vault index for resolving `- [[Name]]` bullets and
  // evaluating `base` blocks. `folder` is the dirname's last segment
  // (wikilink qualifiers); `dir` is the full relative directory path
  // so file.folder.contains("X") matches at any depth, matching
  // Obsidian Bases semantics. `mtime` enables file.mtime sorting; ctime
  // is left undefined until we plumb birthtime through the load path.
  const vaultNotesIndex: ListNoteRef[] = notes.map((n) => {
    const parts = n.path.split("/");
    return {
      filename: n.filename,
      frontmatter: n.frontmatter,
      folder: parts.slice(-2, -1)[0] ?? "",
      dir: parts.slice(0, -1).join("/"),
      mtime: n.mtime,
      body: n.body,
    };
  });

  // Hide intermediate Area / Category list files from the Stream.
  // They're navigation infrastructure; the Sidebar drill is the
  // surface for editing them.
  const streamCandidates = notes.filter((n) => {
    const ref = n.filename.replace(/\.md$/, "");
    return !vaultTaxonomy.hiddenRefs.has(ref);
  });

  // Does this note belong to `ref`? `ref` may be:
  //   - a Notable Folder name (the note IS its main doc, or its
  //     `folder:` YAML points to that NF)
  //   - a Category name (the note's `category:` resolves to that name)
  //   - an Area name (the note's inferred area equals `ref`)
  const belongsTo = (n: LoadedNote, ref: string): boolean => {
    if (n.filename.replace(/\.md$/, "") === ref) return true;
    if (noteFolder(n.frontmatter) === ref) return true;
    const cat = parseRef(n.frontmatter.category);
    if (cat === ref) return true;
    if (inferredArea(n) === ref) return true;
    return false;
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
    // Stream mode: "notes" drops NF cards; "folders" drops ordinary
    // notes (keep only NF main docs); "all" keeps both.
    .filter((n) => {
      if (streamMode === "all") return true;
      const isNF = isNotableFolder(n.frontmatter);
      return streamMode === "notes" ? !isNF : isNF;
    })
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
  // Notable Folder Main Documents float to the top of the Stream by
  // default — they're the "covers" of each folder and read like a
  // table of contents for the recency feed below. Alphabetical
  // among themselves (no meaningful date on an NF main doc). The
  // pinned-folder cover, when one is active, still sits above the
  // alphabetical NF block.
  const sortedNotesFull = [...filteredNotes].sort((a, b) => {
    const am = isPinnedMain(a);
    const bm = isPinnedMain(b);
    if (am !== bm) return am ? -1 : 1;
    const aNF = isNotableFolder(a.frontmatter);
    const bNF = isNotableFolder(b.frontmatter);
    if (aNF !== bNF) return aNF ? -1 : 1;
    if (aNF && bNF) {
      return a.filename.localeCompare(b.filename);
    }
    return sortKey(b).localeCompare(sortKey(a));
  });
  // Pagination for the Stream's flat grid: with no folder filter active
  // we'd otherwise mount one Card per note in the vault — at 10^4 notes
  // each Milkdown editor instance kills the cold open. Cap the visible
  // set at STREAM_PAGE_SIZE and surface a "Show more" affordance for
  // when the user wants to scroll further. Filtered views show the full
  // set (filtering already bounds the count by folder membership).
  const sortedNotes = streamLimit !== null && filters.length === 0
    ? sortedNotesFull.slice(0, streamLimit)
    : sortedNotesFull;
  const hasMore = sortedNotes.length < sortedNotesFull.length;

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
        focused={focusedPath === n.path}
        onFocus={() => setFocusedPath(n.path)}
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
        // Prefer an NF Main Doc with that filename; fall back to any
        // note with that filename so plain-note includes (e.g. clicking
        // a book card whose ref is a leaf .md, not an NF) still render
        // as that section's centerpiece instead of an empty section.
        const mainNote =
          filteredNotes.find(
            (n) => isNotableFolder(n.frontmatter) && n.filename.replace(/\.md$/, "") === ref,
          )
          ?? filteredNotes.find((n) => n.filename.replace(/\.md$/, "") === ref);
        const sectionNotes = filteredNotes
          .filter((n) => !isNotableFolder(n.frontmatter) && noteFolder(n.frontmatter) === ref)
          .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
        const keyFor = (n: LoadedNote) =>
          // The focused card's key omits the external-change version
          // so a watcher event on its file (incl. our own self-write
          // bouncing back through slow-sync) doesn't remount it and
          // wipe Milkdown state / focus mid-edit.
          n.path === focusedPath
            ? n.id
            : `${n.id}:${externalChangeVersion[n.path] ?? 0}`;
        const centerpiece: SectionCell | null = mainNote
          ? { key: keyFor(mainNote), dataPath: mainNote.path, node: cardNode(mainNote, mainCap) }
          : null;
        const noteCells: SectionCell[] = sectionNotes.map((n) => ({
          key: keyFor(n), dataPath: n.path, node: cardNode(n, NOTE_CAP),
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

  /** The new-note flow — extracted so the dock button can call it. */
  const handleNewNote = () => {
    const sel = notableIncludes;
    const create = view !== "stream" ? promptCreate : createNote;
    if (sel.length === 1) {
      void create({
        date: isoDate(), startTime: isoTime(), allDay: false,
        folder: `[[${sel[0]}]]`,
      });
    } else if (sel.length === 0) {
      void create({ date: isoDate(), startTime: isoTime(), allDay: false });
    } else {
      setCreatorOpen((prev) => !prev);
    }
  };

  return (
    <div className={"shell" + (sidebarOpen ? " sidebar-open" : " sidebar-closed")}>
      {/* Bottom hovering dock — the five most-used controls grouped as
          a single cluster, equal-sized, sized for thumb taps. Sits
          above the bottom safe-area inset. */}
      <div className="bottom-dock" role="toolbar" aria-label="Main controls">
        <button
          type="button"
          className="dock-btn dock-btn-new"
          onClick={handleNewNote}
          title="New note"
          aria-label="New note"
        >
          +
        </button>
        <button
          type="button"
          className={`dock-btn dock-btn-view is-${view}` + (viewMenuOpen ? " is-open" : "")}
          onClick={() => { setHomeMenuOpen(false); setViewMenuOpen((o) => !o); }}
          title="Pick view"
          aria-label="Pick view"
          aria-haspopup="menu"
          aria-expanded={viewMenuOpen}
        >
          {(() => {
            // Show the icon for the currently active view so the dock
            // button reads as a status indicator first, picker second.
            if (view === "day") return <CalendarClock size={20} strokeWidth={2.1} />;
            if (view === "week") return <CalendarRange size={20} strokeWidth={2.1} />;
            if (view === "month") return <CalendarDays size={20} strokeWidth={2.1} />;
            if (view === "year") return <CalendarIcon size={20} strokeWidth={2.1} />;
            // Stream view — icon reflects the sub-mode.
            if (streamMode === "folders") return <FolderIcon size={22} strokeWidth={2.1} />;
            if (streamMode === "notes") return <FileText size={22} strokeWidth={2.1} />;
            return <Files size={22} strokeWidth={2.1} />;
          })()}
        </button>
        <button
          type="button"
          className={"dock-btn dock-btn-home" + (homeMenuOpen ? " is-open" : "")}
          onClick={() => { setViewMenuOpen(false); setHomeMenuOpen((o) => !o); }}
          title={homeFolderRef.current ? `Home — ${homeFolderRef.current}` : "Home — clear filters"}
          aria-label="Home menu"
          aria-haspopup="menu"
          aria-expanded={homeMenuOpen}
        >
          <HomeIcon size={20} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          className="dock-btn dock-btn-search"
          onClick={() => setPaletteOpen(true)}
          title="Search (Cmd+K)"
          aria-label="Search"
        >
          <SearchIcon size={20} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          className={"dock-btn dock-btn-settings" + (toolsMenuOpen ? " is-open" : "")}
          onClick={() => setToolsMenuOpen((o) => !o)}
          title="Settings, theme, zoom, publish"
          aria-label="Settings"
        >
          <SettingsIcon size={20} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          className="dock-btn dock-btn-sidebar"
          onClick={toggleSidebar}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarOpen ? <ChevronsRight size={20} strokeWidth={2.1} /> : <PanelRight size={20} strokeWidth={2.1} />}
        </button>
      </div>

      {/* Tools popup — anchored above the settings dock button. Holds
          the controls that used to live on the rail (publish, theme,
          zoom) so the dock stays uncluttered. */}
      {viewMenuOpen && (() => {
        const pickStream = (mode: StreamMode) => {
          setStreamMode(() => { writeStreamMode(mode); return mode; });
          setView("stream");
          setViewMenuOpen(false);
        };
        const pickView = (v: View) => { setView(v); setViewMenuOpen(false); };
        const opt = (
          active: boolean,
          icon: React.ReactNode,
          label: string,
          onClick: () => void,
        ) => (
          <button
            type="button"
            className={"dock-tools-item" + (active ? " is-on" : "")}
            onClick={onClick}
          >
            {icon}
            <span>{label}</span>
            {active && <Check size={12} strokeWidth={2.4} className="dock-tools-check" />}
          </button>
        );
        return (
          <div className="dock-tools-popup dock-view-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dock-tools-group-label">Stream</div>
            {opt(view === "stream" && streamMode === "all", <Files size={14} strokeWidth={2.1} />, "All notes + folders", () => pickStream("all"))}
            {opt(view === "stream" && streamMode === "notes", <FileText size={14} strokeWidth={2.1} />, "Notes only", () => pickStream("notes"))}
            {opt(view === "stream" && streamMode === "folders", <FolderIcon size={14} strokeWidth={2.1} />, "Notable folders only", () => pickStream("folders"))}
            <div className="dock-tools-group-label">Calendar</div>
            {opt(view === "day", <CalendarClock size={14} strokeWidth={2.1} />, "Day", () => pickView("day"))}
            {opt(view === "week", <CalendarRange size={14} strokeWidth={2.1} />, "Week", () => pickView("week"))}
            {opt(view === "month", <CalendarDays size={14} strokeWidth={2.1} />, "Month", () => pickView("month"))}
            {opt(view === "year", <CalendarIcon size={14} strokeWidth={2.1} />, "Year", () => pickView("year"))}
          </div>
        );
      })()}

      {homeMenuOpen && (
        <div className="dock-tools-popup dock-home-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { setHomeMenuOpen(false); goHome(); }}
          >
            <HomeIcon size={14} strokeWidth={2.1} />
            <span>{homeFolderRef.current ? `Home — ${homeFolderRef.current}` : "Home page"}</span>
          </button>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { setHomeMenuOpen(false); resetToDefault(); }}
          >
            <XCircle size={14} strokeWidth={2.1} />
            <span>Clear all filters</span>
          </button>
        </div>
      )}

      {toolsMenuOpen && (
        <div className="dock-tools-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { setToolsMenuOpen(false); setPublishOpen((o) => !o); }}
          >
            <UploadIcon size={14} strokeWidth={2.1} />
            <span>Publish</span>
          </button>
          <button
            type="button"
            className={"dock-tools-item" + (publicOnly ? " is-on" : "")}
            onClick={() => setPublicOnly((v) => { writePublicOnly(!v); return !v; })}
            title={publicOnly ? "Showing public only — click to include private" : "Showing public + private — click for public only"}
            aria-pressed={publicOnly}
          >
            {publicOnly
              ? <Globe size={14} strokeWidth={2.1} />
              : <Lock size={14} strokeWidth={2.1} />}
            <span>{publicOnly ? "Public only" : "Public + private"}</span>
          </button>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { toggleTheme(); }}
            title={`Theme: ${themeLabel(theme)} — click for ${themeLabel(nextTheme(theme))}`}
          >
            {(() => {
              const Icon = { light: Sun, dark: Moon, black: MoonStar, wordperfect: Monitor, america: Flag, christmas: TreePine, lcars: Rocket }[theme];
              return <Icon size={14} strokeWidth={2.1} />;
            })()}
            <span>Theme — {themeLabel(theme)}</span>
          </button>
          <div className="dock-tools-zoom">
            <button
              type="button"
              className="dock-tools-zoom-btn"
              onClick={() => stepTextScale(-TEXT_SCALE_STEP)}
              disabled={textScale <= TEXT_SCALE_MIN}
              aria-label="Smaller text"
            >
              <ZoomOut size={14} strokeWidth={2.1} />
            </button>
            <span className="dock-tools-zoom-label">{Math.round(textScale * 100)}%</span>
            <button
              type="button"
              className="dock-tools-zoom-btn"
              onClick={() => stepTextScale(TEXT_SCALE_STEP)}
              disabled={textScale >= TEXT_SCALE_MAX}
              aria-label="Larger text"
            >
              <ZoomIn size={14} strokeWidth={2.1} />
            </button>
          </div>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { setToolsMenuOpen(false); setSettingsOpen(true); }}
          >
            <SettingsIcon size={14} strokeWidth={2.1} />
            <span>Vault settings…</span>
          </button>
        </div>
      )}

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
                  const create = view !== "stream" ? promptCreate : createNote;
                  void create({
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
            <>
              <div className="card-grid" ref={setGridEl}>
                {sortedNotes.map((n) => {
                  // Per-Card external-change version is folded into the key:
                  // a true external edit (not one of our own writes) bumps it,
                  // remounting the Card with fresh content from disk. Same-id
                  // reloads (chain mutations, our autosaves) keep the same key
                  // and don't remount. The focused card is held stable across
                  // version bumps so editing it isn't interrupted by sync.
                  const v = externalChangeVersion[n.path] ?? 0;
                  const key = n.path === focusedPath ? n.id : `${n.id}:${v}`;
                  return (
                    <div className="card-grid-cell" data-path={n.path} key={key}>
                      {cardNode(n)}
                    </div>
                  );
                })}
              </div>
              {hasMore && (
                <div className="stream-show-more-wrap">
                  <button
                    type="button"
                    className="stream-show-more"
                    onClick={() => setStreamLimit((cur) => (cur ?? 0) + STREAM_PAGE_SIZE)}
                    title={`Showing ${sortedNotes.length} of ${sortedNotesFull.length}`}
                  >
                    Show more ({sortedNotesFull.length - sortedNotes.length} left)
                  </button>
                </div>
              )}
            </>
          )
        )}
        {view === "day" && (
          <CalendarView
            ref={calendarHandleRef}
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
            ref={calendarHandleRef}
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
            ref={calendarHandleRef}
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
            ref={yearHandleRef}
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
          // Sidebar folder click is a real toggle now: filtered → unfilter
          // (drop the include pill); not filtered → switch to the Stream,
          // add the include, and scroll to the NF's main doc.
          selected={includeSet}
          onToggle={(ref) => {
            if (includeSet.has(ref)) {
              removeFilter({ kind: "include", ref });
            } else {
              focusFolder(ref);
            }
          }}
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
          filteredRefs={includeSet}
          onToggleAreaFilter={(name) => {
            if (includeSet.has(name)) removeFilter({ kind: "include", ref: name });
            else addInclude(name);
          }}
          onToggleCategoryFilter={(name) => {
            if (includeSet.has(name)) removeFilter({ kind: "include", ref: name });
            else addInclude(name);
          }}
          filters={(
            <FilterPillStack
              filters={filters}
              onRemove={removeFilter}
              onReorder={setFilters}
              onClear={resetToDefault}
              onJump={(ref) => {
                setFocusedFolder(ref);
                const path = notePathByRef(ref);
                if (path) navigateAndFocus(path);
                else setView("stream");
              }}
            />
          )}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={notableFolders}
          selected={includeSet}
          onToggle={focusFolder}
          onClose={() => setPaletteOpen(false)}
          recents={recentFolders}
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

      {titlePrompt && (() => {
        const callerFolder = parseRef(titlePrompt.patch.folder) ?? null;
        const filterDefault = notableIncludes.length === 1 ? notableIncludes[0] : null;
        const defaultFolder = callerFolder ?? filterDefault ?? homeFolderRef.current ?? null;
        return (
          <CreateEventPrompt
            availableFolders={availableFolderRefs}
            defaultFolder={defaultFolder}
            onSubmit={async (title, folder) => {
              const patch = { ...titlePrompt.patch };
              setTitlePrompt(null);
              if (title) patch.title = title;
              if (folder) patch.folder = `[[${folder}]]`;
              else delete patch.folder;
              await createNote(patch);
            }}
            onCancel={() => setTitlePrompt(null)}
          />
        );
      })()}

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

      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

/** Keyboard-shortcut cheat sheet. Triggered by bare `?` (outside text
 *  input). Esc / backdrop / × dismiss. Reads cmdKey from the platform so
 *  Mac shows ⌘ and other OSes show Ctrl. */
function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const cmd = mac ? "⌘" : "Ctrl";
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows: { keys: string; label: string }[] = [
    { keys: `${cmd} N`, label: "New note (popup with title in calendar views)" },
    { keys: `${cmd} S`, label: "Stream view" },
    { keys: `${cmd} D`, label: "Day view" },
    { keys: `${cmd} W`, label: "Week view" },
    { keys: `${cmd} M`, label: "Month view" },
    { keys: `${cmd} Y`, label: "Year view" },
    { keys: `${cmd} ⌃ ←  /  →`, label: "Back / forward (calendar) · cycle folders (Stream)" },
    { keys: `${cmd} K`, label: "Folder command palette" },
    { keys: `${cmd} O`, label: "Open sidebar" },
    { keys: `${cmd} ;`, label: "Toggle sidebar" },
    { keys: `${cmd} P`, label: "Publish panel" },
    { keys: `${cmd} T`, label: "Cycle theme" },
    { keys: `${cmd} '`, label: "Clear all filters" },
    { keys: `${cmd} +  /  −  /  0`, label: "Note text size · grow / shrink / reset" },
    { keys: "?", label: "Toggle this guide" },
    { keys: "Esc", label: "Close popup / dialog" },
  ];
  return (
    <div className="shortcuts-help-overlay" onMouseDown={onClose}>
      <div className="shortcuts-help" onMouseDown={(e) => e.stopPropagation()}>
        <div className="shortcuts-help-head">
          <span className="shortcuts-help-title">Keyboard shortcuts</span>
          <button type="button" className="shortcuts-help-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <dl className="shortcuts-help-list">
          {rows.map((r) => (
            <div className="shortcuts-help-row" key={r.keys}>
              <dt className="shortcuts-help-keys">{r.keys}</dt>
              <dd className="shortcuts-help-label">{r.label}</dd>
            </div>
          ))}
        </dl>
      </div>
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
            {/* Fast-forward: jump the event +7 days. Lands on the same
                weekday at the same time, mirroring the manual repeat
                gesture without needing recurrence support. */}
            <button
              type="button"
              className="event-action-day event-action-day-next-week"
              onClick={() => {
                if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return;
                const [y, m, d] = eventDate.split("-").map((s) => parseInt(s, 10));
                const next = new Date(y, m - 1, d + 7);
                const iso = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
                onMoveToDay(iso);
              }}
              title="Push to next week (same day, same time)"
              aria-label="Push to next week"
            >
              <ChevronsRight size={14} strokeWidth={2.2} />
            </button>
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
 *  clicking the backdrop cancel. The folder picker is optional and
 *  visually matches the FolderPicker chip used in card footers / the
 *  event action menu — a small colored chip with the NF name; click to
 *  change. Tap × to drop the folder (root note). */
function CreateEventPrompt({ onSubmit, onCancel, availableFolders, defaultFolder }: {
  onSubmit: (title: string, folder: string | null) => void | Promise<void>;
  onCancel: () => void;
  availableFolders: { name: string; color: string }[];
  defaultFolder: string | null;
}) {
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState<string | null>(defaultFolder);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = () => onSubmit(title.trim(), folder);
  return (
    <div
      className="event-prompt-overlay"
      onMouseDown={(e) => {
        // Only dismiss when the click really lands on the backdrop —
        // not on a child of the prompt, and not on a React-portaled
        // descendant (the FolderPicker option list lives outside the
        // prompt's DOM subtree via createPortal but still bubbles
        // events through the React tree to this handler).
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="event-prompt" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="event-prompt-input"
          value={title}
          placeholder="Event title (Enter to create, Esc to cancel)"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !pickerOpen) { e.preventDefault(); void submit(); }
            if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          }}
        />
        {availableFolders.length > 0 && (
          <div className="event-prompt-folder">
            <span className="event-prompt-folder-label">folder</span>
            <FolderPicker
              current={folder}
              available={availableFolders}
              open={pickerOpen}
              query={pickerQuery}
              onOpen={() => setPickerOpen(true)}
              onClose={() => { setPickerOpen(false); setPickerQuery(""); }}
              onQueryChange={setPickerQuery}
              onAssign={async (name) => {
                setFolder(name);
                setPickerOpen(false);
                setPickerQuery("");
              }}
            />
            {folder && (
              <button
                type="button"
                className="event-prompt-folder-clear"
                onClick={() => setFolder(null)}
                title="Drop folder"
                aria-label="Drop folder"
              >
                ×
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

