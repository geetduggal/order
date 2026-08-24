// One Card. Reads its file, strips frontmatter, hands the body to Milkdown
// Crepe, recombines on save. After each save, if the body's explicit h1
// has changed, the file gets renamed to `<date> <title>.md` (Obsidian
// Full Calendar convention) and the parent is notified so calendar
// views stay in sync.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dirname, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { vaultRoot, toVaultRel } from "../lib/vault";
import { vaultFs, markKnownBody } from "../lib/vault-fs";
import { MilkdownSurface, type MilkdownHandle } from "./MilkdownSurface";
import { RawTextSurface } from "./RawTextSurface";
import { CodeMirrorSurface } from "./CodeMirrorSurface";
import {
  parseView, sheetSidecarPath, drawingSidecarPath, serializeSheet, emptySheet,
  type NoteView,
} from "../lib/note-view";
// Heavy editors (react-spreadsheet, Excalidraw) — code-split so the normal
// note path never loads them.
const SheetSurface = lazy(() => import("./SheetSurface").then((m) => ({ default: m.SheetSurface })));
const DrawingSurface = lazy(() => import("./DrawingSurface").then((m) => ({ default: m.DrawingSurface })));
import { FrontmatterInspector } from "./FrontmatterInspector";
import {
  deriveNoteTitleFromBody,
  joinFrontmatter,
  splitFrontmatter,
  toIsoDateValue,
  type Frontmatter,
} from "../lib/frontmatter";
import {
  isListFolder,
  listRender,
  serializeListItems,
  splitBodyAndBullets,
  tightenListSpacing,
  type ListItem,
  type ListNoteRef,
} from "../lib/list-folder";
import { extractBaseBlock, extractRawBaseBlock, parseBase, type ParsedBase } from "../lib/list-base";
import { smartMerge } from "../lib/list-merge";
import { ListView } from "./ListView";
import { folderColor, isMainDocPath, isPinnedName, parseRef, stripSortPrefix } from "../lib/folders";
import { isSpacetimeFile } from "../lib/spacetime";
import { parseEventFilename, formatEventFilename } from "../lib/event-filename";
import { resolveWikilink } from "../lib/wikilink";
import {
  attachmentAssetPrefix,
  attachmentName,
  assetUrl,
  deflateImageEmbeds,
  inflateAttachmentUrls,
  inflateImageEmbeds,
  isImagePath,
  vaultDir,
} from "../lib/attachments";
import {
  inflateEmbedFencesToImage,
  restoreEmbedFences,
  type EmbedFenceRestore,
} from "../lib/youtube";
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Folder as FolderIcon, FolderInput as FolderInputIcon, Link2, Trash2, X as XIcon, FolderOpen as FolderOpenIcon, Home as HomeIcon, List as ListIcon, LayoutGrid as LayoutGridIcon, AlignJustify as AlignJustifyIcon, ArrowUpRight, Copy as CopyIcon, Maximize2 as Maximize2Icon, Minimize2 as Minimize2Icon, EyeOff as EyeOffIcon, Terminal as TerminalIcon, Star as StarIcon, CalendarDays as CalendarIcon, Table as TableIcon, PenTool as PenToolIcon, MoreHorizontal as MoreHorizontalIcon, Code2 as CodeIcon, MapPin as MapPinIcon, DollarSign as DollarSignIcon, Pin as PinIcon, Bell as BellIcon } from "lucide-react";
import { openExternalUrl } from "../lib/open-external";
import { NotableFolderBackside } from "./NotableFolderBackside";
import { OrderTerminal } from "./OrderTerminal";
import { isIosSync } from "../lib/vault";
import * as reminders from "../lib/apple-reminder";
import { useTextScale } from "../lib/text-scale";
import { CardSpeech } from "./CardSpeech";
import { ChatSurface } from "./ChatSurface";
import { CsvSurface } from "./CsvSurface";
import { FinanceReportModal } from "./FinanceReportModal";
import { consumeFullscreenIntent, onFullscreenRequest } from "../lib/fullscreen-intent";

const SAVE_DEBOUNCE_MS = 600;

/** Rename a file to `<dir>/<basename>`, appending ` 2`, ` 3`, … to the
 *  stem if the desired name is already taken. Returns the resolved path.
 *  If the file is already correctly named, returns unchanged. */
async function uniqueRename(dir: string, oldPath: string, basename: string): Promise<string> {
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const ext = dot > 0 ? basename.slice(dot) : "";
  let candidate = basename;
  let n = 2;
  for (let i = 0; i < 999; i++) {
    const newPath = await join(dir, candidate);
    if (newPath === oldPath) return oldPath;
    try {
      await vaultFs.rename(toVaultRel(oldPath), toVaultRel(newPath));
      return newPath;
    } catch {
      candidate = `${stem} ${n}${ext}`;
      n++;
    }
  }
  throw new Error(`No unique name found for ${basename}`);
}

/** A date-prefixed image shown as its own card in a folder's pile: the image
 *  itself plus an inline, editable filename (Enter or blur to rename). */
function ImageCard({ path, onRenamed, onExpand }: { path: string; onRenamed?: (p: string) => void; onExpand?: () => void }) {
  const rel = toVaultRel(path);
  const filename = path.split("/").pop() ?? path;
  const [name, setName] = useState(filename);
  useEffect(() => { setName(filename); }, [filename]);
  const commit = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === filename) { setName(filename); return; }
    const ext = filename.slice(filename.lastIndexOf("."));
    const finalName = /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : trimmed + ext;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
    try {
      await vaultFs.rename(rel, dir + finalName);
      onRenamed?.(path.slice(0, path.length - filename.length) + finalName);
    } catch (e) { console.error("image rename failed", e); setName(filename); }
  };
  return (
    <div className="order-card-image">
      <img className="order-card-image-img" src={assetUrl(rel)} alt={filename} loading="lazy"
        onClick={onExpand} style={onExpand ? { cursor: "zoom-in" } : undefined} />
      <input
        className="order-card-image-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        onBlur={commit}
        spellCheck={false}
        aria-label="Image filename"
      />
    </div>
  );
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; body: string; frontmatter: Frontmatter; rawFm: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
  onRenamed?: (newPath: string) => void;
  onTitleChanged?: (newTitle: string) => void;
  /** For chat cards: called (with the chat's vault-relative path) when the
   *  surface is visited and idle, so the parent can occasionally give a
   *  still-timestamp-named chat a meaningful, content-derived filename. */
  onMaybeChatTitle?: (rel: string) => void;
  /** Called when the user confirms deletion of this card. Card flushes
   *  pending saves first so we don't recreate the file after delete. */
  onDelete?: (path: string) => Promise<void>;
  /** Called after a successful save with the persisted frontmatter + body.
   *  Lets the parent refresh its in-memory copy of structural files
   *  (spacetime.mw / .yml, list folders) so derived state — the sidebar
   *  taxonomy, calendar, and the mw→yml mirror — reflects hand-edits made
   *  in the card. Without it, a self-write is filtered by the watcher and
   *  the parent's `notes` stays stale, so e.g. reordering the hierarchy in
   *  spacetime.mw never reaches the UI. */
  onPersisted?: (path: string, frontmatter: Frontmatter, body: string) => void;
  /** Optional Notable Folder color. Renders as a left-border accent
   *  so cards visually group by folder in the Pile. */
  color?: string;
  /** When this card IS a Notable Folder Main Document, these populate
   *  the "Area › Category" breadcrumb in the footer. */
  area?: string;
  category?: string;
  /** When this card is a regular note, this is its current Notable
   *  Folder (or null) — derived from the note's directory. Shown as
   *  the active row in the folder picker. */
  currentFolder?: string | null;
  /** Move this note into another Notable Folder. Wired to the controls'
   *  folder icon; CardGrid moves the file (and retags the note's
   *  spacetime event when it backs one). Absent on Main Documents and
   *  read-only surfaces — the icon doesn't render. */
  onAssignFolder?: (name: string) => Promise<void> | void;
  /** All Notable Folders in the vault — used to populate the folder
   *  autocomplete in the FrontmatterInspector. */
  availableFolders?: { name: string; color: string }[];
  /** Most-recent-first folder refs surfaced as the default rows of any
   *  folder autocomplete (FolderPicker + FrontmatterInspector). Comes
   *  from CardGrid's `recentFolders` store. */
  recentFolders?: string[];
  /** Generic frontmatter patch handler — used by the FrontmatterInspector.
   *  Keys set to `null` delete; everything else upserts. CardGrid persists
   *  and re-renders the live frontmatter through `liveFrontmatter` so the
   *  inspector stays in sync. */
  onSetFrontmatter?: (patch: Record<string, unknown | null>) => Promise<void>;
  /** Authoritative current frontmatter from CardGrid's notes state. The
   *  inspector reads this so edits re-render immediately. Falls back to
   *  the locally-loaded state.frontmatter when not provided. */
  liveFrontmatter?: Frontmatter;
  /** The note's authoritative spacetime event (source of truth for its date +
   *  all-day-ness), resolved by CardGrid from spacetime.mw — NOT the note's own
   *  YAML. Drives the top-left chip's date + the all-day star. Absent when the
   *  note isn't a calendar event. */
  spacetimeEvent?: { date: string; allDay: boolean };
  /** Minimal vault index for resolving `- [[Name]]` bullets (and for
   *  evaluating `base` blocks) when this card is a list folder. Each
   *  entry carries just enough info for the renders + base evaluator. */
  vaultNotes?: ListNoteRef[];
  /** Set the global folder filter to a single ref. The list renders
   *  call this on title click when the linked target resolves to a
   *  real note. */
  onNavigate?: (ref: string) => void;
  /** Additive variant: add a Notable Folder to the existing filter
   *  set without clearing it. The list renders use this for NF refs
   *  so multiple folders can accumulate. */
  onAddFilter?: (ref: string) => void;
  /** Drop this card's ref from the active folder filter set. When
   *  provided the top-right × dismisses the card from the filtered
   *  view (delete moves under the trash icon next to it). */
  onRemoveFromFilter?: () => void;
  /** Focus the editor after the editor mounts. Used to land the
   *  cursor inside a freshly created note. */
  autoFocus?: boolean;
  /** One-shot: open this card in fullscreen when it becomes true (calendar → note). */
  wantFullscreen?: boolean;
  /** Bumped by the parent on any page navigation; the card exits fullscreen
   *  when it changes so navigating away never leaves you stuck on the old
   *  note. Ignored on mount (a freshly-opened fullscreen card takes the
   *  current value as its baseline). */
  collapseFullscreenSignal?: number;
  /** Bumped by the parent when the watcher reports this file changed
   *  externally. Card re-reads the disk and replaces the Milkdown
   *  document in-place (no remount) so the editor doesn't flicker. */
  externalBodyVersion?: number;
  /** Pinned-focus signal from the parent: when true, the card is
   *  treated as currently expanded (newspaper cap lifted) and is the
   *  card the user is "on". Survives external file changes — the
   *  parent uses this to keep the React key stable for the focused
   *  card so a watcher event doesn't remount the editor mid-edit. */
  focused?: boolean;
  /** Called when the user clicks/focuses anywhere inside this card.
   *  Parent uses this to track which card is the currently-focused
   *  one so it can be held stable across external changes. */
  onFocus?: () => void;
  /** Skip the Tauri disk read on mount and use this body +
   *  frontmatter directly. Set together with `readOnly` for the
   *  published web viewer, where there's no filesystem to read from
   *  and editing is disabled. */
  initialBody?: string;
  initialFrontmatter?: Frontmatter;
  /** When true, the card runs in display mode: Milkdown is read-only
   *  (no caret, no block handles), the editor's onChange + save
   *  pipeline is skipped, and top-right delete / dismiss controls
   *  are hidden. */
  readOnly?: boolean;
  /** Newspaper layout: cap the card body to this many pixels with a
   *  fade + "Read more" until expanded. Focusing the editor (when
   *  editable) or clicking Read more lifts the cap. Omit for the
   *  uncapped temporal-stream behaviour. */
  capHeight?: number;
  /** Full public permalink URL for this note. When set, a link icon in
   *  the card's top-right copies it. Omitted when the note has no
   *  published permalink (private / unpublished). */
  permalink?: string;
  /** Has the user already focused on / visited this Notable Folder?
   *  Only meaningful for NF Main Documents — the chrome dials the
   *  coral highlight back to a hairline once a folder is no longer
   *  novel, so unvisited NF covers stand out and visited ones recede. */
  visited?: boolean;
  /** Notable Folder Main Documents only: tapped from the card chrome
   *  to log a brief all-day note in the folder dated today. The card
   *  surfaces a one-line prompt inline; submitting hands the text to
   *  the parent which performs the actual createNote. */
  onCreateUpdate?: (description: string) => Promise<void> | void;
  /** Notable Folder Main Documents only: is THIS folder the vault's
   *  home (its YAML carries `home: "<user>/<repo>/<path>"`)? Drives
   *  the filled vs. outline state of the home icon in the chrome. */
  isHome?: boolean;
  /** Notable Folder Main Documents only: tap to mark this folder as
   *  the home (or, when already home, clear it). The parent owns the
   *  confirm-replace + URL prompt and the YAML write. */
  onSetHome?: () => Promise<void> | void;
  /** Notable Folder Main Documents only: cycle the `list:` YAML key
   *  through {none → cards → lines → none}. Parent writes YAML. */
  listMode?: "none" | "cards" | "lines" | "masonry";
  onCycleList?: () => Promise<void> | void;
  /** File Piles (session-only). Present only for non-main cards in the
   *  single-folder "Notable Folder view". onTogglePin adds/removes the `$ `
   *  pin marker — durable top-of-folder ordering, the replacement for the old
   *  session-only move-to-top. onClosePile hides a card for the session (kept
   *  for the read-only viewer; the app no longer shows a note × ). */
  onTogglePin?: () => void;
  onClosePile?: () => void;
  /** Finance report → optionally create an all-day calendar event per purchase,
   *  tied to this folder. Passed only for a Notable Folder cover. Returns how
   *  many events were created and how many were skipped as duplicates. */
  onCreatePurchaseEvents?: (dirRel: string, accounts: string[], start: string, end: string) => Promise<{ created: number; duplicates: number }>;
  /** File browser (backside) row actions — present only on the NF Main Doc. */
  onBrowserAddToPile?: (filename: string) => void;
  onBrowserRename?: (oldName: string, newName: string) => Promise<void> | void;
  onBrowserDelete?: (name: string) => Promise<void> | void;
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000;

export function Card(props: Props) {
  const {
    path: initialPath,
    onRenamed,
    onMaybeChatTitle,
    onTitleChanged,
    onDelete,
    onPersisted,
    color,
    area,
    category,
    currentFolder,
    onAssignFolder,
    availableFolders,
    recentFolders,
    onSetFrontmatter,
    liveFrontmatter,
    spacetimeEvent,
    vaultNotes,
    onNavigate,
    onAddFilter,
    onRemoveFromFilter,
    autoFocus,
    wantFullscreen,
    collapseFullscreenSignal,
    focused: focusedProp,
    onFocus: onCardFocus,
    initialBody,
    initialFrontmatter,
    readOnly,
    capHeight,
    permalink,
    onCreateUpdate,
    isHome,
    onSetHome,
    listMode,
    onCycleList,
    externalBodyVersion,
    onTogglePin,
    onClosePile,
    onCreatePurchaseEvents,
    onBrowserAddToPile,
    onBrowserRename,
    onBrowserDelete,
  } = props;
  const milkdownRef = useRef<MilkdownHandle | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Open fullscreen when the parent signals it (calendar → note). Only acts on
  // the false→true transition, so it never fights a manual exit.
  useEffect(() => { if (wantFullscreen) setFullscreen(true); }, [wantFullscreen]);
  // Durable open-fullscreen intent (new note / chat): consumed on mount — no
  // 800ms window to race — and also caught live if the request lands while
  // mounted. See lib/fullscreen-intent.ts.
  useEffect(() => {
    if (consumeFullscreenIntent(initialPath)) setFullscreen(true);
    return onFullscreenRequest(initialPath, () => setFullscreen(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Exit fullscreen when the parent navigates away (wikilink / palette / etc.).
  // Ignore the mount run so a card opened straight into fullscreen — which
  // mounts with the just-bumped signal as its baseline — isn't collapsed.
  const collapseSeenRef = useRef(collapseFullscreenSignal);
  useEffect(() => {
    if (collapseSeenRef.current === collapseFullscreenSignal) return;
    collapseSeenRef.current = collapseFullscreenSignal;
    setFullscreen(false);
  }, [collapseFullscreenSignal]);
  /** Notable Folder Main Documents only: flips the card to the folder
   *  contents browser (see NotableFolderBackside). Desktop-only
   *  feature; the calling card hides the flip button on iOS / viewer.
   *  Lives at the TOP of the hook list so the early-return loading /
   *  error branches don't change hook count between renders. */
  const [flipped, setFlipped] = useState(false);
  // Folder picker popover (regular notes): opened by the controls'
  // folder icon; picking a Notable Folder MOVES the note there.
  const [folderPickOpen, setFolderPickOpen] = useState(false);
  const [folderPickQuery, setFolderPickQuery] = useState("");
  // In-card terminal mode (NF Main Docs, desktop). Opened by the card's
  // terminal icon or the Cmd+4 window event; renders OrderTerminal in
  // place of the card body, rooted at the folder's directory.
  const [termOpen, setTermOpen] = useState(false);
  // Sheet / drawing "flip" view. The persisted default lives in the note's
  // `view:` frontmatter; viewOverride is the optimistic local switch on an
  // icon click (persisted in parallel). Only markdown notes can flip —
  // spacetime / yaml / txt surfaces always stay in their raw editor.
  const [viewOverride, setViewOverride] = useState<NoteView | null>(null);
  // Transient "edit the raw markdown" mode: swaps the Milkdown WYSIWYG for a
  // CodeMirror surface over the SAME body (not persisted — an escape hatch
  // for when the rich editor gets in the way). Both save through handleChange.
  const [sourceOpen, setSourceOpen] = useState(false);
  // App text scale — for HTML report cards, fed into the frame URL so the
  // vaultasset protocol can inject a matching page zoom (a cross-origin frame
  // can't be restyled from outside).
  const textScale = useTextScale();
  // Raw-source editing edits the on-disk file BODY verbatim (exactly what's on
  // disk — no Milkdown re-serialization, so no loose blank lines; and it
  // includes a list folder's bullets/base block, which the WYSIWYG editor
  // strips out). Its own debounced save writes straight to the file.
  const [sourceDraft, setSourceDraft] = useState<string>("");
  const sourceDraftRef = useRef("");
  sourceDraftRef.current = sourceDraft;
  const sourceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Secondary card actions collapse behind a "⋯" popover so the top control
  // row stays uncrowded (and doesn't overlap the date chip or a flipped
  // surface's own toolbar).
  const [moreOpen, setMoreOpen] = useState(false);
  const [finReportOpen, setFinReportOpen] = useState(false);

  // The menu renders in a portal (fixed coords from the button) so it escapes
  // sibling cards' stacking contexts / overflow — otherwise a later card
  // paints over it.
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [morePos, setMorePos] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const openMore = useCallback(() => {
    const r = moreBtnRef.current?.getBoundingClientRect();
    if (r) setMorePos({ top: r.bottom + 4, right: Math.max(6, window.innerWidth - r.right) });
    setMoreOpen((v) => !v);
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.(".order-card-more, .order-card-more-menu")) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKey); };
  }, [moreOpen]);
  // Loaded sidecar contents for the active view (null = not loaded yet).
  const [sheetContent, setSheetContent] = useState<string | null>(null);
  const [drawingContent, setDrawingContent] = useState<string | null>(null);
  const [vaultRootForFlip, setVaultRootForFlip] = useState<string | null>(null);
  // Resolve the vault root once either the file browser OR the terminal
  // needs the folder's absolute path.
  useEffect(() => {
    if ((!flipped && !termOpen) || vaultRootForFlip !== null || readOnly) return;
    let cancelled = false;
    void vaultRoot().then((r) => { if (!cancelled) setVaultRootForFlip(r); });
    return () => { cancelled = true; };
  }, [flipped, termOpen, vaultRootForFlip, readOnly]);
  // Cmd+4 (CardGrid) dispatches `order:open-terminal` with an NF name.
  // The matching Main Doc card TOGGLES its in-card terminal — identical to
  // clicking the card's terminal icon, so Cmd+4 opens it and Cmd+4 again
  // closes it back to the note. termTargetRef carries the live folder name
  // + main-doc-ness so this once-mounted listener stays current without
  // re-subscribing.
  const termTargetRef = useRef<{ name: string; isMain: boolean }>({ name: "", isMain: false });
  useEffect(() => {
    if (readOnly || isIosSync()) return;
    const onOpen = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      const t = termTargetRef.current;
      if (t.isMain && t.name === name) { setFlipped(false); setTermOpen((v) => !v); }
    };
    window.addEventListener("order:open-terminal", onOpen);
    return () => window.removeEventListener("order:open-terminal", onOpen);
  }, [readOnly]);

  // ---- Sheet / Drawing "flip" views ----------------------------------
  // Only a plain markdown note (not a spacetime/yaml/txt raw surface) can
  // flip. The active view = optimistic local override, else the persisted
  // `view:` frontmatter, else "note".
  const filenameForView = initialPath.split("/").pop() ?? "";
  const canFlip = /\.md$/i.test(filenameForView) && !isSpacetimeFile(filenameForView) && !/\.chat\.md$/i.test(filenameForView);
  const viewFm = state.kind === "ready" ? (liveFrontmatter ?? state.frontmatter) : null;
  const view: NoteView = canFlip ? (viewOverride ?? (viewFm ? parseView(viewFm) : "note")) : "note";
  const viewRef = useRef<NoteView>(view);
  viewRef.current = view;
  // "Edit source" (raw markdown of the whole body) applies to any markdown note
  // shown in Milkdown — not raw surfaces (spacetime/yaml/txt) or flipped views.
  // List folders included: source edits the file directly (bullets and all).
  const canEditSource = canFlip && view === "note" && !readOnly;

  // Load the active view's sidecar (created on first flip by flipView).
  useEffect(() => {
    if (view === "note") return;
    let cancelled = false;
    const rel = toVaultRel(view === "sheet" ? sheetSidecarPath(pathRef.current) : drawingSidecarPath(pathRef.current));
    void (async () => {
      const raw = await vaultFs.readText(rel).catch(() => "");
      if (cancelled) return;
      if (view === "sheet") setSheetContent(raw); else setDrawingContent(raw);
    })();
    return () => { cancelled = true; };
  }, [view, initialPath]);

  // Flip to a target view (or back to the note if already there); persist the
  // choice in the note's `view:` frontmatter and create the sidecar on first
  // entry.
  const flipView = useCallback(async (target: NoteView) => {
    const next: NoteView = viewRef.current === target ? "note" : target;
    setFlipped(false);
    setTermOpen(false);
    setViewOverride(next);
    if (next === "sheet") setSheetContent(null);
    else if (next === "drawing") setDrawingContent(null);
    if (next !== "note") {
      const rel = toVaultRel(next === "sheet" ? sheetSidecarPath(pathRef.current) : drawingSidecarPath(pathRef.current));
      const exists = await vaultFs.exists(rel).catch(() => false);
      if (!exists) {
        const seed = next === "sheet" ? serializeSheet(emptySheet(12, 8)) : "";
        try { await vaultFs.writeText(rel, seed); } catch (e) { console.error("create sidecar failed", e); }
      }
    }
    if (onSetFrontmatter) {
      try { await onSetFrontmatter({ view: next === "note" ? null : next }); }
      catch (e) { console.error("persist view failed", e); }
    }
  }, [onSetFrontmatter]);

  // Write the raw source body straight to the file, preserving whatever
  // frontmatter is on disk (edited via the YAML peek, not here).
  const saveSourceNow = useCallback(async (draft: string) => {
    const path = pathRef.current;
    inflight.current += 1;
    try {
      const raw = await vaultFs.readText(toVaultRel(path));
      const { frontmatter } = splitFrontmatter(raw);
      const content = joinFrontmatter(frontmatter, draft);
      markKnownBody(path, draft);
      await vaultFs.writeText(toVaultRel(path), content);
      onPersistedRef.current?.(path, frontmatter, draft);
    } catch (e) { console.error("source save failed", e); }
    finally { inflight.current -= 1; }
  }, []);
  const scheduleSourceSave = useCallback((draft: string) => {
    if (sourceSaveTimer.current) clearTimeout(sourceSaveTimer.current);
    sourceSaveTimer.current = setTimeout(() => { void saveSourceNow(draft); }, SAVE_DEBOUNCE_MS);
  }, [saveSourceNow]);

  // Re-read the file and rebuild the editor/list state from it — used when
  // leaving source mode so Milkdown (and a list folder's bullets) reflect the
  // just-edited raw markdown. Mirrors the initial-load transform.
  const reloadFromDisk = useCallback(async () => {
    const path = pathRef.current;
    try {
      const raw = await vaultFs.readText(toVaultRel(path));
      const split = splitFrontmatter(raw);
      const frontmatter = split.frontmatter;
      const noteDir = vaultDir(toVaultRel(path));
      const embedInflate = inflateEmbedFencesToImage(split.body);
      embedRestoreRef.current = embedInflate.restore;
      const displayBody = inflateImageEmbeds(
        inflateAttachmentUrls(embedInflate.body, attachmentAssetPrefix(await vaultRoot())),
        noteDir,
      );
      let editorNext = displayBody;
      if (isListFolder(frontmatter)) {
        const rawBlock = extractRawBaseBlock(displayBody);
        if (rawBlock) {
          baseBlockRawRef.current = rawBlock;
          setBaseBlockRaw(rawBlock);
          editorNext = displayBody.replace(rawBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
        } else {
          const bs = splitBodyAndBullets(displayBody);
          editorNext = bs.prose;
          listItemsRef.current = bs.items;
          setListItems(bs.items);
        }
      }
      editorBodyRef.current = editorNext;
      setEditorBody(editorNext);
      markKnownBody(path, split.body);
      const rawFm = split.raw.replace(/^---\r?\n/, "").replace(/\r?\n---\r?\n?$/, "");
      setState((s) => (s.kind === "ready" ? { ...s, body: editorNext, frontmatter, rawFm } : s));
    } catch (e) { console.error("reload from disk failed", e); }
  }, []);

  // Toggle raw-source editing. Entering: cancel any pending WYSIWYG save (so it
  // can't clobber the file mid-edit) and load the on-disk body. Leaving: flush
  // the source save, then rebuild the editor from disk.
  const toggleSource = useCallback(() => {
    setSourceOpen((prev) => {
      const next = !prev;
      if (next) {
        if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
        dirty.current = false;
        void (async () => {
          try {
            const raw = await vaultFs.readText(toVaultRel(pathRef.current));
            setSourceDraft(splitFrontmatter(raw).body);
          } catch (e) { console.error("source load failed", e); }
        })();
      } else {
        if (sourceSaveTimer.current) { clearTimeout(sourceSaveTimer.current); sourceSaveTimer.current = null; }
        void (async () => { await saveSourceNow(sourceDraftRef.current); await reloadFromDisk(); })();
      }
      return next;
    });
  }, [saveSourceNow, reloadFromDisk]);

  const saveSheet = useCallback((html: string) => {
    void vaultFs.writeText(toVaultRel(sheetSidecarPath(pathRef.current)), html);
  }, []);
  const saveDrawing = useCallback((json: string) => {
    void vaultFs.writeText(toVaultRel(drawingSidecarPath(pathRef.current)), json);
  }, []);
  /** Newspaper height-cap state: `expanded` lifts the cap (Read more
   *  or, when editable, focusing the card); `overflowing` is whether
   *  the body actually exceeds the cap (only then do we show the
   *  fade + Read more). */
  const [expanded, setExpanded] = useState(false);
  /** Inspector panel state — closed by default, opened by clicking the
   *  top-left `{date}` toggle. When open, the FrontmatterInspector
   *  drops in above the editor body so the YAML is editable inline. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Lifecycle state that drives the delete exit animation. */
  const [exiting, setExiting] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const copyPermalink = useCallback(() => {
    if (!permalink) return;
    void navigator.clipboard?.writeText(permalink);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1400);
  }, [permalink]);
  /** "Copy text" chrome — pushes the current note body to the
   *  clipboard as raw markdown. Editor state is the source of
   *  truth, so we read from the latest `editorBody` mirror; if the
   *  card hasn't loaded yet we fall back to whatever's on disk. */
  const [copiedText, setCopiedText] = useState(false);
  /** Inline Notable Update prompt visibility — opened from the chrome
   *  row's + button, dismissed on submit / Esc / × . NF Main Doc only. */
  const [updateOpen, setUpdateOpen] = useState(false);
  /** Optimistic mirrors of listMode / isHome so the icon flips the
   *  instant the user taps. The parent owns the canonical YAML write
   *  and a reload; until the new prop arrives back here, we render
   *  the pending value so feedback is immediate. Setting the pending
   *  value to null lets the prop win again. */
  const [pendingListMode, setPendingListMode] = useState<"none" | "cards" | "lines" | "masonry" | null>(null);
  const [pendingHome, setPendingHome] = useState<boolean | null>(null);
  // When the prop catches up to the optimistic value, clear the pending
  // override so further external changes (a vault edit on disk) flow
  // through normally.
  useEffect(() => {
    if (pendingListMode !== null && listMode === pendingListMode) {
      setPendingListMode(null);
    }
  }, [listMode, pendingListMode]);
  useEffect(() => {
    if (pendingHome !== null && isHome === pendingHome) {
      setPendingHome(null);
    }
  }, [isHome, pendingHome]);
  const effectiveListMode = pendingListMode ?? listMode ?? "none";
  const effectiveIsHome = pendingHome !== null ? pendingHome : !!isHome;
  // Folded notes render as a compact spine (title only) until the user
  // clicks to reveal. The `folded: true` YAML flag is the persistent
  // state; `unfolded` is the per-session reveal (resets on reload, so
  // a folded note re-folds next time you open the vault). pendingFolded
  // mirrors the optimistic-toggle pattern above so the icon flips on tap.
  const [unfolded, setUnfolded] = useState(false);
  const [pendingFolded, setPendingFolded] = useState<boolean | null>(null);
  const copyBodyText = useCallback(() => {
    // editorBodyRef is populated both on load (setEditorBody during
    // the read effect) and on every editor change, so it's the
    // single source of truth even before the user has typed.
    // Milkdown's serializer emits "loose" lists with a blank line
    // between every item; tighten before writing to the clipboard so
    // the copy matches the on-disk shape.
    const src = editorBodyRef.current;
    if (!src) return;
    void navigator.clipboard?.writeText(tightenListSpacing(src));
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 1400);
  }, []);
  /** Mirrors the editor body so saves can fold the current prose
   *  with the structured list items below. Milkdown stays uncontrolled
   *  — this state is downstream-only. */
  const [editorBody, setEditorBody] = useState<string>("");
  /** Structured list items for *manual* list folders (bullets in body).
   *  Source of truth for what + order. Unused in base-driven mode. */
  const [listItems, setListItems] = useState<ListItem[]>([]);
  const listItemsRef = useRef<ListItem[]>([]);
  useEffect(() => { listItemsRef.current = listItems; }, [listItems]);
  /** Manual ordering for *base-driven* list folders. Persisted as
   *  `manual_order:` in frontmatter; smart-merged with the base's
   *  matched set at render time. */
  const [manualOrder, setManualOrder] = useState<string[]>([]);
  const manualOrderRef = useRef<string[]>([]);
  useEffect(() => { manualOrderRef.current = manualOrder; }, [manualOrder]);
  /** The raw ```base ... ``` fence text stripped from the editor view
   *  so the user sees just prose + rendered cards. Reattached verbatim
   *  on save so the on-disk body stays intact. Null when this note has
   *  no base block. */
  const [baseBlockRaw, setBaseBlockRaw] = useState<string | null>(null);
  const baseBlockRawRef = useRef<string | null>(null);
  useEffect(() => { baseBlockRawRef.current = baseBlockRaw; }, [baseBlockRaw]);
  /** Original `````embed` fence text per canonical YouTube watch-URL,
   *  populated on load. Save path consults this so the on-disk YAML
   *  fence (title / image / description) survives the round-trip
   *  through Crepe's image-form representation. */
  const embedRestoreRef = useRef<EmbedFenceRestore>({ byUrl: new Map() });
  const editorBodyRef = useRef<string>("");
  useEffect(() => { editorBodyRef.current = editorBody; }, [editorBody]);
  /** Set on any user edit (text or list item). flushNow no-ops without
   *  it, so an idle card doesn't periodically rewrite its file. */
  const dirty = useRef(false);
  // Path tracked through a ref so Card doesn't remount when the parent
  // re-renders with the new path after a rename — the editor keeps focus.
  const pathRef = useRef(initialPath);
  useEffect(() => { pathRef.current = initialPath; }, [initialPath]);

  const onRenamedRef = useRef(onRenamed);
  const onTitleChangedRef = useRef(onTitleChanged);
  const onPersistedRef = useRef(onPersisted);
  useEffect(() => { onRenamedRef.current = onRenamed; }, [onRenamed]);
  useEffect(() => { onTitleChangedRef.current = onTitleChanged; }, [onTitleChanged]);
  useEffect(() => { onPersistedRef.current = onPersisted; }, [onPersisted]);

  // When the watcher bumps externalBodyVersion, re-read the file and
  // replace the Milkdown document in-place (no remount, no flicker).
  // Skip if there's a pending save inflight — our own write is what
  // triggered the watcher; the file already reflects what the editor shows.
  //
  // The editor holds PROSE ONLY for a list folder (bullets live in the
  // items array, the base fence in baseBlockRawRef). This path must apply
  // the same split as the initial load: pushing the raw file body in would
  // put the serialized bullets INTO the editor, and the next save — which
  // writes `editorBody + serializeListItems(items)` — would append a second
  // copy of every bullet. Each copy re-triggers the watcher, so the file
  // grows without bound (Geet Duggal.md reached 1102 copies of its 3
  // bullets this way).
  useEffect(() => {
    if (!externalBodyVersion) return;
    if (inflight.current > 0) return;
    // Never yank the document out from under an active edit. `dirty` means the
    // user has unsaved keystrokes (typed within the save-debounce window); a
    // replaceContent here would both reset the caret AND discard those
    // keystrokes. The overwhelmingly common trigger for this effect is our OWN
    // save re-entering as a bogus "external" change once the 6s self-write TTL
    // has lapsed but the slow desktop poller finally ticks (~30s later) — in
    // that case the disk already equals what the editor shows, so there is
    // nothing to apply. Bail on dirty; the equality check below covers the rest.
    if (dirty.current) return;
    void (async () => {
      try {
        const raw = await vaultFs.readText(toVaultRel(pathRef.current));
        const { frontmatter, body } = splitFrontmatter(raw);
        const noteDir = vaultDir(toVaultRel(pathRef.current));
        const displayBody = inflateImageEmbeds(
          inflateAttachmentUrls(body, attachmentAssetPrefix(await vaultRoot())),
          noteDir,
        );
        let editorNext = displayBody;
        if (isListFolder(frontmatter)) {
          const rawBlock = extractRawBaseBlock(displayBody);
          if (rawBlock) {
            baseBlockRawRef.current = rawBlock;
            setBaseBlockRaw(rawBlock);
            editorNext = displayBody.replace(rawBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
          } else {
            const split = splitBodyAndBullets(displayBody);
            editorNext = split.prose;
            listItemsRef.current = split.items;
            setListItems(split.items);
          }
        }
        // Re-check dirty AFTER the await — the user may have started typing
        // while we read the disk. And skip the rebuild entirely when the disk
        // already matches the editor (a no-op touch / stale self-write): a
        // replaceContent with identical text still resets the ProseMirror
        // selection, which is exactly the "cursor jumped" symptom.
        if (dirty.current || editorNext === editorBodyRef.current) return;
        editorBodyRef.current = editorNext;
        milkdownRef.current?.replaceContent(editorNext);
      } catch { /* best-effort; if it fails, the next remount cycle will catch up */ }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalBodyVersion]);

  const pendingBody = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);
  const lastTitleRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Dated HTML notes render in an <iframe> straight from disk — there's no
        // markdown body or frontmatter to read (and the file may be large).
        // (.sheet.html sidecars are excluded from the walk, so this is a page.)
        if (/\.html?$/i.test(initialPath) && !/\.sheet\.html$/i.test(initialPath)) {
          if (!cancelled) setState({ kind: "ready", body: "", frontmatter: {}, rawFm: "" });
          return;
        }
        // Dated images render straight from disk — binary, no text body/frontmatter.
        if (isImagePath(initialPath.split("/").pop() ?? initialPath)) {
          if (!cancelled) setState({ kind: "ready", body: "", frontmatter: {}, rawFm: "" });
          return;
        }
        let body: string;
        let frontmatter: Frontmatter;
        let rawFm = "";
        if (initialBody !== undefined && initialFrontmatter !== undefined) {
          // Pre-loaded source (web viewer). Skip Tauri entirely —
          // attachment URLs in the body stay relative because the
          // viewer is served from a webroot where `Attachments/`
          // resolves directly.
          body = initialBody;
          frontmatter = initialFrontmatter;
        } else {
          const raw = await vaultFs.readText(toVaultRel(initialPath));
          if (cancelled) return;
          const split = splitFrontmatter(raw);
          frontmatter = split.frontmatter;
          body = split.body;
          // Seed the per-path body cache so the watcher can tell a
          // real external edit from a Dropbox / iCloud touch on a
          // leaf note (CardGrid's notes[].body stays "" for leaves).
          markKnownBody(initialPath, body);
          // Strip the `---` fence lines for display in the YAML peek
          // popover — the panel header already implies "frontmatter".
          rawFm = split.raw.replace(/^---\r?\n/, "").replace(/\r?\n---\r?\n?$/, "");
        }
        const noteDir = vaultDir(toVaultRel(initialPath));
        // Transform ```embed YAML fences with YouTube `url:` lines into
        // canonical `![](watch-url)` image embeds so Crepe parses them
        // as images and the YouTube plugin's image-handling path can
        // mount the iframe. The original fence text is stashed in
        // embedRestoreRef so the save path can write it back verbatim,
        // preserving the title / image / description metadata.
        const embedInflate = inflateEmbedFencesToImage(body);
        body = embedInflate.body;
        embedRestoreRef.current = embedInflate.restore;
        const displayBody = initialBody !== undefined
          ? body
          : inflateImageEmbeds(
              inflateAttachmentUrls(body, attachmentAssetPrefix(await vaultRoot())),
              noteDir,
            );
        // List folders come in two flavors:
        //   - manual: bullet list of wikilinks in the body. We strip
        //     them on load so the editor only sees prose; the items
        //     array drives the rendered list.
        //   - base:   a fenced ```base ... ``` block in the body. We
        //     keep the body intact (the user can edit the block), and
        //     manual_order in YAML stores any per-user reordering.
        let editorInitial = displayBody;
        let initialItems: ListItem[] = [];
        let initialManualOrder: string[] = [];
        let initialBaseBlockRaw: string | null = null;
        if (isListFolder(frontmatter)) {
          const rawBlock = extractRawBaseBlock(displayBody);
          if (rawBlock) {
            initialBaseBlockRaw = rawBlock;
            // Hide the base fence from the WYSIWYG editor — the cards
            // render below already. Reattached verbatim on save.
            editorInitial = displayBody.replace(rawBlock, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
            const fmOrder = frontmatter.manual_order;
            initialManualOrder = Array.isArray(fmOrder)
              ? fmOrder.filter((x): x is string => typeof x === "string")
              : [];
          } else {
            const split = splitBodyAndBullets(displayBody);
            editorInitial = split.prose;
            initialItems = split.items;
          }
        }
        lastTitleRef.current = deriveNoteTitleFromBody(editorInitial);
        setState({ kind: "ready", body: editorInitial, frontmatter, rawFm });
        setEditorBody(editorInitial);
        setListItems(initialItems);
        setManualOrder(initialManualOrder);
        setBaseBlockRaw(initialBaseBlockRaw);
        listItemsRef.current = initialItems;
        manualOrderRef.current = initialManualOrder;
        baseBlockRawRef.current = initialBaseBlockRaw;
        editorBodyRef.current = editorInitial;
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: typeof err === "string" ? err : "Failed to load card",
        });
      }
    })();
    return () => { cancelled = true; };
  }, [initialPath]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (readOnly) return;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    pendingBody.current = null;
    const body = editorBodyRef.current;
    inflight.current += 1;
    setSaving(true);
    try {
      const path = pathRef.current;
      // Re-read latest frontmatter so out-of-band edits (Week view drag)
      // are preserved when we write our body.
      const current = await vaultFs.readText(toVaultRel(path));
      const { frontmatter } = splitFrontmatter(current);

      // Three save shapes:
      //   - base-driven list folder: editor body holds prose only; the
      //     hidden base fence is reattached at the bottom, manual_order
      //     captured in frontmatter.
      //   - manual list folder: body = prose + serialized bullets.
      //   - any other note: body unchanged.
      const storedBase = baseBlockRawRef.current;
      const isBaseDriven = isListFolder(frontmatter) && storedBase !== null;
      let outBody = body;
      let outFrontmatter: Frontmatter = frontmatter;

      if (isBaseDriven) {
        outBody = `${body.replace(/\n+$/, "")}\n\n${storedBase}\n`;
        outFrontmatter = { ...frontmatter, manual_order: manualOrderRef.current };
        // If manual_order is empty, drop the key so the YAML stays clean.
        if (manualOrderRef.current.length === 0) {
          const { manual_order: _, ...rest } = outFrontmatter;
          outFrontmatter = rest;
        }
      } else if (isListFolder(frontmatter)) {
        // Drop "empty" items before serializing — Milkdown's CommonMark
        // serializer can leave a `- <br />` artifact behind when a
        // list-item-with-image gets round-tripped (the image becomes a
        // standalone block, the list item is emptied). Without the
        // filter those empties get parsed back as text items on next
        // load and the file slowly self-corrupts on every save.
        const cleanItems = listItemsRef.current.filter(
          (i) => i.image || (i.text && i.text.trim() && i.text.trim() !== "<br />") || (i.ref && i.ref.trim() && i.ref.trim() !== "<br />"),
        );
        // Scrub the editor body of standalone image embeds whose base
        // matches a listItem's image — Milkdown's split-out copies. The
        // list is the source of truth for image items; the body should
        // hold prose only.
        const imageRefs = new Set(
          cleanItems
            .filter((i) => i.image)
            .map((i) => i.ref.toLowerCase()),
        );
        let scrubbed = body;
        if (imageRefs.size > 0) {
          scrubbed = scrubbed.replace(
            /^[ \t]*!\[[^\]]*\]\(([^)\s]+)\)[ \t]*$/gm,
            (full, url: string) => {
              const base = (url.split(/[?#]/)[0].split("/").pop() ?? "").toLowerCase();
              try {
                return imageRefs.has(decodeURIComponent(base)) || imageRefs.has(base) ? "" : full;
              } catch { return imageRefs.has(base) ? "" : full; }
            },
          );
          scrubbed = scrubbed.replace(/\n{3,}/g, "\n\n");
        }
        const bullets = serializeListItems(cleanItems);
        if (bullets) {
          outBody = `${scrubbed.replace(/\n+$/, "")}\n\n${bullets}\n`;
        }
      } else if (listItemsRef.current.length > 0) {
        // Not a list folder right now, but we still hold items from the
        // last load. This is the data-loss window the list-mode toggle
        // used to open: cards → none flipped the YAML, the next save
        // saw frontmatter.list missing, and dropped every bullet
        // because the editor body only carried the prose. Append the
        // items back as a plain markdown list so toggling off
        // preserves them; the next load (now without `list:`) just
        // renders them as a normal bulleted list in the editor.
        const bullets = serializeListItems(listItemsRef.current);
        if (bullets) {
          outBody = `${body.replace(/\n+$/, "")}\n\n${bullets}\n`;
        }
      }

      // Collapse runtime asset:// URLs back to on-disk form so the file
      // is portable / Obsidian-friendly: same-folder images → `![[file]]`,
      // legacy Attachments/ images → `![](Attachments/file)`.
      const noteDir = vaultDir(toVaultRel(path));
      // tightenListSpacing: Milkdown serializes loose lists (blank line
      // between every item); write them back tight.
      // restoreEmbedFences: any YouTube image-form embed that came from a
      // ```embed YAML fence on load is rewritten back to the original
      // fence text so the title / image / description metadata survive.
      const persistedBody = restoreEmbedFences(
        tightenListSpacing(deflateImageEmbeds(outBody, noteDir)),
        embedRestoreRef.current,
      );
      const content = joinFrontmatter(outFrontmatter, persistedBody);
      await vaultFs.writeText(toVaultRel(path), content);
      // Update the per-path body cache so a notify event triggered by
      // our own write (within the self-write TTL but possibly outside
      // it after slow-sync delays) is correctly identified as a
      // no-op when the on-disk content matches what we just wrote.
      markKnownBody(path, persistedBody);
      // Hand the persisted content back to the parent so it can refresh
      // its in-memory `notes` for structural files (spacetime.mw / .yml,
      // list folders). The watcher filters our own writes, so without this
      // a hand-edit — e.g. reordering the hierarchy in spacetime.mw — never
      // reaches the derived sidebar taxonomy / calendar.
      onPersistedRef.current?.(path, outFrontmatter, persistedBody);

      // The filename is DECOUPLED from the body's first line. Editing a note's
      // H1 no longer renames the file — that silently changed a note's identity
      // and broke wikilinks (the confusion this fixes). The filename is edited
      // explicitly via the card's inline name editor (renameFile below). We
      // still mirror the body-derived title into the in-memory note so the
      // pile / search label stays fresh without a reload, but never touch disk.
      const title = deriveNoteTitleFromBody(body);
      if (title && title !== lastTitleRef.current) {
        lastTitleRef.current = title;
        onTitleChangedRef.current?.(title);
      } else if (!title && lastTitleRef.current !== null) {
        lastTitleRef.current = null;
      }
    } catch (err) {
      console.error("write_text failed:", err);
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setSaving(false);
    }
  }, []);

  // The CardGrid OS drag-drop router imports dropped files into a note's dir,
  // then fires this with the written basenames. Insert them into THIS note's
  // editor: images as `![[name]]`, other files as `[name](name)` links (which
  // open in the system viewer on click).
  useEffect(() => {
    const onInsert = (e: Event) => {
      const detail = (e as CustomEvent<{ notePath: string; names: string[] }>).detail;
      if (readOnly || !detail || detail.notePath !== toVaultRel(pathRef.current)) return;
      const md = detail.names
        .map((n) => (isImagePath(n) ? `![[${n}]]` : `[${n}](${encodeURI(n)})`))
        .join("\n\n") + "\n";
      if (milkdownRef.current?.insertMarkdown(md)) {
        dirty.current = true;
        void flushNow();
      }
    };
    window.addEventListener("order:insert-attachments", onInsert as EventListener);
    return () => window.removeEventListener("order:insert-attachments", onInsert as EventListener);
  }, [readOnly, flushNow]);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow, readOnly]);

  // Stable so the memoized MilkdownSurface isn't re-rendered by every Card
  // state change (e.g. the save-status toggle) — see #33.
  const handleEditorDone = useCallback(() => { void flushNow(); }, [flushNow]);
  const renameFile = useCallback(async (nextTitle: string) => {
    const cur = pathRef.current;
    const filename = cur.split("/").pop() ?? cur;
    const marker = (filename.match(/^([!$]\s+)/) || [])[1] ?? "";
    const isChat = /\.chat\.md$/i.test(filename);
    const ext = isChat ? ".chat.md" : (filename.match(/\.[a-z0-9]+$/i)?.[0] ?? ".md");
    const stem = filename.slice(marker.length).replace(/\.chat\.md$/i, "").replace(/\.[a-z0-9]+$/i, "");
    const safe = nextTitle.replace(/[\\/:*?"<>|]/g, "-").trim() || "Untitled";
    const parsed = parseEventFilename(stem);
    const newBase = parsed
      ? marker + formatEventFilename(parsed, safe) + ext   // keep date/time token
      : marker + safe + ext;
    if (newBase === filename) return;
    try {
      const dir = await dirname(cur);
      const newPath = await uniqueRename(dir, cur, newBase);
      if (newPath !== cur) { pathRef.current = newPath; onRenamedRef.current?.(newPath); }
    } catch (err) { console.warn("rename failed:", err); }
  }, []);

  const handleChange = useCallback((markdown: string) => {
    pendingBody.current = markdown;
    // Keep only the REF live per keystroke. `editorBody` (state) has no render
    // consumer, so calling setEditorBody here forced a full Card re-render on
    // every character (the whole control strip, frontmatter inspector, list
    // logic) — the main source of typing choppiness. Load / reload still use
    // setEditorBody (rare) so the state + mirror effect stay coherent.
    editorBodyRef.current = markdown;
    scheduleSave();
  }, [scheduleSave]);

  const handleListChange = useCallback((next: ListItem[]) => {
    // In base mode the body holds the base block (now hidden from the
    // editor and tracked in baseBlockRawRef instead) and the user's
    // ordering lives in frontmatter.manual_order. In manual mode the
    // bullets ARE the order.
    if (baseBlockRawRef.current !== null) {
      const order = next.map((i) => i.ref);
      manualOrderRef.current = order;
      setManualOrder(order);
    } else {
      listItemsRef.current = next;
      setListItems(next);
    }
    scheduleSave();
  }, [scheduleSave]);

  const resetManualOrder = useCallback(() => {
    manualOrderRef.current = [];
    setManualOrder([]);
    scheduleSave();
  }, [scheduleSave]);

  /** Parse the hidden base block we stashed at load (see baseBlockRaw).
   *  The editor view never holds the fence anymore, so we derive from
   *  the stashed raw text. */
  const parsedBase: ParsedBase | null = useMemo(() => {
    if (!baseBlockRaw) return null;
    const inner = extractBaseBlock(baseBlockRaw);
    return inner ? parseBase(inner) : null;
  }, [baseBlockRaw]);

  /** What the renderer shows: smart-merged base results in base mode,
   *  manual bullets otherwise. */
  const itemsForView: ListItem[] = useMemo(() => {
    if (!parsedBase) return listItems;
    return smartMerge(parsedBase, vaultNotes ?? [], manualOrder).map((ref) => ({ ref }));
  }, [parsedBase, listItems, vaultNotes, manualOrder]);

  /** "List of lists": EVERY item resolves to another list folder.
   *  Triggers inline sub-list expansion under each row AND forces the
   *  render to lines so the tree reads. A loose threshold ("some")
   *  used to fire spuriously — e.g. a Books note with a single
   *  `[[Free Will]]` bullet that happened to share a name with a
   *  Spirituality NF flipped Books to lines. Requiring ALL items
   *  to resolve to lists makes the trigger purely structural: a
   *  pure tree of categories qualifies, a list of titles doesn't. */
  const isListOfLists = useMemo(() => {
    if (!vaultNotes || itemsForView.length === 0) return false;
    return itemsForView.every((item) => {
      const note = vaultNotes.find(
        (n) => stripSortPrefix(n.filename.replace(/\.md$/i, "")).toLowerCase() === item.ref.toLowerCase(),
      );
      return !!(note && (note.frontmatter.list || note.frontmatter.type === "list"));
    });
  }, [itemsForView, vaultNotes]);

  // Turning a plain note into a list (picking `list: cards|masonry|…` in the
  // frontmatter inspector) must populate the list immediately. The body's
  // bullets are only split into items at mount, so when `list:` first appears
  // while we're holding none, lift them out of the editor NOW — no reload. The
  // editor keeps the prose; the bullets become items (and re-serialize back on
  // save, so the on-disk body is unchanged).
  const liveListType = viewFm ? listRender(viewFm) : null;
  useEffect(() => {
    if (readOnly || parsedBase) return;
    if (liveListType) {
      // Entering a list: lift the body's bullets into items if we hold none.
      if (listItemsRef.current.length > 0) return;
      const split = splitBodyAndBullets(editorBodyRef.current);
      if (split.items.length === 0) return;
      listItemsRef.current = split.items;
      setListItems(split.items);
      editorBodyRef.current = split.prose;
      milkdownRef.current?.replaceContent(split.prose);
    } else {
      // Left list mode (picked "(none)"): the items were split OUT of the
      // editor, so fold them back in as a normal markdown bullet list — else
      // they'd just vanish from view. Clear the items so the save path doesn't
      // re-append them (the editor now owns the bullets), and mark dirty so the
      // merged body persists.
      if (listItemsRef.current.length === 0) return;
      const bullets = serializeListItems(listItemsRef.current);
      const next = bullets ? `${editorBodyRef.current.replace(/\n+$/, "")}\n\n${bullets}\n` : editorBodyRef.current;
      listItemsRef.current = [];
      setListItems([]);
      editorBodyRef.current = next;
      dirty.current = true;
      milkdownRef.current?.replaceContent(next);
    }
  }, [liveListType, parsedBase, readOnly]);

  // Click on a rendered `[[Name]]` in the editor: resolve folder vs note
  // and route. Folder links accumulate into the filter (like list NF
  // clicks); note links navigate. Broken links no-op.
  const handleWikiNavigate = useCallback((name: string) => {
    const res = resolveWikilink(name, vaultNotes ?? []);
    if (res.kind === "broken") return;
    // Strip the reserved leading marker (`! ` cover / `$ ` pinned) so the ref is
    // the folder/note's plain name — otherwise a cover resolves to "! 32.04
    // Order", which matches nothing and adds a dead filter pill.
    const ref = stripSortPrefix(res.ref.filename.replace(/\.md$/i, ""));
    if (res.kind === "folder") (onAddFilter ?? onNavigate)?.(ref);
    else onNavigate?.(ref);
  }, [vaultNotes, onNavigate, onAddFilter]);

  const handleImageUpload = useCallback(async (file: File): Promise<string> => {
    // Obsidian-style: store the image in the note's OWN folder (matching
    // attachmentFolderPath: "./") and embed it as `![[file]]` (the deflate
    // on save does the conversion). Returns the vaultasset:// URL the
    // custom protocol serves, so the just-pasted image renders live.
    const filename = attachmentName(file);
    const noteDir = vaultDir(toVaultRel(pathRef.current));
    const rel = noteDir ? `${noteDir}/${filename}` : filename;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await vaultFs.writeBinary(rel, Array.from(bytes));
    return assetUrl(rel);
  }, []);

  useEffect(() => { return () => { void flushNow(); }; }, [flushNow]);

  const startDeleteConfirm = useCallback(() => {
    setConfirmingDelete(true);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_TIMEOUT_MS);
  }, []);
  const cancelDeleteConfirm = useCallback(() => {
    setConfirmingDelete(false);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
  }, []);
  const performDelete = useCallback(async () => {
    if (confirmTimer.current) { clearTimeout(confirmTimer.current); confirmTimer.current = null; }
    // Cancel any pending save so we don't write a file we're about to
    // delete (which would otherwise just recreate it on disk).
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    pendingBody.current = null;
    setDeleteError(null);
    // Kick off the exit animation. The actual file delete fires after
    // the animation finishes so the user sees the card glide out.
    setExiting(true);
    setTimeout(() => {
      void (async () => {
        try {
          await onDelete?.(pathRef.current);
        } catch (err) {
          console.error("delete failed:", err);
          const message = typeof err === "string" ? err : (err instanceof Error ? err.message : String(err));
          setExiting(false);
          setDeleteError(message);
          setConfirmingDelete(false);
        }
      })();
    }, 240);
  }, [onDelete]);

  const toggleFullscreen = useCallback(() => {
    setFullscreen((prev) => !prev);
  }, []);
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
  }, []);

  // Esc exits fullscreen via the same animated path as the button —
  // EXCEPT while the in-card terminal is open. A terminal owns Escape
  // (vim leaving insert mode, less quitting, etc.); stealing it to
  // collapse fullscreen is what made vim look broken once the terminal
  // moved inside the card. Close the terminal (× / Cmd+4) first, then
  // Esc exits fullscreen as usual.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (termOpen) return;
        e.preventDefault();
        toggleFullscreen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, toggleFullscreen, termOpen]);

  // Cap active = a capHeight is set, the card isn't expanded, and
  // we're not in fullscreen. Measured against the content's natural
  // height so the fade / Read more only appear when there's actually
  // hidden content.
  const capActive = capHeight !== undefined && !expanded && !fullscreen;

  // Measure whether the body overflows the cap. Re-runs on content
  // resize (Milkdown async render, image load, list expansion).
  useEffect(() => {
    if (capHeight === undefined) { setOverflowing(false); return; }
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > capHeight + 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [capHeight, state, expanded]);

  // Editable cards lift the cap the moment the user focuses into them
  // (so you never edit behind a fade). Read-only cards stay capped
  // until Read more.
  useEffect(() => {
    if (readOnly || capHeight === undefined) return;
    const root = articleRef.current;
    if (!root) return;
    const onFocusIn = () => {
      setExpanded(true);
      onCardFocus?.();
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [readOnly, capHeight, onCardFocus]);
  // Mirror parent's pinned-focus signal into local expanded state so
  // a navigate-and-focus from the parent (sidebar click, calendar
  // open, palette) immediately lifts the cap, even before the editor
  // has wired its focusin listener.
  useEffect(() => {
    if (focusedProp) setExpanded(true);
  }, [focusedProp]);
  // Inspector defaults to closed (it's an authoring affordance, not a
  // primary surface). Click the top-left `{date}` toggle to open it.

  const filename = pathRef.current.split("/").pop() ?? pathRef.current;
  // A dated HTML page rendered in an <iframe> — but NOT a `.sheet.html`
  // spreadsheet sidecar (those render via the sheet surface / their parent .md).
  const isHtmlNote = /\.html?$/i.test(filename) && !/\.sheet\.html$/i.test(filename);
  // An agent conversation. Its own surface (ChatSurface) owns the whole body —
  // no Milkdown, no save pipeline; the Rust core writes the transcript.
  const isChatNote = /\.chat\.md$/i.test(filename);
  // A date-prefixed image surfaced as its own card in the folder pile.
  const isImageNote = isImagePath(filename);
  // A `.csv` file (e.g. a Finance report snapshot) — rendered as a table. #4 of
  // the OSuite Finance MVP: view raw CSVs the way `.sheet.html` sheets render.
  const isCsvNote = /\.csv$/i.test(filename);

  /** Write (or clear) the `folded: true` flag straight into this note's
   *  YAML. Editor-only — the read-only viewer reveals via the spine but
   *  can't change the persistent flag. Declared ABOVE the loading /
   *  error early returns so the hook order stays stable across renders. */
  const toggleFolded = useCallback(async (next: boolean) => {
    setPendingFolded(next);
    if (next) setUnfolded(false); // re-folding hides the body again
    const rel = toVaultRel(pathRef.current);
    try {
      const raw = await vaultFs.readText(rel);
      const { frontmatter, body } = splitFrontmatter(raw);
      const fm: Frontmatter = { ...frontmatter };
      if (next) fm.folded = true; else delete fm.folded;
      const content = joinFrontmatter(fm, body);
      await vaultFs.writeText(rel, content);
      markKnownBody(pathRef.current, body);
      setState((s) => s.kind === "ready" ? { ...s, frontmatter: fm } : s);
    } catch (err) {
      console.warn("toggleFolded failed:", err);
      setPendingFolded(null);
    }
  }, []);

  if (state.kind === "loading") {
    return <article className="order-card is-loading"><div className="card-loading">Loading…</div></article>;
  }
  if (state.kind === "error") {
    return (
      <article className="order-card">
        <p className="card-error">Couldn't load {filename}: {state.message}</p>
      </article>
    );
  }

  // A Notable Folder Main Document is the "cover" of its folder. We
  // mark its card so the chrome can show a permanent coral highlight
  // (same accent as the navigation pulse) and the user always reads
  // an NF cover at a glance — no need to remember which card you
  // just navigated to.
  const isMainDoc = isMainDocPath(initialPath);
  // A pinned note (`$ ` marker) gets a subtle signifier so a glance tells you
  // it's been floated to the top on purpose.
  const isPinned = isPinnedName(pathRef.current.split("/").pop()?.replace(/\.md$/i, "") ?? "");
  // Folded: render the spine until revealed. The persistent flag lives
  // in YAML; pendingFolded gives an optimistic flip on the toggle.
  const isFolded = pendingFolded !== null
    ? pendingFolded
    : state.kind === "ready" && state.frontmatter.folded === true;
  // Show the compact spine when the note is folded and hasn't been
  // revealed this session. Fullscreen always shows the full content.
  const showSpine = isFolded && !unfolded && !fullscreen;
  // Title for the spine — the last derived first-line title, else the
  // filename minus a leading date prefix, else "Folded note".
  const spineTitle = lastTitleRef.current
    || (pathRef.current.split("/").pop() ?? "")
        .replace(/\.md$/i, "")
        .replace(/^\d{4}-\d{2}-\d{2}\s*/, "")
    || "Folded note";
  const folderRelForFlip = vaultDir(toVaultRel(pathRef.current));
  const folderName = pathRef.current.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  // Keep the terminal-target ref current for the order:open-terminal
  // listener (Cmd+4).
  termTargetRef.current = { name: folderName, isMain: isMainDoc };
  const cardClass =
    "order-card" +
    (isMainDoc ? " is-main" : "") +
    (isPinned ? " is-pinned" : "") +
    (isMainDoc && props.visited ? " is-visited" : "") +
    (fullscreen ? " is-fullscreen" : "") +
    (exiting ? " is-exiting" : "") +
    (showSpine ? " is-spine" : "") +
    (view === "sheet" ? " is-sheet" : "") +
    (view === "drawing" ? " is-drawing" : "") +
    (isHtmlNote ? " is-html" : "") +
    (isChatNote ? " is-chat" : "") +
    (capActive && overflowing ? " is-capped" : "");

  // Every card shares the SAME chrome — one theme border, one shadow,
  // one surface. The per-folder border tint that used to live here made
  // each card's edge a slightly different color, which read as
  // inconsistency rather than information; folder identity still shows
  // through the sidebar, pills, breadcrumbs, and cover tiles.

  // Frontmatter inspector source-of-truth: prefer the live frontmatter
  // CardGrid pushes down (so edits re-render synchronously) and fall
  // back to the locally-loaded one. The `{date}` toggle label uses the
  // same date field — bare braces when there's no date yet.
  const fmLive: Frontmatter = liveFrontmatter ?? state.frontmatter;
  // The date + all-day-ness come from the note's spacetime event when it has
  // one (the source of truth); the note's own YAML is only a fallback for
  // non-event notes that carry a bare `date:`.
  // The filename's date prefix is the third authority tier: spacetime,
  // then frontmatter, then the filename. All-day events created by
  // naming (`2026-07-16 Q3 Exec Planning.md`) often carry NO date in
  // YAML — without this fallback their chip showed a bare icon.
  const fnDatePrefix = ((pathRef.current.split("/").pop() ?? "")
    .match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] ?? "";
  const fmDateRaw = spacetimeEvent?.date
    || (typeof fmLive.date === "string" ? fmLive.date : toIsoDateValue(fmLive.date) ?? "")
    || fnDatePrefix;
  // An all-day event gets a filled star (in the theme's other colour) in place
  // of the calendar glyph, so a marked day reads at a glance.
  const isAllDayEvent = !!fmDateRaw && (spacetimeEvent ? spacetimeEvent.allDay : fmLive.allDay === true);
  // The chip shows the WHOLE filename prefix that precedes the title, not just a
  // bare date: an event's full date/time/range token (`2026-05-24 - 2026-05-28`,
  // `2026-05-24 2300-2340`) or a Johnny-Decimal id (`61.04`). Falls back to the
  // spacetime/frontmatter date for notes whose name carries no such prefix.
  const chipLabel = (() => {
    const base = (pathRef.current.split("/").pop() ?? "")
      .replace(/\.md$/i, "").replace(/\.chat$/i, "")
      .replace(/^[!$]+\s*/, ""); // a reserved "! "/"$ " sort marker isn't part of the label
    const parsed = parseEventFilename(base);
    if (parsed) return formatEventFilename(parsed, "");
    const jd = base.match(/^(\d{1,2}(?:\.\d{1,3})+)(?=\s)/);
    if (jd) return jd[1];
    return fmDateRaw;
  })();

  // The human-editable part of the filename: the title AFTER any date/JD prefix
  // and reserved marker. Editing it renames the file while preserving the date/
  // time token, the marker, and the extension (.md / .chat.md).
  const editableTitle = (() => {
    const raw = (pathRef.current.split("/").pop() ?? "")
      .replace(/\.chat\.md$/i, "").replace(/\.[a-z0-9]+$/i, "")
      .replace(/^[!$]+\s*/, "");
    const parsed = parseEventFilename(raw);
    if (parsed) {
      const token = formatEventFilename(parsed, "").trim();
      return raw.slice(token.length).replace(/^\s+/, "");
    }
    return raw.replace(/^\d{1,2}(?:\.\d{1,3})+\s+/, "");
  })();
  // System-reminder toggle (macOS / iOS EventKit). Only meaningful for a DATED
  // note; the date/time come from the filename (source of truth) with a
  // frontmatter fallback. `reminder`/`reminderId` live in the note's YAML.
  const reminderParsed = parseEventFilename(
    (pathRef.current.split("/").pop() ?? "").replace(/\.md$/i, "").replace(/\.chat$/i, "").replace(/^[!$]+\s*/, ""),
  );
  const reminderDate = reminderParsed?.date ?? (typeof fmLive.date === "string" ? fmLive.date.slice(0, 10) : undefined);
  const reminderTime = reminderParsed?.time ?? (typeof fmLive.startTime === "string" ? fmLive.startTime : undefined);
  const reminderOn = fmLive.reminder === true;
  const reminderId = typeof fmLive.reminderId === "string" ? fmLive.reminderId : "";
  const toggleReminder = async () => {
    if (!reminderDate) return;
    try {
      if (reminderOn) {
        if (reminderId) await reminders.deleteReminder(reminderId);
        await onSetFrontmatter?.({ reminder: null, reminderId: null });
      } else {
        const st = await reminders.accessStatus();
        if (st !== "authorized" && st !== "writeOnly") {
          const ok = await reminders.requestAccess().catch(() => false);
          if (!ok) { setDeleteError("Enable Reminders access in Settings → Reminders."); return; }
        }
        const title = (editableTitle || deriveNoteTitleFromBody(editorBodyRef.current) || "Reminder").trim();
        const id = await reminders.saveReminder({ title, date: reminderDate, time: reminderTime, id: reminderId || undefined });
        await onSetFrontmatter?.({ reminder: true, reminderId: id });
      }
    } catch (e) { setDeleteError(`Reminder failed: ${String(e)}`); }
  };

  // First http(s) URL in the YAML → a small link-out pill beside the
  // date chip (replaces the old auto-open-frontmatter heuristic). Always
  // visible so it works on touch; opens via openExternalUrl so every
  // surface (desktop, iOS, published site) lands in the DEFAULT browser,
  // never a WebView inside the app.
  const fmUrl = Object.values(fmLive).find(
    (v): v is string => typeof v === "string" && /^https?:\/\/\S+$/.test(v.trim()),
  )?.trim();
  // Event location / room (imported into frontmatter). Shown as a subtle chip
  // next to the URL link, not clickable.
  const fmLocation = typeof fmLive.location === "string" ? fmLive.location.trim() : "";
  const fmUrlHost = (() => {
    if (!fmUrl) return "";
    try { return new URL(fmUrl).hostname.replace(/^www\./, ""); } catch { return "link"; }
  })();

  return (
    <article
      className={cardClass}
      ref={articleRef}
      onMouseDown={onCardFocus}
      data-note-path={toVaultRel(pathRef.current)}
      data-note-dir={vaultDir(toVaultRel(pathRef.current))}
    >
      {/* Top-left date chip — a lightweight calendar icon plus the note's
          date, always visible (subtle). Doubles as the frontmatter inspector
          toggle: click to drop the FrontmatterInspector in above the editor
          body. Shows on the read-only viewer too. When the note has no date,
          just the icon shows. */}
      {!flipped && !termOpen && !showSpine && (
        <div className="order-card-topleft">
          <button
            type="button"
            className={"order-card-fm-toggle" + (inspectorOpen ? " is-on" : "")}
            onClick={() => setInspectorOpen((v) => !v)}
            title={inspectorOpen ? "Hide frontmatter" : "Show frontmatter"}
            aria-label={inspectorOpen ? "Hide frontmatter" : "Show frontmatter"}
            aria-expanded={inspectorOpen}
          >
            {isAllDayEvent
              ? <StarIcon size={11} strokeWidth={2} fill="currentColor" className="order-card-fm-star" />
              : <CalendarIcon size={11} strokeWidth={2} />}
            {chipLabel && <span className="order-card-fm-date">{chipLabel}</span>}
          </button>
          {isPinned && (
            <span className="order-card-pin" title="Pinned" aria-label="Pinned">
              <PinIcon size={11} strokeWidth={2} fill="currentColor" />
            </span>
          )}
          {fmUrl && (
            <button
              type="button"
              className="order-card-linkout"
              onClick={(e) => { e.stopPropagation(); openExternalUrl(fmUrl); }}
              title={fmUrl}
              aria-label={`Open ${fmUrlHost} in browser`}
            >
              <ArrowUpRight size={11} strokeWidth={2.2} />
              <span className="order-card-linkout-host">{fmUrlHost}</span>
            </button>
          )}
          {fmLocation && (
            <span className="order-card-location" title={fmLocation}>
              <MapPinIcon size={11} strokeWidth={2.2} />
              <span className="order-card-location-text">{fmLocation}</span>
            </span>
          )}
        </div>
      )}
      {/* Unified card chrome — single sticky row of icons in the top
          right. Order (left → right):
            1. Home toggle (NF Main Doc only)
            2. List cycle (NF Main Doc only): no list ↔ cards ↔ lines
            3. Notable update (NF Main Doc only) — opens inline prompt
            4. Permalink (when set; applies to ANY note)
            5. Copy text (any note — copies the body to clipboard)
            6. Folder contents flip (NF Main Doc, editable, desktop)
            7. Delete (editable only)
            8. Fullscreen toggle
            9. × close (dismiss from filtered view) */}
      <div className={"order-card-controls" + (flipped || termOpen ? " is-flipped" : "")} aria-hidden={false}>
        {/* Audio playback — a markdown note card only (not sheet/drawing/html,
            flipped, terminal, or folded). Reads the live body at press time. */}
        {canFlip && view === "note" && !isHtmlNote && !flipped && !termOpen && !showSpine && (
          <CardSpeech getText={() => editorBodyRef.current} notePath={toVaultRel(pathRef.current)} />
        )}
        {/* Primary, always inline: fullscreen, the close/dismiss button, and the
            "⋯" popover. The spreadsheet / drawing flips and everything else live
            in the popover so the row stays uncrowded. */}
        <button
          type="button"
          className="order-card-btn order-card-fullscreen"
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {fullscreen ? <Minimize2Icon size={14} strokeWidth={2} /> : <Maximize2Icon size={14} strokeWidth={2} />}
        </button>
        {readOnly ? (
          <>
            {permalink && (
              <button
                type="button"
                className={"order-card-btn order-card-permalink" + (copiedLink ? " is-copied" : "")}
                onClick={copyPermalink}
                title={copiedLink ? "Permalink copied" : "Copy permalink"}
                aria-label="Copy permalink"
              >
                {copiedLink ? <Check size={14} strokeWidth={2.4} /> : <Link2 size={14} strokeWidth={2} />}
              </button>
            )}
            <button
              type="button"
              className={"order-card-btn order-card-copy" + (copiedText ? " is-copied" : "")}
              onClick={copyBodyText}
              title={copiedText ? "Text copied" : "Copy text"}
              aria-label="Copy text"
            >
              {copiedText ? <Check size={14} strokeWidth={2.4} /> : <CopyIcon size={14} strokeWidth={2} />}
            </button>
            {onRemoveFromFilter && (
              <button type="button" className="order-card-btn order-card-dismiss" onClick={onRemoveFromFilter} title="Remove from filtered view" aria-label="Remove from filtered view">
                <XIcon size={14} strokeWidth={2.4} />
              </button>
            )}
            {onClosePile && (
              <button type="button" className="order-card-btn order-card-dismiss" onClick={onClosePile} title="Close card" aria-label="Close card">
                <XIcon size={14} strokeWidth={2.4} />
              </button>
            )}
          </>
        ) : (
          <>
            {onRemoveFromFilter && (
              <button type="button" className="order-card-btn order-card-dismiss" onClick={onRemoveFromFilter} title="Remove from view" aria-label="Remove from view">
                <XIcon size={14} strokeWidth={2.4} />
              </button>
            )}
            {onClosePile && (
              <button type="button" className="order-card-btn order-card-dismiss" onClick={onClosePile} title="Close card" aria-label="Close card">
                <XIcon size={14} strokeWidth={2.4} />
              </button>
            )}
            <button
              ref={moreBtnRef}
              type="button"
              className={"order-card-btn order-card-more" + (moreOpen ? " is-on" : "")}
              onClick={openMore}
              title="More actions"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
            >
              <MoreHorizontalIcon size={14} strokeWidth={2} />
            </button>
          </>
        )}
      </div>
      {moreOpen && !readOnly && createPortal(
        <div className="order-card-more-menu" role="menu" style={{ top: morePos.top, right: morePos.right }}>
          {isMainDoc && onSetHome && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (effectiveIsHome ? " is-on" : "")} onClick={() => { setPendingHome(!effectiveIsHome); void onSetHome(); setMoreOpen(false); }}>
              <HomeIcon size={14} strokeWidth={2} /><span>{effectiveIsHome ? "Clear home folder" : "Mark as home folder"}</span>
            </button>
          )}
          {isMainDoc && onCreateUpdate && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (updateOpen ? " is-on" : "")} onClick={() => { setUpdateOpen((v) => !v); setMoreOpen(false); }}>
              <StarIcon size={14} strokeWidth={2} /><span>Log a notable</span>
            </button>
          )}
          {permalink && (
            <button type="button" role="menuitem" className="order-card-more-item" onClick={() => { copyPermalink(); setMoreOpen(false); }}>
              {copiedLink ? <Check size={14} strokeWidth={2.4} /> : <Link2 size={14} strokeWidth={2} />}<span>{copiedLink ? "Permalink copied" : "Copy permalink"}</span>
            </button>
          )}
          <button type="button" role="menuitem" className="order-card-more-item" onClick={() => { copyBodyText(); setMoreOpen(false); }}>
            {copiedText ? <Check size={14} strokeWidth={2.4} /> : <CopyIcon size={14} strokeWidth={2} />}<span>{copiedText ? "Text copied" : "Copy text"}</span>
          </button>
          {!isIosSync() && (
            <button type="button" role="menuitem" className="order-card-more-item" onClick={() => { void invoke("reveal_path", { path: pathRef.current }).catch((e) => console.error("reveal_path failed:", e)); setMoreOpen(false); }}>
              <ArrowUpRight size={14} strokeWidth={2} /><span>Reveal in Finder</span>
            </button>
          )}
          {isImageNote && !isIosSync() && (
            <button type="button" role="menuitem" className="order-card-more-item" onClick={() => { void invoke("clipboard_copy_image", { path: pathRef.current }).catch((e) => console.error("copy image failed:", e)); setMoreOpen(false); }}>
              <CopyIcon size={14} strokeWidth={2} /><span>Copy image</span>
            </button>
          )}
          {canFlip && (
            <>
              <button type="button" role="menuitem" className={"order-card-more-item" + (view === "sheet" ? " is-on" : "")} onClick={() => { void flipView("sheet"); setMoreOpen(false); }}>
                <TableIcon size={14} strokeWidth={2} /><span>{view === "sheet" ? "Back to note" : "Edit as a spreadsheet"}</span>
              </button>
              <button type="button" role="menuitem" className={"order-card-more-item" + (view === "drawing" ? " is-on" : "")} onClick={() => { void flipView("drawing"); setMoreOpen(false); }}>
                <PenToolIcon size={14} strokeWidth={2} /><span>{view === "drawing" ? "Back to note" : "Edit as a drawing"}</span>
              </button>
            </>
          )}
          {canEditSource && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (sourceOpen ? " is-on" : "")} onClick={() => { toggleSource(); setMoreOpen(false); }}>
              <CodeIcon size={14} strokeWidth={2} /><span>{sourceOpen ? "Back to note" : "Edit source"}</span>
            </button>
          )}
          {isMainDoc && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (flipped ? " is-on" : "")} onClick={() => { setFlipped((f) => !f); setTermOpen(false); setMoreOpen(false); }}>
              <FolderOpenIcon size={14} strokeWidth={2} /><span>{flipped ? "Back to note" : "Folder contents"}</span>
            </button>
          )}
          {isMainDoc && !isIosSync() && (
            <button
              type="button"
              role="menuitem"
              className="order-card-more-item"
              onClick={() => { setMoreOpen(false); setFinReportOpen(true); }}
            >
              <DollarSignIcon size={14} strokeWidth={2} /><span>Generate finance report</span>
            </button>
          )}
          {!isIosSync() && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (termOpen ? " is-on" : "")} onClick={() => { setTermOpen((t) => !t); setFlipped(false); setMoreOpen(false); }}>
              <TerminalIcon size={14} strokeWidth={2} /><span>{termOpen ? "Close terminal" : "Open terminal"}</span>
            </button>
          )}
          {onTogglePin && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (isPinned ? " is-on" : "")} onClick={() => { onTogglePin(); setMoreOpen(false); }}>
              <PinIcon size={14} strokeWidth={2} /><span>{isPinned ? "Unpin note" : "Pin note"}</span>
            </button>
          )}
          {reminderDate && onSetFrontmatter && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (reminderOn ? " is-on" : "")} onClick={() => { void toggleReminder(); setMoreOpen(false); }}>
              <BellIcon size={14} strokeWidth={2} /><span>{reminderOn ? "Clear reminder" : "Set reminder"}</span>
            </button>
          )}
          {!isMainDoc && onAssignFolder && (availableFolders?.length ?? 0) > 0 && (
            <button type="button" role="menuitem" className="order-card-more-item order-card-more-refolder" onClick={() => { setFolderPickQuery(""); setFolderPickOpen(true); setMoreOpen(false); }}>
              <FolderInputIcon size={14} strokeWidth={2} /><span>{currentFolder ? `Move from ${currentFolder}…` : "Move to a folder…"}</span>
            </button>
          )}
          {!fullscreen && (
            <button type="button" role="menuitem" className={"order-card-more-item" + (isFolded ? " is-on" : "")} onClick={() => { void toggleFolded(!isFolded); setMoreOpen(false); }}>
              {isFolded ? <ChevronsUpDown size={14} strokeWidth={2} /> : <ChevronsDownUp size={14} strokeWidth={2} />}<span>{isFolded ? "Unfold" : "Fold to a line"}</span>
            </button>
          )}
          {confirmingDelete ? (
            <>
              <button type="button" role="menuitem" className="order-card-more-item is-danger" onClick={() => { void performDelete(); setMoreOpen(false); }}>
                <Trash2 size={14} strokeWidth={2} /><span>Confirm delete</span>
              </button>
              <button type="button" role="menuitem" className="order-card-more-item" onClick={cancelDeleteConfirm}>
                <XIcon size={14} strokeWidth={2.2} /><span>Cancel</span>
              </button>
            </>
          ) : (
            <button type="button" role="menuitem" className="order-card-more-item is-danger" onClick={() => startDeleteConfirm()}>
              <Trash2 size={14} strokeWidth={2} /><span>Delete note</span>
            </button>
          )}
        </div>,
        document.body,
      )}
      {/* The folder picker now lives inline in the footer (order-card-folder-slot)
          and is opened either by tapping its chip or via the ⋯ menu — both drive
          the same folderPickOpen state, so no separate popup mount is needed. */}
      {isMainDoc && !readOnly && !flipped && onCreateUpdate && updateOpen && (
        <NotableUpdateBar
          onSubmit={async (description) => {
            await onCreateUpdate(description);
            setUpdateOpen(false);
          }}
          onCancel={() => setUpdateOpen(false)}
        />
      )}
      {flipped && isMainDoc && !readOnly && vaultRootForFlip && (
        <NotableFolderBackside
          vaultRoot={vaultRootForFlip}
          folderRel={folderRelForFlip}
          folderName={folderName}
          onFlipBack={() => setFlipped(false)}
          onAddToPile={onBrowserAddToPile ? (filename: string) => { onBrowserAddToPile(filename); setFlipped(false); } : undefined}
          onRenameFile={onBrowserRename}
          onDeleteFile={onBrowserDelete}
        />
      )}
      {termOpen && !readOnly && vaultRootForFlip && (
        <div className="order-card-term-panel">
          <div className="order-card-term-head">
            <button
              type="button"
              className="order-card-term-close"
              onClick={() => setTermOpen(false)}
              title="Close terminal"
              aria-label="Close terminal"
            >
              <XIcon size={13} strokeWidth={2.2} />
            </button>
            <span className="order-card-term-title">
              <TerminalIcon size={12} strokeWidth={2} /> {folderRelForFlip || folderName}
            </span>
          </div>
          <OrderTerminal cwd={`${vaultRootForFlip}/${folderRelForFlip}`} />
        </div>
      )}
      <div
        className="order-card-content"
        ref={contentRef}
        style={
          (flipped || termOpen) && isMainDoc && !readOnly
            ? { display: "none" }
            : showSpine ? undefined
            : capActive ? { maxHeight: `${capHeight}px`, overflow: "hidden" } : undefined
        }
      >
        {inspectorOpen && !showSpine && (
          <FrontmatterInspector
            frontmatter={fmLive}
            onChange={onSetFrontmatter ? (patch) => { void onSetFrontmatter(patch); } : undefined}
            folderCandidates={availableFolders?.map((f) => f.name)}
            recentFolders={recentFolders}
            folderColorFor={(ref) => availableFolders?.find((f) => f.name === ref)?.color}
            filename={editableTitle}
            onRenameFile={(!isMainDoc && !readOnly && !isImageNote && !isHtmlNote) ? renameFile : undefined}
          />
        )}
        {showSpine ? (
          // Folded spine: title only. Click anywhere to unfold — in the
          // editor that clears the persistent YAML flag (symmetric with
          // the fold button in the top-right strip); the read-only
          // viewer can't write, so it reveals for the session instead.
          // The editor isn't mounted until revealed, so a folded card
          // stays cheap in a long pile.
          <button
            type="button"
            className="order-card-spine"
            onClick={() => { if (readOnly) setUnfolded(true); else void toggleFolded(false); }}
            title="Click to unfold"
          >
            <EyeOffIcon size={13} strokeWidth={2} className="order-card-spine-icon" />
            <span className="order-card-spine-title">{spineTitle}</span>
            <span className="order-card-spine-hint">folded</span>
          </button>
        ) : isImageNote ? (
          // A date-prefixed image surfaced as its own folder card.
          <ImageCard path={pathRef.current} onRenamed={(p) => onRenamedRef.current?.(p)} onExpand={fullscreen ? undefined : () => setFullscreen(true)} />
        ) : isChatNote ? (
          // Agent conversation. ChatSurface owns the whole body: it renders the
          // transcript, streams the live turn, and handles write-approval. The
          // Rust core does every file touch + model call.
          <ChatSurface path={pathRef.current} autoFocus={autoFocus && !readOnly} onMaybeTitle={onMaybeChatTitle} />
        ) : isCsvNote ? (
          // Raw CSV rendered as a table (Finance report snapshots + any CSV).
          <CsvSurface path={pathRef.current} />
        ) : isHtmlNote ? (
          // Dated HTML note: render the page itself in a sandboxed frame, filling
          // the card (and the whole screen in fullscreen) so you see at a glance
          // what it shows. Served from disk via the vaultasset:// scheme, so
          // sibling assets (css/js/images) it references resolve too.
          <iframe
            className="order-html-frame"
            // `_v` cache-busts on external file changes (the watcher bumps
            // externalBodyVersion) so the page reloads live when the file is
            // edited — in fullscreen or not — without remounting the card.
            src={`${assetUrl(toVaultRel(pathRef.current))}?_zoom=${textScale}&_v=${externalBodyVersion ?? 0}`}
            title={filename.replace(/\.html?$/i, "")}
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals allow-downloads"
          />
        ) : view === "sheet" ? (
          <Suspense fallback={<div className="order-surface-loading">Loading sheet…</div>}>
            {sheetContent !== null && (
              <SheetSurface
                initial={sheetContent}
                onChange={saveSheet}
                readOnly={readOnly}
                minimal={!fullscreen}
                onExpand={() => setFullscreen(true)}
                minRows={fullscreen ? 40 : 12}
                minCols={fullscreen ? 20 : 8}
              />
            )}
          </Suspense>
        ) : view === "drawing" ? (
          <Suspense fallback={<div className="order-surface-loading">Loading drawing…</div>}>
            {drawingContent !== null && (
              <DrawingSurface initial={drawingContent} onChange={saveDrawing} readOnly={readOnly} fullscreen={fullscreen} />
            )}
          </Suspense>
        ) : isSpacetimeFile(filename) ? (
          // Spacetime source (spacetime.md / *.spacetime.md / legacy .mw) —
          // CodeMirror with Markdown highlighting, edited as raw markwhen
          <CodeMirrorSurface
            value={state.body}
            onChange={handleChange}
            lang="markdown"
            readOnly={readOnly}
          />
        ) : /\.ya?ml$/i.test(filename) ? (
          // YAML file (spacetime.yml, etc.) — CodeMirror with YAML highlighting
          <CodeMirrorSurface
            value={state.body}
            onChange={handleChange}
            lang="yaml"
            readOnly={readOnly}
          />
        ) : /\.txt$/i.test(filename) ? (
          // Plain-text card surface — no highlighting (todo.txt)
          <RawTextSurface
            initial={state.body}
            onChange={handleChange}
            onDone={() => { void flushNow(); }}
            autoFocus={autoFocus && !readOnly}
            readOnly={readOnly}
          />
        ) : sourceOpen ? (
          // Raw-markdown escape hatch (More → Edit source). Edits the on-disk
          // file body verbatim with its own debounced save; toggling back
          // rebuilds the WYSIWYG editor from disk (see toggleSource).
          <CodeMirrorSurface
            value={sourceDraft}
            onChange={(v) => { setSourceDraft(v); scheduleSourceSave(v); }}
            lang="markdown"
            readOnly={readOnly}
          />
        ) : (
          <MilkdownSurface
            ref={milkdownRef}
            initial={state.body}
            onChange={handleChange}
            onDone={handleEditorDone}
            onImageUpload={readOnly ? undefined : handleImageUpload}
            wikiNotes={vaultNotes}
            onWikiNavigate={handleWikiNavigate}
            autoFocus={autoFocus && !readOnly}
            readOnly={readOnly}
            noteDir={vaultDir(toVaultRel(pathRef.current))}
          />
        )}
        {isListFolder(fmLive) && !sourceOpen && (
          <>
            {parsedBase && (
              <div className="order-card-list-controls">
                <span className="order-card-list-mode">
                  base · {parsedBase.view.name ?? "view"}
                  {parsedBase.unsupported.length > 0 && (
                    <span
                      className="order-card-list-hint"
                      title={parsedBase.unsupported.join("\n")}
                    >
                      {" "}({parsedBase.unsupported.length} unsupported)
                    </span>
                  )}
                </span>
                {manualOrder.length > 0 && (
                  <button
                    type="button"
                    className="order-card-list-reset"
                    onClick={resetManualOrder}
                    title="Discard manual order and re-sort from the base"
                  >
                    Reset order
                  </button>
                )}
              </div>
            )}
            <ListView
              render={isListOfLists ? "lines" : (parsedBase?.view.type ?? listRender(fmLive) ?? "cards")}
              items={itemsForView}
              vaultNotes={vaultNotes ?? []}
              onChange={handleListChange}
              readOnly={readOnly}
              readOnlyMembership={!!parsedBase}
              expandSublists={isListOfLists}
              onNavigate={onNavigate ? (ref) => { if (fullscreen) setFullscreen(false); onNavigate(ref); } : undefined}
              onAddFilter={onAddFilter ? (ref) => { if (fullscreen) setFullscreen(false); onAddFilter(ref); } : undefined}
              noteDir={vaultDir(toVaultRel(pathRef.current))}
              onUploadImage={readOnly ? undefined : handleImageUpload}
            />
          </>
        )}
        {capActive && overflowing && <div className="order-card-fade" aria-hidden />}
      </div>
      {/* One reversible truncation control (#23): capped-and-overflowing shows
          "Read more" to lift the cap; once expanded the same control becomes
          "Show less" to re-cap. Collapsing scrolls the card top back into view
          so you're never stranded partway down the (now-hidden) tail. */}
      {capHeight !== undefined && !fullscreen && (overflowing || expanded) && (
        <button
          type="button"
          className={"order-card-readmore" + (expanded ? " is-expanded" : "")}
          onClick={() => {
            setExpanded((v) => {
              const next = !v;
              if (!next) {
                // Re-folding: bring the card head back into view.
                requestAnimationFrame(() => {
                  articleRef.current?.scrollIntoView({ block: "nearest" });
                });
              }
              return next;
            });
          }}
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>
          {readOnly ? "" : (saving ? "saving…" : "saved")}
        </span>
        {/* Middle slot: breadcrumb for Notable Folders; folder picker
            for regular notes; both together when an NF Main Doc also
            carries a `folder:` (e.g. an article that's its own NF
            but lives inside the Articles list). */}
        {(area || category) && (
          <span className="order-card-breadcrumb" style={color ? { color } : undefined}>
            {area && <span>{area}</span>}
            {area && category && <ChevronRight size={11} strokeWidth={2} className="order-card-breadcrumb-sep" />}
            {category && <span>{category}</span>}
          </span>
        )}
        {/* Notable Folder chip — a clear-but-subtle way to change a card's
            folder right from the card. Shows the current folder; tapping it
            opens the picker (moving the file into that folder's directory —
            placement is structural, there is no folder frontmatter). The ⋯
            menu's "Move to a folder…" drives the same folderPickOpen state. */}
        {!isMainDoc && onAssignFolder && (availableFolders?.length ?? 0) > 0 && !readOnly && (
          <span className="order-card-folder-slot">
            <FolderPicker
              current={currentFolder ?? null}
              available={availableFolders ?? []}
              open={folderPickOpen}
              query={folderPickQuery}
              onOpen={() => { setFolderPickQuery(""); setFolderPickOpen(true); }}
              onClose={() => setFolderPickOpen(false)}
              onQueryChange={setFolderPickQuery}
              onAssign={async (name) => { setFolderPickOpen(false); if (name) await onAssignFolder(name); }}
              recents={recentFolders}
            />
          </span>
        )}
        {finReportOpen && (
          <FinanceReportModal
            dirRel={(() => { const r = toVaultRel(pathRef.current); return r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : ""; })()}
            onClose={() => setFinReportOpen(false)}
            onCreateEvents={onCreatePurchaseEvents}
          />
        )}
      </div>
      {deleteError && (
        <div className="order-card-error" role="alert">
          delete failed: {deleteError}
          <button type="button" className="dismiss-btn" onClick={() => setDeleteError(null)}>×</button>
        </div>
      )}
    </article>
  );
}

interface FolderPickerProps {
  current: string | null;
  available: { name: string; color: string }[];
  open: boolean;
  query: string;
  onOpen: () => void;
  onClose: () => void;
  onQueryChange: (q: string) => void;
  onAssign: (name: string | null) => Promise<void>;
  /** Most-recent-first folder refs. With an empty query these land on
   *  top of the dropdown so the picker reads as "recents first" — same
   *  contract as FolderAutocomplete. */
  recents?: string[];
}

export function FolderPicker({ current, available, open, query, onOpen, onClose, onQueryChange, onAssign, recents }: FolderPickerProps) {
  // The dropdown is position:fixed (positioned from the input's rect) so it
  // escapes the card grid's overflow clipping / stacking and never sits
  // behind sibling cards.
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // `placed` gates opacity so the menu doesn't flash at 0,0 for one frame
  // before the first rAF positions it. Position itself lives in the DOM node,
  // not React state (see below).
  const [placed, setPlaced] = useState(false);
  // Keep the fixed dropdown glued to the input on EVERY paint frame via a
  // continuous requestAnimationFrame poll — the same trick Floating UI's
  // autoUpdate uses. Scroll/resize listeners are throttled during iOS momentum
  // scrolling, so a fixed element repositioned from those events visibly
  // detaches from the input and snaps back; polling per frame tracks smoothly.
  //
  // Crucially, top/left/maxHeight are written straight to the DOM node and are
  // NEVER in the JSX style object, so a query-driven re-render can't clobber
  // them (React only reconciles style props it owns). React owns only
  // position/opacity. It also grows UPWARD when the keyboard leaves no room
  // below, hugging the input from just above, and tracks the visual viewport.
  useLayoutEffect(() => {
    if (!open) { setPlaced(false); return; }
    let raf = 0;
    let didPlace = false;
    const place = () => {
      const el = inputRef.current;
      const menu = menuRef.current;
      if (el && menu) {
        const r = el.getBoundingClientRect();
        const vv = window.visualViewport;
        const vTop = vv ? vv.offsetTop : 0;
        const vh = vv ? vv.height : window.innerHeight;
        const gap = 6, pad = 8;
        const menuH = menu.scrollHeight;
        const spaceBelow = (vTop + vh) - r.bottom - gap - pad;
        const spaceAbove = r.top - vTop - gap - pad;
        const below = spaceBelow >= Math.min(menuH, 160) || spaceBelow >= spaceAbove;
        let top: number, maxH: number;
        if (below) {
          top = r.bottom + gap;
          maxH = Math.max(120, spaceBelow);
        } else {
          maxH = Math.max(120, spaceAbove);
          top = Math.max(vTop + pad, r.top - gap - Math.min(menuH, spaceAbove));
        }
        menu.style.top = `${Math.round(top)}px`;
        menu.style.left = `${Math.round(r.left)}px`;
        menu.style.maxHeight = `${Math.round(maxH)}px`;
        if (!didPlace) { didPlace = true; setPlaced(true); }
      }
      raf = requestAnimationFrame(place);
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Recents-first when the query is empty (most-recent on top, then
  // the rest alphabetically); substring filter with prefix-match
  // ranking once the user has typed anything. Each row carries a
  // `recent` flag so the dropdown can render the "recent" badge.
  const matches: { name: string; color: string; recent: boolean }[] = (() => {
    const byName = new Map(available.map((f) => [f.name, f]));
    const q = query.trim().toLowerCase();
    if (!q) {
      const seen = new Set<string>();
      const out: { name: string; color: string; recent: boolean }[] = [];
      for (const r of (recents ?? [])) {
        const f = byName.get(r);
        if (!f || seen.has(f.name)) continue;
        seen.add(f.name);
        out.push({ ...f, recent: true });
        if (out.length >= 8) return out;
      }
      const rest = [...available]
        .filter((f) => !seen.has(f.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const f of rest) {
        out.push({ ...f, recent: false });
        if (out.length >= 8) break;
      }
      return out;
    }
    return available
      .filter((f) => f.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.name.localeCompare(b.name);
      })
      .slice(0, 8)
      .map((f) => ({ ...f, recent: false }));
  })();

  if (current && !open) {
    const f = available.find((x) => x.name === current);
    const color = f?.color;
    const label = (
      <>
        <FolderIcon size={10} strokeWidth={2} />
        <span className="order-card-folder-name">{current}</span>
      </>
    );
    return (
      <span className="order-card-folder-chip" style={color ? { color, borderColor: color + "55" } : undefined} title={current}>
        {available.length > 0 ? (
          // Click the chip to move this note to another Notable Folder.
          // (No remove affordance — a note always lives in a folder.)
          <button
            type="button"
            className="order-card-folder-chip-btn"
            onClick={onOpen}
            title={`Change folder — currently ${current}`}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </span>
    );
  }

  if (!open) {
    return (
      <button type="button" className="order-card-folder-add" onClick={onOpen}>
        + folder
      </button>
    );
  }

  return (
    <span className="order-card-folder-picker">
      <input
        ref={inputRef}
        autoFocus
        className="order-card-folder-input"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Enter" && matches[0]) { e.preventDefault(); void onAssign(matches[0].name); }
        }}
        // Option rows commit on mouseDown (with preventDefault), so a
        // click on one never blurs first — blur only means "clicked away".
        onBlur={onClose}
        placeholder="Assign folder…"
      />
      {matches.length > 0 && createPortal(
        // Rendered into <body> so NO card ancestor (transform / overflow /
        // stacking context) can clip or trap it — fixed coords come from
        // the input's on-screen rect. top/left/maxHeight are set imperatively
        // by the rAF loop above (kept out of this style object on purpose so
        // re-renders never reset them); opacity hides the pre-placement frame.
        <ul
          ref={menuRef}
          className="order-card-folder-options"
          style={{ position: "fixed", overflowY: "auto", opacity: placed ? 1 : 0, pointerEvents: placed ? "auto" : "none" }}
        >
          {matches.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                className="order-card-folder-option"
                onMouseDown={(e) => { e.preventDefault(); void onAssign(f.name); }}
              >
                <span className="order-card-folder-swatch" style={{ background: f.color }} />
                <span className="order-card-folder-option-name">{f.name}</span>
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </span>
  );
}

/** Inline "notable update" prompt that drops below the card chrome
 *  when the user taps the + icon in the control strip. Parent owns
 *  the open/close state so it's driven by the same button that
 *  rendered the icon; we just show the input + buttons. */
function NotableUpdateBar({
  onSubmit,
  onCancel,
}: {
  onSubmit: (description: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  async function commit() {
    const t = text.trim();
    if (!t) { onCancel(); return; }
    setBusy(true);
    try { await onSubmit(t); }
    finally { setBusy(false); setText(""); }
  }
  return (
    <div className="nf-update-bar">
      <input
        ref={inputRef}
        type="text"
        className="nf-update-input"
        placeholder="Brief description…"
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); void commit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
      />
      <button
        type="button"
        className="nf-update-save"
        onClick={() => { void commit(); }}
        disabled={busy || !text.trim()}
      >
        {busy ? "…" : "Save"}
      </button>
      <button
        type="button"
        className="nf-update-cancel"
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel"
      >
        ×
      </button>
    </div>
  );
}
