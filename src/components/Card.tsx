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
} from "../lib/frontmatter";

const SAVE_DEBOUNCE_MS = 600;
const ATTACHMENTS_DIR = "attachments";

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
  | { kind: "ready"; body: string }
  | { kind: "error"; message: string };

interface Props {
  path: string;
  onRenamed?: (newPath: string) => void;
  onTitleChanged?: (newTitle: string) => void;
  /** Called when the user confirms deletion of this card. Card flushes
   *  pending saves first so we don't recreate the file after delete. */
  onDelete?: (path: string) => Promise<void>;
}

const DELETE_CONFIRM_TIMEOUT_MS = 4000;

export function Card({ path: initialPath, onRenamed, onTitleChanged, onDelete }: Props) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  /** Lifecycle states that drive exit animations. */
  const [exiting, setExiting] = useState(false);
  const [closingFullscreen, setClosingFullscreen] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    invoke<string>("read_text", { path: initialPath })
      .then((raw) => {
        if (cancelled) return;
        const { body } = splitFrontmatter(raw);
        lastTitleRef.current = firstLineTitle(body);
        setState({ kind: "ready", body });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: typeof err === "string" ? err : "Failed to load card",
        });
      });
    return () => { cancelled = true; };
  }, [initialPath]);

  const flushNow = useCallback(async (): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const body = pendingBody.current;
    if (body === null) return;
    pendingBody.current = null;
    inflight.current += 1;
    setSaving(true);
    try {
      const path = pathRef.current;
      // Re-read latest frontmatter so out-of-band edits (Week view drag)
      // are preserved when we write our body.
      const current = await invoke<string>("read_text", { path });
      const { frontmatter } = splitFrontmatter(current);
      const content = joinFrontmatter(frontmatter, body);
      await invoke("write_text", { path, content });

      // Auto-rename whenever the body's first line of text changes —
      // heading or not. firstLineTitle strips leading markdown markers
      // (#, -, *, >) so the filename always tracks the visible first
      // line. Empty body skips rename (file keeps "Untitled" or the
      // last name the user typed).
      const title = firstLineTitle(body);
      if (title && title !== lastTitleRef.current) {
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

  const handleChange = useCallback((markdown: string) => {
    pendingBody.current = markdown;
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flushNow(); }, SAVE_DEBOUNCE_MS);
  }, [flushNow]);

  const handleImageUpload = useCallback(async (file: File): Promise<string> => {
    const dir = await dirname(pathRef.current);
    const filename = attachmentName(file);
    const absolute = await join(dir, ATTACHMENTS_DIR, filename);
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
          // Parent will unmount us; if it doesn't, drop the exit class
          // so the card recovers (rare error path).
        } catch (err) {
          console.error("delete failed:", err);
          const message = typeof err === "string" ? err : (err instanceof Error ? err.message : String(err));
          setExiting(false);
          setDeleteError(message);
          setConfirmingDelete(false);
        }
      })();
    }, 180);
  }, [onDelete]);

  const toggleFullscreen = useCallback(() => {
    if (!fullscreen) {
      setFullscreen(true);
      return;
    }
    if (closingFullscreen) return;
    // Play the exit keyframe, then drop out of fullscreen so the card
    // pops back into its grid cell crisply.
    setClosingFullscreen(true);
    setTimeout(() => {
      setFullscreen(false);
      setClosingFullscreen(false);
    }, 140);
  }, [fullscreen, closingFullscreen]);
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
    (closingFullscreen ? " is-closing-fullscreen" : "") +
    (exiting ? " is-exiting" : "");

  return (
    <article className={cardClass}>
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
      <div className="order-card-status">
        <span className={saving ? "is-saving" : "is-saved"}>{saving ? "saving…" : "saved"}</span>
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
