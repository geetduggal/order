// Full-screen image inspector for image-only list items. Click an
// image card in a List NF to open this — Milkdown-style edit
// experience for the image:
//   - Replace (file picker → uploads into the NF dir + swaps the ref)
//   - Delete (drops the item from the list)
//   - Zoom (− / + / reset, plus Cmd/Ctrl + scroll)
//   - Caption (persists as the `|caption` suffix on the wikilink)
//
// Closed by Esc, backdrop click, or the explicit ×.

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2, X as XIcon, Copy as CopyIcon, Check } from "lucide-react";

interface Props {
  imageUrl: string;
  initialCaption?: string;
  onCaptionChange: (next: string) => void;
  /** When provided, the Replace button is enabled. Returning a new
   *  basename swaps the item to point at the uploaded file. */
  onReplaceImage?: (file: File) => Promise<string>;
  /** Drop the item from the parent list. When omitted, Delete is hidden. */
  onDeleteItem?: () => void;
  onClose: () => void;
  readOnly?: boolean;
}

export function ImageInspector({
  imageUrl, initialCaption, onCaptionChange, onReplaceImage, onDeleteItem, onClose, readOnly,
}: Props) {
  const [caption, setCaption] = useState(initialCaption ?? "");
  const [scale, setScale] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionRef = useRef(initialCaption ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [copied, setCopied] = useState(false);

  // Copy the image to the clipboard by drawing the loaded <img> to a canvas
  // (avoids fetching the vaultasset:// URL, which the webview may not allow).
  async function copyImage() {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const blob: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error("copy image failed:", err);
    }
  }

  // Esc closes; on close, persist the caption if it changed.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    const next = caption.trim();
    if (next !== (captionRef.current ?? "").trim()) onCaptionChange(next);
    onClose();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same filename later
    if (!file || !onReplaceImage) return;
    setUploading(true);
    try {
      await onReplaceImage(file);
      // Persist any in-progress caption edit before closing, then close
      // so the user sees the swap in the card grid.
      const next = caption.trim();
      if (next !== (captionRef.current ?? "").trim()) onCaptionChange(next);
      onClose();
    } catch (err) {
      console.error("image replace failed:", err);
    } finally {
      setUploading(false);
    }
  }

  function onDeleteClick() {
    if (!onDeleteItem) return;
    if (confirmingDelete) {
      if (confirmTimerRef.current) { clearTimeout(confirmTimerRef.current); confirmTimerRef.current = null; }
      onDeleteItem();
      onClose();
      return;
    }
    setConfirmingDelete(true);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmingDelete(false), 4000);
  }

  function onWheel(e: React.WheelEvent) {
    // Pinch-zoom (mac trackpad) and ctrl/cmd + wheel both report deltaY
    // with ctrlKey true; treat plain wheel-Y as a normal scroll.
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const step = e.deltaY > 0 ? 0.9 : 1.1;
    setScale((s) => Math.min(8, Math.max(0.2, s * step)));
  }

  return (
    <div
      className="img-inspector-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="img-inspector-frame" onWheel={onWheel}>
        <button
          type="button"
          className="img-inspector-close"
          onClick={close}
          aria-label="Close"
          title="Close (Esc)"
        >
          <XIcon size={18} strokeWidth={2} />
        </button>
        <div className="img-inspector-stage">
          <img
            ref={imgRef}
            src={imageUrl}
            alt={caption || ""}
            className="img-inspector-img"
            style={{ transform: `scale(${scale})` }}
            draggable={false}
          />
        </div>
        <div className="img-inspector-controls">
          <div className="img-inspector-zoom">
            <button type="button" onClick={() => setScale((s) => Math.max(0.2, s * 0.8))} aria-label="Zoom out">−</button>
            <span>{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => setScale((s) => Math.min(8, s * 1.25))} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => setScale(1)} aria-label="Reset zoom">⤺</button>
          </div>
          <button
            type="button"
            className="img-inspector-action"
            onClick={copyImage}
            title="Copy image to clipboard"
          >
            {copied ? <Check size={14} strokeWidth={2.4} /> : <CopyIcon size={14} strokeWidth={2.1} />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          <input
            type="text"
            className="img-inspector-caption"
            value={caption}
            placeholder={readOnly ? "" : "Caption…"}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); close(); } }}
            disabled={readOnly}
          />
          {!readOnly && onReplaceImage && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={handleFile}
              />
              <button
                type="button"
                className="img-inspector-action"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Replace this image"
              >
                <ImagePlus size={14} strokeWidth={2.1} />
                <span>{uploading ? "Uploading…" : "Replace"}</span>
              </button>
            </>
          )}
          {!readOnly && onDeleteItem && (
            <button
              type="button"
              className={"img-inspector-action img-inspector-action-delete" + (confirmingDelete ? " is-confirming" : "")}
              onClick={onDeleteClick}
              title={confirmingDelete ? "Click again to delete" : "Delete this image"}
            >
              <Trash2 size={14} strokeWidth={2.1} />
              <span>{confirmingDelete ? "Confirm" : "Delete"}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
