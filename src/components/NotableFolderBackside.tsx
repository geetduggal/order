// Backside of a Notable Folder card — a lightweight folder browser.
//
// Front side stays the Main Document. A flip icon on the card's top-
// right swaps in this panel: a sortable list of every file directly
// inside the folder (the Main Doc is excluded — it's already the
// front). Tap a row to open the file via the OS (Quick Look on macOS,
// the default handler elsewhere). Drag a row OUT to drop the file
// somewhere else on the desktop; drop files INTO the panel to copy
// them into the folder. Two header buttons reveal the folder in the
// system file browser and open it in a terminal.
//
// Desktop-only: the calling card hides the flip control on iOS and
// in the published viewer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowDownAZ, Clock4, FolderOpen, Terminal, FileText, FileImage, FileVideo, Folder as FolderIcon, File as FileIcon } from "lucide-react";
import { vaultFs, type VaultDirEntryStat } from "../lib/vault-fs";

type SortMode = "name" | "mtime";

function iconFor(name: string, isDir: boolean) {
  if (isDir) return FolderIcon;
  const lower = name.toLowerCase();
  if (/\.md$/.test(lower)) return FileText;
  if (/\.(png|jpe?g|gif|webp|heic|svg|tiff?)$/.test(lower)) return FileImage;
  if (/\.(mov|mp4|m4v|webm|avi|mkv)$/.test(lower)) return FileVideo;
  return FileIcon;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatMtime(epoch: number): string {
  if (!epoch) return "—";
  const d = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}

export function NotableFolderBackside({
  vaultRoot,
  folderRel,
  folderName,
  onFlipBack,
}: {
  /** Absolute path to the vault root — joined with folderRel for the
   *  OS-side `open_path` / `reveal_path` / `open_terminal` commands. */
  vaultRoot: string;
  /** Vault-relative path to this Notable Folder's directory (no
   *  trailing slash). Used for the file-list call to Rust. */
  folderRel: string;
  /** Display name (the folder's basename) for the header. */
  folderName: string;
  onFlipBack: () => void;
}) {
  const [entries, setEntries] = useState<VaultDirEntryStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("name");
  const [dropHover, setDropHover] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const absPath = useMemo(() => {
    const base = vaultRoot.replace(/\/+$/, "");
    return folderRel ? `${base}/${folderRel}` : base;
  }, [vaultRoot, folderRel]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const es = await vaultFs.listDir(folderRel);
      setEntries(es);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [folderRel]);

  useEffect(() => { void reload(); }, [reload]);

  const sorted = useMemo(() => {
    const xs = [...entries];
    if (sort === "name") {
      xs.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      });
    } else {
      xs.sort((a, b) => b.mtime - a.mtime);
    }
    return xs;
  }, [entries, sort]);

  const openFile = useCallback(async (name: string) => {
    const target = folderRel ? `${absPath}/${name}` : `${absPath}/${name}`;
    try { await invoke("open_path", { path: target }); }
    catch (e) { console.error("open_path failed:", e); }
  }, [absPath, folderRel]);

  const revealFolder = useCallback(async () => {
    try { await invoke("reveal_path", { path: absPath }); }
    catch (e) { console.error("reveal_path failed:", e); }
  }, [absPath]);

  const openTerminal = useCallback(async () => {
    try { await invoke("open_terminal", { path: absPath }); }
    catch (e) { console.error("open_terminal failed:", e); }
  }, [absPath]);

  // Drag IN from the OS: Tauri's webview eats HTML5 dataTransfer at
  // the OS layer, so the React onDrop handler never receives the
  // file list. The native event from getCurrentWebview().
  // onDragDropEvent() gives us absolute OS paths instead. We gate on
  // whether the drop point lands on a descendant of this panel via
  // document.elementFromPoint — more robust than bounding-rect math
  // (handles cards in scroll containers, transformed parents, etc.).
  // If no panelRef yet or position is missing, we still import — being
  // generous beats failing silently when the user clearly intends to
  // drop on the flipped card.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const positionInPanel = useCallback((x: number | undefined, y: number | undefined) => {
    if (panelRef.current == null) return false;
    if (x == null || y == null) return true; // no position → trust the listener
    const dpr = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(x / dpr, y / dpr) as HTMLElement | null;
    if (!el) return true; // off-canvas → accept
    return panelRef.current.contains(el);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const handle = await getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload as {
            type: "enter" | "over" | "drop" | "leave";
            position?: { x: number; y: number };
            paths?: string[];
          };
          // Diagnostic — keep until the drop flow is confirmed working.
          // eslint-disable-next-line no-console
          console.log("[nf-flip] dragDrop", p.type, p);
          if (p.type === "over" || p.type === "enter") {
            setDropHover(positionInPanel(p.position?.x, p.position?.y));
          } else if (p.type === "leave") {
            setDropHover(false);
          } else if (p.type === "drop") {
            const paths = p.paths ?? [];
            setDropHover(false);
            if (paths.length === 0) return;
            if (!positionInPanel(p.position?.x, p.position?.y)) return;
            (async () => {
              try {
                const written = await vaultFs.importFiles(paths, folderRel);
                // eslint-disable-next-line no-console
                console.log("[nf-flip] imported", written);
                await reload();
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error("[nf-flip] import failed", err);
                setUploadError(String(err));
              }
            })();
          }
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Non-Tauri context (web viewer) — ignore.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [folderRel, reload, positionInPanel]);

  // Drag OUT to the OS isn't directly supported by HTML5 drag-and-drop
  // (browsers refuse to expose a fs path for security), but we can hand
  // a `DownloadURL` for a fetched blob via vaultasset:// — Finder accepts
  // that, dropping the file at the destination. We assemble the URL on
  // dragstart so the heavy read isn't done for hovers that never lead
  // to a drop.
  const onRowDragStart = useCallback(
    (e: React.DragEvent<HTMLLIElement>, name: string) => {
      const rel = folderRel ? `${folderRel}/${name}` : name;
      const url = `vaultasset://localhost/${rel}`;
      // application/octet-stream covers Finder + most file managers.
      const mime = "application/octet-stream";
      e.dataTransfer.setData("DownloadURL", `${mime}:${name}:${url}`);
      e.dataTransfer.effectAllowed = "copyMove";
    },
    [folderRel],
  );

  return (
    <div
      ref={panelRef}
      className={"nf-flip-panel" + (dropHover ? " is-drop-hover" : "")}
    >
      <header className="nf-flip-header">
        <div className="nf-flip-title">
          <FolderIcon size={14} strokeWidth={2.2} />
          <span>{folderName}</span>
        </div>
        <div className="nf-flip-actions">
          <button
            type="button"
            className={"nf-flip-sort" + (sort === "name" ? " is-on" : "")}
            onClick={() => setSort("name")}
            title="Sort by name"
            aria-pressed={sort === "name"}
          >
            <ArrowDownAZ size={13} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className={"nf-flip-sort" + (sort === "mtime" ? " is-on" : "")}
            onClick={() => setSort("mtime")}
            title="Sort by modified time"
            aria-pressed={sort === "mtime"}
          >
            <Clock4 size={13} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="nf-flip-tool"
            onClick={() => { void revealFolder(); }}
            title="Reveal folder in Finder"
          >
            <FolderOpen size={13} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="nf-flip-tool"
            onClick={() => { void openTerminal(); }}
            title="Open in Terminal"
          >
            <Terminal size={13} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="nf-flip-back"
            onClick={onFlipBack}
            title="Flip back"
            aria-label="Flip back to the note"
          >
            ↺
          </button>
        </div>
      </header>
      {error && <div className="nf-flip-error">{error}</div>}
      {uploadError && <div className="nf-flip-error">Upload: {uploadError}</div>}
      {loading ? (
        <div className="nf-flip-empty">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="nf-flip-empty">Empty folder. Drop files here to add them.</div>
      ) : (
        <ul className="nf-flip-list">
          {sorted.map((e) => {
            const Icon = iconFor(e.name, e.isDir);
            return (
              <li
                key={e.name}
                className={"nf-flip-row" + (e.isDir ? " is-dir" : "")}
                draggable={!e.isDir}
                onDragStart={!e.isDir ? (ev) => onRowDragStart(ev, e.name) : undefined}
                onClick={() => { void openFile(e.name); }}
                title={e.name}
              >
                <Icon size={13} strokeWidth={2} className="nf-flip-row-icon" />
                <span className="nf-flip-row-name">{e.name}</span>
                <span className="nf-flip-row-meta">
                  {e.isDir ? "" : formatSize(e.size)}
                </span>
                <span className="nf-flip-row-mtime">{formatMtime(e.mtime)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {dropHover && <div className="nf-flip-drop-overlay">Drop to add to {folderName}</div>}
    </div>
  );
}
