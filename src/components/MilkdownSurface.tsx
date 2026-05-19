// Thin imperative wrapper around Milkdown Crepe.
// Crepe owns the document state — we hand it the initial markdown once
// and subscribe to markdownUpdated for changes. We deliberately do NOT
// react to `initial` prop changes after mount: this surface is a
// single-edit-session component.

import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { invoke } from "@tauri-apps/api/core";
import { vaultRoot } from "../lib/vault";
import { ATTACHMENTS_DIRNAME, attachmentAssetPrefix } from "../lib/attachments";
import { join } from "@tauri-apps/api/path";

type Props = {
  initial: string;
  onChange: (markdown: string) => void;
  onDone?: () => void;
  /** Called when the user pastes (or drops) an image into the editor.
   *  Returns a URL the editor can display. The card owns the path / asset
   *  protocol concerns — this component just inserts `![](<url>)` at
   *  the cursor once the upload resolves. */
  onImageUpload?: (file: File) => Promise<string>;
  /** Focus the ProseMirror surface once Crepe finishes its async
   *  initialisation. Used to land the cursor in a freshly created
   *  note so the user can start typing immediately. */
  autoFocus?: boolean;
  /** Run Crepe in read-only mode — no caret, no block handles, no
   *  edits saved. Used by the published web viewer. */
  readOnly?: boolean;
};

export function MilkdownSurface({ initial, onChange, onDone, onImageUpload, autoFocus, readOnly }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  const onImageUploadRef = useRef(onImageUpload);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  useEffect(() => { onImageUploadRef.current = onImageUpload; }, [onImageUpload]);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let crepe: Crepe | null = null;

    crepe = new Crepe({ root: host.current, defaultValue: initial });

    crepe
      .create()
      .then(() => {
        if (cancelled || !crepe) return;
        if (readOnly) {
          crepe.setReadonly(true);
        }
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        });
        if (autoFocus && host.current) {
          // ProseMirror needs a frame after Crepe wires up its
          // plugins before .focus() lands the caret reliably.
          requestAnimationFrame(() => {
            const pm = host.current?.querySelector<HTMLElement>(".ProseMirror");
            pm?.focus();
          });
        }
      })
      .catch((err: unknown) => {
        console.error("Crepe init failed:", err);
      });

    return () => {
      cancelled = true;
      crepe?.destroy();
      crepe = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Link click handler. Attachments (PDFs, etc.) inside Milkdown
  // resolve to either bare `Attachments/foo.pdf` (read-only paths
  // the editor never inflated) or `asset://localhost/...` URLs
  // (inflated image links re-used for other media). In both cases
  // the webview can't navigate to them in a useful way, so route
  // the click through the OS opener.
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    async function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const anchor = t.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const raw = anchor.getAttribute("href") ?? "";
      if (!raw) return;
      // External http(s) URLs: let the default handler (or Tauri's
      // shell allowlist) take over.
      if (/^https?:\/\//i.test(raw) || raw.startsWith("mailto:")) return;
      const lower = raw.toLowerCase();
      // Resolve to an absolute filesystem path the OS opener can use.
      let absolute: string | null = null;
      try {
        const vault = await vaultRoot();
        if (raw.startsWith(`${ATTACHMENTS_DIRNAME}/`)) {
          absolute = await join(vault, raw);
        } else {
          const prefix = attachmentAssetPrefix(vault);
          if (lower.startsWith(prefix.toLowerCase())) {
            const rest = raw.slice(prefix.length);
            let decoded = rest;
            try { decoded = decodeURI(rest); } catch { /* keep raw */ }
            absolute = await join(vault, ATTACHMENTS_DIRNAME, decoded);
          }
        }
      } catch (err) {
        console.warn("link resolve failed:", err);
      }
      if (!absolute) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        await invoke("open_path", { path: absolute });
      } catch (err) {
        console.error("open_path failed:", err);
      }
    }
    root.addEventListener("click", onClick, true);
    return () => { root.removeEventListener("click", onClick, true); };
  }, []);

  // Image paste/drop handler. Capture phase so it runs before Milkdown's
  // built-in clipboard handler — preventDefault stops Crepe from
  // converting the image to base64 or otherwise mangling it.
  useEffect(() => {
    const root = host.current;
    if (!root) return;

    async function handleImageFiles(files: File[]): Promise<boolean> {
      const upload = onImageUploadRef.current;
      if (!upload) return false;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return false;
      for (const file of images) {
        try {
          const url = await upload(file);
          document.execCommand("insertText", false, `![](${url})`);
        } catch (err) {
          console.error("image upload failed:", err);
        }
      }
      return true;
    }

    async function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      const handled = await handleImageFiles(files);
      if (handled) e.preventDefault();
    }

    async function onDrop(e: DragEvent) {
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const handled = await handleImageFiles(Array.from(files));
      if (handled) e.preventDefault();
    }

    root.addEventListener("paste", onPaste, true);
    root.addEventListener("drop", onDrop, true);
    return () => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("drop", onDrop, true);
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      onDoneRef.current?.();
    }
  }

  return <div className="milkdown-host" ref={host} onKeyDown={onKeyDown} />;
}
