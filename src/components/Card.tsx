// One Card. Reads its file, strips frontmatter, hands the body to Milkdown
// Crepe, recombines on save. After each save, if the body's explicit h1
// has changed, the file gets renamed to `<date> <title>.md` (Obsidian
// Full Calendar convention) and the parent is notified so calendar
// views stay in sync.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { dirname, join } from "@tauri-apps/api/path";
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
  serializeListItems,
  splitBodyAndBullets,
  type ListItem,
} from "../lib/list-folder";
import { ListCards } from "./ListCards";
import { folderColor, isNotableFolder, noteFolder, parseRef } from "../lib/folders";
import {
  ATTACHMENTS_DIRNAME,
  attachmentAssetPrefix,
  deflateAttachmentUrls,
  inflateAttachmentUrls,
} from "../lib/attachments";
import { ChevronRight, Folder as FolderIcon, X as XIcon } from "lucide-react";

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
      await invoke("rename_file", { from: oldPath, to: newPath });
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
  | { kind: "ready"; body: string; frontmatter: Frontmatter }
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
  /** Minimal vault index for resolving `- [[Name]]` bullets when this
   *  card is a `type: list` Notable Folder Main Document. Each entry
   *  exposes just enough YAML for the list card grid to find covers,
   *  authors, descriptions. */
  vaultNotes?: { filename: string; frontmatter: Frontmatter }[];
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000;

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
    vaultNotes,
  } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Lifecycle state that drives the delete exit animation. */
  const [exiting, setExiting] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Folder picker (autocomplete) state for regular notes. */
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerQuery, setFolderPickerQuery] = useState("");
  /** Mirrors the editor body so saves can fold the current prose
   *  with the structured list items below. Milkdown stays uncontrolled
   *  — this state is downstream-only. */
  const [editorBody, setEditorBody] = useState<string>("");
  /** Structured list items for `type: list` folders. We strip bullets
   *  from the body on load so they don't show in the editor, hold them
   *  as a typed array here for drag-reorder / edit / delete / add, and
   *  serialize them back into the body on save. */
  const [listItems, setListItems] = useState<ListItem[]>([]);
  const listItemsRef = useRef<ListItem[]>([]);
  useEffect(() => { listItemsRef.current = listItems; }, [listItems]);
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
        const raw = await invoke<string>("read_text", { path: initialPath });
        if (cancelled) return;
        const { frontmatter, body } = splitFrontmatter(raw);
        const vault = await dirname(await dirname(initialPath));
        const prefix = attachmentAssetPrefix(vault);
        const displayBody = inflateAttachmentUrls(body, prefix);
        let proseBody = displayBody;
        let initialItems: ListItem[] = [];
        if (isListFolder(frontmatter)) {
          const split = splitBodyAndBullets(displayBody);
          proseBody = split.prose;
          initialItems = split.items;
        }
        lastTitleRef.current = firstLineTitle(proseBody);
        setState({ kind: "ready", body: proseBody, frontmatter });
        setEditorBody(proseBody);
        setListItems(initialItems);
        listItemsRef.current = initialItems;
        editorBodyRef.current = proseBody;
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
      const current = await invoke<string>("read_text", { path });
      const { frontmatter } = splitFrontmatter(current);
      // For list folders, fold the structured items back into the body
      // as wikilink bullets at the end. The editor only ever holds
      // prose; the items array is the source of truth for ordering.
      let foldedBody = body;
      if (isListFolder(frontmatter)) {
        const bullets = serializeListItems(listItemsRef.current);
        if (bullets) {
          foldedBody = `${body.replace(/\n+$/, "")}\n\n${bullets}\n`;
        }
      }
      // Collapse runtime asset:// URLs back to vault-relative paths so
      // the file on disk is portable / Obsidian-friendly.
      const vault = await dirname(await dirname(path));
      const persistedBody = deflateAttachmentUrls(foldedBody, attachmentAssetPrefix(vault));
      const content = joinFrontmatter(frontmatter, persistedBody);
      await invoke("write_text", { path, content });

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
    dirty.current = true;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow]);

  const handleChange = useCallback((markdown: string) => {
    pendingBody.current = markdown;
    editorBodyRef.current = markdown;
    setEditorBody(markdown);
    scheduleSave();
  }, [scheduleSave]);

  const handleListChange = useCallback((next: ListItem[]) => {
    listItemsRef.current = next;
    setListItems(next);
    scheduleSave();
  }, [scheduleSave]);

  const handleImageUpload = useCallback(async (file: File): Promise<string> => {
    // Save under <vault>/Attachments/. Vault root is the parent of the
    // cards dir, hence dirname(dirname(cardPath)).
    const cardDir = await dirname(pathRef.current);
    const vault = await dirname(cardDir);
    const filename = attachmentName(file);
    const absolute = await join(vault, ATTACHMENTS_DIRNAME, filename);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await invoke("write_binary", { path: absolute, data: Array.from(bytes) });
    return convertFileSrc(absolute);
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

  const cardClass =
    "order-card" +
    (fullscreen ? " is-fullscreen" : "") +
    (exiting ? " is-exiting" : "");

  const cardStyle: React.CSSProperties | undefined = color
    ? { borderLeft: `3px solid ${color}` }
    : undefined;

  return (
    <article className={cardClass} style={cardStyle}>
      <div className="order-card-controls" aria-hidden={false}>
        <button
          type="button"
          className="order-card-fullscreen"
          onClick={toggleFullscreen}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {fullscreen ? "⤡" : "⤢"}
        </button>
        {confirmingDelete ? (
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
            className="order-card-delete"
            onClick={startDeleteConfirm}
            title="Delete this note"
            aria-label="Delete note"
          >
            ×
          </button>
        )}
      </div>
      <MilkdownSurface
        initial={state.body}
        onChange={handleChange}
        onDone={() => { void flushNow(); }}
        onImageUpload={handleImageUpload}
      />
      {isListFolder(state.frontmatter) && (
        <ListCards
          items={listItems}
          vaultNotes={vaultNotes ?? []}
          onChange={handleListChange}
        />
      )}
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
        {/* Middle slot: breadcrumb for Notable Folders, folder picker for
            regular notes. Drops the slot entirely when neither applies. */}
        {(area || category) && (
          <span className="order-card-breadcrumb" style={color ? { color } : undefined}>
            {area && <span>{area}</span>}
            {area && category && <ChevronRight size={11} strokeWidth={2} className="order-card-breadcrumb-sep" />}
            {category && <span>{category}</span>}
          </span>
        )}
        {!area && !category && (
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

function FolderPicker({ current, available, open, query, onOpen, onClose, onQueryChange, onAssign }: FolderPickerProps) {
  const matches = query.trim()
    ? available.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6)
    : available.slice(0, 6);

  if (current && !open) {
    const f = available.find((x) => x.name === current);
    const color = f?.color;
    return (
      <span className="order-card-folder-chip" style={color ? { color, borderColor: color + "55" } : undefined}>
        <FolderIcon size={10} strokeWidth={2} />
        <span className="order-card-folder-name">{current}</span>
        <button
          type="button"
          className="order-card-folder-clear"
          onClick={() => { void onAssign(null); }}
          title="Remove folder"
          aria-label="Remove folder"
        >
          <XIcon size={10} strokeWidth={2.5} />
        </button>
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
      {matches.length > 0 && (
        <ul className="order-card-folder-options">
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
        </ul>
      )}
    </span>
  );
}
