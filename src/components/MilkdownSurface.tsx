// Thin imperative wrapper around Milkdown Crepe.
// Crepe owns the document state — we hand it the initial markdown once
// and subscribe to markdownUpdated for changes. We deliberately do NOT
// react to `initial` prop changes after mount: this surface is a
// single-edit-session component.

import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

type Props = {
  initial: string;
  onChange: (markdown: string) => void;
  onDone?: () => void;
  /** Called when the user pastes (or drops) an image into the editor.
   *  Returns a URL the editor can display. The card owns the path / asset
   *  protocol concerns — this component just inserts `![](<url>)` at
   *  the cursor once the upload resolves. */
  onImageUpload?: (file: File) => Promise<string>;
};

export function MilkdownSurface({ initial, onChange, onDone, onImageUpload }: Props) {
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
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        });
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
