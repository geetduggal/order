// One Card. Reads its file, strips frontmatter, hands the body to Milkdown
// Crepe, recombines on save. After each save, if the body's explicit h1
// has changed, the file gets renamed to `<date> <title>.md` (Obsidian
// Full Calendar convention) and the parent is notified so calendar
// views stay in sync.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { dirname, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { vaultRoot, toVaultRel } from "../lib/vault";
import { vaultFs, markKnownBody } from "../lib/vault-fs";
import { MilkdownSurface } from "./MilkdownSurface";
import {
  basenameForEvent,
  firstLineTitle,
  isoDate,
  isoTime,
  joinFrontmatter,
  splitFrontmatter,
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
import { folderColor, isNotableFolder, noteFolder, parseRef } from "../lib/folders";
import { resolveWikilink } from "../lib/wikilink";
import {
  attachmentAssetPrefix,
  assetUrl,
  deflateImageEmbeds,
  inflateAttachmentUrls,
  inflateImageEmbeds,
  vaultDir,
} from "../lib/attachments";
import {
  inflateEmbedFencesToImage,
  restoreEmbedFences,
  type EmbedFenceRestore,
} from "../lib/youtube";
import { Braces, Check, ChevronRight, Folder as FolderIcon, Link2, Trash2, X as XIcon, FolderOpen as FolderOpenIcon, Home as HomeIcon, List as ListIcon, LayoutGrid as LayoutGridIcon, AlignJustify as AlignJustifyIcon, Plus as PlusIcon, Copy as CopyIcon, Maximize2 as Maximize2Icon, Minimize2 as Minimize2Icon } from "lucide-react";
import { NotableFolderBackside } from "./NotableFolderBackside";
import { isIosSync } from "../lib/vault";

const SAVE_DEBOUNCE_MS = 600;

function attachmentName(file: File): string {
  const baseName = (file.name || "image").split(/[/\\]/).pop() ?? "image";
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const extFromName = dot > 0 ? baseName.slice(dot + 1).toLowerCase() : null;
  const extFromMime = file.type.startsWith("image/") ? file.type.slice("image/".length) : null;
  const ext = (extFromName || extFromMime || "png").replace(/[^a-z0-9]/g, "");
  const stamp = `${isoDate()}-${isoTime().replace(":", "")}`;
  return `${stem}-${stamp}.${ext}`;
}

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

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; body: string; frontmatter: Frontmatter; rawFm: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
  onRenamed?: (newPath: string) => void;
  onTitleChanged?: (newTitle: string) => void;
  /** Called when the user confirms deletion of this card. Card flushes
   *  pending saves first so we don't recreate the file after delete. */
  onDelete?: (path: string) => Promise<void>;
  /** Optional Notable Folder color. Renders as a left-border accent
   *  so cards visually group by folder in the Stream. */
  color?: string;
  /** When this card IS a Notable Folder Main Document, these populate
   *  the "Area › Category" breadcrumb in the footer. */
  area?: string;
  category?: string;
  /** When this card is a regular note, this is its currently assigned
   *  Notable Folder (or null). The autocomplete in the footer reads /
   *  writes it through `onAssignFolder`. */
  currentFolder?: string | null;
  /** All Notable Folders in the vault — used to populate the folder
   *  autocomplete. Each carries the same color we render the chip in. */
  availableFolders?: { name: string; color: string }[];
  /** Called when the user picks (or clears) a folder for this note.
   *  Pass null to clear. CardGrid persists to YAML + updates state. */
  onAssignFolder?: (name: string | null) => Promise<void>;
  /** Toggle the note's `public:` YAML flag. CardGrid persists and
   *  updates state so the footer pill reflects the new value. */
  onTogglePublic?: (makePublic: boolean) => Promise<void>;
  /** Authoritative `public:` value driven by CardGrid's note state.
   *  The footer pill reads this so the label flips immediately after
   *  the toggle handler resolves (Card's own loaded state is captured
   *  once on mount and would otherwise stay stale). */
  isPublic?: boolean;
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
  listMode?: "none" | "cards" | "lines";
  onCycleList?: () => Promise<void> | void;
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000;

// Wikilink + URL splitter used by the YAML peek popover. Splits a
// string into a sequence of plain-text and clickable segments. Order
// matters: try wikilink first (more specific shape), then URLs.
const FM_TOKEN_RE = /(\[\[[^\]\n]+?\]\])|((?:https?|mailto|tel):[^\s)<>]+)/g;
function fmTokens(text: string): Array<
  | { kind: "text"; value: string }
  | { kind: "wiki"; ref: string; alt?: string }
  | { kind: "url"; href: string }
> {
  const out: ReturnType<typeof fmTokens> = [];
  let last = 0;
  for (const m of text.matchAll(FM_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ kind: "text", value: text.slice(last, idx) });
    if (m[1]) {
      const inner = m[1].slice(2, -2);
      const pipe = inner.indexOf("|");
      const ref = pipe >= 0 ? inner.slice(0, pipe).trim() : inner.trim();
      const alt = pipe >= 0 ? inner.slice(pipe + 1).trim() : undefined;
      out.push({ kind: "wiki", ref, alt });
    } else if (m[2]) {
      out.push({ kind: "url", href: m[2] });
    }
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", value: text.slice(last) });
  return out;
}

function FmInline({
  text, onNavigate,
}: { text: string; onNavigate: (ref: string) => void }) {
  const parts = fmTokens(text);
  if (parts.length === 1 && parts[0].kind === "text") return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "text") return <span key={i}>{p.value}</span>;
        if (p.kind === "wiki") return (
          <a
            key={i}
            className="order-card-fm-link order-card-fm-link-wiki"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onNavigate(p.ref); }}
            href="#"
            title={`Open ${p.ref}`}
          >
            {p.alt || p.ref}
          </a>
        );
        return (
          <a
            key={i}
            className="order-card-fm-link order-card-fm-link-url"
            href={p.href}
            target="_blank"
            rel="noreferrer"
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              try { await invoke("open_url", { url: p.href }); }
              catch (err) { console.warn("open_url failed:", err); }
            }}
          >
            {p.href.replace(/^https?:\/\//, "")}
          </a>
        );
      })}
    </>
  );
}

function FmValue({
  value, onNavigate,
}: { value: unknown; onNavigate: (ref: string) => void }) {
  if (value === null || value === undefined || value === "") {
    return <span className="order-card-fm-null">—</span>;
  }
  if (typeof value === "boolean") {
    return <span className="order-card-fm-bool">{value ? "true" : "false"}</span>;
  }
  if (typeof value === "number") {
    return <span className="order-card-fm-num">{value}</span>;
  }
  if (value instanceof Date) {
    return <span className="order-card-fm-date">{value.toISOString().slice(0, 10)}</span>;
  }
  if (typeof value === "string") {
    return <FmInline text={value} onNavigate={onNavigate} />;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="order-card-fm-null">[]</span>;
    return (
      <ul className="order-card-fm-list">
        {value.map((it, i) => (
          <li key={i}><FmValue value={it} onNavigate={onNavigate} /></li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="order-card-fm-null">{"{}"}</span>;
    return (
      <dl className="order-card-fm-grid order-card-fm-grid-nested">
        {entries.map(([k, v]) => (
          <div className="order-card-fm-row" key={k}>
            <dt className="order-card-fm-key">{k}</dt>
            <dd className="order-card-fm-val"><FmValue value={v} onNavigate={onNavigate} /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

export function Card(props: Props) {
  const {
    path: initialPath,
    onRenamed,
    onTitleChanged,
    onDelete,
    color,
    area,
    category,
    currentFolder,
    availableFolders,
    onAssignFolder,
    onTogglePublic,
    isPublic,
    vaultNotes,
    onNavigate,
    onAddFilter,
    onRemoveFromFilter,
    autoFocus,
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
  } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Notable Folder Main Documents only: flips the card to the folder
   *  contents browser (see NotableFolderBackside). Desktop-only
   *  feature; the calling card hides the flip button on iOS / viewer.
   *  Lives at the TOP of the hook list so the early-return loading /
   *  error branches don't change hook count between renders. */
  const [flipped, setFlipped] = useState(false);
  const [vaultRootForFlip, setVaultRootForFlip] = useState<string | null>(null);
  useEffect(() => {
    if (!flipped || vaultRootForFlip !== null || readOnly) return;
    let cancelled = false;
    void vaultRoot().then((r) => { if (!cancelled) setVaultRootForFlip(r); });
    return () => { cancelled = true; };
  }, [flipped, vaultRootForFlip, readOnly]);
  /** Newspaper height-cap state: `expanded` lifts the cap (Read more
   *  or, when editable, focusing the card); `overflowing` is whether
   *  the body actually exceeds the cap (only then do we show the
   *  fade + Read more). */
  const [expanded, setExpanded] = useState(false);
  /** Frontmatter strip collapsed (just the `{ }` toggle) vs. shown
   *  (full key/value pairs). Default is initialized once state loads:
   *  collapsed when the body has substantial content (the user is
   *  reading prose; YAML metadata is a distraction), shown when the
   *  body is essentially empty (the YAML IS the content). */
  const [fmCollapsed, setFmCollapsed] = useState<boolean | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** Lifecycle state that drives the delete exit animation. */
  const [exiting, setExiting] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Folder picker (autocomplete) state for regular notes. */
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerQuery, setFolderPickerQuery] = useState("");
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
  const [pendingListMode, setPendingListMode] = useState<"none" | "cards" | "lines" | null>(null);
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
  const copyBodyText = useCallback(() => {
    // editorBodyRef is populated both on load (setEditorBody during
    // the read effect) and on every editor change, so it's the
    // single source of truth even before the user has typed.
    const src = editorBodyRef.current;
    if (!src) return;
    void navigator.clipboard?.writeText(src);
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
  useEffect(() => { onRenamedRef.current = onRenamed; }, [onRenamed]);
  useEffect(() => { onTitleChangedRef.current = onTitleChanged; }, [onTitleChanged]);

  const pendingBody = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(0);
  const lastTitleRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
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
        lastTitleRef.current = firstLineTitle(editorInitial);
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

      // Auto-rename whenever the body's first line of text changes —
      // heading or not. firstLineTitle strips leading markdown markers
      // (#, -, *, >) so the filename always tracks the visible first
      // line. Empty body skips rename (file keeps "Untitled" or the
      // last name the user typed).
      // Notable Folder Main Documents skip rename because their filename
      // IS the folder's identity (other notes reference it via
      // `folder: [[Books]]` and that link would break on rename).
      const title = firstLineTitle(body);
      const isMain = isNotableFolder(frontmatter);
      if (!isMain && title && title !== lastTitleRef.current) {
        const date = typeof frontmatter.date === "string" ? frontmatter.date : undefined;
        const desired = basenameForEvent(date, title);
        const currentFilename = path.split("/").pop() ?? path;
        if (desired !== currentFilename) {
          try {
            const dir = await dirname(path);
            const newPath = await uniqueRename(dir, path, desired);
            if (newPath !== path) {
              pathRef.current = newPath;
              onRenamedRef.current?.(newPath);
            }
          } catch (err) {
            console.warn("rename failed:", err);
          }
        }
        lastTitleRef.current = title;
        onTitleChangedRef.current?.(title);
      } else if (!title && lastTitleRef.current !== null) {
        // Body went empty — leave the filename alone but stop tracking
        // the old title so the next non-empty save triggers a rename.
        lastTitleRef.current = null;
      }
    } catch (err) {
      console.error("write_text failed:", err);
    } finally {
      inflight.current -= 1;
      if (inflight.current === 0) setSaving(false);
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow, readOnly]);

  const handleChange = useCallback((markdown: string) => {
    pendingBody.current = markdown;
    editorBodyRef.current = markdown;
    setEditorBody(markdown);
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
        (n) => n.filename.replace(/\.md$/i, "").toLowerCase() === item.ref.toLowerCase(),
      );
      return !!(note && (note.frontmatter.list || note.frontmatter.type === "list"));
    });
  }, [itemsForView, vaultNotes]);

  // Click on a rendered `[[Name]]` in the editor: resolve folder vs note
  // and route. Folder links accumulate into the filter (like list NF
  // clicks); note links navigate. Broken links no-op.
  const handleWikiNavigate = useCallback((name: string) => {
    const res = resolveWikilink(name, vaultNotes ?? []);
    if (res.kind === "broken") return;
    const ref = res.ref.filename.replace(/\.md$/i, "");
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

  // Esc exits fullscreen via the same animated path as the button.
  useEffect(() => {
    if (!fullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        toggleFullscreen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, toggleFullscreen]);

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
  // Decide frontmatter strip default once the body is loaded.
  // "Substantial" = anything beyond a single H1 heading (with
  // surrounding whitespace) — so a calendar event that's just
  // "# Some title" still surfaces its YAML, but a note with even
  // one paragraph of prose collapses the strip out of the way.
  useEffect(() => {
    if (state.kind !== "ready" || fmCollapsed !== null) return;
    const body = state.body || "";
    // Strip everything that's "just the title" — leading whitespace,
    // an H1 line, and trailing whitespace. Anything left counts as
    // substantial. Setext-style headings (=== underlines) and HTML
    // block tags like <br /> are also peeled off.
    const remainder = body
      .replace(/^\s*#\s+[^\n]*\n?/, "")
      .replace(/^\s*[^\n]+\n=+\s*\n?/, "")
      .replace(/^\s*<br\s*\/?>\s*/i, "")
      .trim();
    setFmCollapsed(remainder.length > 0);
  }, [state, fmCollapsed]);

  const filename = pathRef.current.split("/").pop() ?? pathRef.current;

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
  const isMainDoc = isNotableFolder(state.frontmatter);
  const folderRelForFlip = vaultDir(toVaultRel(pathRef.current));
  const folderName = pathRef.current.split("/").pop()?.replace(/\.md$/i, "") ?? "";
  const cardClass =
    "order-card" +
    (isMainDoc ? " is-main" : "") +
    (isMainDoc && props.visited ? " is-visited" : "") +
    (fullscreen ? " is-fullscreen" : "") +
    (exiting ? " is-exiting" : "") +
    (capActive && overflowing ? " is-capped" : "");

  // Subtle full-border tint in the card's folder color (≈33% alpha).
  // Skipped when no color is available so the default rule color
  // stays. `${color}55` works because folderColor returns a 6-digit
  // hex string. Main Docs (NF covers) drop the folder tint so the
  // permanent coral highlight defined in styles.css can take over.
  const cardStyle: React.CSSProperties | undefined = (color && !isMainDoc)
    ? { borderColor: `${color}88` }
    : undefined;

  return (
    <article
      className={cardClass}
      style={cardStyle}
      ref={articleRef}
      onMouseDown={onCardFocus}
    >
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
      <div className="order-card-controls" aria-hidden={false}>
        {isMainDoc && !readOnly && onSetHome && (
          <button
            type="button"
            className={"order-card-btn order-card-home" + (effectiveIsHome ? " is-on" : "")}
            onClick={() => {
              // Optimistically toggle so the icon flips immediately.
              // If the parent's confirm/prompt is cancelled the prop
              // never advances, the pending value lingers harmless,
              // and the next render after a real change clears it.
              setPendingHome(!effectiveIsHome);
              void onSetHome();
            }}
            title={effectiveIsHome ? "This is the home folder — tap to clear" : "Mark as home folder (will prompt for publish URL)"}
            aria-label={effectiveIsHome ? "Clear home folder" : "Mark as home folder"}
            aria-pressed={effectiveIsHome}
          >
            <HomeIcon size={14} strokeWidth={2} />
          </button>
        )}
        {isMainDoc && !readOnly && onCycleList && (
          <button
            type="button"
            className={"order-card-btn order-card-list is-" + effectiveListMode}
            onClick={() => {
              // Same optimistic pattern — flip locally on tap so the
              // icon swaps the moment the user touches the button.
              const next = effectiveListMode === "none" ? "cards"
                : effectiveListMode === "cards" ? "lines"
                : "none";
              setPendingListMode(next);
              void onCycleList();
            }}
            title={
              effectiveListMode === "cards" ? "List: cards — tap for lines" :
              effectiveListMode === "lines" ? "List: lines — tap to drop" :
              "Make this a list folder (cards)"
            }
            aria-label="Cycle list mode"
          >
            {effectiveListMode === "cards"
              ? <LayoutGridIcon size={14} strokeWidth={2} />
              : effectiveListMode === "lines"
                ? <AlignJustifyIcon size={14} strokeWidth={2} />
                : <ListIcon size={14} strokeWidth={2} />}
          </button>
        )}
        {isMainDoc && !readOnly && onCreateUpdate && (
          <button
            type="button"
            className={"order-card-btn order-card-update" + (updateOpen ? " is-on" : "")}
            onClick={() => setUpdateOpen((v) => !v)}
            title={updateOpen ? "Close notable update" : "Log a notable update"}
            aria-label="Notable update"
            aria-pressed={updateOpen}
          >
            <PlusIcon size={14} strokeWidth={2} />
          </button>
        )}
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
        {isMainDoc && !readOnly && (
          <button
            type="button"
            className={"order-card-btn order-card-flip" + (flipped ? " is-on" : "")}
            onClick={() => setFlipped((f) => !f)}
            title={flipped ? "Back to note" : "Folder contents"}
            aria-label={flipped ? "Show note" : "Show folder contents"}
            aria-pressed={flipped}
          >
            <FolderOpenIcon size={14} strokeWidth={2} />
          </button>
        )}
        {!readOnly && (confirmingDelete ? (
          <span className="order-card-delete-confirm">
            <button
              type="button"
              className="confirm-btn"
              onClick={() => { void performDelete(); }}
            >
              delete?
            </button>
            <button
              type="button"
              className="cancel-btn"
              onClick={cancelDeleteConfirm}
              title="Cancel"
              aria-label="Cancel delete"
            >
              ×
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="order-card-btn order-card-delete"
            onClick={startDeleteConfirm}
            title="Delete this note"
            aria-label="Delete note"
          >
            <Trash2 size={14} strokeWidth={2} />
          </button>
        ))}
        <button
          type="button"
          className="order-card-btn order-card-fullscreen"
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {fullscreen ? <Minimize2Icon size={14} strokeWidth={2} /> : <Maximize2Icon size={14} strokeWidth={2} />}
        </button>
        {onRemoveFromFilter && !confirmingDelete && (
          <button
            type="button"
            className="order-card-btn order-card-dismiss"
            onClick={onRemoveFromFilter}
            title="Remove from filtered view"
            aria-label="Remove from filtered view"
          >
            <XIcon size={14} strokeWidth={2.4} />
          </button>
        )}
      </div>
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
        />
      )}
      <div
        className="order-card-content"
        ref={contentRef}
        style={
          flipped && isMainDoc && !readOnly
            ? { display: "none" }
            : capActive ? { maxHeight: `${capHeight}px`, overflow: "hidden" } : undefined
        }
      >
        <MilkdownSurface
          initial={state.body}
          onChange={handleChange}
          onDone={() => { void flushNow(); }}
          onImageUpload={readOnly ? undefined : handleImageUpload}
          wikiNotes={vaultNotes}
          onWikiNavigate={handleWikiNavigate}
          autoFocus={autoFocus && !readOnly}
          readOnly={readOnly}
          noteDir={vaultDir(toVaultRel(pathRef.current))}
        />
        {isListFolder(state.frontmatter) && (
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
              render={isListOfLists ? "lines" : (parsedBase?.view.type ?? listRender(state.frontmatter) ?? "cards")}
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
      {capActive && overflowing && (
        <button
          type="button"
          className="order-card-readmore"
          onClick={() => setExpanded(true)}
        >
          Read more
        </button>
      )}
      {Object.keys(state.frontmatter).length > 0 && (
        fmCollapsed
          ? (
            <footer className="order-card-fm is-collapsed" aria-label="Frontmatter (collapsed)">
              <button
                type="button"
                className="order-card-fm-toggle"
                onClick={() => setFmCollapsed(false)}
                title="Show frontmatter"
                aria-label="Show frontmatter"
                aria-expanded={false}
              >
                <Braces size={12} strokeWidth={2} />
              </button>
            </footer>
          )
          : (
            <footer className="order-card-fm" aria-label="Frontmatter">
              <button
                type="button"
                className="order-card-fm-toggle"
                onClick={() => setFmCollapsed(true)}
                title="Hide frontmatter"
                aria-label="Hide frontmatter"
                aria-expanded={true}
              >
                <Braces size={12} strokeWidth={2} />
              </button>
              {Object.entries(state.frontmatter).map(([k, v]) => (
                <span className="order-card-fm-pair" key={k}>
                  <span className="order-card-fm-key">{k}</span>
                  <span className="order-card-fm-val">
                    <FmValue value={v} onNavigate={handleWikiNavigate} />
                  </span>
                </span>
              ))}
            </footer>
          )
      )}
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>
          {readOnly ? "" : (saving ? "saving…" : "saved")}
        </span>
        {onTogglePublic && (() => {
          // Prefer the prop (driven by CardGrid's notes state) so the
          // pill flips synchronously with the toggle; fall back to the
          // initially-loaded frontmatter if no prop was passed.
          const isPub = isPublic !== undefined
            ? isPublic
            : state.frontmatter.public === true;
          return (
            <button
              type="button"
              className={"order-card-public" + (isPub ? " is-on" : "")}
              onClick={() => { void onTogglePublic(!isPub); }}
              title={isPub ? "This note is in the public set" : "Mark as public"}
              aria-pressed={isPub}
            >
              {isPub ? "public" : "private"}
            </button>
          );
        })()}
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
        {/* Folder picker stays available even when an Area › Category
            breadcrumb is showing, so the user can re-select the
            Notable Folder for a note that already lives in one. The
            breadcrumb shows where the note is in the taxonomy; the
            chip shows which NF it's assigned to. */}
        {onAssignFolder && (
          <FolderPicker
            current={currentFolder ?? null}
            available={availableFolders ?? []}
            open={folderPickerOpen}
            query={folderPickerQuery}
            onOpen={() => setFolderPickerOpen(true)}
            onClose={() => { setFolderPickerOpen(false); setFolderPickerQuery(""); }}
            onQueryChange={setFolderPickerQuery}
            onAssign={async (name) => {
              await onAssignFolder?.(name);
              setFolderPickerOpen(false);
              setFolderPickerQuery("");
            }}
          />
        )}
        <span className="order-card-path" title={pathRef.current}>{filename}</span>
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
}

export function FolderPicker({ current, available, open, query, onOpen, onClose, onQueryChange, onAssign }: FolderPickerProps) {
  // The dropdown is position:fixed (positioned from the input's rect) so it
  // escapes the card grid's overflow clipping / stacking and never sits
  // behind sibling cards.
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const el = inputRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left });
  }, [open, query]);

  const matches = query.trim()
    ? available.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : available.slice(0, 6);

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
        placeholder="Assign folder…"
      />
      {matches.length > 0 && menuPos && createPortal(
        // Rendered into <body> so NO card ancestor (transform / overflow /
        // stacking context) can clip or trap it — fixed coords come from
        // the input's on-screen rect.
        <ul
          className="order-card-folder-options"
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
        >
          {matches.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                className="order-card-folder-option"
                onMouseDown={(e) => { e.preventDefault(); void onAssign(f.name); }}
              >
                <span className="order-card-folder-swatch" style={{ background: f.color }} />
                {f.name}
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
