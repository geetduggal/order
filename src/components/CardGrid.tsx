// Top-level shell. Loads all seed notes once (creating files / injecting
// calendar metadata as needed), then switches between the Pile masonry
// and the Week calendar. Notes' metadata is the single source of truth
// the Week view reads; individual Cards re-read their files for body
// edits so the two views can mutate safely in parallel.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Upload as UploadIcon, Settings as SettingsIcon, Files, FileText, ZoomIn, ZoomOut, Moon, MoonStar, Sun, SunMoon, Monitor, Terminal as TerminalIcon, Type as TypeIcon, Flag, TreePine, Rocket, Globe, Lock, Folder as FolderIcon, ChevronsRight, Search as SearchIcon, PanelRight, Home as HomeIcon, Calendar as CalendarIcon, CalendarDays, CalendarRange, CalendarClock, Layers, X as XCircle, Check, FilterX } from "lucide-react";
import { useTextScale, stepTextScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_STEP } from "../lib/text-scale";
import { useTheme, toggleTheme, nextTheme, themeLabel } from "../lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { join } from "@tauri-apps/api/path";
import { open as openDialog, confirm as tauriConfirm, message as tauriMessage } from "@tauri-apps/plugin-dialog";
import { vaultRoot, walkVaultMarkdown, setVaultOverride, toVaultRel, isIos, isIosSync, syncVaultRoot } from "../lib/vault";
import { vaultFs, consumeSelfWrite, markKnownBody, readKnownBody } from "../lib/vault-fs";
import { useGridLayout } from "../lib/grid-layout";
import { Card, FolderPicker } from "./Card";
import { LazyCell } from "./LazyCell";
import { FtsOverlay } from "./FtsOverlay";
import { CalendarView, type CalendarViewHandle, type NoteMeta } from "./CalendarView";
import { YearLinearView, type YearLinearViewHandle } from "./YearLinearView";
import { SeasonView, type SeasonViewHandle } from "./SeasonView";
import { parseSeasons, serializeSeasons, isSeasonsFile, type Season } from "../lib/seasons";
import {
  buildSpacetime, serializeSpacetime, parseSpacetime, serializeMarkwhen,
  parseMarkwhenFormat, mergeSpacetimes, applySpaceMutation, type SpaceMutation,
  mwUpdateEvent, mwDeleteEvent, mwAddEvent, isSpacetimeFile,
  type SpacetimeEvent, type Spacetime, type SpacetimeSource, type SpaceNode,
} from "../lib/spacetime";
import { planSpacetimeSync, summarizePlan, summarizeMwChanges, type SyncPlan, type MwChangeItem } from "../lib/spacetime-sync";
import { parseMarkwhenEvents } from "../lib/markwhen";
import { Sidebar, type NotableFolder } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";
import { PublishPanel, type HomeFolder, type PublishableNote, type PublishOutcome } from "./PublishPanel";
import { SettingsPanel } from "./SettingsPanel";
import { collectPublishedSite } from "../lib/publish";
import { folderColor, folderDirName, folderMatchKey, isMainDocPath, noteFolder, parseRef, resolveProjectToNf, nfNameToProjectSlug } from "../lib/folders";
import { computePileOrder } from "../lib/file-piles";
import { buildPushIntents, type PushIntent } from "../lib/gcal-push";
import { gcalSyncPlan, naturalKey, loadSyncRecord, saveSyncRecord, type SyncRecord } from "../lib/gcal-sync-plan";
import { distinctEmails } from "../lib/gcal-recipients";

/** Schedule/attendee portion of the push signature — the fields whose change
 *  warrants notifying guests (host, times, all-day, title, attendees). Pure +
 *  module-scoped. */
function gcalSchedSig(it: PushIntent): string {
  return [it.host, it.date, it.time ?? "", it.endTime ?? "", it.allDay, it.title, [...it.attendees].sort().join(",")].join("|");
}
/** Full per-event signature for Google-push pending tracking: the schedule sig
 *  PLUS the backing note's mtime, so editing the note's body (which becomes the
 *  event description) also re-flags the event for sync. A push happens whenever
 *  this differs from the last-synced value. */
function gcalSig(it: PushIntent): string {
  return gcalSchedSig(it) + "|" + (it.noteMtime ?? "");
}
import {
  DEFAULT_TODO_TXT_PATH,
  eventKey,
  getMirrorKeys,
  getTodoTxtSettings,
  isTodoTxtPath,
  makeTodoTxtPath,
  mutateTodoLine,
  parseTodoTxt,
  setMirrorKeys,
  splitTodoTxtPath,
  subscribeTodoTxtSettings,
  syncTodoBody,
  type MirrorSource,
  type TodoItem,
  type TodoTxtSettings,
} from "../lib/todo-txt";
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
import { planVaultMigration } from "../lib/vault-migrate";
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

// Pile membership filter — three states, cycled by the prominent
// FAB on the left rail. Persists across sessions.
//   - "all":     ordinary notes AND Notable-Folder cards (default in-app)
//   - "notes":   ordinary notes only
//   - "folders": Notable-Folder main docs only (default for published home)
export type PileMode = "all" | "notes" | "folders";
// Desktop, phone, and the published web viewer all land in "all" on
// every fresh open — no localStorage read. In-session toggles stay
// in React state but don't bleed into the next launch, so the
// landing screen is always the same surface the docs talk about.
function readPileMode(): PileMode { return "all"; }
function writePileMode(_m: PileMode): void { /* intentional no-op */ }
function nextPileMode(m: PileMode): PileMode {
  // Cycle: all → notes → folders → all.
  return m === "all" ? "notes" : m === "notes" ? "folders" : "all";
}

// Every launch defaults to Week. We deliberately do NOT persist the
// active view: the calendar surface is the home base, and a single
// accidental Pile / Day / Month switch shouldn't quietly change
// "what Order opens on" forever. Week is the right balance — a full
// look at the upcoming week without the density of a Month grid or
// the tunnel-vision of a single Day.
function readInitialView(): View {
  return "week";
}

// "Public only" filter: when on, the Pile shows only notes flagged
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

// spacetime.mw sync baseline: the mw content the vault's on-disk structure
// currently reflects (i.e. the last applied/accepted version). Persisted per
// vault root so a declined-but-kept edit still shows the "pending sync"
// indicator after a reload. Compared against the live mw to detect pending
// structural changes.
const MW_BASELINE_KEY = "order.mwSyncBaseline";
function readMwBaseline(root: string): string | null {
  try {
    const raw = localStorage.getItem(MW_BASELINE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.root === root && typeof o.content === "string" ? o.content : null;
  } catch { return null; }
}
function writeMwBaseline(root: string, content: string): void {
  try { localStorage.setItem(MW_BASELINE_KEY, JSON.stringify({ root, content })); }
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
  addMinutesToIsoTime,
  DEFAULT_EVENT_MINUTES,
  joinFrontmatter,
  splitFrontmatter,
  suggestCalendarPatch,
  toIsoDateValue,
  noteTitle,
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

type View = "pile" | "day" | "week" | "month" | "year" | "season";

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

/** A note is a calendar EVENT when it carries a date plus a time or the
 *  all-day flag. spacetime.mw is the source of truth for events, so an event
 *  note whose (date, title) is NOT in the mw is drift — an "orphan event": it
 *  must be flagged for reconciliation, never shown in a folder / pile view. */
function isOrphanEventNote(
  n: LoadedNote,
  mwEventIndex: Map<string, SpacetimeEvent>,
  linkMap?: Map<string, { date: string; title: string }>,
  focusedPath?: string | null,
): boolean {
  const date = toIsoDateValue(n.frontmatter.date);
  if (!date) return false;
  const st = typeof n.frontmatter.startTime === "string" ? n.frontmatter.startTime : "";
  const isEvent = n.frontmatter.allDay === true || /^\d{2}:\d{2}$/.test(st);
  if (!isEvent) return false;
  const title = (n.title || n.filename.replace(/\.md$/i, "")).toLowerCase();
  if (mwEventIndex.has(`${date}|${title}`)) return false; // already in spacetime
  // The note being actively edited is never "drift" — its title is mid-flight.
  if (focusedPath && n.path === focusedPath) return false;
  // A note still linked to a real spacetime event is an event BEING MODIFIED,
  // not an orphan: keep it visible (it's surfaced for review via modifiedEvents).
  const link = linkMap?.get(n.id);
  if (link && mwEventIndex.has(`${link.date}|${link.title.toLowerCase()}`)) return false;
  return true;
}

/** A Notable Folder's main document, identified STRUCTURALLY: a note named
 *  after its own parent directory — `<NF>/<NF>.md`. This replaces the
 *  `category` frontmatter heuristic (isNotableFolder) so main-doc identity is
 *  derived from structure (which mirrors spacetime), never the note's YAML. */
function isMainDoc(n: LoadedNote): boolean {
  return isMainDocPath(n.path);
}

let nextNoteId = 0;
function newNoteId(): string { return `n${nextNoteId++}`; }

/** Strip the markdown syntax most likely to appear in a note's first line
 *  so the derived title reads as plain text — leading list markers and
 *  task checkboxes, wikilinks (including Milkdown's backslash-escaped
 *  form), markdown links, inline code, emphasis, and backslash escapes
 *  of markdown specials. Conservative: pure text passes through. */
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
function needsBodyUpfront(fm: Frontmatter, filename: string): boolean {
  if (fm.role === "areas") return true;
  if (fm.role === "seasons") return true;
  if (typeof fm.category === "string" && fm.category) return true;
  if (typeof fm.list === "string" && fm.list) return true;
  // markwhen notes: the timeline lives in the body, and both the
  // spacetime mirror and the backing-note materializer need it up front.
  if (fm.markwhen === true) return true;
  // Plain-text files (.txt — currently used for todo.txt) carry no
  // frontmatter, but the todo.txt parser needs the whole body to
  // build calendar events. Pre-load so the first calendar render
  // sees them. Spacetime source files (spacetime.md / *.spacetime.md /
  // legacy .mw) are the source of truth for events, so they too must
  // be resident before the first calendar render.
  if (/\.(txt|ya?ml)$/i.test(filename) || isSpacetimeFile(filename)) return true;
  return false;
}

/** Plain-text companion files (todo.txt, spacetime.yml) and spacetime source
 *  files (spacetime.md / *.spacetime.md / legacy .mw) — edited raw, not as
 *  rich markdown. */
function isRawTextFile(filename: string): boolean {
  return /\.(txt|ya?ml)$/i.test(filename) || isSpacetimeFile(filename);
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
      if (needsBodyUpfront(frontmatter, filename)) {
        // Chain / list files: full read + splitFrontmatter so any
        // calendar-frontmatter migration runs (suggestCalendarPatch)
        // — same behaviour the old loadOne provided. Plain-text
        // files (.txt) skip the frontmatter split and the calendar
        // migration; the body is the whole file.
        const raw = await readVault(m.path);
        if (isRawTextFile(filename)) {
          body = raw;
        } else {
          const split = splitFrontmatter(raw);
          frontmatter = split.frontmatter;
          body = split.body;
          const patch = suggestCalendarPatch(frontmatter, body);
          if (patch) {
            frontmatter = { ...frontmatter, ...patch };
            try { await writeVault(m.path, joinFrontmatter(frontmatter, body)); }
            catch (err) { console.warn("calendar migration failed:", m.path, err); }
          }
        }
      } else {
        // Leaf: body stays "" until Card mounts. We intentionally skip
        // suggestCalendarPatch here because bodyHasH1("") is always false,
        // which would incorrectly stamp files like spacetime.md (which start
        // with # Space) as calendar events. Calendar injection for new notes
        // happens correctly when the Card mounts and loads the real body.
      }
      out.push({
        id: newNoteId(),
        path: m.path,
        filename,
        frontmatter,
        title: isRawTextFile(filename) ? filename : noteTitle(frontmatter, body, filename.replace(/\.md$/, "")),
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
  // Live mirror of `view` for callbacks with empty dep arrays (removeFilter).
  const viewRef = useRef<View>(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  // Wipe any persisted view from earlier builds — Order now always opens
  // on the viewport-default (Week on desktop, Day on phones).
  useEffect(() => { try { localStorage.removeItem("order.view"); } catch { /* non-fatal */ } }, []);
  // Every time the user switches to a calendar surface (Day / Week /
  // Month / Year), drop all filters so the calendar lands on the full
  // vault by default. The effect re-runs only when `view` changes, so
  // filters the user adds AFTER landing on a calendar view persist
  // until they leave or pick another scale. Pile / newspaper mode
  // is unaffected — its filters belong to its own context.
  useEffect(() => {
    if (view === "day" || view === "week" || view === "month" || view === "year" || view === "season") {
      setFilters([]);
    }
  }, [view]);
  // Imperative handles for Cmd+arrow nav inside the active calendar view.
  // Only one of the two is "live" at a time (the mounted view sets it; the
  // other stays null), so the key handler can blindly call .current.
  const calendarHandleRef = useRef<CalendarViewHandle | null>(null);
  const yearHandleRef = useRef<YearLinearViewHandle | null>(null);
  const seasonHandleRef = useRef<SeasonViewHandle | null>(null);
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
  // Ref mirror so the []-dep effectiveFolder callback can see the live value.
  const focusedPathRef = useRef<string | null>(null);
  focusedPathRef.current = focusedPath;
  // Stable note→event link: a note's durable id → the spacetime event it last
  // backed (date+title). The id survives title edits AND renames, so when the
  // user edits an event's note the title diverges from the mw line but the link
  // persists — Order recognises "this event is being modified" instead of
  // orphaning the note. Populated when the calendar matches notes to events
  // (chipMap build); never cleared (validity is checked against the live mw).
  const noteEventLinkRef = useRef<Map<string, { date: string; title: string }>>(new Map());
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
  // Todo.txt mode is opt-in via Settings. When enabled, new calendar
  // events go into `<configured path>` instead of as standalone .md
  // files. Subscribed via a custom event so a settings flip from the
  // panel propagates without a reload.
  const [todoSettings, setTodoSettings] = useState<TodoTxtSettings>(getTodoTxtSettings);
  useEffect(() => subscribeTodoTxtSettings(setTodoSettings), []);
  // Active filter pills. `null` until hydrated so the first-load
  // default-home-exclude effect can tell "never set" from "user
  // cleared everything".
  const [filters, setFilters] = useState<Filter[]>(() => readStoredFilters() ?? []);
  // Bumped by the home-reset to collapse every section's Show-more
  // expansion back to its first batch.
  const [collapseNonce, setCollapseNonce] = useState(0);
  // The folder whose Main Document is pinned to the top of the Pile.
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
  // "Notes only" toggle: hide Notable-Folder cards from the Pile and
  // show ordinary notes only. Persisted; survives filter changes.
  const [pileMode, setPileMode] = useState<PileMode>(readPileMode);
  // "Public only" toggle: show only `public: true` notes in the Pile
  // (off = public + private together). Persisted; survives filter changes.
  const [publicOnly, setPublicOnly] = useState<boolean>(readPublicOnly);
  // Pile pagination: cap initial Card mounts when nothing is filtered.
  // Card mounts ProseMirror per note, so unbounded Piles at 10^4 notes
  // are dead on arrival. `pileLimit = N` shows the N most-recent notes;
  // a "Show more" tile bumps it. null = unbounded (e.g., the user clicked
  // "Show more" enough to get there, or a filter is active).
  const PILE_PAGE_SIZE = 60;
  const [pileLimit, setPileLimit] = useState<number | null>(PILE_PAGE_SIZE);
  useEffect(() => { setPileLimit(PILE_PAGE_SIZE); }, [filters]);
  // Latest sorted-full list, read by the target-extend effect below
  // without forcing the effect to refire on every render (a non-memoed
  // array would cause that — we want it to fire only when a new target
  // is requested, then look up against current state).
  const sortedFullRef = useRef<LoadedNote[]>([]);
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
  /** Remove a specific pill (matched by kind + ref). If this empties
   *  the filter set, behave like resetToDefault — clear collapsing
   *  signal + jump to the default Week view — so dismissing the last
   *  pinned NF doesn't leave the cleared pile behind, which read
   *  as "the close button didn't do anything" since the NF Main Doc
   *  re-rendered as a flat-grid card. */
  const removeFilter = useCallback((target: Filter) => {
    // Home is non-removable in pile view (it's the sticky anchor). The
    // pill renders without an × anyway; this guards the keyboard / other
    // paths. To go unfiltered, switch to a calendar view.
    if (
      target.kind === "include" &&
      target.ref === homeFolderRef.current &&
      viewRef.current === "pile"
    ) {
      return;
    }
    setFilters((prev) => {
      const next = prev.filter(
        (f) => !(f.kind === target.kind && f.ref === target.ref),
      );
      // Diagnostic — verify a single tap fires once and yields the
      // right state. Keep until the close-twice complaint is gone.
      // eslint-disable-next-line no-console
      console.log("[removeFilter]", target, "prev", prev, "next", next);
      if (next.length === 0) {
        setCollapseNonce((n) => n + 1);
        setView("week");
      }
      return next;
    });
  }, []);
  /** Reset to the default view: a single include pill for the home
   *  Notable Folder, AND collapse every section's Show-more
   *  expansion (via collapseNonce). The home-reset icon and the
   *  sidebar's clear-× both call this. Empty vault → no filters. */
  const resetToDefault = useCallback(() => {
    // No more home-folder seeding: clearing filters clears them. The
    // calendar / Pile then show everything in scope (subject to the
    // notes-only / public-only toggles). The default landing surface
    // is Week — same as a cold launch — so clearing also resets the
    // view there. The user can still tap a different view from the
    // dock; this just means "start over" is one tap, not two.
    setFilters([]);
    setCollapseNonce((n) => n + 1);
    setView("week");
    // The home ⇄ week toggle leaves Week with a clean slate — drop
    // the Show 3-state back to "all" so a leftover "notes only" or
    // "folders only" from the home view doesn't carry over and hide
    // half the calendar.
    setPileMode(() => { writePileMode("all"); return "all"; });
  }, []);
  // Forward-ref binding for Cmd+' (declared earlier in the component).
  useEffect(() => { resetToDefaultRef.current = resetToDefault; }, [resetToDefault]);

  // A note's effective Notable Folder for display + membership. The space
  // tree maps each folder to a directory (Area/Category/Folder) and notes
  // live directly inside it, so a note's PARENT DIRECTORY *is* its folder —
  // that is the canonical home (#geet-duggal → Geet Duggal → .../Geet Duggal/).
  // The `folder:` frontmatter field is consulted only as a fallback for a
  // note that sits OUTSIDE any folder dir (e.g. a loose note at the vault
  // root). This is why a folder page shows every note in its directory, not
  // just the few that happen to carry a `folder:` field — and regardless of
  // whether the note backs a spacetime.mw event (the pile isn't mw-gated).
  const folderDirIndexRef = useRef<Map<string, string>>(new Map());
  const effectiveFolder = useCallback((n: LoadedNote): string | null => {
    // spacetime.mw is the source of truth for events. A note carrying
    // calendar-event frontmatter (a date plus a time or the all-day flag) IS an
    // event; if that event is NOT in the mw it's drift, and must not surface in
    // any folder / pile view — it's flagged in the reconciliation indicator
    // (see orphanedEvents) for the user to add to spacetime.mw or remove.
    if (isOrphanEventNote(n, mwEventIndexRef.current, noteEventLinkRef.current, focusedPathRef.current)) return null;
    // A note is a FLAT member of a Notable Folder only when it sits directly in
    // one: <Area>/<Category>/<NF>/<note>.md (4 path segments). We key off the NF
    // POSITION (parts[2]) — not the immediate parent dir NAME — so a note nested
    // in a subfolder (e.g. Readwise/Articles/…) is never matched to a same-named
    // NF elsewhere in the tree. Anything nested deeper than the NF is library
    // content surfaced by that folder's list/base query, not the flat pile, and
    // is never an orphan. Placement is the directory's (spacetime's) job — there
    // is deliberately no `folder:` frontmatter fallback.
    const parts = toVaultRel(n.path).split("/");
    if (parts.length === 4) {
      const canonical = folderDirIndexRef.current.get(folderMatchKey(parts[2]));
      if (canonical) {
        // Auto-membership: the main doc (<NF>/<NF>.md) and dated notes
        // (<NF>/YYYY-MM-DD *.md) appear in the folder's pile automatically.
        // Any other file is left alone on disk (not flagged, not auto-shown);
        // it can be surfaced in the pile on demand via File Piles.
        const base = n.filename.replace(/\.md$/i, "");
        const isMain = folderMatchKey(base) === folderMatchKey(parts[2]);
        const isDated = /^\d{4}-\d{2}-\d{2}/.test(base);
        return (isMain || isDated) ? canonical : null;
      }
    }
    return null;
  }, []);
  /** Scroll the pile to a card and pin focus on it. Single entry
   *  point used by every navigation surface (sidebar tile, calendar
   *  Open, command palette, wikilink, filter-pill jump) so the
   *  "click → focused card" guarantee holds uniformly.
   *
   *  Side effect: additively include the note's Notable Folder in
   *  the filter set. This narrows the Pile to the section that
   *  contains the note — newspaper mode kicks in, the NF main doc
   *  lands at the top, and the scroll target has far less mass
   *  around it to drift through. Side benefit: it doubles as a
   *  navigation breadcrumb ("you're inside Cal Newport now") that
   *  the user can dismiss with the pill's ×. */
  const navigateAndFocus = useCallback((path: string) => {
    setView("pile");
    const note = notesRef.current?.find((n) => n.path === path);
    if (note) {
      // Public-only is on but the target is private — drop the lens so
      // the note actually surfaces. Otherwise the click would silently
      // do nothing (filter hides the card it just pinned).
      if (publicOnly && note.frontmatter.public !== true) {
        setPublicOnly(false);
        writePublicOnly(false);
      }
      const ownRef = note.filename.replace(/\.md$/i, "");
      const targetFolder = isMainDoc(note)
        ? ownRef
        : effectiveFolder(note);
      if (targetFolder) {
        // Pin the target NF at the FRONT of the include set so its
        // newspaper section renders at the top of the Pile. Any
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
      } else {
        // Folder-less note: pin its OWN ref so the include filter
        // narrows to just this one card. belongsTo() matches by
        // filename ref, so the note appears alone instead of getting
        // lost in whatever the current pile happens to show.
        setFilters((prev) => [
          { kind: "include", ref: ownRef },
          ...prev.filter((f) => !(f.kind === "include" && f.ref === ownRef)),
        ]);
      }
    }
    setScrollTargetPath(path);
    setFocusPath(path);
    setFocusedPath(path);
  }, [markFolderRecent, publicOnly]);
  /** Add an include filter AND scroll the pile to it. Bound to
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
  /** Pick a folder from the command palette: switch to the Pile,
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
      setView("pile");
    }
  }, [navigateAndFocus]);
  /** Jump to the home Notable Folder — the one whose YAML carries
   *  `home: "<user>/<repo>/<path>"`. Sets the filter to ONLY that
   *  folder (clearing any other includes/excludes), so the user lands
   *  on the home newspaper section as if Order had just opened.
   *  Falls back to plain reset if no home folder exists. */
  const goHome = useCallback(() => {
    setView("pile");
    setCollapseNonce((n) => n + 1);
    // Home shows both Notable Folders AND notes (pileMode "all") —
    // matches the viewer's home and the user's mental model of "home
    // is the whole pile filtered to my home folder." The dock
    // pileMode cycle button still lets you narrow to one or the
    // other within the session.
    setPileMode("all");
    const home = homeFolderRef.current;
    if (!home) { setFilters([]); return; }
    setFilters([{ kind: "include", ref: home }]);
    setFocusedFolder(home);
    const path = notePathByRef(home);
    if (path) navigateAndFocus(path);
  }, [navigateAndFocus]);
  // Forward-ref binding for Cmd+R's "jump to home" half of the toggle.
  useEffect(() => { goHomeRef.current = goHome; }, [goHome]);

  // Cmd+4: open the terminal for the currently-focused Notable Folder.
  // "Focused" = the pinned/focused NF, else the top of the include pile,
  // else home. We navigate to the NF's Main Document so its card is
  // visible, then dispatch `order:open-terminal` with the folder name —
  // the matching Card opens its in-card terminal (identical to clicking
  // the card's terminal icon). Bound through a ref so the keydown effect
  // always calls the latest closure.
  const openFocusedTerminal = useCallback(() => {
    const name = focusedFolder
      ?? notableIncludesRef.current[0]
      ?? homeFolderRef.current;
    if (!name) return;
    const path = notePathByRef(name);
    if (path) navigateAndFocus(path);
    window.dispatchEvent(new CustomEvent<string>("order:open-terminal", { detail: name }));
  }, [focusedFolder, navigateAndFocus]);
  useEffect(() => { openTerminalRef.current = openFocusedTerminal; }, [openFocusedTerminal]);

  // Parse spacetime.yml into memory once per notes change. Used as the
  // single-file fallback when no vault-wide .mw sources are present.
  const parsedSpacetime = useMemo<Spacetime | undefined>(() => {
    if (!notes) return undefined;
    // Root spacetime.yml only — sub-folder copies (Craft/spacetime.yml) are
    // partial mirrors and must not shadow the canonical root file.
    const st = notes.find((n) => toVaultRel(n.path) === "spacetime.yml");
    if (!st || !st.body) return undefined;
    return parseSpacetime(st.body);
  }, [notes]);

  // Collect ALL spacetime source files in the vault as composable sources.
  // The root spacetime.md (or legacy spacetime.mw) is included (it's the
  // primary single-file source); other spacetime files anywhere in the vault
  // (*.spacetime.md / *.mw) contribute sub-broods. spacetime.yml is separate.
  const mwSources = useMemo<SpacetimeSource[]>(() => {
    if (!notes) return [];
    return notes
      .filter((n) => isSpacetimeFile(n.filename) && n.body)
      .map((n) => ({
        parsed: parseMarkwhenFormat(n.body),
        path: n.filename,
      }));
  }, [notes]);

  // The canonical ROOT spacetime file, resolved adaptively so both new
  // (spacetime.md) and legacy (spacetime.mw) vaults work: prefer an existing
  // root spacetime.md, else a legacy root spacetime.mw, else default to
  // spacetime.md for the first write. Every canonical read/write below keys
  // off this (via the ref, to stay current inside async callbacks).
  const spacetimeRootPath = useMemo<string>(() => {
    const rels = new Set((notes ?? []).map((n) => toVaultRel(n.path)));
    if (rels.has("spacetime.md")) return "spacetime.md";
    if (rels.has("spacetime.mw")) return "spacetime.mw";
    return "spacetime.md";
  }, [notes]);
  // Kept current synchronously (not via effect) so render-time memos that read
  // it (mwEventIndex etc.) see the resolved path on the SAME render notes load,
  // never a one-render-stale default. This assignment runs before those memos.
  const spacetimeRootPathRef = useRef(spacetimeRootPath);
  spacetimeRootPathRef.current = spacetimeRootPath;

  // Walk the chain rooted at Areas.md to produce Areas → Categories
  // → Folder refs. When .mw sources or spacetime.yml carry a space tree,
  // that drives the taxonomy; chain files stay on disk as a fallback.
  const vaultTaxonomy = useMemo(() => {
    if (!notes) return { areas: [], hiddenRefs: new Set<string>() };
    // When .mw sources are present, derive the effective space from their merge
    // so the sidebar reflects the composable hierarchy. Fall back to yml, then chain.
    let effectiveSpacetime = parsedSpacetime;
    if (mwSources.length > 0) {
      const r = mergeSpacetimes(mwSources);
      if (r.spacetime.space.length > 0) effectiveSpacetime = r.spacetime;
    }
    return buildVaultTaxonomy(
      notes.map((n) => ({ filename: n.filename, frontmatter: n.frontmatter, body: n.body })),
      effectiveSpacetime,
    );
  }, [notes, parsedSpacetime, mwSources]);

  // Index each Notable Folder's on-disk directory name → its canonical name
  // so effectiveFolder() can resolve a note's parent directory to the folder
  // it lives in. Keyed by both the raw and the filesystem-sanitized name (the
  // directory uses the sanitized form, e.g. "Foo: Bar" → "Foo- Bar").
  const folderDirIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of vaultTaxonomy.areas)
      for (const c of a.categories)
        for (const f of c.folders) m.set(folderMatchKey(f), f);
    return m;
  }, [vaultTaxonomy]);
  folderDirIndexRef.current = folderDirIndex;

  // Drift detection (spacetime.mw is the source of truth): Notable Folder main
  // docs that exist on disk but are NOT in the mw space tree. These are cruft —
  // e.g. a folder removed from spacetime.mw whose directory was kept, or a
  // stale dir left by an earlier bug. Surfaced in the sync review so the user
  // can reconcile (remove the directory, or re-add it to spacetime.mw).
  // A Notable Folder is identified STRUCTURALLY, not by frontmatter: its main
  // doc lives at `<Area>/<Category>/<Folder>/<Folder>.md` (filename === its own
  // directory). Area + Category are read straight from the path. The note's
  // `area:` / `category:` frontmatter is NOT consulted — the directory tree and
  // spacetime.mw are the only sources of truth.
  const orphanedFolders = useMemo<{ name: string; path: string; fileCount: number; area: string; category: string }[]>(() => {
    if (!notes) return [];
    const out: { name: string; path: string; fileCount: number; area: string; category: string }[] = [];
    for (const n of notes) {
      const rel = toVaultRel(n.path);
      const parts = rel.split("/");
      if (parts.length !== 4) continue;                       // Area/Category/Folder/Folder.md
      const folder = parts[2];
      if (parts[3].replace(/\.md$/i, "") !== folder) continue; // main doc names its own dir
      if (folderDirIndex.has(folderMatchKey(folder))) continue; // already in spacetime.mw (normalized + truncation-aware)
      const dir = vaultDir(rel);
      const fileCount = notes.filter((x) => toVaultRel(x.path).startsWith(dir + "/")).length;
      out.push({ name: folder, path: n.path, fileCount, area: parts[0], category: parts[1] });
    }
    return out;
  }, [notes, folderDirIndex]);

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
  // Desktop vault-load failure (wrong / blocked / missing folder — e.g.
  // a default path that only exists on another machine). Without this the
  // load throws, `notes` stays null, and the app freezes on "Preparing
  // cards…" with no reachable Settings. loadError drives a recovery screen
  // that re-opens the folder picker; loadErrorPath is the path we tried.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadErrorPath, setLoadErrorPath] = useState<string>("");

  const reloadNotes = useCallback(async () => {
    let attemptedRoot = "";
    try {
      // On iOS an empty root means no vault bookmark yet — prompt a pick
      // rather than rendering an empty vault.
      const root = await syncVaultRoot();
      attemptedRoot = root;
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
      setLoadError(null);
    } catch (err) {
      console.error("reload failed:", err);
      setLoadError(String(err));
      setLoadErrorPath(attemptedRoot || (await vaultRoot().catch(() => "")));
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
  // Snapshot of externalChangeVersion at the moment a card became
  // focused. Held in a ref so reads + writes don't trigger renders.
  // The keyFor below freezes the focused card's key at this snapshot
  // so a subsequent watcher bump (e.g. our own write re-entering via
  // slow-sync) doesn't change the key and remount the card mid-edit.
  //
  // Just as important: the snapshot is captured LAZILY during the
  // first keyFor read after focus flips, not in a useEffect that runs
  // after the consuming render. That window is exactly where the
  // "first tap does nothing, second tap works" bug used to live —
  // the old keyFor returned `${id}` (no version suffix) for the
  // focused card and `${id}:0` for everyone else, so the very first
  // mousedown changed the key, React unmounted the card, and the
  // matching click event landed on a detached DOM node. With the
  // lazy snapshot, the key stays at `${id}:${cur}` across the focus
  // flip, no remount happens, and the click delivers normally. */
  const focusedKeyVersionRef = useRef<Record<string, number>>({});

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
     *  No longer used as a filter — see reportExternal. Kept here in
     *  case we want the comparison back as a "real-content" telemetry
     *  signal later. */
    void readKnownBody;
    void markKnownBody;
    async function reportExternal(paths: string[]) {
      if (cancelled) return;
      // Drop our own writes from the change set; anything remaining is
      // a genuine external mtime change.
      const external: string[] = [];
      for (const p of paths) if (!consumeSelfWrite(p)) external.push(p);
      // eslint-disable-next-line no-console
      console.log("[watcher] reportExternal", { incoming: paths.length, external: external.length, paths: external });
      if (external.length === 0) return;
      // Bump for every external mtime change. We used to filter via
      // a body-comparison check to skip Dropbox / iCloud touches that
      // change mtime without changing content — but that filter was
      // also (silently) eating real edits whenever the body cache
      // hadn't been populated for the path, leaving the user staring
      // at stale content. Reliability over efficiency: bump always,
      // and let the Card's remount re-read the disk. A spurious
      // remount on a content-less touch is annoying but recoverable;
      // a missed edit is invisible and infuriating.
      bumpExternal(external);
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
        // eslint-disable-next-line no-console
        console.log("[watcher] notify started on", root);
        unlisten = await listen<string[]>("vault-changed", (e) => {
          // OS-level event from the notify watcher: handle content
          // changes via the content-aware path AND force an index
          // reload so brand-new / deleted files reach the Pile.
          // (The watcher doesn't distinguish create/delete from
          // modify; reload is cheap relative to body re-reads, and
          // happens at most once per 250ms via the timer.)
          const paths = e.payload ?? [];
          // eslint-disable-next-line no-console
          console.log("[watcher] notify event", paths);
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
        if (added || removed || changed.length > 0) {
          // eslint-disable-next-line no-console
          console.log("[watcher] poll", { added, removed, changed: changed.length });
        }
        if (added || removed) scheduleReload();
        if (changed.length > 0) void reportExternal(changed);
        firstPoll = false;
      } catch { /* sleep + retry */ }
      // iOS lacks a working recursive notify watcher under the
      // security-scoped sandbox, so the poller is the ONLY freshness
      // signal there. 15 s left external edits feeling laggy; drop to
      // 5 s. The content-aware filter still drops pure-touch noise.
      if (!cancelled) pollTimer = setTimeout(pollOnce, isIosSync() ? 5000 : 3000);
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

  // Lightweight inline toast (bottom-center pill). `warn` = coral nudge
  // (caps, blocked actions); `ok` = calm confirmation that replaces what used
  // to be obtrusive native "success" dialogs.
  const [capWarning, setCapWarning] = useState<{ text: string; kind: "warn" | "ok" } | null>(null);

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

  /** Filename (no .md) of the Notable Folder marked as home — the
   *  one whose YAML carries `home: "<user>/<repo>/<path>"`. Single
   *  source of truth for both navigation and publishing now that the
   *  card-chrome home toggle writes the same key (and the parent
   *  enforces "one home at a time" by clearing any previous holder).
   *  Held as a ref so createNote can read the latest value without
   *  re-running on every notes change. */
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

  // Remember the last "meaningful" pile — a non-empty filter set plus its
  // focused folder and pile mode — captured whenever the pile is showing
  // one. A trip to a calendar view clears the filters (resetToDefault /
  // dropping the last pill both jump to Week with an empty set), so this
  // snapshot is what Cmd+P restores: you land back on the pile exactly as
  // you left it, not on the cleared everything-shown pile.
  const pileRef = useRef<{ filters: Filter[]; focusedFolder: string | null; pileMode: PileMode } | null>(null);
  useEffect(() => {
    if (view === "pile" && filters.length > 0) {
      pileRef.current = { filters, focusedFolder, pileMode };
    }
  }, [view, filters, focusedFolder, pileMode]);

  // Home is sticky in the Pile: pile view ALWAYS includes the home folder
  // (pinned, non-removable). Only a calendar view may be unfiltered. If
  // we're in pile view and home isn't an active include, append it.
  useEffect(() => {
    if (view !== "pile") return;
    const home = homeFolderRef.current;
    if (!home) return;
    if (filters.some((f) => f.kind === "include" && f.ref === home)) return;
    setFilters((prev) =>
      prev.some((f) => f.kind === "include" && f.ref === home)
        ? prev
        : [...prev, { kind: "include", ref: home }],
    );
  }, [view, filters]);

  /** Jump to the last remembered pile (its filters, focused folder, and
   *  pile mode). Only non-empty piles are ever remembered, so if there's
   *  no snapshot — or it was the global unfiltered pile — fall back to
   *  going home. Powers the dock's "last pile" button. */
  const goToPile = useCallback(() => {
    const last = pileRef.current;
    if (last && last.filters.length > 0) {
      setView("pile");
      setCollapseNonce((n) => n + 1);
      setFilters(last.filters);
      setFocusedFolder(last.focusedFolder);
      setPileMode(last.pileMode);
      const focusName = last.focusedFolder;
      const path = focusName ? notePathByRef(focusName) : null;
      if (path) navigateAndFocus(path);
      requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    } else {
      goHome();
    }
  }, [goHome, navigateAndFocus]);

  // First-ever launch (no persisted filters) seeds an `include` pill
  // for the home Notable Folder, so Order opens focused on home (its
  // Main Doc pinned, its notes below). Runs in useLayoutEffect so it
  // lands before first paint (no flash of the unfiltered pile).
  // After the first run, the persisted set wins and the user is free
  // to add/remove pills.
  const seededDefault = useRef<boolean>(readStoredFilters() !== null);
  // Default at app open: no folder filter. The calendar shows everything
  // dated; the Pile shows the full recency timeline. Used to seed the
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
  const handlePublish = useCallback(async (home: HomeFolder, extras?: { githubToken?: string; commitMessage?: string }): Promise<PublishOutcome> => {
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
      // Publish the spacetime-derived hierarchy so the viewer's sidebar is
      // built from the (public subset of) spacetime, not legacy Areas.md files.
      taxonomy: { areas: vaultTaxonomy.areas },
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
        github_token: extras?.githubToken,
        commit_message: extras?.commitMessage,
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
        mtime: n.mtime,
      }));
  }, [notes]);
  const flashCap = useCallback((msg: string, kind: "warn" | "ok" = "warn") => {
    setCapWarning({ text: msg, kind });
    setTimeout(() => setCapWarning((c) => (c?.text === msg ? null : c)), 2500);
  }, []);

  // ---- spacetime.mw space/season mutation helpers ----------------
  // All structure edits (add/remove/reorder area, category, folder; season
  // writes) read from and write to spacetime.mw — the single source of truth.
  // Reading from the mw (not the yml) is essential: the mw holds the full,
  // current event list, so re-serializing preserves events. Basing these off a
  // possibly-stale yml would erase events from the mw. spacetime.yml is then
  // mirrored from the same model so external yml readers stay consistent.

  // ---- spacetime.mw hand-edit review baseline ----
  // mwBaselineRef holds the mw content the on-disk structure reflects (the
  // last APPLIED/accepted version). A hand-edit that diverges from it stages
  // a review (see Effect 2) rather than auto-applying. Declared here so
  // writeSpacetimeModel can advance it; the rest of the review state lives
  // further down with Effect 2.
  const mwBaselineRef = useRef<string | null>(null);
  const mwVaultRootRef = useRef<string>("");
  const persistMwBaseline = useCallback((content: string) => {
    mwBaselineRef.current = content;
    if (mwVaultRootRef.current) writeMwBaseline(mwVaultRootRef.current, content);
  }, []);

  /** Persist a full Spacetime model to both mw and yml, and optimistically
   *  update the in-memory mw note so the sidebar/calendar recompute now. */
  const writeSpacetimeModel = useCallback(async (next: Spacetime): Promise<void> => {
    const mwContent = serializeMarkwhen(next);
    lastMarkwhenRef.current = mwContent;
    lastMwSpaceRef.current = mwContent.split("# Time")[0];
    await writeVault(spacetimeRootPathRef.current, mwContent);
    const yml = serializeSpacetime(next);
    lastSpacetimeRef.current = yml;
    await writeVault("spacetime.yml", yml);
    // Programmatic structure edits (sidebar tiles, calendar) are applied
    // immediately and ARE the accepted path, so advance the hand-edit review
    // baseline to match — they must never register as a "pending" mw change.
    persistMwBaseline(mwContent);
    setNotes((prev) => prev?.map((n) =>
      toVaultRel(n.path) === spacetimeRootPathRef.current ? { ...n, body: mwContent } : n) ?? null);
  }, [persistMwBaseline]);

  const patchSpacetimeSpace = useCallback(async (mutation: SpaceMutation): Promise<void> => {
    const mw = await readVault(spacetimeRootPathRef.current).catch(() => "");
    const st = parseMarkwhenFormat(mw);
    await writeSpacetimeModel({ ...st, space: applySpaceMutation(st.space, mutation) });
  }, [writeSpacetimeModel]);

  const patchSpacetimeSeasons = useCallback(async (seasons: import("../lib/seasons").Season[]): Promise<void> => {
    const mw = await readVault(spacetimeRootPathRef.current).catch(() => "");
    const st = parseMarkwhenFormat(mw);
    await writeSpacetimeModel({
      ...st,
      seasons: seasons.map((s) => ({
        date: s.start,
        title: s.name ?? "",
        ...(s.end ? { endDate: s.end } : {}),
      })),
    });
  }, [writeSpacetimeModel]);

  /** Add an Area = append a bullet to Areas.md. Caps at 10. */
  const handleAddArea = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const cur = parseMarkwhenFormat(await readVault(spacetimeRootPathRef.current).catch(() => ""));
    if (cur.space.length >= 10) { flashCap("Areas full (10 / 10) — remove one to add another."); return; }
    await patchSpacetimeSpace({ kind: "addArea", name: trimmed });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes, flashCap]);

  const handleRemoveArea = useCallback(async (name: string) => {
    await patchSpacetimeSpace({ kind: "removeArea", name });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

  const handleAddCategory = useCallback(async (name: string, areaName: string) => {
    const trimmed = name.trim();
    const trimmedArea = areaName.trim();
    if (!trimmed || !trimmedArea) return;
    // Read from the mw (source of truth) so events are preserved on rewrite.
    const cur = parseMarkwhenFormat(await readVault(spacetimeRootPathRef.current).catch(() => ""));
    const area = cur.space.find((a) => a.name === trimmedArea);
    if (area && area.children.length >= 10) {
      flashCap(`${trimmedArea} full (10 / 10 categories) — remove one to add another.`); return;
    }
    // Ensure Area exists in space, then add the category
    let next = area ? cur : { ...cur, space: applySpaceMutation(cur.space, { kind: "addArea", name: trimmedArea }) };
    next = { ...next, space: applySpaceMutation(next.space, { kind: "addCategory", area: trimmedArea, name: trimmed }) };
    await writeSpacetimeModel(next);
    await reloadNotes();
  }, [reloadNotes, flashCap, writeSpacetimeModel]);

  const handleRemoveCategory = useCallback(async (name: string, areaName: string) => {
    await patchSpacetimeSpace({ kind: "removeCategory", area: areaName, name });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

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

  // Single-step up/down reorders. The hierarchy lives in spacetime.mw, so these
  // compute the new order from the mw-derived taxonomy and apply a reorder
  // mutation to the mw (the old list-file bullet edits were vestigial — the
  // sidebar reads its order from the mw, not the chain files).
  const swapOrder = (refs: string[], name: string, dir: "up" | "down"): string[] | null => {
    const i = refs.findIndex((r) => r.toLowerCase() === name.toLowerCase());
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= refs.length) return null;
    const out = [...refs];
    [out[i], out[j]] = [out[j], out[i]];
    return out;
  };

  const handleReorderArea = useCallback(async (name: string, dir: "up" | "down") => {
    const order = swapOrder(vaultTaxonomy.areas.map((a) => a.ref), name, dir);
    if (!order) return;
    await patchSpacetimeSpace({ kind: "reorderAreas", names: order });
    await reloadNotes();
  }, [vaultTaxonomy, patchSpacetimeSpace, reloadNotes]);

  const handleReorderCategory = useCallback(async (name: string, areaName: string, dir: "up" | "down") => {
    const area = vaultTaxonomy.areas.find((a) => a.ref === areaName);
    if (!area) return;
    const order = swapOrder(area.categories.map((c) => c.ref), name, dir);
    if (!order) return;
    await patchSpacetimeSpace({ kind: "reorderCategories", area: areaName, names: order });
    await reloadNotes();
  }, [vaultTaxonomy, patchSpacetimeSpace, reloadNotes]);

  const handleReorderFolder = useCallback(async (name: string, areaName: string, categoryName: string, dir: "up" | "down") => {
    const cat = vaultTaxonomy.areas.find((a) => a.ref === areaName)?.categories.find((c) => c.ref === categoryName);
    if (!cat) return;
    const order = swapOrder(cat.folders, name, dir);
    if (!order) return;
    await patchSpacetimeSpace({ kind: "reorderFolders", area: areaName, category: categoryName, names: order });
    await reloadNotes();
  }, [vaultTaxonomy, patchSpacetimeSpace, reloadNotes]);

  // Remove a Notable Folder from a Category: drop it from spacetime.yml
  // space tree. The note itself is kept (non-destructive).
  const handleRemoveFolder = useCallback(async (name: string, areaName: string, categoryName: string) => {
    await patchSpacetimeSpace({ kind: "removeFolder", area: areaName, category: categoryName, name });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

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
    await patchSpacetimeSpace({ kind: "reorderAreas", names });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

  const handleReorderCategoriesTo = useCallback(async (areaName: string, names: string[]) => {
    await patchSpacetimeSpace({ kind: "reorderCategories", area: areaName, names });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

  const handleReorderFoldersTo = useCallback(async (areaName: string, categoryName: string, names: string[]) => {
    await patchSpacetimeSpace({ kind: "reorderFolders", area: areaName, category: categoryName, names });
    await reloadNotes();
  }, [patchSpacetimeSpace, reloadNotes]);

  // Shape Sidebar's existing API expects.
  const storedAreas = vaultTaxonomy.areas.map((a) => a.ref);
  const storedCategories = vaultTaxonomy.areas.flatMap((a) =>
    a.categories.map((c) => ({ area: a.ref, name: c.ref })),
  );

  // Popover state for the new-note picker (shows when multiple
  // folders are selected and the user clicks the + FAB).
  const [creatorOpen, setCreatorOpen] = useState(false);
  // Cmd+K opens the centered command palette (open a folder by name).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [ftsOpen, setFtsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  // Dock-view picker — pick a pile sub-mode or a calendar view
  // from a menu instead of cycling through them by repeated taps.

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
  /** Recover from a failed vault load by re-picking the folder. iOS uses
   *  its scoped-bookmark picker; desktop opens the native directory
   *  dialog. A successful reload clears loadError and renders the cards. */
  const recoverVault = useCallback(async () => {
    if (await isIos()) { await pickVaultIos(); return; }
    try {
      const result = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: loadErrorPath || undefined,
      });
      if (typeof result === "string") await handleChangeVault(result);
    } catch (err) {
      console.error("vault re-pick failed:", err);
    }
  }, [handleChangeVault, loadErrorPath, pickVaultIos]);
  // Forward-ref to createNote so Cmd+N can invoke it from the keyboard
  // useEffect above the declaration site without a TS forward-ref error.
  const createNoteRef = useRef<((p: Frontmatter) => Promise<void>) | null>(null);
  const promptCreateRef = useRef<((p: Frontmatter) => Promise<void>) | null>(null);
  // Forward-ref so the keyboard handler (declared above resetToDefault)
  // can invoke the latest version for Cmd+'.
  const resetToDefaultRef = useRef<(() => void) | null>(null);
  // Same forward-ref pattern for Cmd+R's "jump to home" half of the
  // toggle — goHome is defined earlier and we don't want a stale
  // closure from the keydown effect's mount.
  const goHomeRef = useRef<(() => void) | null>(null);
  // Cmd+4 opens the terminal for the currently-focused Notable Folder —
  // same effect as clicking the terminal icon on that NF's card. It
  // dispatches a window event the matching Card listens for (forward-ref
  // so the keydown effect calls the latest closure).
  const openTerminalRef = useRef<(() => void) | null>(null);
  // Shortcuts overlay — toggled by bare `?` outside text input.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return true;
      return t.isContentEditable; // covers Milkdown / ProseMirror
    }
    function onKey(e: KeyboardEvent) {
      // The in-card terminal owns the keyboard while it's focused: every
      // keystroke — Ctrl-C/D/W/R, vim's Ctrl-F/B/D/U and Esc, arrows,
      // everything — must reach the shell, not trigger an app shortcut.
      // (The global handler otherwise fires on Ctrl as well as Cmd, so
      // vim's Ctrl commands and the shell's control keys were being eaten
      // as Day/Week/search shortcuts.) Only Cmd/Ctrl+4 still fires, so
      // there's always a keyboard way to toggle the terminal back off.
      const tgt = e.target;
      if (tgt instanceof HTMLElement && tgt.closest(".order-terminal")) {
        const isToggle = (e.metaKey || e.ctrlKey) && e.key === "4";
        if (!isToggle) return;
      }
      // Bare-key shortcuts only fire when no input / editor has focus,
      // so typing "?" inside a note doesn't pop the help overlay.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "?" && !isTyping(e.target)) {
          e.preventDefault();
          setHelpOpen((o) => !o);
          return;
        }
        if (e.key === "/" && !isTyping(e.target)) {
          // Bare '/' opens full-text search (vim-style). Cmd+F is
          // the same control with the platform-standard binding.
          e.preventDefault();
          setFtsOpen(true);
          return;
        }
        return;
      }
      if (e.key === "k" || e.key === "K") {
        // Cmd+K opens the centered folder palette — the single way to
        // open a folder by name. Inside an editor Cmd+K belongs to
        // Milkdown's link tooltip (selected text → link prompt), so we
        // only intercept it outside the editor.
        if (isTyping(e.target)) return;
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        // Cmd+F: open the full-text search overlay (Cmd+K is the
        // folder palette — Cmd+F searches NOTE BODIES).
        e.preventDefault();
        setFtsOpen((open) => !open);
        return;
      }
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        if (e.shiftKey) {
          // Cmd+Shift+P → Publish (moved off Cmd+P so that key can jump
          // to the Pile, mirroring P-for-Pile).
          setPublishOpen((open) => !open);
        } else {
          // Cmd+P → the Pile. If we're returning to a cleared pile (a
          // calendar view emptied the filters), restore the last
          // remembered pile — its filters, focused folder, and pile mode
          // — so you land where you left off. Otherwise it's a plain view
          // switch like Cmd+D/W/M, scrolled to the top (newest cards).
          setView("pile");
          const last = pileRef.current;
          if (last && filtersRef.current.length === 0 && last.filters.length > 0) {
            setFilters(last.filters);
            setFocusedFolder(last.focusedFolder);
            setPileMode(last.pileMode);
          }
          requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
        }
        return;
      }
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        const start = isoTime();
        const patch: Frontmatter = {
          date: isoDate(),
          startTime: start,
          endTime: addMinutesToIsoTime(start, DEFAULT_EVENT_MINUTES),
          allDay: false,
        };
        // In a calendar view, present the title prompt first (same UX
        // as drag-to-create on a slot) so the event lands with a name
        // without having to open the note. Pile goes straight to the
        // editor as before.
        if (view !== "pile") void promptCreateRef.current?.(patch);
        else void createNoteRef.current?.(patch);
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        setView("season");
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
      // Cmd+4 ($ lives on the 4 key) opens a terminal at the currently-
      // focused Notable Folder's directory.
      if (e.key === "4") {
        e.preventDefault();
        openTerminalRef.current?.();
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        setView("year");
        return;
      }
      // Cmd+Ctrl+arrow navigation: forward/back by the active view's
      // unit. Pile cycles single-folder focus through notableFolders.
      // Requires both Cmd and Ctrl so plain Cmd+← / → keep their
      // browser-style text-editing behaviour inside the Milkdown editor.
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.metaKey && e.ctrlKey) {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (view === "pile") {
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
        } else if (view === "season") {
          if (dir > 0) seasonHandleRef.current?.next(); else seasonHandleRef.current?.prev();
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
      // Cmd+R mirrors the dock's Home toggle: if currently filtered
      // to home only, clear all filters; otherwise jump to home.
      // Overrides the platform's "reload" default — Order is the
      // page, you don't reload the page from inside the page.
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        const home = homeFolderRef.current;
        const inc = includeSetRef.current;
        const homeFiltered = !!home && inc.size === 1 && inc.has(home);
        if (homeFiltered) resetToDefaultRef.current?.();
        else goHomeRef.current?.();
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
        // Spacetime is the source of truth. A vault with ANY spacetime file
        // (spacetime.md / *.spacetime.md / legacy .mw / .yml) is already on the
        // modern model — the legacy chain-file migration must NOT run there, or
        // it pollutes the vault root with Areas.md / <Area>.md / <Category>.md
        // index files that spacetime.md replaced.
        const hasSpacetime = loaded.some(
          (n) => isSpacetimeFile(n.filename) || n.filename === "spacetime.yml",
        );
        if (!hasAreas && !hasSpacetime && !migratedRef.current) {
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
        setLoadError(null);
      } catch (err) {
        console.error("Could not load cards:", err);
        if (cancelled) return;
        // Surface a recovery screen instead of freezing on "Preparing
        // cards…": the vault folder is unreadable on this machine.
        setLoadError(String(err));
        setLoadErrorPath(await vaultRoot().catch(() => ""));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- todo.txt mirror sync -------------------------------------
  // Keep todo.txt in lockstep with every .md calendar event.
  //
  // Rule: a todo.txt line and an .md event refer to the same thing
  // when their `(date, startTime, normalized title)` keys match. The
  // calendar always renders the .md side for those; the .txt line is
  // its mirror representation on disk. Lines that match no .md are
  // native todo.txt-only events.
  //
  // Delete detection uses a localStorage-persisted set of "last
  // mirror keys" — keys we wrote as mirrors on the previous sync. If
  // a line's key is in that set but no longer matches any .md, the
  // .md was deleted and the line is dropped from the body.
  //
  // The sync writes back through `writeVault`, which routes through
  // the self-write filter, so the file watcher doesn't bounce us into
  // an infinite reload.
  useEffect(() => {
    if (!notes) return;
    if (!todoSettings.enabled) return;
    const todoNote = notes.find((n) => toVaultRel(n.path) === todoSettings.path);
    if (!todoNote) return;

    // Build mirror sources, deduplicated by identity. Two .md files
    // that share the same (date, startTime, normalized title) are
    // indistinguishable from todo.txt's perspective; the mirror only
    // emits ONE line for the group. Without this, a batch of e.g.
    // transcript notes that share a first line all spawn identical
    // lines in todo.txt — exactly the runaway-duplicate bug.
    const sourcesByKey = new Map<string, MirrorSource>();
    for (const n of notes) {
      const fm = n.frontmatter;
      // Accept both a string `date:` (the form `isoDate()` writes,
      // quoted) and a Date instance (the form js-yaml hands us back
      // for an UNQUOTED `2026-06-12` per YAML 1.1's date type). Without
      // the Date branch, hand-written events drop out of the mirror
      // entirely and their todo.txt lines render as duplicate chips
      // beside the .md events.
      const date = toIsoDateValue(fm.date);
      if (!date) continue;
      // ROUND-TRIP VALIDATION: if startTime isn't a clean HH:MM, the
      // mirror serializer can't emit it in the canonical "due:DATE HH:MM"
      // form AND the parser can't read it back to the same identity,
      // which would re-classify every regenerated line as "native" and
      // cause runaway growth (one .md with startTime: '108:30' grew the
      // file by 2012 lines before we caught this). Treat malformed
      // times as all-day so the line round-trips cleanly.
      const startTimeRaw = typeof fm.startTime === "string" ? fm.startTime : undefined;
      const startTime = startTimeRaw && /^\d{2}:\d{2}$/.test(startTimeRaw) ? startTimeRaw : undefined;
      const endTimeRaw = typeof fm.endTime === "string" ? fm.endTime : undefined;
      const endTime = endTimeRaw && /^\d{2}:\d{2}$/.test(endTimeRaw) ? endTimeRaw : undefined;
      const allDay = fm.allDay === true || (!!startTimeRaw && !startTime);
      // No valid time AND not allDay → not a calendar event (dated
      // reference notes from Readwise, etc.). Skip.
      if (!allDay && !startTime) continue;
      const endDate = typeof fm.endDate === "string" ? String(fm.endDate).slice(0, 10) : undefined;
      const folder = noteFolder(fm) ?? undefined;
      const title = n.title || n.filename.replace(/\.md$/i, "");
      const src: MirrorSource = {
        title,
        date,
        ...(startTime ? { startTime } : {}),
        ...(endTime ? { endTime } : {}),
        ...(endDate ? { endDate } : {}),
        allDay,
        ...(folder ? { folder } : {}),
      };
      const k = eventKey({ date, startTime, title });
      if (!sourcesByKey.has(k)) sourcesByKey.set(k, src);
    }
    const sources: MirrorSource[] = [...sourcesByKey.values()];
    const result = syncTodoBody(todoNote.body, sources, getMirrorKeys());
    if (!result) return; // up to date

    const todoPath = todoNote.path;
    void writeVault(todoPath, result.body);
    setMirrorKeys(result.mirrorKeys);
    setNotes((prev) => prev?.map((n) =>
      n.path === todoPath ? { ...n, body: result.body } : n,
    ) ?? null);
  }, [notes, todoSettings.enabled, todoSettings.path]);

  // NOTE: The old "vault notes → spacetime.mw/.yml" mirror effect was REMOVED.
  // spacetime.mw is the single source of truth: every edit in Order writes the
  // mw directly, and Effect 2 (below) propagates the mw to backing notes and
  // mirrors it to spacetime.yml. A reverse notes→mw sync would re-introduce the
  // bidirectional loop that caused runaway event duplication. lastSpacetimeRef
  // is retained because the space-mutation handlers and migration still use it.
  const lastSpacetimeRef = useRef<string | null>(null);

  /** Reconcile all renames in the space tree between two spacetime.mw edits.
   *
   *  Handles ALL three levels (area → category → notable folder) with a
   *  single, uniform algorithm:
   *    1. Items in both old and new: no action.
   *    2. Items only in old vs only in new: matched positionally → rename.
   *    3. Any extra unmatched "new" items: left for the materialisation loop.
   *
   *  Renames are applied top-down so that after an area dir is renamed, the
   *  category and folder paths underneath already use the new area name.
   *
   *  Safety guards:
   *    • old path must exist on disk   → won't invent a rename from nothing
   *    • new path must NOT exist       → won't clobber an existing dir
   *
   *  For notable folders: renames dir + index file, syncs `title:`, rewrites
   *  `[[OldName]]` wikilinks and `folder: [[OldName]]` frontmatter across vault.
   *  For area / category: renames dir + updates `area:` / `category:` frontmatter. */
  const reconcileSpaceChanges = useCallback(async (
    oldSpace: SpaceNode[],
    newSpace: SpaceNode[],
  ): Promise<void> => {
    const san = (n: string) => n.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();

    type Named = { name: string; safe: string; key: string };
    type RenamePair = { old: Named; new: Named };

    // Identity is the NORMALIZED match key (folderMatchKey): em-dash vs
    // hyphen vs NBSP, and the 78-char directory truncation, all collapse to
    // one identity — so re-serializing the mw with a different dash (or a
    // long name vs its truncated dir) is NEVER seen as a rename.
    //
    // A rename is inferred ONLY when it is unambiguous: exactly one folder
    // disappeared and exactly one appeared. Positionally zipping multiple
    // removed/added entries pairs UNRELATED folders and renames one dir
    // (and its content) onto another's name — that is what scrambled
    // article folders. When it's ambiguous we rename nothing; the removed
    // entries fall through as orphans (non-destructive — files stay put).
    function computeRenames(
      oldItems: Named[],
      newItems: Named[],
    ): { pairs: RenamePair[]; orphaned: Named[] } {
      const newKeys = new Set(newItems.map((i) => i.key));
      const oldKeys = new Set(oldItems.map((i) => i.key));
      const removed = oldItems.filter((i) => !newKeys.has(i.key));
      const added   = newItems.filter((i) => !oldKeys.has(i.key));
      const pairs: RenamePair[] =
        removed.length === 1 && added.length === 1
          ? [{ old: removed[0], new: added[0] }]
          : [];
      const orphaned = removed.filter((r) => !pairs.some((p) => p.old === r));
      return { pairs, orphaned };
    }

    const list = notesRef.current ?? [];
    const folderRefRe = /^\[\[([^\]]+)\]\]$/;

    // ---- Area renames ----
    const { pairs: areaRenames } = computeRenames(
      oldSpace.map((a) => ({ name: a.name, safe: san(a.name), key: folderMatchKey(a.name) })),
      newSpace.map((a) => ({ name: a.name, safe: san(a.name), key: folderMatchKey(a.name) })),
    );
    for (const { old: oldA, new: newA } of areaRenames) {
      if (!(await vaultFs.exists(oldA.safe)) || (await vaultFs.exists(newA.safe))) continue;
      await vaultFs.rename(oldA.safe, newA.safe);
      for (const n of list) {
        const raw = await readVault(toVaultRel(n.path)).catch(() => "");
        if (!raw) continue;
        const { frontmatter, body } = splitFrontmatter(raw);
        if (frontmatter.area === oldA.name) {
          await writeVault(toVaultRel(n.path),
            joinFrontmatter({ ...frontmatter, area: newA.name }, body));
        }
      }
    }

    // ---- Category and folder renames ----
    for (const newArea of newSpace) {
      const newAreaSafe = san(newArea.name);
      const newAreaKey = folderMatchKey(newArea.name);
      const areaRename = areaRenames.find((r) => r.new.key === newAreaKey);
      const oldAreaKey = areaRename ? areaRename.old.key : newAreaKey;
      const oldArea = oldSpace.find((a) => folderMatchKey(a.name) === oldAreaKey);
      if (!oldArea) continue;

      const { pairs: catRenames } = computeRenames(
        oldArea.children.map((c) => ({ name: c.name, safe: san(c.name), key: folderMatchKey(c.name) })),
        newArea.children.map((c) => ({ name: c.name, safe: san(c.name), key: folderMatchKey(c.name) })),
      );
      for (const { old: oldC, new: newC } of catRenames) {
        const oldCatPath = `${newAreaSafe}/${oldC.safe}`;
        const newCatPath = `${newAreaSafe}/${newC.safe}`;
        if (!(await vaultFs.exists(oldCatPath)) || (await vaultFs.exists(newCatPath))) continue;
        await vaultFs.rename(oldCatPath, newCatPath);
        for (const n of list) {
          const raw = await readVault(toVaultRel(n.path)).catch(() => "");
          if (!raw) continue;
          const { frontmatter, body } = splitFrontmatter(raw);
          if (frontmatter.area === newArea.name && frontmatter.category === oldC.name) {
            await writeVault(toVaultRel(n.path),
              joinFrontmatter({ ...frontmatter, category: newC.name }, body));
          }
        }
      }

      for (const newCat of newArea.children) {
        const newCatSafe = san(newCat.name);
        const newCatKey = folderMatchKey(newCat.name);
        const catRename = catRenames.find((r) => r.new.key === newCatKey);
        const oldCatKey = catRename ? catRename.old.key : newCatKey;
        const oldCat = oldArea.children.find((c) => folderMatchKey(c.name) === oldCatKey);
        if (!oldCat) continue;

        // Renames only — applying an mw edit is NON-DESTRUCTIVE. A folder
        // dropped from the mw is NOT deleted here; it simply becomes an orphan
        // (on disk, not in spacetime.mw) that the user resolves explicitly in
        // the review's "On disk but not in spacetime.mw" section.
        const { pairs: folderRenames } = computeRenames(
          oldCat.children.map((f) => ({ name: f.name, safe: san(f.name), key: folderMatchKey(f.name) })),
          newCat.children.map((f) => ({ name: f.name, safe: san(f.name), key: folderMatchKey(f.name) })),
        );

        for (const { old: oldF, new: newF } of folderRenames) {
          const oldFolderPath = `${newAreaSafe}/${newCatSafe}/${oldF.safe}`;
          const newFolderPath = `${newAreaSafe}/${newCatSafe}/${newF.safe}`;
          if (!(await vaultFs.exists(oldFolderPath)) || (await vaultFs.exists(newFolderPath))) continue;

          // 1. Rename the directory.
          await vaultFs.rename(oldFolderPath, newFolderPath);

          // 2. Rename the index file (old name, now inside the renamed dir).
          const oldIndexPath = `${newFolderPath}/${oldF.safe}.md`;
          const newIndexPath = `${newFolderPath}/${newF.safe}.md`;
          try { await vaultFs.rename(oldIndexPath, newIndexPath); } catch { /* no index */ }

          // 3. Sync title if it still mirrors the old name.
          try {
            const raw = await readVault(newIndexPath);
            const { frontmatter, body } = splitFrontmatter(raw);
            const t = frontmatter.title;
            if (!t || t === oldF.name || t === oldF.safe) {
              await writeVault(newIndexPath,
                joinFrontmatter({ ...frontmatter, title: newF.name }, body));
            }
          } catch { /* no index */ }

          // 4. Rewrite inbound [[OldName]] wikilinks and folder: [[OldName]] across vault.
          const target = oldF.name.toLowerCase();
          for (const n of list) {
            try {
              const nPath = toVaultRel(n.path);
              const raw = await readVault(nPath).catch(() => "");
              if (!raw) continue;
              const { frontmatter, body } = splitFrontmatter(raw);
              let nextBody = body;
              let nextFm: Frontmatter = frontmatter;
              let dirty = false;
              if (body.toLowerCase().includes(target)) {
                const rb = rewriteWikilinksForRename(body, oldF.name, newF.safe);
                if (rb !== body) { nextBody = rb; dirty = true; }
              }
              const fv = frontmatter.folder;
              if (typeof fv === "string") {
                const m = fv.trim().match(folderRefRe);
                if (m && m[1].trim().toLowerCase() === target) {
                  nextFm = { ...frontmatter, folder: `[[${newF.safe}]]` };
                  dirty = true;
                }
              }
              if (dirty) await writeVault(nPath, joinFrontmatter(nextFm, nextBody));
            } catch { /* skip */ }
          }
        }
      }
    }

    // No folder deletion here: applying an mw edit never removes files. Folders
    // dropped from the mw stay on disk as orphans for explicit reconciliation.
  }, [notesRef]);

  // ---- spacetime.mw → spacetime.yml sync -------------------------
  // When spacetime.mw changes (user hand-edit in the raw-text card or
  // external editor), parse it and apply fully:
  //   • space + seasons → written to spacetime.yml immediately
  //   • events → full two-way sync against backing notes:
  //       - in .mw and in vault  → patch frontmatter in place (time, folder…)
  //       - in .mw but not vault → create backing note
  //       - in vault but not .mw → strip calendar frontmatter (non-destructive:
  //                                  file stays, just falls off the calendar)
  //
  // The mirror always writes ALL events to .mw, so "not in .mw" reliably
  // means the user deliberately removed it.
  //
  // Re-fire guard: stamp lastMarkwhenRef at the TOP of the handler (before
  // any await) so that the reloadNotes() at the end doesn't cause the
  // same user-edited body to re-trigger the handler.
  const lastMarkwhenRef = useRef<string | null>(null);
  // Track only the Space section of mw so we can skip materialisation when
  // only events changed (e.g. Effect 1 spliced in updated events).
  const lastMwSpaceRef = useRef<string | null>(null);

  // ---- spacetime.mw hand-edit review (gated structural sync) ----------
  // (mwBaselineRef / persistMwBaseline are declared earlier, before
  // writeSpacetimeModel, since that callback advances the baseline.)
  const mwInitRef = useRef(false);
  // The staged review (null = no pending changes). `mwBody` is the edited mw
  // the review describes; applying it advances the baseline to it. The dialog
  // is NEVER auto-opened — a detected change only lights the bottom-left
  // indicator, which the user clicks to open the review when ready (so editing
  // spacetime.mw is never interrupted by a popup).
  const [mwReview, setMwReview] = useState<{ items: MwChangeItem[]; mwBody: string; destructive: boolean } | null>(null);
  const [mwReviewOpen, setMwReviewOpen] = useState(false);
  const [mwApplying, setMwApplying] = useState(false);
  // Per-orphan Area/Category overrides keyed by note path; defaults come from
  // the folder's on-disk path. Lets the user re-file an orphan when reconciling.
  const [orphanEdits, setOrphanEdits] = useState<Record<string, { area: string; category: string }>>({});

  // Count note files under a space path. The Area/Category segments use raw
  // names, but the leaf folder directory is sanitized + truncated to 78 chars,
  // so the leaf must go through folderDirName or the prefix won't match (and
  // the rename guard / file count would read 0).
  const countFilesUnder = useCallback((oldPath: string[]): number => {
    if (oldPath.length === 0) return 0;
    const segs = oldPath.map((s, i) => (i === oldPath.length - 1 ? folderDirName(s) : s));
    const prefix = segs.join("/") + "/";
    let n = 0;
    for (const note of notesRef.current ?? [])
      if (toVaultRel(note.path).startsWith(prefix)) n++;
    return n;
  }, []);

  // Apply an accepted mw hand-edit: restructure the vault to match `mwBody`.
  // This is the OLD Effect-2 body, now gated behind the review dialog —
  // reconcile renames, mirror yml, materialize new folder dirs, then advance
  // the baseline so the change is no longer "pending".
  const applyMwSync = useCallback(async (mwBody: string): Promise<void> => {
    setMwApplying(true);
    try {
      const baseline = mwBaselineRef.current ?? "";
      const oldSpace = baseline ? parseMarkwhenFormat(baseline).space : [];
      const newSt = parseMarkwhenFormat(mwBody);
      if (newSt.space.length > 0 && oldSpace.length > 0)
        await reconcileSpaceChanges(oldSpace, newSt.space);
      const yml = serializeSpacetime(newSt);
      lastSpacetimeRef.current = yml;
      await writeVault("spacetime.yml", yml);
      // Notable Folders whose main doc already exists ON DISK, by normalized
      // key (truncation- AND dash-aware so a >78-char or em-dash variant still
      // matches). A Notable Folder main doc lives at the depth-4 path
      // <Area>/<Category>/<Folder>/<Folder>.md (filename === its dir). This must
      // come from the loaded notes, NOT folderDirIndex: folderDirIndex mirrors
      // the live spacetime taxonomy, which already lists the just-added folder,
      // so using it would skip exactly the folders whose main doc still needs
      // creating (the "added via spacetime edit → no main document" bug).
      const onDiskFolders = new Set<string>();
      for (const n of notesRef.current ?? []) {
        const parts = toVaultRel(n.path).split("/");
        if (parts.length === 4 && parts[3].replace(/\.md$/i, "") === parts[2])
          onDiskFolders.add(folderMatchKey(parts[2]));
      }
      for (const area of newSt.space)
        for (const cat of area.children)
          for (const nf of cat.children) {
            // Skip only when the folder's main doc already exists on disk —
            // otherwise materialize it below so a folder added via a spacetime
            // edit gets its <NF>/<NF>.md cover.
            if (onDiskFolders.has(folderMatchKey(nf.name))) continue;
            const safe = nf.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();
            const relPath = `${area.name}/${cat.name}/${safe}/${safe}.md`;
            try { await readVault(relPath); continue; } catch { /* doesn't exist → create */ }
            await writeVault(relPath, joinFrontmatter({ category: cat.name, area: area.name }, `# ${nf.name}\n`));
          }
      persistMwBaseline(mwBody);
      await reloadNotes();
    } finally {
      setMwApplying(false);
      setMwReview(null);
      setMwReviewOpen(false);
    }
  }, [reconcileSpaceChanges, reloadNotes, persistMwBaseline]);

  const declineMwSync = useCallback(() => {
    // Just close the dialog. The file edits and the pending indicator stay
    // (mwReview is non-null) until the user applies or reverts in the editor.
    setMwReviewOpen(false);
  }, []);

  // Reconcile an orphaned folder into spacetime.mw under the chosen Area /
  // Category (defaulted from its path, editable in the dialog). Placement lives
  // in the directory tree + spacetime.mw, never frontmatter. Since the folder's
  // directory already exists on disk, we add it to BOTH the live mw AND the
  // baseline (the baseline reflects the disk), so it stops being an orphan
  // without generating a spurious "add" and without absorbing other un-applied
  // mw edits. Idempotent: a folder already present (by normalized key) is never
  // duplicated.
  const reconcileOrphan = useCallback(async (path: string, areaIn: string, categoryIn: string) => {
    const area = areaIn.trim();
    const category = categoryIn.trim();
    const note = notesRef.current?.find((n) => n.path === path);
    if (!note) return;
    const name = note.filename.replace(/\.md$/i, "");
    if (!area || !category) { flashCap(`Pick an area and category for ${name}.`); return; }
    const key = folderMatchKey(name);
    const hasFolder = (space: SpaceNode[]) =>
      space.some((a) => a.children.some((c) => c.children.some((f) => folderMatchKey(f.name) === key)));
    const addAll = (space: SpaceNode[]) =>
      applySpaceMutation(
        applySpaceMutation(
          applySpaceMutation(space, { kind: "addArea", name: area }),
          { kind: "addCategory", area, name: category }),
        { kind: "addFolder", area, category, name });

    const mwAbs = notesRef.current?.find((n) => toVaultRel(n.path) === spacetimeRootPathRef.current)?.path;
    const mw = await readVault(spacetimeRootPathRef.current).catch(() => "");
    const cur = parseMarkwhenFormat(mw);
    const next = hasFolder(cur.space) ? mw : serializeMarkwhen({ ...cur, space: addAll(cur.space) });
    // Mirror the same add into the baseline (the directory exists, so the disk
    // already reflects this folder) — keeps it from showing as a pending add.
    if (mwBaselineRef.current) {
      const base = parseMarkwhenFormat(mwBaselineRef.current);
      if (!hasFolder(base.space)) persistMwBaseline(serializeMarkwhen({ ...base, space: addAll(base.space) }));
    }

    // Move the directory only if the chosen placement differs from where it is.
    const curDir = vaultDir(toVaultRel(path));
    const targetDir = `${area}/${category}/${name}`;
    let moved = false;
    if (curDir && curDir !== targetDir) {
      try {
        if (await vaultFs.exists(targetDir)) flashCap(`${name}: ${targetDir} already exists — left in place.`);
        else { await vaultFs.rename(curDir, targetDir); moved = true; }
      } catch (e) { console.error("orphan move failed", e); }
    }

    if (next !== mw) await writeVault(spacetimeRootPathRef.current, next);
    if (moved) {
      await reloadNotes();
    } else {
      // Update in place and refresh the open editor card so it shows the add
      // (and doesn't clobber it on its next autosave). Don't stamp
      // lastMarkwhenRef — let the detector recompute the (now smaller) review.
      setNotes((prev) => prev?.map((n) =>
        toVaultRel(n.path) === spacetimeRootPathRef.current ? { ...n, body: next } : n) ?? null);
      if (mwAbs) { delete focusedKeyVersionRef.current[mwAbs]; bumpExternal([mwAbs]); }
    }
  }, [reloadNotes, flashCap, persistMwBaseline, bumpExternal]);

  // Reconcile an orphaned folder the destructive way: delete its directory and
  // every file in it. Confirmed first — this can't be undone.
  const removeOrphanFolder = useCallback(async (path: string, name: string) => {
    const ok = await tauriConfirm(
      `Delete the “${name}” folder and all of its files from disk? It isn't in spacetime. This can't be undone.`,
      { title: "Remove folder from disk?", kind: "warning" },
    );
    if (!ok) return;
    const dir = vaultDir(toVaultRel(path));
    if (!dir) return;
    try { await vaultFs.remove(dir); }
    catch (e) { console.error("remove orphan folder failed", e); flashCap("Couldn't remove the folder."); return; }
    await reloadNotes();
  }, [reloadNotes, flashCap]);

  // Delete orphan event NOTES from disk (calendar-event notes not in
  // spacetime.mw). Bulk-capable so a flood of stray stubs can be cleared in one
  // confirm. Can't be undone.
  const removeOrphanEvents = useCallback(async (paths: string[], label: string) => {
    if (paths.length === 0) return;
    const ok = await tauriConfirm(
      paths.length === 1
        ? `Delete the note “${label}” from disk? It's a calendar event that isn't in spacetime. This can't be undone.`
        : `Delete ${paths.length} event notes that aren't in spacetime from disk? This can't be undone.`,
      { title: "Remove event notes?", kind: "warning" },
    );
    if (!ok) return;
    for (const p of paths) {
      try { await vaultFs.remove(toVaultRel(p)); }
      catch (e) { console.error("remove orphan event failed", p, e); }
    }
    await reloadNotes();
  }, [reloadNotes]);


  // ---- spacetime.mw is THE source of truth for calendar events --------
  // The event list and its index are derived SYNCHRONOUSLY from the parsed
  // mw during render. spacetime.mw's body is loaded up front
  // (needsBodyUpfront matches `.mw`), so this is available on the first
  // paint — no effect timing, no async gap, no dependency on note YAML.
  // Note frontmatter is irrelevant to what appears on the calendar.
  const mwEvents = useMemo<SpacetimeEvent[]>(() => {
    // Match the ROOT spacetime.mw specifically — sub-folder .mw files (e.g.
    // Craft/spacetime.mw) share the same filename but hold only a subset of
    // events. Selecting by vault-relative path avoids grabbing the wrong one.
    const mwNote = notes?.find((n) => toVaultRel(n.path) === spacetimeRootPathRef.current);
    if (!mwNote?.body) return [];
    return parseMarkwhenFormat(mwNote.body).events;
  }, [notes]);
  const mwEventIndex = useMemo<Map<string, SpacetimeEvent>>(() => {
    const idx = new Map<string, SpacetimeEvent>();
    for (const ev of mwEvents) idx.set(`${ev.date}|${ev.title.toLowerCase()}`, ev);
    return idx;
  }, [mwEvents]);
  // Mirror the latest index into a ref so event-handler callbacks
  // (handleEventClick, openEventNote) can read it without re-binding.
  const mwEventIndexRef = useRef<Map<string, SpacetimeEvent>>(mwEventIndex);
  mwEventIndexRef.current = mwEventIndex;
  // Drift: notes that ARE calendar events (date + time/all-day) but whose event
  // isn't in spacetime.mw. effectiveFolder hides them from every view; here we
  // collect them so the reconciliation indicator can flag them for the user to
  // add to spacetime.mw or delete.
  const orphanedEvents = useMemo<{ title: string; path: string; date: string }[]>(() => {
    if (!notes) return [];
    return notes
      .filter((n) => isOrphanEventNote(n, mwEventIndex, noteEventLinkRef.current, focusedPath))
      .map((n) => ({
        title: n.title || n.filename.replace(/\.md$/i, ""),
        path: n.path,
        date: toIsoDateValue(n.frontmatter.date) ?? "",
      }));
  }, [notes, mwEventIndex, focusedPath]);
  // Events whose backing note was EDITED so it no longer matches the spacetime
  // line (almost always a retitle on auto-save). The note still carries a live
  // link to a real mw event (noteEventLinkRef), so it is NOT orphaned — instead
  // it's surfaced for the user to push the change into spacetime.mw (the source
  // of truth) or leave alone. This is the "modified, not orphaned" path.
  const modifiedEvents = useMemo<{ noteId: string; path: string; date: string; oldTitle: string; newTitle: string }[]>(() => {
    if (!notes) return [];
    const out: { noteId: string; path: string; date: string; oldTitle: string; newTitle: string }[] = [];
    for (const n of notes) {
      const link = noteEventLinkRef.current.get(n.id);
      if (!link) continue;
      // The linked event must still exist in the mw (else it's a true orphan).
      if (!mwEventIndex.has(`${link.date}|${link.title.toLowerCase()}`)) continue;
      const cur = (n.title || n.filename.replace(/\.md$/i, "")).trim();
      if (cur && cur.toLowerCase() !== link.title.toLowerCase()) {
        out.push({ noteId: n.id, path: n.path, date: link.date, oldTitle: link.title, newTitle: cur });
      }
    }
    return out;
  }, [notes, mwEventIndex]);
  // NOTE: Undated, non-main files inside a Notable Folder are NOT flagged for
  // reconciliation. Reconciliation only surfaces files that LOOK like they
  // belong in spacetime but aren't — i.e. dated event notes missing from the mw
  // (orphanedEvents above). A plain note without a YYYY-MM-DD prefix is just
  // content living in the folder; it's left alone on disk (surfaced via the
  // file browser, and pinnable to a folder's pile via File Piles).
  // ---- Google Calendar push, surfaced through reconciliation -----------
  // Connected accounts (host/invitee resolution). Loaded on mount and when
  // Settings signals a change. Empty when no account / desktop-only.
  const [gcalAccounts, setGcalAccounts] = useState<{ accounts: string[]; default: string | null }>({ accounts: [], default: null });
  const refreshGcalAccounts = useCallback(async () => {
    try {
      const v = await import("../lib/gcal-accounts").then((m) => m.listAccounts());
      setGcalAccounts({ accounts: v.accounts, default: v.default });
    } catch { /* not connected */ }
  }, []);
  useEffect(() => { void refreshGcalAccounts(); }, [refreshGcalAccounts]);
  useEffect(() => {
    const h = () => { void refreshGcalAccounts(); };
    window.addEventListener("order:gcal-accounts-changed", h);
    return () => window.removeEventListener("order:gcal-accounts-changed", h);
  }, [refreshGcalAccounts]);

  const [gcalSynced, setGcalSynced] = useState<SyncRecord>(loadSyncRecord);
  const gcalSyncedRef = useRef(gcalSynced);
  gcalSyncedRef.current = gcalSynced;
  const gcalSavedOnce = useRef(false);
  useEffect(() => {
    if (!gcalSavedOnce.current) { gcalSavedOnce.current = true; return; } // skip the load-echo
    saveSyncRecord(gcalSynced);
  }, [gcalSynced]);
  const [gcalSyncing, setGcalSyncing] = useState(false);
  const gcalPlan = useMemo(() => {
    if (gcalAccounts.accounts.length === 0) return { pushes: [], deletes: [] };
    const intents = buildPushIntents(mwEvents, gcalAccounts.accounts, gcalAccounts.default).map((it) => {
      // Fold in the backing note's mtime so editing its body (the event
      // description) changes the signature and re-flags the event for sync.
      // Matched the same way the push resolves the description (title + date).
      const note = notes?.find((n) =>
        n.title.toLowerCase() === it.title.toLowerCase()
        && toIsoDateValue(n.frontmatter.date) === it.date);
      return note ? { ...it, noteMtime: note.mtime } : it;
    });
    return gcalSyncPlan(gcalSynced, intents, gcalSig);
  }, [mwEvents, notes, gcalAccounts, gcalSynced]);
  const gcalPendingCount = gcalPlan.pushes.length + gcalPlan.deletes.length;
  const gcalPlanRef = useRef(gcalPlan);
  gcalPlanRef.current = gcalPlan;

  // Import review modal: the day being imported, the rows (checked = accept),
  // the chosen account, and the target folder.
  const [importReview, setImportReview] = useState<{ date: string; account: string; rows: (import("../lib/gcal-import").ImportRow & { accept: boolean })[]; folder: string } | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  const mwEventsRefForImport = useRef<SpacetimeEvent[]>([]);
  mwEventsRefForImport.current = mwEvents;

  const startImport = useCallback(async (dateIso: string) => {
    try {
      const m = await import("../lib/gcal-accounts");
      const acc = await m.listAccounts();
      if (acc.accounts.length === 0) { await tauriMessage("Connect a Google account in Settings first.", { title: "Import" }); return; }
      const account = acc.default ?? acc.accounts[0];
      const fetched = await m.listDayEvents(account, dateIso);
      if (fetched.length === 0) { await tauriMessage(`No Google events on ${dateIso}.`, { title: "Import" }); return; }
      const { classifyImports } = await import("../lib/gcal-import");
      const dayEvents = mwEventsRefForImport.current.filter((e) => e.date === dateIso);
      const rows = classifyImports(fetched, dayEvents).map((r) => ({ ...r, accept: r.isNew }));
      setImportReview({ date: dateIso, account, rows, folder: homeFolderRef.current ?? "" });
    } catch (e) { await tauriMessage(`Import failed: ${String(e)}`, { title: "Import", kind: "error" }); }
  }, []);

  const applyImport = useCallback(async () => {
    const review = importReview;
    if (!review) return;
    setImportBusy(true);
    try {
      const accepted = review.rows.filter((r) => r.accept);
      if (accepted.length === 0) { setImportReview(null); return; }
      const root = await vaultRoot();
      const dir = (review.folder && noteDirByRef(review.folder)) || root;
      // Create a backing note (description body) for each accepted event, then
      // add all events to spacetime.mw in one edit (tagged with the source
      // account email so they're recognized as that calendar's events).
      const noteErrors: string[] = [];
      for (const r of accepted) {
        try {
          const fm: Frontmatter = {
            date: r.date,
            allDay: r.allDay,
            ...(r.time ? { startTime: r.time } : {}),
            ...(r.endTime ? { endTime: r.endTime } : {}),
            ...(r.endDate ? { endDate: r.endDate } : {}),
            ...(review.folder ? { folder: `[[${review.folder}]]` } : {}),
            title: r.title,
          };
          const body = `# ${r.title}\n${r.description ? `\n${r.description}\n` : ""}`;
          await uniqueWrite(dir, basenameForEvent(r.date, r.title), joinFrontmatter(fm, body));
        } catch (e) {
          noteErrors.push(`${r.title}: ${String(e)}`);
        }
      }
      await applyMwEdit((mw) => accepted.reduce((acc, r) => mwAddEvent(acc, {
        date: r.date,
        title: r.title,
        ...(r.time ? { time: r.time } : {}),
        ...(r.endTime ? { endTime: r.endTime } : {}),
        ...(r.endDate ? { endDate: r.endDate } : {}),
        ...(r.allDay ? { allDay: true } : {}),
        ...(review.folder ? { folder: review.folder } : {}),
        // Host account + the event's guests (deduped, lowercased) so invitees
        // land on the spacetime line and round-trip on a later push.
        emails: [...new Set([review.account.toLowerCase(), ...r.attendees.map((a) => a.toLowerCase())])],
      }), mw));
      setImportReview(null);
      const baseMsg = `Imported ${accepted.length} event(s) into ${review.folder || "home"}.`;
      const fullMsg = noteErrors.length > 0 ? `${baseMsg}\n${noteErrors.length} note(s) failed:\n${noteErrors.join("\n")}` : baseMsg;
      await tauriMessage(fullMsg, { title: "Import", ...(noteErrors.length > 0 ? { kind: "warning" } : {}) });
    } catch (e) { await tauriMessage(`Import apply failed: ${String(e)}`, { title: "Import", kind: "error" }); }
    finally { setImportBusy(false); }
  }, [importReview]);

  // Push all pending events to Google AND delete removed events; update the
  // persisted sync record (add pushed keys, remove deleted keys).
  const applyGcalSync = useCallback(async () => {
    const { pushes, deletes } = gcalPlanRef.current;
    if (pushes.length === 0 && deletes.length === 0) return;
    setGcalSyncing(true);
    try {
      const { pushEvent, deleteEvent } = await import("../lib/gcal-accounts");
      let created = 0, updated = 0, removed = 0; const errors: string[] = [];
      const recAdds: SyncRecord = {}; const recDels: string[] = [];
      for (const it of pushes) {
        const note = notesRef.current?.find((n) =>
          n.title.toLowerCase() === it.title.toLowerCase()
          && toIsoDateValue(n.frontmatter.date) === it.date,
        );
        let description = "";
        if (note) {
          try { description = (await readVault(toVaultRel(note.path))).replace(/^---[\s\S]*?---\n?/, "").trim(); }
          catch { /* leave empty */ }
        }
        // A description-only edit (the event already synced, schedule +
        // attendees unchanged) pushes SILENTLY so guests aren't emailed; any
        // schedule/attendee change — or a brand-new event — still notifies.
        const prev = gcalSyncedRef.current[naturalKey(it.date, it.time, it.title)];
        const descOnly = !!prev && prev.schedSig === gcalSchedSig(it);
        try {
          const r = await pushEvent({ ...it, description, notify: !descOnly });
          if (r === "created") created++; else updated++;
          recAdds[naturalKey(it.date, it.time, it.title)] = { host: it.host, date: it.date, time: it.time, title: it.title, sig: gcalSig(it), schedSig: gcalSchedSig(it) };
        } catch (e) { errors.push(`${it.title}: ${String(e)}`); }
      }
      // A failed delete leaves its key in the record, so it re-appears as a
      // pending delete next sync (a reschedule's new-key push may already have
      // succeeded — that's fine, the stale delete just needs another sync).
      for (const d of deletes) {
        try {
          await deleteEvent(d.host, d.date, d.time, d.title);
          removed++;
          recDels.push(naturalKey(d.date, d.time, d.title));
        } catch (e) { errors.push(`delete ${d.title}: ${String(e)}`); }
      }
      setGcalSynced((prev) => {
        const next = { ...prev, ...recAdds };
        for (const k of recDels) delete next[k];
        return next;
      });
      const summary = `Synced to Google — ${created} created, ${updated} updated, ${removed} deleted`;
      if (errors.length) {
        await tauriMessage(`${summary}\n${errors.length} failed:\n${errors.join("\n")}`, { title: "Sync to Google", kind: "warning" });
      } else {
        flashCap(summary, "ok");
      }
    } finally { setGcalSyncing(false); }
  }, [flashCap]);

  // Auto-reset the review's OPEN flag once everything it could show is resolved.
  // The dialog only renders when `mwReviewOpen && (review || orphan folders ||
  // orphan events || gcal pending)`, so when the content empties the dialog
  // vanishes but the flag stays true — and the next item would silently RE-open
  // it. Resetting here keeps reopening an explicit pill click: new drift only
  // lights the bottom-left indicator, never pops a modal.
  useEffect(() => {
    if (mwReviewOpen && !mwReview && orphanedFolders.length === 0 && orphanedEvents.length === 0 && modifiedEvents.length === 0 && gcalPendingCount === 0) {
      setMwReviewOpen(false);
    }
  }, [mwReviewOpen, mwReview, orphanedFolders.length, orphanedEvents.length, modifiedEvents.length, gcalPendingCount]);
  // Maps each rendered calendar chip's `path` → the mw event it represents,
  // so move/edit/delete handlers can locate the authoritative mw line. Also
  // records the backing note path (if any) so the same edit can keep that
  // note's filename + frontmatter in sync. Populated during render below.
  const eventChipRef = useRef<Map<string, { ev: SpacetimeEvent; notePath: string | null }>>(new Map());

  // File Piles (session-only display state; never persisted). Keyed by folder
  // ref (canonical Notable Folder name). pileFront = paths moved/added to the
  // top in order; pileHidden = cards closed this session. Reset on restart.
  const [pileFront, setPileFront] = useState<Map<string, string[]>>(new Map());
  const [pileHidden, setPileHidden] = useState<Map<string, Set<string>>>(new Map());

  const addToPile = useCallback((folder: string, path: string) => {
    setPileFront((prev) => {
      const next = new Map(prev);
      const cur = next.get(folder) ?? [];
      next.set(folder, [path, ...cur.filter((p) => p !== path)]);
      return next;
    });
    setPileHidden((prev) => {
      const cur = prev.get(folder);
      if (!cur || !cur.has(path)) return prev;
      const next = new Map(prev);
      const s = new Set(cur);
      s.delete(path);
      next.set(folder, s);
      return next;
    });
  }, []);

  const closeFromPile = useCallback((folder: string, path: string) => {
    setPileHidden((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(folder) ?? []);
      s.add(path);
      next.set(folder, s);
      return next;
    });
    setPileFront((prev) => {
      const cur = prev.get(folder);
      if (!cur || !cur.includes(path)) return prev;
      const next = new Map(prev);
      next.set(folder, cur.filter((p) => p !== path));
      return next;
    });
  }, []);

  // Resolve a file-browser row (folderRel + filename) to its loaded note path,
  // then surface it at the top of folderRef's pile.
  const addToPileByName = useCallback((folderRef: string, folderRel: string, filename: string) => {
    const rel = folderRel ? `${folderRel}/${filename}` : filename;
    const note = notesRef.current?.find((n) => toVaultRel(n.path) === rel);
    if (note) addToPile(folderRef, note.path);
  }, [addToPile]);

  const renameVaultFile = useCallback(async (folderRel: string, oldName: string, newName: string) => {
    const from = folderRel ? `${folderRel}/${oldName}` : oldName;
    const to = folderRel ? `${folderRel}/${newName}` : newName;
    if (from === to) return;
    await vaultFs.rename(from, to);
    await reloadNotes();
  }, [reloadNotes]);

  const deleteVaultFile = useCallback(async (folderRel: string, name: string) => {
    const ok = await tauriConfirm(`Delete "${name}"? This can't be undone.`, { title: "Delete file?", kind: "warning" });
    if (!ok) return;
    const rel = folderRel ? `${folderRel}/${name}` : name;
    await vaultFs.remove(rel);
    await reloadNotes();
  }, [reloadNotes]);

  /** Apply a transform to the root spacetime.mw and persist it. Optimistically
   *  updates the in-memory mw note body so the calendar (which reads mwEvents)
   *  reflects the change on the next render; Effect 2 then mirrors to yml and
   *  reconciles any space changes. spacetime.mw is the single source of truth. */
  const applyMwEdit = useCallback(async (transform: (mw: string) => string) => {
    const mw = await readVault(spacetimeRootPathRef.current).catch(() => "");
    if (!mw) return;
    const next = transform(mw);
    if (next === mw) return;
    await writeVault(spacetimeRootPathRef.current, next);
    setNotes((prev) => prev?.map((n) =>
      toVaultRel(n.path) === spacetimeRootPathRef.current ? { ...n, body: next } : n) ?? null);
  }, []);

  // spacetime.mw hand-edit DETECTION (gated sync). Structural mw changes are
  // no longer applied automatically: when the live mw diverges from the
  // applied baseline we STAGE a review (the dialog below) — Accept restructures
  // the vault, Decline keeps the file edits and leaves a pending indicator.
  // Event-only edits have no disk consequence, so they're mirrored to yml
  // silently. Programmatic writes (sidebar/calendar) stamp lastMarkwhenRef AND
  // advance the baseline, so they never reach this path.
  useEffect(() => {
    if (!notes) return;
    const mwNote = notes.find((n) => toVaultRel(n.path) === spacetimeRootPathRef.current);
    if (!mwNote?.body) return;
    if (mwNote.body === lastMarkwhenRef.current) return;
    const spaceSection = mwNote.body.split("# Time")[0];
    if (lastMarkwhenRef.current === null) {
      // Cold boot: stamp the change-detector only. The init effect below
      // establishes the sync baseline and flags any boot-time drift.
      lastMarkwhenRef.current = mwNote.body;
      lastMwSpaceRef.current = spaceSection;
      return;
    }
    // A real in-memory mw change (hand-edit in the card, or external editor
    // picked up by the watcher). Stamp the detector before any async work.
    lastMarkwhenRef.current = mwNote.body;
    lastMwSpaceRef.current = spaceSection;
    const mwBody = mwNote.body;
    const baseline = mwBaselineRef.current ?? mwBody;
    const items = summarizeMwChanges(
      parseMarkwhenFormat(baseline),
      parseMarkwhenFormat(mwBody),
      countFilesUnder,
    );
    if (items.length === 0) {
      // No structural / seasons change (e.g. only events were edited). Nothing
      // to restructure on disk — mirror the yml and advance the baseline so the
      // edit isn't treated as pending, and clear any stale review/mute.
      void (async () => {
        const yml = serializeSpacetime(parseMarkwhenFormat(mwBody));
        lastSpacetimeRef.current = yml;
        await writeVault("spacetime.yml", yml);
        persistMwBaseline(mwBody);
      })();
      setMwReview(null);
      return;
    }
    // Structural / seasons changes → stage a review (indicator only; the dialog
    // is opened by the user, never auto-popped, so it can't interrupt editing).
    setMwReview({ items, mwBody, destructive: items.some((i) => i.destructive) });
  }, [notes, countFilesUnder, persistMwBaseline]);

  // First-load baseline + boot-time drift flag. Establishes the sync baseline
  // from localStorage (per vault root); if the persisted baseline differs from
  // the mw on disk (a previously-declined-but-kept edit), surface it as a
  // pending review — indicator only, no auto-popped dialog on launch.
  useEffect(() => {
    if (mwInitRef.current || !notes) return;
    const mwNote = notes.find((n) => toVaultRel(n.path) === spacetimeRootPathRef.current);
    if (!mwNote?.body) return;
    mwInitRef.current = true;
    const mwBody = mwNote.body;
    void (async () => {
      const root = await vaultRoot().catch(() => "");
      mwVaultRootRef.current = root;
      const stored = root ? readMwBaseline(root) : null;
      mwBaselineRef.current = stored ?? mwBody;
      if (stored === null && root) writeMwBaseline(root, mwBody); // first run: disk reflects mw
      if (stored !== null && stored !== mwBody) {
        const items = summarizeMwChanges(
          parseMarkwhenFormat(stored), parseMarkwhenFormat(mwBody), countFilesUnder,
        );
        if (items.length > 0) {
          setMwReview({ items, mwBody, destructive: items.some((i) => i.destructive) });
        }
      }
    })();
  }, [notes, countFilesUnder]);

  // ---- markwhen → backing notes ---------------------------------
  // A note with `markwhen: true` carries a markwhen timeline in its body.
  // For each event in it, materialize a real event note in the same
  // directory if one doesn't already exist (matched by date + time +
  // title), using Order's normal event-note convention. Idempotent: once
  // a backing note exists, its identity is in `notes` and we skip it.
  const materializingRef = useRef(false);
  useEffect(() => {
    if (!notes || materializingRef.current) return;
    const mwNotes = notes.filter((n) => n.frontmatter.markwhen === true);
    if (mwNotes.length === 0) return;
    // Identity set of every event note already on disk.
    const existing = new Set<string>();
    for (const n of notes) {
      const d = toIsoDateValue(n.frontmatter.date);
      if (!d) continue;
      const st = typeof n.frontmatter.startTime === "string" && /^\d{2}:\d{2}$/.test(n.frontmatter.startTime)
        ? n.frontmatter.startTime : "";
      const t = (n.title || n.filename.replace(/\.md$/i, "")).toLowerCase();
      existing.add(`${d}|${st}|${t}`);
    }
    const toCreate: { dir: string; folder: string | null; date: string; title: string;
      time?: string; endTime?: string; endDate?: string; allDay: boolean }[] = [];
    for (const src of mwNotes) {
      const dir = vaultDir(toVaultRel(src.path));
      // The event's Notable Folder: the source note's `folder:`, else its
      // own containing directory (its NF). Without this, a markwhen note
      // with no `folder:` produced backing notes that no folder claimed.
      const folder = noteFolder(src.frontmatter) ?? (dir.split("/").pop() || null);
      for (const ev of parseMarkwhenEvents(src.body)) {
        const k = `${ev.date}|${ev.time ?? ""}|${ev.title.toLowerCase()}`;
        if (existing.has(k)) continue;
        existing.add(k); // also dedupe within this pass
        toCreate.push({
          dir, folder, date: ev.date, title: ev.title,
          time: ev.time, endTime: ev.endTime, endDate: ev.endDate,
          allDay: ev.allDay === true || !ev.time,
        });
      }
    }
    if (toCreate.length === 0) return;
    materializingRef.current = true;
    let cancelled = false;
    (async () => {
      const created: LoadedNote[] = [];
      for (const c of toCreate) {
        const fm: Frontmatter = {
          allDay: c.allDay,
          date: c.date,
          ...(c.time ? { startTime: c.time } : {}),
          ...(c.endTime ? { endTime: c.endTime } : {}),
          ...(c.endDate ? { endDate: c.endDate } : {}),
          ...(c.folder ? { folder: `[[${c.folder}]]` } : {}),
          title: c.title,
        };
        const seedBody = `# ${c.title}\n`;
        try {
          const path = await uniqueWrite(c.dir, basenameForEvent(c.date, c.title), joinFrontmatter(fm, seedBody));
          if (cancelled) return;
          created.push({
            id: newNoteId(), path, filename: path.split("/").pop() ?? "",
            frontmatter: fm, title: c.title, body: seedBody, mtime: Date.now(),
          });
        } catch { /* name collision storm or write error: skip this one */ }
      }
      materializingRef.current = false;
      if (created.length && !cancelled) setNotes((prev) => [...(prev ?? []), ...created]);
    })();
    return () => { cancelled = true; materializingRef.current = false; };
  }, [notes]);

  // ---- spacetime.yml reverse sync (manual, reviewed) ------------
  // Diff the on-disk spacetime.yml against the vault and let the user
  // review + confirm before any write. This phase applies the TIME
  // dimension (events + seasons): create / update-in-place / delete
  // notes. Space (folder) changes are surfaced in the review but not yet
  // applied. Destructive deletes are itemized and confirmed.
  const [syncReview, setSyncReview] = useState<
    { plan: SyncPlan; desiredSeasons: { start: string; end: string | null; name?: string }[] } | null
  >(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const handleRunMigration = useCallback(async () => {
    const cur = notesRef.current ?? [];
    const eventCount = cur.filter((n) => {
      const d = toIsoDateValue(n.frontmatter.date);
      return !!d && !n.frontmatter.role && n.frontmatter.list !== "cards" && n.frontmatter.list !== "lines" && !n.frontmatter.category;
    }).length;
    const backupPath = await vaultFs.backup().catch((e: unknown) => {
      void tauriMessage(`Backup failed: ${String(e)}`, { title: "Backup failed", kind: "error" }); return null;
    });
    if (!backupPath) return;
    const ok = await tauriConfirm(
      `Vault backed up to:\n${backupPath}\n\n` +
      `This will:\n` +
      `• Strip date/time/folder frontmatter from ~${eventCount} event notes\n` +
      `• Archive Areas.md, Seasons.md, and category index files to .order-legacy/chain/\n\n` +
      `spacetime.yml becomes the sole source of truth for structure and seasons.\n\n` +
      `Proceed?`,
      { title: "Apply spacetime migration", kind: "warning" }
    );
    if (!ok) return;
    // Load raw bodies for all notes (most leaves are body-lazy)
    const notesWithRaw = await Promise.all(cur.map(async (n) => {
      const rel = toVaultRel(n.path);
      const raw = await readVault(rel).catch(() => "");
      const { frontmatter, body } = splitFrontmatter(raw);
      return { path: rel, filename: n.filename, frontmatter, body, raw };
    }));
    const actions = planVaultMigration(notesWithRaw);
    let done = 0;
    for (const a of actions) {
      if (a.kind === "stripFrontmatter") {
        await writeVault(a.path, a.newContent);
      } else {
        const content = await readVault(a.path).catch(() => "");
        await writeVault(a.archivePath, content);
        await vaultFs.remove(a.path);
      }
      done++;
    }
    // Quiet inline confirmation instead of a blocking dialog; the backup path
    // is rarely needed in the moment, so log it for recovery rather than
    // interrupting with it.
    console.log(`[migration] complete — ${done} files updated. Backup: ${backupPath}`);
    flashCap(`Migration complete — ${done} files updated`, "ok");
    lastSpacetimeRef.current = null;
    await reloadNotes();
  }, [reloadNotes, flashCap]);

  const onSyncSpacetime = useCallback(async () => {
    try {
      const text = await readVault("spacetime.yml");
      const desired = parseSpacetime(text);
      const current = buildSpacetime(notesRef.current ?? [], vaultTaxonomy, parsedSpacetime, mwSources.length > 0 ? mwSources : undefined);
      const plan = planSpacetimeSync(current, desired);
      const desiredSeasons = desired.seasons.map((s) => ({
        start: s.date, end: s.endDate ?? null, ...(s.title ? { name: s.title } : {}),
      }));
      setSyncReview({ plan, desiredSeasons });
    } catch (err) {
      console.error("spacetime sync: couldn't read/parse spacetime.yml", err);
      void tauriMessage("Couldn't read spacetime.yml at the vault root.", { title: "Error", kind: "error" });
    }
  }, [vaultTaxonomy]);

  // Plain function (not useCallback) so it always closes over the latest
  // notes + chain handlers (notePathByRef etc. are recomputed per render).
  const applySpacetimeSync = async () => {
    if (!syncReview) return;
    setSyncBusy(true);
    try {
      const cur = notesRef.current ?? [];
      const noteKey = (n: LoadedNote): string | null => {
        const d = toIsoDateValue(n.frontmatter.date);
        if (!d) return null;
        const t = noteTitle(n.frontmatter, n.body, n.filename.replace(/\.md$/i, ""));
        return `${d}|${t.toLowerCase()}`;
      };
      const byKey = new Map<string, LoadedNote[]>();
      for (const n of cur) {
        const k = noteKey(n);
        if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(n);
      }
      const evKey = (e: SpacetimeEvent) => `${e.date}|${e.time ?? ""}|${e.title.toLowerCase()}`;
      const fmFor = (e: SpacetimeEvent): Frontmatter => ({
        allDay: e.allDay === true || !e.time,
        date: e.date,
        ...(e.time ? { startTime: e.time } : {}),
        ...(e.endTime ? { endTime: e.endTime } : {}),
        ...(e.endDate ? { endDate: e.endDate } : {}),
        ...(e.folder ? { folder: `[[${e.folder}]]` } : {}),
        title: e.title,
      });
      const root = await vaultRoot();
      const createEvent = async (e: SpacetimeEvent) => {
        const dir = (e.folder && noteDirByRef(e.folder)) || root;
        await uniqueWrite(dir, basenameForEvent(e.date, e.title), joinFrontmatter(fmFor(e), e.title ? `# ${e.title}\n` : ""));
      };
      for (const op of syncReview.plan.events) {
        if (op.kind === "delete") {
          for (const n of byKey.get(evKey(op.event)) ?? []) {
            try { await vaultFs.remove(toVaultRel(n.path)); } catch (err) { console.error("sync delete failed", err); }
          }
        } else if (op.kind === "create") {
          await createEvent(op.event);
        } else if (op.kind === "update") {
          const n = (byKey.get(evKey(op.from)) ?? [])[0];
          if (!n) { await createEvent(op.to); continue; }
          // Update frontmatter in place (no file move/rename in this phase),
          // preserving the note body.
          try {
            const raw = await readVault(n.path);
            const { body } = splitFrontmatter(raw);
            await writeVault(n.path, joinFrontmatter({ ...n.frontmatter, ...fmFor(op.to) }, body));
          } catch (err) { console.error("sync update failed", err); }
        }
      }
      if (syncReview.plan.seasonsChanged) {
        await patchSpacetimeSeasons(syncReview.desiredSeasons);
      }

      // ---- SPACE (folders) ----
      const space = syncReview.plan.space;
      // Removals (destructive): delete the directory recursively + drop the
      // parent's chain bullet. Skip any node whose ancestor is also being
      // removed (the ancestor's delete already takes it). Deepest first.
      const removedPaths = new Set(
        space.filter((o) => o.kind === "removeFolder").map((o) => o.path.join("/")),
      );
      const hasRemovedAncestor = (p: string[]) => {
        for (let i = 1; i < p.length; i++) if (removedPaths.has(p.slice(0, i).join("/"))) return true;
        return false;
      };
      const removals = space
        .filter((o): o is Extract<typeof o, { kind: "removeFolder" }> => o.kind === "removeFolder")
        .filter((o) => !hasRemovedAncestor(o.path))
        .sort((a, b) => b.path.length - a.path.length);
      for (const op of removals) {
        const p = op.path;
        const leaf = p[p.length - 1];
        const leafPath = notePathByRef(leaf);
        if (leafPath) {
          try { await vaultFs.remove(vaultDir(toVaultRel(leafPath))); } catch (err) { console.error("sync remove folder failed", err); }
        }
        // Remove from spacetime.yml space tree
        if (p.length === 1) await patchSpacetimeSpace({ kind: "removeArea", name: leaf });
        else if (p.length === 2) await patchSpacetimeSpace({ kind: "removeCategory", area: p[0], name: leaf });
        else await patchSpacetimeSpace({ kind: "removeFolder", area: p[0], category: p[1], name: leaf });
      }
      // Adds: shallowest first so parents exist before children.
      const adds = space
        .filter((o): o is Extract<typeof o, { kind: "addFolder" }> => o.kind === "addFolder")
        .sort((a, b) => a.path.length - b.path.length);
      for (const op of adds) {
        const p = op.path;
        if (p.length === 1) await handleAddArea(p[0]);
        else if (p.length === 2) await handleAddCategory(p[1], p[0]);
        else if (p.length >= 3) {
          // Prefer handleCreateFolder (uses noteDirByRef); fall back to
          // direct path construction from the space tree so this works
          // even after migration when Category .md files no longer exist.
          const catDir = noteDirByRef(p[1]);
          if (catDir) {
            await handleCreateFolder(p[2], p[0], p[1]);
          } else {
            const root = await vaultRoot();
            const safe = p[2].replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();
            const relPath = `${p[0]}/${p[1]}/${safe}/${safe}.md`;
            const fm: Frontmatter = { category: p[1], area: p[0] };
            await writeVault(relPath, joinFrontmatter(fm, `# ${p[2]}\n`));
            await patchSpacetimeSpace({ kind: "addFolder", area: p[0], category: p[1], name: safe });
            void root; // referenced for fallback clarity
          }
        }
      }
      // Reorders: rewrite the parent's chain to the desired order.
      for (const op of space) {
        if (op.kind !== "reorder") continue;
        if (op.parent.length === 0) await handleReorderAreasTo(op.order);
        else if (op.parent.length === 1) await handleReorderCategoriesTo(op.parent[0], op.order);
        else if (op.parent.length >= 2) await handleReorderFoldersTo(op.parent[0], op.parent[1], op.order);
      }

      setSyncReview(null);
      // Allow the mirror to rewrite the canonical spacetime.yml now that
      // the vault reflects the applied edits (clears the hand-edit hold).
      lastSpacetimeRef.current = null;
      await reloadNotes();
    } finally {
      setSyncBusy(false);
    }
  };

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
    { path: string; title: string; x: number; y: number; date: string | null; folder: string | null; emails: string[] } | null
  >(null);
  const handleEventClick = useCallback((path: string, coords?: { x: number; y: number }) => {
    let title = "Untitled";
    let d: string | null = null;
    let f: string | null = null;
    let em: string[] = [];
    if (isTodoTxtPath(path)) {
      // The "note" here is the underlying todo.txt file; the line
      // index in the synthetic path picks out the actual item so the
      // action menu can show its title and date.
      const split = splitTodoTxtPath(path);
      if (split) {
        const file = notesRef.current?.find((n) => n.path === split.file);
        const item = file ? parseTodoTxt(file.body).find((i) => i.index === split.index) : null;
        if (item) {
          // Strip todo.txt metadata tokens (+project / @context) from
          // the visible title — same shape the calendar chip uses.
          const cleanTitle = item.text
            .replace(/(?:^|\s)[+@]\S+/g, "")
            .replace(/\s+/g, " ")
            .trim();
          title = cleanTitle || "Untitled";
          d = item.due ?? null;
          if (item.project) {
            const names = notableFoldersRef.current ?? [];
            f = resolveProjectToNf(item.project, names);
          }
        }
      }
    } else {
      // Every calendar chip is mapped to its authoritative mw event in the chip
      // map, keyed by the exact path FullCalendar used. The mw is the source of
      // truth for title / date / folder — note frontmatter (which can be stale
      // or missing) is never consulted for these.
      const chip = eventChipRef.current.get(path);
      if (chip) {
        title = chip.ev.title;
        d = chip.ev.date;
        f = chip.ev.folder ?? null;
        em = chip.ev.emails ?? [];
      } else if (path.startsWith("mw-event:")) {
        // Fallback for a synthetic path not in the current chip map.
        const mwEv = mwEventIndexRef.current.get(path.slice("mw-event:".length));
        if (mwEv) { title = mwEv.title; d = mwEv.date; f = mwEv.folder ?? null; }
      } else {
        // Last resort: a real note with no chip entry.
        const note = notesRef.current?.find((n) => n.path === path);
        if (note) {
          title = note.title;
          d = typeof note.frontmatter.date === "string" ? note.frontmatter.date : null;
          f = effectiveFolder(note);
        }
      }
    }
    setEventMenu({
      path,
      title,
      x: coords?.x ?? window.innerWidth / 2,
      y: coords?.y ?? window.innerHeight / 2,
      date: d,
      folder: f,
      emails: em,
    });
  }, []);
  /** Opening a todo.txt-only chip prompts to "promote" it to a real
   *  .md note — same shape as `createNote` would build from a calendar
   *  drag, but seeded from the existing line. The prompt is small +
   *  centered (Esc cancels, Enter confirms) so it never blocks the
   *  user's flow. */
  const [createMdPrompt, setCreateMdPrompt] = useState<{
    syntheticPath: string;
    title: string;
    date: string;
    startTime?: string;
    endTime?: string;
    endDate?: string;
    allDay: boolean;
    folder?: string;
  } | null>(null);

  /** Rename a calendar event's title from the action menu. Routes the
   *  same way mutations do: synthetic todo.txt path rewrites the line
   *  in place (preserving any `+project` tag), .md path rewrites the
   *  H1 + frontmatter title and renames the file to match. */
  const renameEventTitle = useCallback(async (path: string, newTitle: string) => {
    const cleanTitle = newTitle.trim();
    if (!cleanTitle) return;
    if (isTodoTxtPath(path)) {
      const split = splitTodoTxtPath(path);
      if (!split) return;
      const fileBody = await readVault(split.file);
      const items = parseTodoTxt(fileBody);
      const target = items.find((i) => i.index === split.index);
      if (!target) return;
      // Keep all metadata tokens (+project / @context), drop only the
      // existing description, then rebuild as "newTitle [+tags]".
      const tags = (target.text.match(/(?:^|\s)[+@]\S+/g) ?? [])
        .map((t) => t.trim());
      const newText = [cleanTitle, ...tags].join(" ").trim();
      const next: TodoItem = { ...target, text: newText };
      const nextBody = mutateTodoLine(fileBody, split.index, next);
      await writeVault(split.file, nextBody);
      setNotes((prev) => prev?.map((n) =>
        n.path === split.file ? { ...n, body: nextBody } : n,
      ) ?? null);
      return;
    }
    // mw event: the calendar reads the title from spacetime.mw, so the rename
    // must update the mw event first (source of truth for display).
    const chip = eventChipRef.current.get(path);
    if (!chip) return;
    const { ev, notePath } = chip;
    await applyMwEdit((mw) => mwUpdateEvent(mw, ev.date, ev.title, { title: cleanTitle }));
    // If a backing note exists, also rewrite its frontmatter title + H1 so the
    // note's own content matches the renamed event.
    if (notePath) {
      const raw = await readVault(toVaultRel(notePath)).catch(() => "");
      if (raw) {
        const { frontmatter, body } = splitFrontmatter(raw);
        const nextFm: Frontmatter = { ...frontmatter, title: cleanTitle };
        const lines = body.split(/\r?\n/);
        let h1Replaced = false;
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i].trim();
          if (!t) continue;
          if (t.startsWith("#")) { lines[i] = `# ${cleanTitle}`; h1Replaced = true; }
          break;
        }
        const newBody = h1Replaced ? lines.join("\n") : `# ${cleanTitle}\n${body}`;
        await writeVault(toVaultRel(notePath), joinFrontmatter(nextFm, newBody));
      }
    }
  }, [applyMwEdit]);

  const openEventNote = useCallback((path: string) => {
    if (path.startsWith("mw-event:")) {
      // No backing note exists yet. Materialise it by creating the note
      // directly from the mw event data, then navigate to it.
      const key = path.slice("mw-event:".length);
      const mwEv = mwEventIndexRef.current.get(key);
      if (!mwEv) return;
      void (async () => {
        const root = await vaultRoot();
        const dir = (mwEv.folder && noteDirByRef(mwEv.folder)) || root;
        const fm: Frontmatter = {
          date: mwEv.date,
          allDay: mwEv.allDay ?? !mwEv.time,
          ...(mwEv.time    ? { startTime: mwEv.time }    : {}),
          ...(mwEv.endTime ? { endTime: mwEv.endTime }    : {}),
          ...(mwEv.endDate ? { endDate: mwEv.endDate }    : {}),
          ...(mwEv.folder  ? { folder: `[[${mwEv.folder}]]` } : {}),
          title: mwEv.title,
        };
        const notePath = await uniqueWrite(
          dir,
          basenameForEvent(mwEv.date, mwEv.title),
          joinFrontmatter(fm, `# ${mwEv.title}\n`),
        );
        navigateAndFocus(notePath);
      })();
      return;
    }
    if (isTodoTxtPath(path)) {
      const split = splitTodoTxtPath(path);
      if (!split) return;
      const file = notesRef.current?.find((n) => n.path === split.file);
      const item = file ? parseTodoTxt(file.body).find((i) => i.index === split.index) : null;
      if (!item || !item.due) return;
      // Strip todo.txt metadata tokens from the visible title — same
      // logic the calendar feed uses for chip titles.
      const cleanTitle = item.text
        .replace(/(?:^|\s)[+@]\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const folder = item.project
        ? resolveProjectToNf(item.project, notableFoldersRef.current ?? []) ?? undefined
        : undefined;
      setCreateMdPrompt({
        syntheticPath: path,
        title: cleanTitle || "Untitled",
        date: item.due,
        ...(item.startTime ? { startTime: item.startTime } : {}),
        ...(item.endTime ? { endTime: item.endTime } : {}),
        ...(item.endDate ? { endDate: item.endDate } : {}),
        allDay: item.allDay,
        ...(folder ? { folder } : {}),
      });
      return;
    }
    navigateAndFocus(path);
  }, [navigateAndFocus]);

  /** Materialise the prompted todo.txt-only event into a real .md
   *  file, then navigate to it. The next sync sees the new .md,
   *  marks the original line as a mirror (identity match), and the
   *  line stays in todo.txt as a clean mirror line. */
  const confirmCreateMd = useCallback(async () => {
    const prompt = createMdPrompt;
    if (!prompt) return;
    const root = await vaultRoot();
    const frontmatter: Frontmatter = {
      date: prompt.date,
      allDay: prompt.allDay,
      ...(prompt.startTime ? { startTime: prompt.startTime } : {}),
      ...(prompt.endTime ? { endTime: prompt.endTime } : {}),
      ...(prompt.endDate ? { endDate: prompt.endDate } : {}),
      ...(prompt.folder ? { folder: `[[${prompt.folder}]]` } : {}),
    };
    const folderRef = parseRef(frontmatter.folder);
    const writeDir = (folderRef && noteDirByRef(folderRef)) || root;
    const seedBody = `# ${prompt.title}\n`;
    const content = joinFrontmatter(frontmatter, seedBody);
    const basename = basenameForEvent(prompt.date, prompt.title);
    const path = await uniqueWrite(writeDir, basename, content);
    const filename = path.split("/").pop() ?? basename;
    setNotes((prev) => [
      ...(prev ?? []),
      {
        id: newNoteId(),
        path,
        filename,
        frontmatter,
        title: prompt.title,
        body: seedBody,
        mtime: Date.now(),
      },
    ]);
    setCreateMdPrompt(null);
    // Pin the NF filter explicitly. navigateAndFocus would do this
    // automatically — but it reads from notesRef which hasn't flushed
    // the new note yet (we're inside the same React tick that called
    // setNotes), so the lookup misses. Setting the include filter
    // here puts the new note's NF at the top of the pile so the
    // newspaper section template kicks in and lands the user inside it.
    if (prompt.folder) {
      const nf = prompt.folder;
      setFilters((prev) => [
        { kind: "include", ref: nf },
        ...prev.filter((f) => !(f.kind === "include" && f.ref === nf)),
      ]);
      setFocusedFolder(nf);
      markFolderRecent(nf);
    }
    setView("pile");
    setScrollTargetPath(path);
    setFocusPath(path);
    setFocusedPath(path);
  }, [createMdPrompt, navigateAndFocus, markFolderRecent]);
  const deleteEventNote = useCallback(async (path: string) => {
    // Todo.txt line delete: rewrite the file with the line spliced
    // out. The synthetic path identifies which line.
    if (isTodoTxtPath(path)) {
      const split = splitTodoTxtPath(path);
      if (!split) return;
      const body = await readVault(split.file);
      const nextBody = mutateTodoLine(body, split.index, null);
      await writeVault(split.file, nextBody);
      setNotes((prev) => prev?.map((n) =>
        n.path === split.file ? { ...n, body: nextBody } : n,
      ) ?? null);
      return;
    }
    // mw event: remove it from spacetime.mw (source of truth → off the
    // calendar). Also delete the backing note file if one exists.
    const chip = eventChipRef.current.get(path);
    if (chip) {
      await applyMwEdit((mw) => mwDeleteEvent(mw, chip.ev.date, chip.ev.title));
      if (chip.notePath) {
        const note = notesRef.current?.find((n) => n.path === chip.notePath);
        if (note) await handleCardDelete(note.id, chip.notePath);
      }
      return;
    }
    // Fallback: a direct note path with no chip entry.
    const note = notesRef.current?.find((n) => n.path === path);
    if (!note) return;
    await handleCardDelete(note.id, path);
  }, [applyMwEdit]);
  /** Rewrite a calendar event's date to `newDate` (YYYY-MM-DD), keeping the
   *  startTime / endTime / allDay flag untouched — "move to same time on
   *  another day." Forward-ref so the action menu (declared earlier) can
   *  invoke the latest version once updateNoteFrontmatter is in scope. */
  const moveEventToDayRef = useRef<((path: string, newDate: string) => Promise<void>) | null>(null);

  // Before the scroll-to-target settle timer fires, make sure the
  // target is actually in the rendered slice. The bare-pile is
  // paginated to PILE_PAGE_SIZE; a newly-created note dated in the
  // past — or a calendar-event Open on something off the recency
  // tail — could land outside that window, and the cell lookup
  // below would silently miss. Extend the limit to the next
  // PILE_PAGE_SIZE boundary that covers the target's sorted index.
  useEffect(() => {
    if (view !== "pile") return;
    if (filters.length > 0) return;
    const target = scrollTargetPath ?? focusPath ?? focusedPath;
    if (!target) return;
    const idx = sortedFullRef.current.findIndex((n) => n.path === target);
    if (idx < 0) return;
    const need = idx + 1;
    setPileLimit((cur) => {
      if (cur === null) return cur;
      if (need <= cur) return cur;
      return Math.ceil(need / PILE_PAGE_SIZE) * PILE_PAGE_SIZE;
    });
    // sortedFullRef is a mutable ref — we deliberately don't list it
    // in deps so this only fires when a new target is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, scrollTargetPath, focusPath, focusedPath, filters.length]);

  // After switching to Pile with a target set, scroll the matching
  // card into view and pulse a highlight on it. We wait long enough
  // for the masonry layout effect to compute row spans (otherwise the
  // cell's final Y is wrong) and then for the smooth scroll to start.
  // Clearing scrollTargetPath happens INSIDE the timeout so the effect's
  // cleanup doesn't cancel the timer mid-flight.
  useEffect(() => {
    if (view !== "pile" || !scrollTargetPath) return;
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
    // Every create — dock + button, Cmd+N, calendar drag/click — makes
    // a real .md file. The file is the durable source of truth; with
    // todo.txt mode on, the mirror sync reflects it into todo.txt as a
    // line on the next pass. (Order briefly created todo.txt-ONLY
    // lines for calendar drags, but a line whose only home is a file
    // that two devices' sync passes rewrite concurrently can lose the
    // race and vanish. An .md can't: even if todo.txt gets clobbered
    // by a sync conflict, the next mirror pass regenerates its line.)
    const root = await vaultRoot();
    // Defaults match the auto-inject path: notes get allDay=false unless
    // the caller explicitly says otherwise (Year + Month all-day clicks).
    const frontmatter: Frontmatter = { allDay: false, ...patch };
    // Folder resolution priority:
    //   1. caller supplied `folder` (calendar quick-create from a
    //      pinned section, dock new-note picker, etc.)
    //   2. at least one Notable Folder is active in the include
    //      filter — drop the new note in the top of the pile (the
    //      most-recently-touched section, which sits first in the
    //      include set). No picker even when several folders are
    //      pinned: the user's pile order IS the picker.
    //   3. home Notable Folder
    // Empty vault skips all three and the file just goes at root.
    if (!frontmatter.folder) {
      const activeIncludes = notableIncludesRef.current;
      if (activeIncludes.length >= 1) {
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
    // A dated create is a calendar event — register it in spacetime.mw (the
    // source of truth the calendar renders from). The .md just written is its
    // backing note; the chip will resolve to it by date+title. Undated creates
    // (plain notes via Cmd+N / dock +) never touch the mw.
    if (typeof frontmatter.date === "string") {
      const ev: SpacetimeEvent = {
        date: frontmatter.date,
        title: title || "Untitled",
        ...(folderRef ? { folder: folderRef } : {}),
        ...(typeof frontmatter.startTime === "string" ? { time: frontmatter.startTime } : {}),
        ...(typeof frontmatter.endTime === "string"   ? { endTime: frontmatter.endTime } : {}),
        ...(typeof frontmatter.endDate === "string"   ? { endDate: frontmatter.endDate } : {}),
        ...(frontmatter.allDay === true ? { allDay: true } : {}),
      };
      await applyMwEdit((mw) => mwAddEvent(mw, ev));
    }
    // Visibility safety net: if a filter is active and the new note's
    // folder isn't part of the include set, additively add it so the
    // card lands on screen instead of being hidden behind a filter
    // the user just authored under. Keeps the user's existing filter
    // intent intact (doesn't clear) — additive, like a wikilink click.
    if (folderRef && includeSetRef.current.size > 0 && !includeSetRef.current.has(folderRef)) {
      setFilters((prev) => [...prev, { kind: "include", ref: folderRef }]);
    }
    // Land focus + scroll on the new note. Both Pile and the
    // calendar views consume scrollTargetPath; the Card itself
    // picks up autoFocus on mount.
    setFocusPath(path);
    setScrollTargetPath(path);
    setFocusedPath(path);
    // Stay in whichever view triggered the create — calendar views
    // re-render with the new event at its date/time; Pile sorts it
    // into place by date+startTime.
  }, [applyMwEdit]);
  // Keep the forward-ref in sync so the keyboard handler (Cmd+N), which
  // sits earlier in this component, can invoke the latest createNote.
  useEffect(() => { createNoteRef.current = createNote; }, [createNote]);
  useEffect(() => { promptCreateRef.current = promptCreate; }, [promptCreate]);

  // Reconcile orphan event notes INTO spacetime.mw (the inverse of removing
  // them). The event is rebuilt from the note's own frontmatter — date, time,
  // all-day — and its location is inferred from `folder:` (or, failing that,
  // the note's own directory) and appended to the # Time/Events section. Once
  // it's in the mw it stops being an orphan and renders normally. Bulk-capable;
  // one mw write for the whole batch.
  const addOrphanEventsToSpacetime = useCallback(async (paths: string[]) => {
    const events: SpacetimeEvent[] = [];
    for (const p of paths) {
      const n = notesRef.current?.find((x) => x.path === p);
      if (!n) continue;
      const date = toIsoDateValue(n.frontmatter.date);
      if (!date) continue;
      const folderRef = parseRef(n.frontmatter.folder)
        ?? (vaultDir(toVaultRel(n.path)).split("/").pop() || undefined);
      const st = typeof n.frontmatter.startTime === "string" && /^\d{2}:\d{2}$/.test(n.frontmatter.startTime)
        ? n.frontmatter.startTime : undefined;
      events.push({
        date,
        title: n.title || n.filename.replace(/\.md$/i, ""),
        ...(folderRef ? { folder: folderRef } : {}),
        ...(st ? { time: st } : {}),
        ...(typeof n.frontmatter.endTime === "string" ? { endTime: n.frontmatter.endTime } : {}),
        ...(typeof n.frontmatter.endDate === "string" ? { endDate: String(n.frontmatter.endDate).slice(0, 10) } : {}),
        ...(n.frontmatter.allDay === true ? { allDay: true } : {}),
      });
    }
    if (events.length === 0) return;
    await applyMwEdit((mw) => events.reduce((acc, ev) => mwAddEvent(acc, ev), mw));
    await reloadNotes();
  }, [applyMwEdit, reloadNotes]);

  // Push a modified event's new title into spacetime.mw — the user confirming
  // "yes, this retitle is real." Updates the mw line and re-points the stable
  // link at the new title so it stops being flagged. Bulk-capable.
  const applyModifiedEvents = useCallback(async (noteIds: string[]) => {
    const edits: { date: string; oldTitle: string; newTitle: string; id: string }[] = [];
    for (const id of noteIds) {
      const n = notesRef.current?.find((x) => x.id === id);
      const link = noteEventLinkRef.current.get(id);
      if (!n || !link) continue;
      const newTitle = (n.title || n.filename.replace(/\.md$/i, "")).trim();
      if (!newTitle || newTitle.toLowerCase() === link.title.toLowerCase()) continue;
      edits.push({ date: link.date, oldTitle: link.title, newTitle, id });
    }
    if (edits.length === 0) return;
    await applyMwEdit((mw) => edits.reduce(
      (acc, e) => mwUpdateEvent(acc, e.date, e.oldTitle, { title: e.newTitle }), mw));
    for (const e of edits) noteEventLinkRef.current.set(e.id, { date: e.date, title: e.newTitle });
    await reloadNotes();
  }, [applyMwEdit, reloadNotes]);

  /** Settings → "Open todo.txt": create the configured file if it
   *  doesn't exist yet, then show ONLY that file in the Pile by
   *  replacing the active filter set with a single include pinned to
   *  its filename. Replacing (rather than navigateAndFocus's
   *  prepending) is important because the user is most often on the
   *  home NF when they open Settings — preserving that filter would
   *  splash the home folder's whole pile alongside the file. */
  const openTodoTxt = useCallback(async () => {
    const settings = getTodoTxtSettings();
    const relPath = settings.path || DEFAULT_TODO_TXT_PATH;
    const root = await vaultRoot();
    const fullPath = `${root}/${relPath}`;
    const existing = notesRef.current?.find((n) => toVaultRel(n.path) === relPath);
    if (!existing) {
      await writeVault(fullPath, "");
      setNotes((prev) => [
        ...(prev ?? []),
        {
          id: newNoteId(),
          path: fullPath,
          filename: relPath.split("/").pop() ?? relPath,
          frontmatter: {},
          title: relPath,
          body: "",
          mtime: Date.now(),
        },
      ]);
    }
    // Filename is the include ref; .txt files keep their extension
    // (belongsTo only strips `.md`), so `todo.txt` matches itself
    // exclusively.
    const ownRef = (relPath.split("/").pop() ?? relPath);
    setView("pile");
    setFilters([{ kind: "include", ref: ownRef }]);
    setFocusedFolder(null);
    setFocusPath(fullPath);
    setFocusedPath(fullPath);
    setScrollTargetPath(fullPath);
  }, []);

  /** Open spacetime.yml as an editable raw-text card (like todo.txt). The
   *  continuous mirror writes it as you work; opening it lets you hand-edit
   *  and then "Apply spacetime.yml to vault" to sync the changes back. */
  const openSpacetimeFile = useCallback(async (relPath: string, ensureContent?: () => string) => {
    const root = await vaultRoot();
    const fullPath = `${root}/${relPath}`;
    const existing = notesRef.current?.find((n) => toVaultRel(n.path) === relPath);
    if (!existing && ensureContent) {
      const content = ensureContent();
      await writeVault(relPath, content);
      setNotes((prev) => [
        ...(prev ?? []),
        { id: newNoteId(), path: fullPath, filename: relPath, frontmatter: {}, title: relPath, body: content, mtime: Date.now() },
      ]);
    }
    setView("pile");
    // Filter by the note's REF (filename minus a .md extension — exactly what
    // refOf() produces), NOT the raw path. `spacetime.md`'s ref is `spacetime`,
    // so filtering on `spacetime.md` would match nothing and the card wouldn't
    // open. (.mw/.yml keep their extension in the ref, so this is a no-op there.)
    setFilters([{ kind: "include", ref: relPath.replace(/\.md$/i, "") }]);
    setFocusedFolder(null);
    setFocusPath(fullPath);
    setFocusedPath(fullPath);
    setScrollTargetPath(fullPath);
  }, []);

  const openSpacetime = useCallback(async () => {
    await openSpacetimeFile("spacetime.yml", () =>
      serializeSpacetime(buildSpacetime(notesRef.current ?? [], vaultTaxonomy, parsedSpacetime, mwSources.length > 0 ? mwSources : undefined))
    );
  }, [openSpacetimeFile, vaultTaxonomy, parsedSpacetime, mwSources]);

  const openSpacetimeMw = useCallback(async () => {
    await openSpacetimeFile(spacetimeRootPathRef.current, () => {
      const st = buildSpacetime(notesRef.current ?? [], vaultTaxonomy, parsedSpacetime, mwSources.length > 0 ? mwSources : undefined);
      return serializeMarkwhen(st);
    });
  }, [openSpacetimeFile, vaultTaxonomy, parsedSpacetime, mwSources]);

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

  // Refresh the in-memory copy of a structural file after the user
  // hand-edits it in its card. The watcher filters our own writes, so a
  // self-write to spacetime.mw / .yml (or a list folder) otherwise leaves
  // `notes` — and everything derived from it (the sidebar taxonomy,
  // mwSources, the mw→yml mirror in Effect 2) — stale. Reordering the
  // hierarchy in spacetime.mw then looked like a no-op.
  //
  // Gated to needsBodyUpfront files only: leaf notes own their body in the
  // Card, and churning `notes` on every leaf autosave would re-render the
  // whole grid for no benefit.
  const handleCardPersisted = useCallback((path: string, frontmatter: Frontmatter, body: string) => {
    const rel = toVaultRel(path);
    const filename = rel.split("/").pop() ?? rel;
    if (!needsBodyUpfront(frontmatter, filename)) return;
    setNotes((prev) => prev?.map((n) =>
      toVaultRel(n.path) === rel ? { ...n, frontmatter, body } : n) ?? null);
  }, []);

  /** Assign (or clear) a regular note's Notable Folder. Writes the
   *  `folder: [[Name]]` field into the file's YAML AND moves the file
   *  into that folder's directory on disk so the layout matches the
   *  YAML (mirrors where createNote places new notes). Clearing a
   *  folder just rewrites YAML and leaves the file where it is. */
  const handleAssignFolder = useCallback(async (path: string, folderName: string | null) => {
    // Todo.txt-backed chip: rewrite the line's `+project` token rather
    // than reading/writing a non-existent .md. The line stays in the
    // same position; only its `text` and `project` fields change so
    // the synthetic path remains valid for subsequent interactions.
    if (isTodoTxtPath(path)) {
      const split = splitTodoTxtPath(path);
      if (!split) return;
      const fileBody = await readVault(split.file);
      const items = parseTodoTxt(fileBody);
      const target = items.find((i) => i.index === split.index);
      if (!target) return;
      const slug = folderName ? nfNameToProjectSlug(folderName) : null;
      // Drop every existing +project/@context token from the text,
      // then re-append the new one (if any). Order: title, then tag.
      const textNoTags = target.text
        .replace(/(?:^|\s)[+@]\S+/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const newText = slug ? `${textNoTags} +${slug}` : textNoTags;
      const next: TodoItem = {
        ...target,
        text: newText,
        ...(slug ? { project: slug } : { project: undefined }),
      };
      const nextBody = mutateTodoLine(fileBody, split.index, next);
      await writeVault(split.file, nextBody);
      setNotes((prev) => prev?.map((n) =>
        n.path === split.file ? { ...n, body: nextBody } : n,
      ) ?? null);
      return;
    }
    // mw event chip: the calendar reads an event's folder from its #tag in
    // spacetime.mw, so re-folder updates the mw event first (source of truth).
    // Then, if a backing note exists, move/retag the file to match below.
    const chip = eventChipRef.current.get(path);
    let notePath = path;
    if (chip) {
      await applyMwEdit((mw) =>
        mwUpdateEvent(mw, chip.ev.date, chip.ev.title, { folder: folderName ?? undefined }));
      markFolderRecent(folderName ?? "");
      if (!chip.notePath) return; // synthetic event — no file to move
      notePath = chip.notePath;
    }

    const raw = await readVault(toVaultRel(notePath)).catch(() => "");
    if (!raw) return;
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    if (folderName) next.folder = `[[${folderName}]]`;
    else delete next.folder;
    const content = joinFrontmatter(next, body);

    // Move into the target folder's directory when it resolves and
    // differs from where the file currently lives. write-new + delete-
    // old (via uniqueWrite) handles name collisions in the target.
    const targetDir = folderName ? noteDirByRef(folderName) : null;
    const curDir = notePath.slice(0, notePath.lastIndexOf("/"));
    if (targetDir && targetDir !== curDir) {
      const filename = notePath.split("/").pop() ?? "note.md";
      const newPath = await uniqueWrite(targetDir, filename, content);
      await vaultFs.remove(toVaultRel(notePath));
      // Move the note's same-folder images along with it so the ![[…]]
      // embeds keep resolving from the new folder.
      for (const file of embeddedImageFiles(body)) {
        try {
          await vaultFs.rename(toVaultRel(`${curDir}/${file}`), toVaultRel(`${targetDir}/${file}`));
        } catch { /* missing or already present — skip */ }
      }
      setNotes((prev) => prev?.map((n) =>
        n.path === notePath
          ? { ...n, path: newPath, filename: newPath.split("/").pop() ?? n.filename, frontmatter: next }
          : n) ?? null);
      // Forward path-tracking state so the focused card's React key
      // stays stable across the move (otherwise edit mode is lost).
      setFocusedPath((p) => (p === notePath ? newPath : p));
      setFocusPath((p) => (p === notePath ? newPath : p));
      setScrollTargetPath((p) => (p === notePath ? newPath : p));
      // Land the user inside the new NF. In calendar views, stay in the
      // calendar — just update recents. Only switch to Pile when already
      // in Pile (so a folder reassignment from the Pile stays in Pile).
      markFolderRecent(folderName ?? "");
      if (folderName && viewRef.current === "pile") {
        setFilters([{ kind: "include", ref: folderName }]);
        setFocusedFolder(folderName);
      }
      return;
    }

    await writeVault(toVaultRel(notePath), content);
    setNotes((prev) => prev?.map((n) => (n.path === notePath ? { ...n, frontmatter: next } : n)) ?? null);
  }, [applyMwEdit]);

  const knownEmails = useMemo(() => distinctEmails(mwEvents), [mwEvents]);

  /** Commit a new recipient list onto the event's spacetime.mw line. Updates
   *  the open menu optimistically so chips repaint without closing it. */
  const handleSetEmails = useCallback(async (path: string, emails: string[]) => {
    const chip = eventChipRef.current.get(path);
    if (!chip) return;
    const { date, title } = chip.ev;
    setEventMenu((m) => (m && m.path === path ? { ...m, emails } : m));
    await applyMwEdit((mw) => mwUpdateEvent(mw, date, title, { emails }));
  }, [applyMwEdit]);

  /** Generic frontmatter patcher driving the FrontmatterInspector.
   *  Read, mutate, write, sync state. Keys set to `null` are deleted;
   *  everything else upserts. Replaces the per-key togglers we used
   *  to have for `public`, `allDay`, etc. */
  const handleSetFrontmatter = useCallback(async (
    path: string,
    patch: Record<string, unknown | null>,
  ) => {
    const raw = await readVault(path);
    const { frontmatter, body } = splitFrontmatter(raw);
    const next: Frontmatter = { ...frontmatter };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    await writeVault(path, joinFrontmatter(next, body));
    setNotes((prev) => prev?.map((n) => (n.path === path ? { ...n, frontmatter: next } : n)) ?? null);
  }, []);

  /** Rename a Notable Folder.
   *
   *  An NF lives at `<vault>/<Area>/<Category>/<Name>/<Name>.md`. The
   *  folder NAME is its filename ref (the bullet text in its parent
   *  Category list, and the link target for any `folder: [[Name]]`
   *  frontmatter elsewhere). To rename in-place without breaking refs:
   *
   *    1. Rename the dir   `.../OldName/`     → `.../NewName/`
   *    2. Rename the file  `NewName/OldName.md` → `NewName/NewName.md`
   *    3. Sync `title:` on the main doc if it used to mirror the name.
   *    4. Rewrite inbound  `[[OldName]]` (bodies) and
   *                        `folder: [[OldName]]` (frontmatter) across
   *       every other note in the vault.
   *    5. Reload from disk so paths, refs, and chain order pick up.
   *
   *  Unsafe filesystem chars in the new name are coerced to `-`. The
   *  pretty form (with `:` etc.) belongs in `title:`, which the
   *  FrontmatterInspector edits separately. */
  const handleRenameNotableFolder = useCallback(async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const safe = trimmed.replace(/[\\/:*?"<>|]/g, "-").trim();
    if (!safe || safe === oldName) return;
    const list = notesRef.current ?? [];
    const main = list.find(
      (n) => n.filename.replace(/\.md$/i, "") === oldName && isMainDoc(n),
    );
    if (!main) return;
    const oldRel = toVaultRel(main.path);
    const oldDir = vaultDir(oldRel);
    const parentDir = vaultDir(oldDir);
    const newDir = parentDir ? `${parentDir}/${safe}` : safe;
    const newPath = `${newDir}/${safe}.md`;
    try {
      // 1. Dir rename. If the target dir exists already, bail — we'd
      //    rather refuse than merge with an unrelated folder.
      if (await vaultFs.exists(newDir)) {
        flashCap(`Couldn't rename — ${safe} already exists.`);
        return;
      }
      await vaultFs.rename(oldDir, newDir);
      // 2. Rename the main doc inside.
      await vaultFs.rename(`${newDir}/${oldName}.md`, newPath);
      // 3. Sync title if it was mirroring the filename name.
      try {
        const raw = await readVault(newPath);
        const { frontmatter, body } = splitFrontmatter(raw);
        const t = frontmatter.title;
        if (typeof t !== "string" || !t.trim() || t === oldName) {
          await writeVault(newPath, joinFrontmatter({ ...frontmatter, title: safe }, body));
        }
      } catch (err) {
        console.warn("title sync skipped on folder rename", err);
      }
      // 4. Rewrite inbound refs (bodies + frontmatter folder field).
      const target = oldName.toLowerCase();
      const folderRefRe = /^\[\[([^\]]+)\]\]$/;
      for (const n of list) {
        if (n.id === main.id) continue;
        try {
          const raw = await readVault(n.path);
          const { frontmatter, body } = splitFrontmatter(raw);
          let nextBody = body;
          let nextFm: Frontmatter = frontmatter;
          let dirty = false;
          if (body.toLowerCase().includes(target)) {
            const rb = rewriteWikilinksForRename(body, oldName, safe);
            if (rb !== body) { nextBody = rb; dirty = true; }
          }
          const fv = frontmatter.folder;
          if (typeof fv === "string") {
            const m = fv.trim().match(folderRefRe);
            if (m && m[1].trim().toLowerCase() === target) {
              nextFm = { ...frontmatter, folder: `[[${safe}]]` };
              dirty = true;
            }
          }
          if (dirty) await writeVault(n.path, joinFrontmatter(nextFm, nextBody));
        } catch (err) {
          console.warn("rename inbound rewrite skipped for", n.path, err);
        }
      }
    } catch (err) {
      console.error("NF rename failed:", err);
      flashCap(`Rename failed: ${String(err)}`);
      return;
    }
    // 5. Rename the folder in spacetime.mw (source of truth): rename the node
    //    in the `# Space` tree AND re-tag every event that pointed at it.
    //    writeSpacetimeModel stamps lastMarkwhenRef, so Effect 2 won't try to
    //    re-reconcile (and re-rename) the directory we already moved on disk.
    try {
      const mw = await readVault(spacetimeRootPathRef.current).catch(() => "");
      if (mw) {
        const st = parseMarkwhenFormat(mw);
        const walk = (nodes: SpaceNode[]) => {
          for (const n of nodes) { if (n.name === oldName) n.name = safe; walk(n.children); }
        };
        walk(st.space);
        for (const ev of st.events) if (ev.folder === oldName) ev.folder = safe;
        await writeSpacetimeModel(st);
      }
    } catch (err) {
      console.warn("mw folder rename sync skipped", err);
    }
    // 6. Pick up everything fresh — paths, refs, chain order all moved.
    await reloadNotes();
  }, [reloadNotes, writeSpacetimeModel]);


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
    // Register the new folder in spacetime.yml (replaces the old category bullet)
    await patchSpacetimeSpace({ kind: "addFolder", area: areaName, category: categoryName, name: bulletRef });
    setNotes((prev) => [
      ...(prev ?? []),
      { id: newNoteId(), path, filename, frontmatter, title: trimmed, body, mtime: Date.now() },
    ]);
  }, [flashCap, patchSpacetimeSpace]);

  const updateNoteFrontmatter = useCallback(async (path: string, patch: Frontmatter) => {
    // Todo.txt items are a parallel calendar source — route to the line writer.
    // The patch shape from CalendarView is the same (date / startTime / endTime
    // / endDate / allDay) but the writer is line-based, not YAML.
    if (isTodoTxtPath(path)) {
      await mutateTodoTxtFromPatch(path, patch);
      return;
    }
    // Every other calendar chip is an mw event. Locate it via the chip map and
    // apply the move/edit to spacetime.mw — the source of truth the calendar
    // reads from. (Writing note frontmatter here would be ignored on re-render
    // and the event would snap back to its mw position.)
    const chip = eventChipRef.current.get(path);
    if (!chip) return;
    const { ev } = chip;
    const next: Partial<SpacetimeEvent> = {};
    if ("date" in patch)      next.date    = typeof patch.date === "string" ? patch.date : ev.date;
    if ("startTime" in patch) next.time    = patch.startTime === undefined ? undefined : String(patch.startTime);
    if ("endTime" in patch)   next.endTime = patch.endTime   === undefined ? undefined : String(patch.endTime);
    if ("endDate" in patch)   next.endDate = patch.endDate   === undefined ? undefined : String(patch.endDate);
    if (patch.allDay === true)  { next.allDay = true; next.time = undefined; next.endTime = undefined; }
    if (patch.allDay === false) { next.allDay = undefined; }
    await applyMwEdit((mw) => mwUpdateEvent(mw, ev.date, ev.title, next));
    // mutateTodoTxtFromPatch is a stable useCallback declared just below; it is
    // intentionally omitted from deps to avoid a temporal-dead-zone reference.
  }, [applyMwEdit]);

  /** Apply a CalendarView-shape patch to a single todo.txt line.
   *  Reads the file fresh so concurrent edits don't clobber. */
  const mutateTodoTxtFromPatch = useCallback(async (
    syntheticPath: string,
    patch: Frontmatter,
  ) => {
    const split = splitTodoTxtPath(syntheticPath);
    if (!split) return;
    const body = await readVault(split.file);
    const items = parseTodoTxt(body);
    const target = items.find((i) => i.index === split.index);
    if (!target) return;

    // Merge patch into the item. `undefined` removes a field.
    const next: TodoItem = { ...target };
    if ("date" in patch) {
      const v = patch.date;
      if (typeof v === "string") next.due = v;
      else if (v === undefined) next.due = undefined;
    }
    if ("startTime" in patch) {
      const v = patch.startTime;
      next.startTime = v === undefined ? undefined : String(v);
    }
    if ("endTime" in patch) {
      const v = patch.endTime;
      next.endTime = v === undefined ? undefined : String(v);
    }
    if ("endDate" in patch) {
      const v = patch.endDate;
      next.endDate = v === undefined ? undefined : String(v);
    }
    if ("allDay" in patch) next.allDay = patch.allDay === true;

    const nextBody = mutateTodoLine(body, split.index, next);
    await writeVault(split.file, nextBody);
    // Local mirror: rewrite the LoadedNote.body so the next render
    // re-derives todoCalendarNotes from the same content the watcher
    // would have surfaced.
    setNotes((prev) => prev?.map((n) =>
      n.path === split.file ? { ...n, body: nextBody } : n,
    ) ?? null);
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

  if (loadError && notes === null && !iosNeedsVault) {
    return (
      <div className="vault-pick vault-pick-error">
        <h1>Couldn't open your vault</h1>
        {loadErrorPath && <p className="vault-pick-path">{loadErrorPath}</p>}
        <p>
          Order couldn't read this folder on this Mac. It may live on
          another computer, have moved, or macOS may be blocking access.
          Pick the folder that holds your notes here, and Order will
          remember it for this machine.
        </p>
        <div className="vault-pick-actions">
          <button type="button" className="vault-pick-btn" onClick={() => { void recoverVault(); }}>
            Choose vault folder…
          </button>
          <button
            type="button"
            className="vault-pick-btn is-ghost"
            onClick={() => { setLoadError(null); setNotes(null); void reloadNotes(); }}
          >
            Retry
          </button>
        </div>
        <p className="vault-pick-detail">{loadError}</p>
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

  // Area + Category come from the PATH, not frontmatter: a note inside
  // `<Area>/<Category>/<Folder>/…` belongs to that Area and Category. Frontmatter
  // is only a fallback for loose notes that don't live inside a folder directory.
  function inferredArea(n: LoadedNote): string {
    const parts = toVaultRel(n.path).split("/");
    if (parts.length >= 4) return parts[parts.length - 4];
    const yaml = parseRef(n.frontmatter.area);
    if (yaml) return yaml;
    const cat = parseRef(n.frontmatter.category);
    if (cat) return areaByCategory.get(cat) ?? "";
    return "";
  }
  function inferredCategory(n: LoadedNote): string {
    const parts = toVaultRel(n.path).split("/");
    if (parts.length >= 4) return parts[parts.length - 3];
    return parseRef(n.frontmatter.category) ?? "";
  }

  // Seasons: prefer spacetime.yml when it carries season records; fall back
  // to Seasons.md so un-migrated vaults keep working.
  const seasonsFile = notes.find((n) => isSeasonsFile(n.frontmatter, n.filename));
  const seasons: Season[] = (parsedSpacetime && parsedSpacetime.seasons.length > 0)
    ? parsedSpacetime.seasons.map((s) => ({ start: s.date, end: s.endDate ?? null, name: s.title }))
    : (seasonsFile ? parseSeasons(seasonsFile.body) : []);
  const seasonsPath = seasonsFile?.path ?? null;

  // Notable Folder Main Documents — notes whose YAML carries `category`.
  // Their title comes from the filename minus the .md (which is also
  // the slug other notes use to point at them via `folder: [[Name]]`).
  const notableFolders: NotableFolder[] = notes
    .filter((n) => isMainDoc(n))
    .map((n) => ({
      name: n.filename.replace(/\.md$/, ""),
      area: inferredArea(n),
      category: inferredCategory(n),
      frontmatter: n.frontmatter,
      path: n.path,
    }));
  notableFoldersRef.current = notableFolders.map((f) => f.name);

  // The hierarchy comes from spacetime.mw, NOT note frontmatter. Build the
  // folder list straight from the mw space tree (vaultTaxonomy), attaching each
  // folder's on-disk main document (matched by normalized key, truncation/dash
  // aware) only for navigation + color. A folder present in the mw shows even
  // if its main doc lacks `category`/`folder` frontmatter, and order follows
  // the mw exactly. This is the source of truth for the sidebar + folder picker.
  const mainDocByFolderKey = new Map<string, LoadedNote>();
  for (const n of notes) {
    const parts = toVaultRel(n.path).split("/");
    if (parts.length === 4 && parts[3].replace(/\.md$/i, "") === parts[2]) {
      mainDocByFolderKey.set(folderMatchKey(parts[2]), n);
    }
  }
  const mwFolders: NotableFolder[] = vaultTaxonomy.areas.flatMap((a) =>
    a.categories.flatMap((c) =>
      c.folders.map((f) => {
        const doc = mainDocByFolderKey.get(folderMatchKey(f));
        return {
          name: f,
          area: a.ref,
          category: c.ref,
          frontmatter: doc?.frontmatter ?? {},
          path: doc?.path ?? `${a.ref}/${c.ref}/${f}`,
        };
      }),
    ),
  );

  // Flat list of folder names + their deterministic colors, fed to the
  // folder picker in each non-Notable card's footer — also mw-sourced.
  const availableFolderRefs = mwFolders.map((f) => ({
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

  // Hide intermediate Area / Category list files from the Pile.
  // They're navigation infrastructure; the Sidebar drill is the
  // surface for editing them.
  const pileCandidates = notes.filter((n) => {
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
    if (effectiveFolder(n) === ref) return true;
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
    ? pileCandidates.filter(filterMatches)
    : pileCandidates)
    // Pile mode: "notes" drops NF cards; "folders" drops ordinary
    // notes (keep only NF main docs); "all" keeps both.
    .filter((n) => {
      if (pileMode === "all") return true;
      const isNF = isMainDoc(n);
      return pileMode === "notes" ? !isNF : isNF;
    })
    // "Public only": drop notes without `public: true` in YAML.
    .filter((n) => !publicOnly || n.frontmatter.public === true);

  // Single-folder mode = exactly one include filter. In this mode the
  // folder reads like a "page": its Main Document gets the full-width
  // cover treatment at the top, its notes below. Any other state
  // (multiple includes, or none) treats Notable Folders as ordinary
  // cards in a flat recency timeline.
  const singleFolderMode = includeRefs.length === 1;

  // The Pile is one recency-ordered timeline (newest first), keyed
  // off the note's date + startTime frontmatter.
  const sortKey = (n: LoadedNote): string => {
    // Source of truth first: if the note backs a spacetime event, order by the
    // EVENT's date/time — the note's own date/filename may differ or be absent
    // (e.g. a note written today for a future all-day event).
    const evLink = noteEventLinkRef.current.get(n.id);
    if (evLink) {
      const ev = mwEventIndex.get(`${evLink.date}|${evLink.title.toLowerCase()}`);
      if (ev) return `${ev.date} ${ev.time ?? "00:00"}`;
    }
    // Otherwise the note's own date. Accept both string and js-yaml Date for
    // `date` so unquoted YAML (Readwise sync, hand-typed bare dates) sorts
    // alongside the quoted strings we emit via isoDate().
    const raw = n.frontmatter.date;
    let d = "0000-00-00";
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      d = raw.slice(0, 10);
    } else if (raw instanceof Date && !isNaN(raw.getTime())) {
      const y = raw.getUTCFullYear();
      const m = String(raw.getUTCMonth() + 1).padStart(2, "0");
      const day = String(raw.getUTCDate()).padStart(2, "0");
      d = `${y}-${m}-${day}`;
    } else {
      // No `date` frontmatter (Geets / articles carry the date in the
      // FILENAME — "YYYY-MM-DD - Title"). Fall back to that leading date so
      // they sort chronologically alongside dated notes instead of sinking
      // to the bottom as 0000-00-00.
      const m = n.filename.match(/^(\d{4}-\d{2}-\d{2})/);
      if (m) d = m[1];
    }
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
    && isMainDoc(n)
    && n.filename.replace(/\.md$/, "") === pinnedRef;
  // Notable Folder Main Documents float to the top of the Pile by
  // default — they're the "covers" of each folder and read like a
  // table of contents for the recency feed below. Alphabetical
  // among themselves (no meaningful date on an NF main doc). The
  // pinned-folder cover, when one is active, still sits above the
  // alphabetical NF block.
  const sortedNotesFull = [...filteredNotes].sort((a, b) => {
    const am = isPinnedMain(a);
    const bm = isPinnedMain(b);
    if (am !== bm) return am ? -1 : 1;
    const aNF = isMainDoc(a);
    const bNF = isMainDoc(b);
    if (aNF !== bNF) return aNF ? -1 : 1;
    if (aNF && bNF) {
      return a.filename.localeCompare(b.filename);
    }
    return sortKey(b).localeCompare(sortKey(a));
  });
  // Pagination for the Pile's flat grid: with no folder filter active
  // we'd otherwise mount one Card per note in the vault — at 10^4 notes
  // each Milkdown editor instance kills the cold open. Cap the visible
  // set at PILE_PAGE_SIZE and surface a "Show more" affordance for
  // when the user wants to scroll further. Filtered views show the full
  // set (filtering already bounds the count by folder membership).
  sortedFullRef.current = sortedNotesFull;
  const sortedNotes = pileLimit !== null && filters.length === 0
    ? sortedNotesFull.slice(0, pileLimit)
    : sortedNotesFull;
  const hasMore = sortedNotes.length < sortedNotesFull.length;

  const vaultDirRelFor = (n: LoadedNote) => vaultDir(toVaultRel(n.path));

  // Render one note as a <Card>. Shared by the temporal flat grid and
  // the newspaper sections; capHeight is only set in newspaper mode.
  const cardNode = (n: LoadedNote, capHeight?: number, pile?: { folder: string }) => {
    const isMain = isMainDoc(n);
    const ref = n.filename.replace(/\.md$/, "");
    const folderName = isMain ? ref : (effectiveFolder(n) ?? pile?.folder ?? null);
    const c = folderName ? folderColor(folderName) : undefined;
    const inFilter = includeSet.has(ref);
    // The note's authoritative spacetime event (source of truth for its date +
    // all-day-ness), found via the stable spacetime link — set when an event
    // matched this note by TITLE. The note's own YAML / disk location is NOT
    // consulted; the event in spacetime decides.
    const evLink = noteEventLinkRef.current.get(n.id);
    const matchedEvent = evLink ? mwEventIndex.get(`${evLink.date}|${evLink.title.toLowerCase()}`) : undefined;
    const spacetimeEvent = matchedEvent
      ? { date: matchedEvent.date, allDay: matchedEvent.allDay ?? (!matchedEvent.time && !matchedEvent.endDate) }
      : undefined;
    // Permalink only for a public note whose slug is pinned (after a
    // publish) and when a home target exists to build the URL from.
    const slug = typeof n.frontmatter.slug === "string" ? n.frontmatter.slug : "";
    const base = homeFolders[0]?.target ? publicBaseUrl(homeFolders[0].target) : null;
    const permalink =
      n.frontmatter.public === true && slug && base ? `${base}${slug}/` : undefined;
    return (
      <Card
        path={n.path}
        externalBodyVersion={externalChangeVersion[n.path] ?? 0}
        permalink={permalink}
        color={c}
        area={isMain ? inferredArea(n) || undefined : undefined}
        category={isMain ? inferredCategory(n) || undefined : undefined}
        currentFolder={isMain ? undefined : effectiveFolder(n)}
        availableFolders={availableFolderRefs}
        onSetFrontmatter={(patch) => handleSetFrontmatter(n.path, patch)}
        liveFrontmatter={n.frontmatter}
        spacetimeEvent={spacetimeEvent}
        recentFolders={recentFolders}
        vaultNotes={vaultNotesIndex}
        onNavigate={navigateToRef}
        onAddFilter={addFolderToFilter}
        onRemoveFromFilter={inFilter ? () => removeFilter({ kind: "include", ref }) : undefined}
        onClosePile={pile && !isMain ? () => closeFromPile(pile.folder, n.path) : undefined}
        onAddToPile={pile && !isMain ? () => addToPile(pile.folder, n.path) : undefined}
        onBrowserAddToPile={isMain ? (filename: string) => { addToPileByName(ref, vaultDirRelFor(n), filename); focusFolder(ref); } : undefined}
        onBrowserRename={isMain ? (oldName: string, newName: string) => renameVaultFile(vaultDirRelFor(n), oldName, newName) : undefined}
        onBrowserDelete={isMain ? (name: string) => deleteVaultFile(vaultDirRelFor(n), name) : undefined}
        autoFocus={focusPath === n.path}
        focused={focusedPath === n.path}
        onFocus={() => setFocusedPath(n.path)}
        capHeight={capHeight}
        visited={isMain ? includeSet.has(ref) : undefined}
        onRenamed={(newPath) => handleCardRenamed(n.id, newPath)}
        onTitleChanged={(t) => handleCardTitleChanged(n.id, t)}
        onDelete={(path) => handleCardDelete(n.id, path)}
        onPersisted={handleCardPersisted}
        onCreateUpdate={isMain ? async (description) => {
          // Notable Update: stamp an all-day note in this folder for
          // today with the description as both the H1 title and the
          // body lead. Filename: "<date> <description>.md", same
          // shape as the calendar quick-create.
          const title = description.trim().slice(0, 120);
          await createNote({
            date: isoDate(),
            allDay: true,
            folder: `[[${ref}]]`,
            title,
          });
        } : undefined}
        isHome={isMain ? n.filename.replace(/\.md$/i, "") === homeFolderRef.current : undefined}
        onSetHome={isMain ? async () => {
          // Toggle the publishing/home key `home: "<user>/<repo>/<path>"`
          // for THIS NF Main Doc. There is at most one home at a time —
          // if another NF currently holds it, we confirm replacement
          // with the user before clearing the old one.
          const thisRef = n.filename.replace(/\.md$/i, "");
          const current = homeFolderRef.current;
          const isThisHome = current === thisRef;
          if (isThisHome) {
            // Already home → tap clears it. No prompt.
            const raw = await vaultFs.readText(toVaultRel(n.path));
            const split = splitFrontmatter(raw);
            const fm = { ...split.frontmatter };
            delete fm.home;
            await writeVault(n.path, joinFrontmatter(fm, split.body));
            await reloadNotes();
            return;
          }
          // Setting home on this folder. If another folder already
          // holds `home:`, confirm the takeover first.
          if (current) {
            const ok = await tauriConfirm(
              `${current} is currently the home folder. Replace it with ${thisRef}?`,
              { title: "Replace home folder?", kind: "warning" },
            );
            if (!ok) return;
          }
          // Prompt for the publish URL/string. Suggest the current
          // value (if any) on this note, else a sensible scaffold.
          const existing = typeof n.frontmatter.home === "string" ? n.frontmatter.home : "";
          const target = window.prompt(
            "Publish target for this home (e.g. user/repo/path):",
            existing || "user/repo/path",
          );
          if (!target || !target.trim()) return;
          // Clear `home:` from the previous holder, if any.
          if (current) {
            const prevPath = (notesRef.current ?? []).find(
              (other) => other.filename.replace(/\.md$/i, "") === current,
            )?.path;
            if (prevPath && prevPath !== n.path) {
              const raw = await vaultFs.readText(toVaultRel(prevPath));
              const split = splitFrontmatter(raw);
              const fm = { ...split.frontmatter };
              delete fm.home;
              await writeVault(prevPath, joinFrontmatter(fm, split.body));
            }
          }
          // Write `home:` on this folder.
          const raw = await vaultFs.readText(toVaultRel(n.path));
          const split = splitFrontmatter(raw);
          const fm = { ...split.frontmatter, home: target.trim() };
          await writeVault(n.path, joinFrontmatter(fm, split.body));
          // Self-writes are filtered by the watcher to dodge our own
          // bounce-backs, so we have to reload manually for the
          // parent state (and downstream Card props like listMode /
          // isHome) to reflect the new YAML. Bump the version and
          // drop the focused-key snapshot too — Card captures
          // frontmatter in state at mount-time, so a prop change
          // alone isn't enough; remount forces a fresh state seed.
          bumpExternal([n.path]);
          delete focusedKeyVersionRef.current[n.path];
          await reloadNotes();
        } : undefined}
        listMode={
          (n.frontmatter.list === "cards" ? "cards"
            : n.frontmatter.list === "lines" ? "lines"
            : "none")
        }
        onCycleList={async () => {
          // Cycle the `list:` YAML through none → cards → lines →
          // none. Body untouched — the renderer reacts on next load.
          const raw = await vaultFs.readText(toVaultRel(n.path));
          const split = splitFrontmatter(raw);
          const fm = { ...split.frontmatter };
          const cur = fm.list === "cards" ? "cards" : fm.list === "lines" ? "lines" : "none";
          if (cur === "none") fm.list = "cards";
          else if (cur === "cards") fm.list = "lines";
          else delete fm.list;
          await writeVault(n.path, joinFrontmatter(fm, split.body));
          // Self-writes are filtered by the watcher, so reload by
          // hand. AND: this is a STRUCTURAL frontmatter change
          // (list mode flips how Card splits prose vs. items), so
          // we need the Card to fully remount with the new
          // frontmatter rather than just receive a new prop —
          // Card captures frontmatter in state at mount-time. Bump
          // the version and drop the focused-key snapshot so the
          // computed key changes on next render.
          bumpExternal([n.path]);
          delete focusedKeyVersionRef.current[n.path];
          await reloadNotes();
        }}
      />
    );
  };

  // Newspaper mode: active whenever ≥1 Notable Folder is filtered IN
  // (this includes the default single home-include view). Each
  // included folder becomes a section — its Main Document as the
  // centerpiece, its notes orbiting below, newest first. An empty or
  // exclude-only filter falls through to the flat temporal pile.
  const MAIN_CAP = 1400;
  const NOTE_CAP = 440;
  const newspaperMode = includeRefs.length >= 1;
  // A single section (the home page, or one folder filtered in) shows
  // its Main Document uncapped so the page reads uninterrupted. With
  // several stacked sections, cap each Main Doc to keep visual weight
  // even.
  const mainCap = includeRefs.length > 1 ? MAIN_CAP : undefined;
  const noteByPath = new Map(notes.map((n) => [n.path, n] as const));
  const sections = newspaperMode
    ? includeRefs.map((ref) => {
        // Prefer an NF Main Doc with that filename; fall back to any
        // note with that filename so plain-note includes (e.g. clicking
        // a book card whose ref is a leaf .md, not an NF) still render
        // as that section's centerpiece instead of an empty section.
        const mainNote =
          filteredNotes.find(
            (n) => isMainDoc(n) && n.filename.replace(/\.md$/, "") === ref,
          )
          ?? filteredNotes.find((n) => n.filename.replace(/\.md$/, "") === ref);
        const sectionNotes = filteredNotes
          .filter((n) => !isMainDoc(n) && effectiveFolder(n) === ref)
          .sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
        // Key is just the stable note id — external body edits are now
        // delivered in-place via the externalBodyVersion prop, so we
        // never need to remount a card just because the file changed.
        // Structural mutations (list-mode flip, home:, rename) still
        // force a remount because reloadNotes() mints a new id for the
        // affected path.
        const keyFor = (n: LoadedNote) => n.id;
        const centerpiece: SectionCell | null = mainNote
          ? { key: keyFor(mainNote), dataPath: mainNote.path, node: cardNode(mainNote, mainCap) }
          : null;
        // File Piles applies to every folder section (single-folder view AND
        // each section of the home/multi-folder newspaper). Surface
        // session-added files at the top, drop closed ones, and give each card
        // its close/add controls. When a folder's pile is untouched, front and
        // hidden are empty and computePileOrder returns the default dated order
        // — so an unpiled folder renders exactly as before.
        const front = pileFront.get(ref) ?? [];
        const hidden = pileHidden.get(ref) ?? new Set<string>();
        const datedPaths = sectionNotes.map((n) => n.path);
        const ordered = computePileOrder(datedPaths, front, hidden, mainNote?.path ?? null);
        const noteCells: SectionCell[] = ordered
          .map((p) => noteByPath.get(p))
          .filter((n): n is LoadedNote => !!n)
          .map((n) => ({
            key: keyFor(n), dataPath: n.path, node: cardNode(n, NOTE_CAP, { folder: ref }),
          }));
        return { ref, centerpiece, noteCells };
      })
    : [];

  // Calendar events carry their folder's color so Week/Month/Year
  // events read at a glance.
  // Calendar / Year feed: apply the include/exclude folder pile, the
  // public-only toggle, AND the Show 3-state (all / notes /
  // notable-folders-only). The dock's left button is now an explicit
  // one-tap cycle, so applying it everywhere matches user
  // expectation — what you toggle is what you see, on every surface.
  // Calendar events are driven ENTIRELY by spacetime.mw. Every event in the
  // mw becomes a chip using the MW's date, time, and folder — note YAML
  // frontmatter never decides what shows or when. A backing note (matched
  // by date+title, or folder+title when the note's date was stripped)
  // supplies the click-through path and lets the pile / public / pileMode
  // filters apply. Events with no backing note use a synthetic `mw-event:`
  // path that openEventNote materializes on demand.
  const noteByDateTitle = new Map<string, LoadedNote>();
  // Title alone → note. A spacetime event's TITLE is its stable, spacetime-
  // derived identity, so this is the primary way an event finds its backing
  // note — independent of the note's date, frontmatter, or disk location, any
  // of which may have drifted from spacetime (drift is reconciled separately,
  // not used as a matching key).
  const noteByTitle = new Map<string, LoadedNote>();
  // Also index by the `YYYY-MM-DD Title` encoded in the FILENAME. Event notes
  // are named that way (basenameForEvent), so even when a note's calendar
  // frontmatter was stripped, its filename still identifies which mw event it
  // backs — this prevents openEventNote from creating a duplicate file.
  const noteByFilenameKey = new Map<string, LoadedNote>();
  for (const n of notes) {
    if (isRawTextFile(n.filename)) continue;
    const t = n.title.toLowerCase();
    if (t && !noteByTitle.has(t)) noteByTitle.set(t, n);
    const d = toIsoDateValue(n.frontmatter.date);
    if (d && !noteByDateTitle.has(`${d}|${t}`)) noteByDateTitle.set(`${d}|${t}`, n);
    const fnMatch = n.filename.match(/^(\d{4}-\d{2}-\d{2})\s+(.+)\.md$/i);
    if (fnMatch) {
      const fk = `${fnMatch[1]}|${fnMatch[2].toLowerCase()}`;
      if (!noteByFilenameKey.has(fk)) noteByFilenameKey.set(fk, n);
    }
  }

  const chipMap = new Map<string, { ev: SpacetimeEvent; notePath: string | null }>();
  const markdownCalendarNotes: NoteMeta[] = (() => {
    const out: NoteMeta[] = [];
    const seen = new Set<string>();
    for (const ev of mwEvents) {
      const t = ev.title.toLowerCase();
      const backing =
        noteByDateTitle.get(`${ev.date}|${t}`) ??   // same date AND title (most specific)
        noteByFilenameKey.get(`${ev.date}|${t}`) ?? // filename encodes date+title
        noteByTitle.get(t);                         // title alone — the spacetime key
      // Remember this note backs this event, keyed by the note's stable id —
      // set BEFORE any filter/dedup `continue` so the link always exists. It
      // survives title edits AND date mismatches (a note written today for a
      // future all-day event), powering the card's date/star chip + the
      // modified-event detection without date|title needing to stay aligned.
      if (backing) noteEventLinkRef.current.set(backing.id, { date: ev.date, title: ev.title });

      // Apply pile / public / pileMode filters. With a backing note we filter
      // on it; without one we filter on the mw folder directly (such events
      // are ordinary, non-NF, non-public notes).
      if (backing) {
        if (!filterMatches(backing)) continue;
        if (publicOnly && backing.frontmatter.public !== true) continue;
        if (pileMode !== "all") {
          const isNF = isMainDoc(backing);
          if (pileMode === "notes" ? isNF : !isNF) continue;
        }
      } else {
        if (includeRefs.length > 0 && !(ev.folder && includeRefs.includes(ev.folder))) continue;
        if (ev.folder && excludeRefs.includes(ev.folder)) continue;
        if (publicOnly) continue;
        if (pileMode === "folders") continue;
      }

      // Dedup by (date, time, title) so a duplicated mw line can't stack
      // into a tower of identical chips.
      const k = eventKey({ date: ev.date, startTime: ev.time, title: ev.title });
      if (seen.has(k)) continue;
      seen.add(k);

      const fm: Frontmatter = {
        date: ev.date,
        // An event with no start time is all-day — including multi-day date
        // ranges (date / endDate). Gating on !endDate here left those with
        // allDay:false and no startTime, so CalendarView skipped them.
        allDay: ev.allDay ?? !ev.time,
        ...(ev.time    ? { startTime: ev.time }    : {}),
        ...(ev.endTime ? { endTime: ev.endTime }    : {}),
        ...(ev.endDate ? { endDate: ev.endDate }    : {}),
        ...(ev.folder  ? { folder: `[[${ev.folder}]]` } : {}),
        title: ev.title,
      };
      const path = backing ? backing.path : `mw-event:${ev.date}|${t}`;
      chipMap.set(path, { ev, notePath: backing ? backing.path : null });
      out.push({
        path,
        filename: backing ? backing.filename : `${ev.date} ${ev.title}.md`,
        title: ev.title,
        frontmatter: fm,
        color: ev.folder ? folderColor(ev.folder) : undefined,
      });
    }
    return out;
  })();
  eventChipRef.current = chipMap;

  // Todo.txt is a parallel calendar source. Each dated `due:` line
  // becomes a virtual NoteMeta with a synthetic
  // `<vault-rel>.txt#L<index>` path so updates / deletes can be
  // dispatched back to the right line. Unmatched `+project` tokens
  // produce uncolored events that still render.
  const nfNamesForTodo = notableFolders.map((f) => f.name);
  // todo.txt lines carry no `public:` flag, so they are private by
  // definition — under the public-only lens the whole source drops
  // out, matching how publish (which only ships `public: true` notes)
  // never includes them either.
  const todoTxtNote = todoSettings.enabled && !publicOnly
    ? notes.find((n) => toVaultRel(n.path) === todoSettings.path)
    : undefined;
  // Identity keys for every .md calendar event in the vault — used to
  // skip todo.txt mirror lines (which look identical on disk to the
  // lines we generated for those .md events). Built from the full
  // notes list, not the filter-passed list, so toggling Pile filters
  // can't make a mirror line resurface as a duplicate chip.
  const mdEventKeys = new Set<string>();
  for (const n of notes) {
    const fm = n.frontmatter;
    // toIsoDateValue handles both `date: "2026-06-12"` (string the
    // calendar writes) and `date: 2026-06-12` (Date instance js-yaml
    // hands us for the unquoted form). Without the Date branch,
    // hand-written events miss the dedup set and their matching
    // todo.txt lines render as duplicate chips.
    const date = toIsoDateValue(fm.date);
    if (!date) continue;
    const allDay = fm.allDay === true;
    const startTime = typeof fm.startTime === "string" ? fm.startTime : undefined;
    if (!allDay && !startTime) continue;
    mdEventKeys.add(eventKey({
      date,
      startTime,
      title: n.title,
    }));
  }

  const todoCalendarNotes: NoteMeta[] = todoTxtNote
    ? parseTodoTxt(todoTxtNote.body)
        .filter((i) => !!i.due)
        // Skip todo.txt lines that mirror an .md event — the .md
        // already renders for them.
        .filter((i) => !mdEventKeys.has(eventKey({
          date: i.due,
          startTime: i.startTime,
          title: i.text,
        })))
        .map((i) => {
          const nf = i.project ? resolveProjectToNf(i.project, nfNamesForTodo) : null;
          const fm: Frontmatter = {
            date: i.due,
            allDay: i.allDay,
            ...(i.startTime ? { startTime: i.startTime } : {}),
            ...(i.endTime
              ? { endTime: i.endTime }
              : i.startTime ? { endTime: addMinutesToIsoTime(i.startTime, DEFAULT_EVENT_MINUTES) } : {}),
            ...(i.endDate ? { endDate: i.endDate } : {}),
            ...(nf ? { folder: `[[${nf}]]` } : {}),
            ...(i.completed ? { completed: true } : {}),
          };
          // Strip every `+project` / `@context` token from the visible
          // title; they're todo.txt metadata, not part of the
          // description.
          const cleanTitle = i.text
            .replace(/(?:^|\s)[+@]\S+/g, "")
            .replace(/\s+/g, " ")
            .trim();
          return {
            path: makeTodoTxtPath(todoTxtNote.path, i.index),
            filename: todoTxtNote.filename,
            title: cleanTitle || "Untitled",
            frontmatter: fm,
            color: nf ? folderColor(nf) : undefined,
          };
        })
    : [];

  // markdownCalendarNotes already holds every mw event (mw is the source of
  // truth); todo.txt is a parallel calendar source merged in alongside it.
  const calendarNotes: NoteMeta[] = [...markdownCalendarNotes, ...todoCalendarNotes];

  /** The new-note flow — extracted so the dock button can call it.
   *
   *  Pile: same semantics as Cmd+N — the note lands in the
   *  top-of-pile Notable Folder (createNote resolves pile top → home)
   *  and the existing filter pile is left alone.
   *
   *  Calendar views: jump home — create in the home NF, pin the
   *  filter to it, land in its pile with the cursor in the new
   *  card. A calendar has no pile context, so home is the one
   *  predictable destination. */
  const handleNewNote = () => {
    if (pileMode === "folders") {
      setPileMode(() => { writePileMode("all"); return "all"; });
    }
    const patch: Frontmatter = { date: isoDate(), startTime: isoTime(), allDay: false };
    if (view === "pile") {
      void createNote(patch);
      return;
    }
    const home = homeFolderRef.current;
    setView("pile");
    if (home) {
      setFilters([{ kind: "include", ref: home }]);
      setFocusedFolder(home);
    } else {
      setFilters([]);
    }
    void createNote({ ...patch, ...(home ? { folder: `[[${home}]]` } : {}) });
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
        {(() => {
          // Calendar button: tap goes to the Week view. Highlights only
          // when you're actually on the unfiltered Week calendar — at home
          // (or anywhere else) it reads as unhighlighted, so the home and
          // calendar buttons never both light up at once.
          const noFilters = filters.length === 0;
          const isAtCalendar = noFilters && view === "week";
          const active = isAtCalendar;
          return (
            <button
              type="button"
              className={"dock-btn dock-btn-cal" + (active ? " is-active" : "")}
              onClick={() => resetToDefault()}
              title="Week view"
              aria-label="Week view"
              aria-pressed={active}
            >
              <CalendarRange size={22} strokeWidth={2.1} />
            </button>
          );
        })()}
        {(() => {
          // Pure "go home" button — always jumps to the home pile (the
          // home Notable Folder's section). Highlights when you're
          // already there. (Calendar/Week now has its own dock button.)
          const home = homeFolderRef.current;
          const homeFiltered = !!home && includeSet.size === 1 && includeSet.has(home);
          const isAtHome = homeFiltered && view === "pile";
          const tip = home ? `Home — ${home}` : "Home";
          return (
            <button
              type="button"
              className={"dock-btn dock-btn-home" + (isAtHome ? " is-at-home" : "")}
              onClick={goHome}
              title={tip}
              aria-label={tip}
            >
              <HomeIcon size={20} strokeWidth={2.1} />
            </button>
          );
        })()}
        {(() => {
          // "Pile" button: jump back to the last remembered pile
          // (its filters / focus). Highlights when you're currently on
          // it. Falls back to Home when there's no remembered pile (or it
          // was the global unfiltered pile).
          const last = pileRef.current;
          const onPile =
            view === "pile" &&
            !!last && last.filters.length > 0 &&
            JSON.stringify(filters) === JSON.stringify(last.filters);
          return (
            <button
              type="button"
              className={"dock-btn dock-btn-pile" + (onPile ? " is-active" : "")}
              onClick={goToPile}
              title="Pile"
              aria-label="Pile"
              aria-pressed={onPile}
            >
              <Layers size={20} strokeWidth={2.1} />
            </button>
          );
        })()}
        <button
          type="button"
          className="dock-btn dock-btn-search"
          onClick={() => setPaletteOpen(true)}
          title="Open Notable Folder (Cmd+K)"
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
          className={"dock-btn dock-btn-sidebar" + (filters.some((f) => f.kind === "include") && !sidebarOpen ? " is-exploring" : "")}
          onClick={toggleSidebar}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarOpen ? <ChevronsRight size={20} strokeWidth={2.1} /> : <PanelRight size={20} strokeWidth={2.1} />}
        </button>
      </div>

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
              const Icon = { auto: SunMoon, light: Sun, dark: Moon, black: MoonStar, wordperfect: Monitor, terminal: TerminalIcon, typewriter: TypeIcon, america: Flag, christmas: TreePine, lcars: Rocket }[theme];
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
                  const create = view !== "pile" ? promptCreate : createNote;
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
        {view === "pile" && (
          newspaperMode ? (
            <div className="nf-sections">
              {sections.map((s) => (
                <NotebookSection
                  key={s.ref}
                  sectionRef={s.ref}
                  centerpiece={s.centerpiece}
                  notes={s.noteCells}
                  collapseSignal={collapseNonce}
                  scrollTarget={scrollTargetPath ?? focusPath ?? focusedPath}
                />
              ))}
            </div>
          ) : (
            <>
              <div className="card-grid" ref={setGridEl}>
                {sortedNotes.map((n) => {
                  // Per-Card external-change version is folded into the key:
                  // a true external edit (not one of our own writes) bumps
                  // Body changes are delivered in-place via externalBodyVersion
                  // prop; key stays stable so Card never remounts on an edit.
                  return (
                    <LazyCell
                      key={n.id}
                      className="card-grid-cell"
                      dataPath={n.path}
                      forceMount={n.path === focusedPath}
                    >
                      {() => cardNode(n)}
                    </LazyCell>
                  );
                })}
              </div>
              {hasMore && (
                <div className="pile-show-more-wrap">
                  <button
                    type="button"
                    className="pile-show-more"
                    onClick={() => setPileLimit((cur) => (cur ?? 0) + PILE_PAGE_SIZE)}
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
            currentView="day"
            onSelectView={setView}
            onImportDay={(iso) => { void startImport(iso); }}
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
            currentView="week"
            onSelectView={setView}
            onImportDay={(iso) => { void startImport(iso); }}
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
            currentView="month"
            onSelectView={setView}
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
            currentView="year"
            onSelectView={setView}
          />
        )}
        {view === "season" && (
          <SeasonView
            ref={seasonHandleRef}
            key="season"
            seasons={seasons}
            seasonsPath={seasonsPath}
            areas={vaultTaxonomy.areas.map((a) => ({
              ref: a.ref,
              nfRefs: a.categories.flatMap((c) => c.folders),
            }))}
            notes={calendarNotes}
            onOpenRef={focusFolder}
            onOpenPath={navigateAndFocus}
            currentView="season"
            onSelectView={setView}
          />
        )}
      </main>

      {sidebarOpen && (
        <Sidebar
          view={view}
          onSelectView={setView}
          folders={mwFolders}
          // Sidebar folder click is a real toggle now: filtered → unfilter
          // (drop the include pill); not filtered → switch to the Pile,
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
          onRenameFolder={handleRenameNotableFolder}
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
            <>
              <FilterPillStack
                filters={filters}
                onRemove={removeFilter}
                onReorder={setFilters}
                onClear={resetToDefault}
                stickyRef={view === "pile" ? (homeFolderRef.current ?? undefined) : undefined}
                onJump={(ref) => {
                  setFocusedFolder(ref);
                  const path = notePathByRef(ref);
                  if (path) navigateAndFocus(path);
                  else setView("pile");
                }}
              />
              {view !== "pile" && filters.length === 0 && pileRef.current && pileRef.current.filters.length > 0 && (
                <button
                  type="button"
                  className="sb-apply-pile"
                  onClick={() => setFilters(pileRef.current!.filters)}
                  title="Filter this calendar by your pile"
                >
                  <Layers size={13} strokeWidth={2} /> Filter by the pile
                </button>
              )}
            </>
          )}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={mwFolders}
          selected={includeSet}
          onToggle={focusFolder}
          onClose={() => setPaletteOpen(false)}
          recents={recentFolders}
          extras={[
            ...(todoSettings.enabled ? [{
              label: todoSettings.path || DEFAULT_TODO_TXT_PATH,
              keywords: "todo todo.txt todotxt",
              hint: "todo.txt",
              onPick: () => { void openTodoTxt(); },
            }] : []),
            {
              label: "spacetime",
              keywords: "spacetime mw markwhen space time",
              hint: "spacetime · Markwhen",
              onPick: () => { void openSpacetimeMw(); setPaletteOpen(false); },
            },
          ]}
        />
      )}

      <FtsOverlay
        open={ftsOpen}
        onClose={() => setFtsOpen(false)}
        titleForPath={(p) => {
          const n = notes?.find((x) => x.path === p);
          return n?.title || (p.split("/").pop() ?? p).replace(/\.md$/i, "");
        }}
        onPick={(path) => { navigateAndFocus(path); }}
      />

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
          onOpenTodoTxt={async () => { await openTodoTxt(); setSettingsOpen(false); }}
        />
      )}

      {syncReview && (() => {
        const s = summarizePlan(syncReview.plan);
        const deletes = syncReview.plan.events.filter((o): o is Extract<typeof o, { kind: "delete" }> => o.kind === "delete");
        const folderRemoves = syncReview.plan.space.filter((o): o is Extract<typeof o, { kind: "removeFolder" }> => o.kind === "removeFolder");
        const dangerCount = s.deletes + s.foldersRemoved;
        return (
          <div className="settings-overlay" role="dialog" aria-label="Apply spacetime.yml" onMouseDown={() => !syncBusy && setSyncReview(null)}>
            <div className="settings-panel sync-review" onMouseDown={(e) => e.stopPropagation()}>
              <div className="settings-head">
                <h2 className="settings-title">Apply spacetime.yml</h2>
                <button type="button" className="settings-close" onClick={() => setSyncReview(null)} disabled={syncBusy} aria-label="Close">✕</button>
              </div>
              {s.empty ? (
                <p className="sync-empty">spacetime.yml already matches the vault. Nothing to apply.</p>
              ) : (
                <>
                  <ul className="sync-summary">
                    {s.creates > 0 && <li>{s.creates} note{s.creates > 1 ? "s" : ""} created</li>}
                    {s.updates > 0 && <li>{s.updates} note{s.updates > 1 ? "s" : ""} updated</li>}
                    {s.deletes > 0 && <li className="is-delete">{s.deletes} note{s.deletes > 1 ? "s" : ""} deleted</li>}
                    {s.seasons && <li>Seasons updated</li>}
                    {s.foldersAdded > 0 && <li>{s.foldersAdded} folder{s.foldersAdded > 1 ? "s" : ""} created</li>}
                    {s.reorders > 0 && <li>{s.reorders} folder reorder{s.reorders > 1 ? "s" : ""}</li>}
                    {s.foldersRemoved > 0 && <li className="is-delete">{s.foldersRemoved} folder{s.foldersRemoved > 1 ? "s" : ""} removed (with their notes)</li>}
                  </ul>
                  {(deletes.length > 0 || folderRemoves.length > 0) && (
                    <div className="sync-deletes">
                      <strong>These will be permanently deleted:</strong>
                      <ul>
                        {folderRemoves.map((o) => (
                          <li key={`f-${o.path.join("/")}`}>📁 {o.path.join(" / ")} (folder + all notes)</li>
                        ))}
                        {deletes.map((o) => (
                          <li key={`${o.event.date}-${o.event.title}`}>{o.event.date} · {o.event.title}{o.event.folder ? ` (${o.event.folder})` : ""}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="settings-actions">
                    <button type="button" className="settings-btn" onClick={() => setSyncReview(null)} disabled={syncBusy}>Cancel</button>
                    <button type="button" className={"settings-btn" + (dangerCount > 0 ? " is-danger" : "")} onClick={() => { void applySpacetimeSync(); }} disabled={syncBusy}>
                      {syncBusy ? "Applying…" : dangerCount > 0 ? `Apply (deletes ${dangerCount})` : "Apply"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* spacetime.mw review: gated structural sync + on-disk drift flags. */}
      {mwReviewOpen && (mwReview || orphanedFolders.length > 0 || orphanedEvents.length > 0 || modifiedEvents.length > 0 || gcalPendingCount > 0) && (() => {
        // Removals aren't applied (apply is non-destructive) — a dropped folder
        // becomes an orphan, shown in the section below. So the apply list shows
        // only renames / adds / reorders / seasons.
        const items = (mwReview?.items ?? []).filter((i) => i.kind !== "remove");
        const dangerCount = items.filter((i) => i.destructive).length;
        return (
          <div className="settings-overlay" role="dialog" aria-label="Review spacetime changes" onMouseDown={() => !mwApplying && setMwReviewOpen(false)}>
            <div className="settings-panel mw-review-panel" onMouseDown={(e) => e.stopPropagation()}>
              <div className="settings-head">
                <h2 className="settings-title">spacetime changed</h2>
                <button type="button" className="settings-close" onClick={() => setMwReviewOpen(false)} disabled={mwApplying} aria-label="Close">✕</button>
              </div>

              <div className="mw-review-body">
                {mwReview && (
                  <section className="mw-review-section">
                    <p className="mw-review-lead">{items.length} change{items.length === 1 ? "" : "s"} to apply to your vault.</p>
                    <ul className="mw-change-list">
                      {items.map((it, idx) => (
                        <li key={idx} className={"mw-change" + (it.destructive ? " is-delete" : "")}>
                          <span className={"mw-change-kind kind-" + it.kind}>{it.kind}</span>
                          <span className="mw-change-text">{it.text}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

              {orphanedFolders.length > 0 && (
                <div className="sync-deletes">
                  <strong>On disk but not in spacetime:</strong>
                  <p className="mw-orphan-hint">Set where each belongs, then add it to spacetime — placement comes from the folder's location, never frontmatter.</p>
                  <datalist id="mw-area-options">
                    {vaultTaxonomy.areas.map((a) => <option key={a.ref} value={a.ref} />)}
                  </datalist>
                  <datalist id="mw-cat-options">
                    {vaultTaxonomy.areas.flatMap((a) => a.categories.map((c) => <option key={`${a.ref}/${c.ref}`} value={c.ref} />))}
                  </datalist>
                  <ul>
                    {orphanedFolders.map((o) => {
                      const edit = orphanEdits[o.path] ?? { area: o.area, category: o.category };
                      const setEdit = (patch: Partial<{ area: string; category: string }>) =>
                        setOrphanEdits((prev) => ({ ...prev, [o.path]: { ...edit, ...patch } }));
                      return (
                        <li key={o.path} className="mw-orphan-row">
                          <span className="mw-orphan-name">📁 {o.name}{o.fileCount > 0 ? ` (${o.fileCount} file${o.fileCount === 1 ? "" : "s"})` : ""}</span>
                          <span className="mw-orphan-fields">
                            <input className="mw-orphan-input" list="mw-area-options" placeholder="Area" value={edit.area} disabled={mwApplying} onChange={(e) => setEdit({ area: e.target.value })} />
                            <span className="mw-orphan-sep">›</span>
                            <input className="mw-orphan-input" list="mw-cat-options" placeholder="Category" value={edit.category} disabled={mwApplying} onChange={(e) => setEdit({ category: e.target.value })} />
                          </span>
                          <span className="mw-orphan-actions">
                            <button type="button" className="mw-orphan-btn" disabled={mwApplying} onClick={() => { void reconcileOrphan(o.path, edit.area, edit.category); }}>Add to spacetime</button>
                            <button type="button" className="mw-orphan-btn is-danger" disabled={mwApplying} onClick={() => { void removeOrphanFolder(o.path, o.name); }}>Remove from disk</button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {orphanedEvents.length > 0 && (
                <div className="sync-deletes">
                  <strong>Events on disk but not in spacetime:</strong>
                  <p className="mw-orphan-hint">These notes carry calendar-event frontmatter but aren't in spacetime.mw, so Order hides them. "Add to spacetime" registers the event (its date, time, and folder are inferred from the note); "Remove" deletes the stray note.</p>
                  <ul>
                    {orphanedEvents.map((o) => (
                      <li key={o.path} className="mw-orphan-row">
                        <span className="mw-orphan-name">🗓 {o.date} {o.title}</span>
                        <span className="mw-orphan-actions">
                          <button type="button" className="mw-orphan-btn" disabled={mwApplying} onClick={() => { void addOrphanEventsToSpacetime([o.path]); }}>Add to spacetime</button>
                          <button type="button" className="mw-orphan-btn is-danger" disabled={mwApplying} onClick={() => { void removeOrphanEvents([o.path], o.title); }}>Remove</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="mw-orphan-actions">
                    <button type="button" className="mw-orphan-btn" disabled={mwApplying} onClick={() => { void addOrphanEventsToSpacetime(orphanedEvents.map((o) => o.path)); }}>Add all {orphanedEvents.length} to spacetime</button>
                    <button type="button" className="mw-orphan-btn is-danger" disabled={mwApplying} onClick={() => { void removeOrphanEvents(orphanedEvents.map((o) => o.path), `${orphanedEvents.length} notes`); }}>Remove all {orphanedEvents.length}</button>
                  </span>
                </div>
              )}
              {modifiedEvents.length > 0 && (
                <div className="sync-deletes">
                  <strong>Events edited (note retitled):</strong>
                  <p className="mw-orphan-hint">These notes back a real spacetime event but were renamed, so the note and the spacetime line no longer match. "Update spacetime" rewrites the event's title to match the note.</p>
                  <ul>
                    {modifiedEvents.map((m) => (
                      <li key={m.noteId} className="mw-orphan-row">
                        <span className="mw-orphan-name">✎ {m.date} <s>{m.oldTitle}</s> → {m.newTitle}</span>
                        <span className="mw-orphan-actions">
                          <button type="button" className="mw-orphan-btn" disabled={mwApplying} onClick={() => { void applyModifiedEvents([m.noteId]); }}>Update spacetime</button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="mw-orphan-actions">
                    <button type="button" className="mw-orphan-btn" disabled={mwApplying} onClick={() => { void applyModifiedEvents(modifiedEvents.map((m) => m.noteId)); }}>Update all {modifiedEvents.length}</button>
                  </span>
                </div>
              )}
              {(gcalPlan.pushes.length > 0 || gcalPlan.deletes.length > 0) && (
                <div className="sync-deletes">
                  <strong>Sync to Google Calendar:</strong>
                  <p className="mw-orphan-hint">Curated events that changed. "Sync" creates/updates them on the host calendar (with invites) and deletes events you removed or un-shared.</p>
                  <ul>
                    {gcalPlan.pushes.map((it) => (
                      <li key={`p:${gcalSig(it)}`} className="mw-orphan-row">
                        <span className="mw-orphan-name">
                          ↗ {it.date}{it.time ? ` ${it.time}` : ""} {it.title}
                          <span className="mw-orphan-sep"> · {it.host}</span>
                          {it.attendees.length > 0 ? <span className="mw-orphan-sep"> · invite {it.attendees.join(", ")}</span> : null}
                        </span>
                      </li>
                    ))}
                    {gcalPlan.deletes.map((d) => (
                      <li key={`d:${naturalKey(d.date, d.time, d.title)}`} className="mw-orphan-row">
                        <span className="mw-orphan-name">
                          ✕ Delete: {d.date}{d.time ? ` ${d.time}` : ""} {d.title}
                          <span className="mw-orphan-sep"> · {d.host}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <span className="mw-orphan-actions">
                    <button type="button" className="mw-orphan-btn" disabled={gcalSyncing} onClick={() => { void applyGcalSync(); }}>{gcalSyncing ? "Syncing…" : `Sync ${gcalPlan.pushes.length + gcalPlan.deletes.length} to Google`}</button>
                  </span>
                </div>
              )}
              </div>

              <div className="settings-actions">
                {mwReview ? (
                  <>
                    <button type="button" className="settings-btn" onClick={declineMwSync} disabled={mwApplying}>Keep editing</button>
                    <button type="button" className={"settings-btn" + (dangerCount > 0 ? " is-danger" : "")} onClick={() => { if (mwReview) void applyMwSync(mwReview.mwBody); }} disabled={mwApplying}>
                      {mwApplying ? "Applying…" : dangerCount > 0 ? `Apply (deletes ${dangerCount})` : "Apply"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="settings-btn" onClick={() => setMwReviewOpen(false)} disabled={mwApplying}>Close</button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {importReview && (
        <div className="settings-overlay" onMouseDown={() => { if (!importBusy) setImportReview(null); }}>
          <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
            <h2 className="settings-title">Import {importReview.date} from Google</h2>
            <p className="mw-orphan-hint">From {importReview.account}. New events are pre-checked; events you already have are unchecked. Accepted events are added to spacetime in the chosen folder.</p>
            <div className="settings-row">
              <span className="settings-label">Folder</span>
              <input className="settings-input" list="mw-folder-options" placeholder="home"
                value={importReview.folder}
                onChange={(e) => setImportReview((r) => r ? { ...r, folder: e.target.value } : r)} />
            </div>
            <ul className="gcal-account-list">
              {importReview.rows.map((r, i) => (
                <li key={`${r.date}|${r.time ?? ""}|${r.title}`} className="gcal-account-row">
                  <label className="settings-toggle">
                    <input type="checkbox" checked={r.accept}
                      onChange={(e) => setImportReview((rv) => rv ? { ...rv, rows: rv.rows.map((x, j) => j === i ? { ...x, accept: e.target.checked } : x) } : rv)} />
                    <span>{r.date}{r.time ? ` ${r.time}` : ""} {r.title || "(untitled)"}{r.isNew ? "" : " · already have"}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="settings-actions">
              <button type="button" className="settings-btn" disabled={importBusy} onClick={() => setImportReview(null)}>Cancel</button>
              <button type="button" className="settings-btn" disabled={importBusy} onClick={() => { void applyImport(); }}>
                {importBusy ? "Importing…" : `Import ${importReview.rows.filter((r) => r.accept).length}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Subtle reminder when there are unsynced spacetime.mw changes or drift. */}
      {!mwReviewOpen && (mwReview || orphanedFolders.length > 0 || orphanedEvents.length > 0 || modifiedEvents.length > 0 || gcalPendingCount > 0) && (() => {
        const n = (mwReview?.items.length ?? 0) + orphanedFolders.length + orphanedEvents.length + modifiedEvents.length + gcalPendingCount;
        return (
          <button
            type="button"
            className="mw-pending-indicator"
            onClick={() => setMwReviewOpen(true)}
            title="spacetime has unsynced changes — click to review"
          >
            <span className="mw-pending-dot" />
            spacetime · {n} pending
          </button>
        );
      })()}

      {capWarning && (
        <div className={"cap-warning" + (capWarning.kind === "ok" ? " is-ok" : "")} role="status">{capWarning.text}</div>
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

      {createMdPrompt && (
        <div
          className="event-prompt-overlay"
          role="dialog"
          aria-label="Create note for this event"
          onMouseDown={() => setCreateMdPrompt(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); setCreateMdPrompt(null); }
            if (e.key === "Enter") { e.preventDefault(); void confirmCreateMd(); }
          }}
          tabIndex={-1}
          ref={(el) => { el?.focus(); }}
        >
          <div
            className="event-prompt create-md-prompt"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="create-md-prompt-text">
              Create a note for <strong>{createMdPrompt.title}</strong>?
            </div>
            <div className="create-md-prompt-actions">
              <button
                type="button"
                className="create-md-prompt-btn create-md-prompt-cancel"
                onClick={() => setCreateMdPrompt(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="create-md-prompt-btn create-md-prompt-confirm"
                onClick={() => { void confirmCreateMd(); }}
                autoFocus
              >
                Create &amp; open
              </button>
            </div>
          </div>
        </div>
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
          // Pile's notes.
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
          onRename={async (newTitle) => {
            await renameEventTitle(eventMenu.path, newTitle);
          }}
          emails={eventMenu.emails}
          knownEmails={knownEmails}
          onSetEmails={(emails) => { void handleSetEmails(eventMenu.path, emails); }}
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
    { keys: `${cmd} P`, label: "Pile view (top of pile)" },
    { keys: `${cmd} D / W / M / Y / S`, label: "Day / Week / Month / Year / Season view" },
    { keys: `${cmd} ⌃ ←  /  →`, label: "Back / forward by the view's unit" },
    { keys: `${cmd} O  ·  ${cmd} K`, label: "Folder palette (folders + todo.txt)" },
    { keys: `${cmd} F  ·  /`, label: "Full-text search" },
    { keys: `${cmd} R`, label: "Home ⇄ clear-filters toggle" },
    { keys: `${cmd} 4`, label: "Terminal in the focused folder ($ on 4)" },
    { keys: `${cmd} ;`, label: "Toggle sidebar" },
    { keys: `${cmd} ⇧ P`, label: "Publish panel" },
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
 *  to Pile and scrolls to the note; Delete removes the file. Backdrop
 *  click or Esc dismisses. */
function EventActionMenu({
  title, x, y, eventDate, currentFolder, availableFolders,
  onOpen, onDelete, onMoveToDay, onAssignFolder, onRename, onCancel,
  emails, knownEmails, onSetEmails,
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
  /** Save a new title for the event. Fires on blur or Enter when the
   *  text has actually changed. */
  onRename: (newTitle: string) => Promise<void> | void;
  onCancel: () => void;
  /** Current recipient emails on the event (Google sync). */
  emails?: string[];
  /** Autocomplete suggestions — distinct emails already in spacetime.mw. */
  knownEmails?: string[];
  /** Commit a new full recipient list; writes to spacetime.mw. When omitted,
   *  the Recipients section is not shown. */
  onSetEmails?: (emails: string[]) => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  // Reset the draft when the popup opens for a different event.
  useEffect(() => { setDraftTitle(title); }, [title]);
  const commit = () => {
    const next = draftTitle.trim();
    if (next && next !== title) void onRename(next);
  };
  const [folderQuery, setFolderQuery] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [recipDraft, setRecipDraft] = useState("");
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
  const recipH = onSetEmails ? 40 + (emails?.length ?? 0) * 26 : 0;
  const menuH = (weekDays.length > 0 ? 170 : 120) + (availableFolders.length > 0 ? (folderOpen ? 220 : 56) : 0) + recipH;
  const menuW = (weekDays.length > 0 || availableFolders.length > 0 || onSetEmails) ? 280 : 200;
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
        <input
          type="text"
          className="event-action-menu-title"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { e.preventDefault(); setDraftTitle(title); onCancel(); }
          }}
        />
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
        {onSetEmails && (
          <div className="event-action-recipients">
            {(emails ?? []).length > 0 && (
              <ul className="event-action-recip-list">
                {(emails ?? []).map((m) => (
                  <li key={m} className="event-action-recip-chip">
                    <span className="event-action-recip-addr">{m}</span>
                    <button
                      type="button"
                      className="event-action-recip-x"
                      aria-label={`Remove ${m}`}
                      onClick={() => onSetEmails((emails ?? []).filter((x) => x !== m))}
                    >×</button>
                  </li>
                ))}
              </ul>
            )}
            <input
              className="event-action-recip-input"
              list="event-action-recip-options"
              placeholder="Add recipient email…"
              value={recipDraft}
              onChange={(e) => setRecipDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = recipDraft.trim().toLowerCase();
                  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && !(emails ?? []).includes(v)) {
                    onSetEmails([...(emails ?? []), v]);
                    setRecipDraft("");
                  }
                }
                if (e.key === "Escape") { e.preventDefault(); onCancel(); }
              }}
            />
            <datalist id="event-action-recip-options">
              {(knownEmails ?? []).map((m) => <option key={m} value={m} />)}
            </datalist>
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
  // Focus AFTER the first paint so the overlay's dvh-based sizing
  // has a chance to land its real height before iOS opens the soft
  // keyboard. Without the rAF gap the focus + keyboard show can
  // race the layout and the prompt briefly renders against the
  // pre-keyboard viewport — the "popup off-screen until it
  // recenters" jitter the user reported.
  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
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

