// Thin imperative wrapper around Milkdown Crepe.
// Crepe owns the document state — we hand it the initial markdown once
// and subscribe to markdownUpdated for changes. We deliberately do NOT
// react to `initial` prop changes after mount: this surface is a
// single-edit-session component.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { editorViewCtx, parserCtx, serializerCtx } from "@milkdown/kit/core";
import { Slice } from "@milkdown/kit/prose/model";
import { invoke } from "@tauri-apps/api/core";
import { vaultRoot } from "../lib/vault";
import { ATTACHMENTS_DIRNAME, attachmentAssetPrefix, isImagePath } from "../lib/attachments";

// Tauri-only path detector: the @tauri-apps/api runtime injects
// `window.__TAURI_INTERNALS__`. Absent in the published web viewer.
// Used to skip `invoke(...)` calls that would otherwise hang or throw
// silently and stop default browser link navigation.
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
import { join } from "@tauri-apps/api/path";
import { tightenListSpacing } from "../lib/list-folder";
import { wikilinkProsePlugin, wikilinkAutocompletePlugin } from "../lib/milkdown-wikilink";
import { linkKeymapPlugin } from "../lib/milkdown-link-keymap";
import { youtubeEmbedPlugin } from "../lib/milkdown-youtube";
import { videoEmbedPlugin } from "../lib/milkdown-video";
import { youtubeId } from "../lib/youtube";
import { normalizeWikilinkBrackets, unescapeLinkUrls, type WikiRef } from "../lib/wikilink";

/** Convert CommonMark's default 2-space-per-level list indent to 4
 *  spaces — matches Obsidian's "indent list with hard tabs" output style
 *  and stays compatible with strict-CommonMark parsers (which accept
 *  either). Doubles any leading run of two-space groups that precedes a
 *  list marker (`- `, `* `, `+ `, `1. `, or a task checkbox), and
 *  continuation lines indented to the same depth. Anything else passes
 *  through unchanged. */
function widenListIndent(md: string): string {
  if (!md) return md;
  const lines = md.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    lines[i] = lines[i].replace(
      /^( {2})+(?=([-*+] |\d+\.\s|\[[\sxX]\]))/,
      (m) => " ".repeat(m.length * 2),
    );
  }
  return lines.join("\n");
}

// Milkdown's CommonMark serializer backslash-escapes ASCII punctuation so the
// markdown re-parses unambiguously (`1\.`, `\-`, `\[`, `\#`, `\!`…). Great for
// round-tripping, ugly when the text is copied to paste as PLAIN text. Strip
// those escapes for the clipboard — outside fenced code blocks, where escapes
// are meaningful and the serializer doesn't add them anyway.
const MD_ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g;
function stripMarkdownEscapes(md: string): string {
  if (!md || !md.includes("\\")) return md;
  const lines = md.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    lines[i] = lines[i].replace(MD_ESCAPE_RE, "$1");
  }
  return lines.join("\n");
}

export interface MilkdownHandle {
  /** Replace the entire document with new markdown content — no remount,
   *  no cursor disruption to an in-progress edit. Returns false when the
   *  editor isn't mounted yet (safe to ignore). */
  replaceContent: (markdown: string) => boolean;
  /** Insert markdown at the current selection (used for dropped attachments). */
  insertMarkdown: (markdown: string) => boolean;
}

type Props = {
  initial: string;
  onChange: (markdown: string) => void;
  onDone?: () => void;
  /** Vault index for resolving `[[..]]` decorations (broken vs resolved).
   *  Read live via a ref so the decoration pass sees the current vault. */
  wikiNotes?: WikiRef[];
  /** Click handler for a rendered `[[..]]` link — receives the bare name.
   *  The caller resolves folder vs note and navigates. */
  onWikiNavigate?: (name: string) => void;
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
  /** Vault-relative directory of the note being edited. Used to
   *  resolve `[[X.png]]` (non-embedded image wiki-links) to a local
   *  file the OS opener can launch on click. */
  noteDir?: string;
};

export const MilkdownSurface = forwardRef<MilkdownHandle, Props>(function MilkdownSurface(
  { initial, onChange, onDone, onImageUpload, wikiNotes, onWikiNavigate, autoFocus, readOnly, noteDir }: Props,
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const wikiNotesRef = useRef<WikiRef[]>(wikiNotes ?? []);
  // True while a programmatic replaceContent transaction is in flight.
  // markdownUpdated can't see the transaction's `externalUpdate` meta, so
  // without this the caller's onChange fires for a document the caller
  // just handed us — the card marks itself dirty and saves, the save wakes
  // the watcher, the watcher calls replaceContent again: a write loop.
  const applyingExternalRef = useRef(false);

  useImperativeHandle(ref, () => ({
    replaceContent(markdown: string): boolean {
      const crepe = crepeRef.current;
      if (!crepe) return false;
      applyingExternalRef.current = true;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const doc = ctx.get(parserCtx)(markdown);
          if (!doc) return;
          // Replace the whole document without touching the selection or
          // scroll position if possible — the user may be mid-edit elsewhere
          // on the same card and we don't want to jump their cursor.
          const { tr } = view.state;
          tr.replaceWith(0, view.state.doc.content.size, doc.content);
          tr.setMeta("externalUpdate", true);
          view.dispatch(tr);
        });
      } finally {
        // markdownUpdated fires synchronously inside dispatch, but reset on
        // a microtask too so a listener that defers can't leave the flag set.
        applyingExternalRef.current = false;
        queueMicrotask(() => { applyingExternalRef.current = false; });
      }
      return true;
    },
    insertMarkdown(markdown: string): boolean {
      const crepe = crepeRef.current;
      if (!crepe) return false;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const doc = ctx.get(parserCtx)(markdown);
        if (!doc) return;
        view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
        view.focus();
      });
      return true;
    },
  }), []);
  useEffect(() => { wikiNotesRef.current = wikiNotes ?? []; }, [wikiNotes]);
  const onWikiNavigateRef = useRef(onWikiNavigate);
  useEffect(() => { onWikiNavigateRef.current = onWikiNavigate; }, [onWikiNavigate]);
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  const onImageUploadRef = useRef(onImageUpload);
  const pathDirRef = useRef<string>(noteDir ?? "");
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onDoneRef.current = onDone; }, [onDone]);
  useEffect(() => { onImageUploadRef.current = onImageUpload; }, [onImageUpload]);
  useEffect(() => { pathDirRef.current = noteDir ?? ""; }, [noteDir]);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let crepe: Crepe | null = null;
    let copyCleanup: (() => void) | null = null;

    crepe = new Crepe({ root: host.current, defaultValue: initial });
    crepeRef.current = crepe;
    // Register the wikilink decoration plugin before create() so it's
    // part of the editor's plugin set. (SPIKE: verify Crepe applies a
    // plugin added via editor.use() before create.)
    try {
      crepe.editor.use(wikilinkProsePlugin(() => wikiNotesRef.current));
      // Autocomplete only when editable — the viewer is read-only.
      if (!readOnly) {
        crepe.editor.use(wikilinkAutocompletePlugin(() => wikiNotesRef.current));
      }
    } catch (err) {
      console.warn("wikilink plugin registration failed:", err);
    }
    try {
      // Cmd+K with a selection → wrap in markdown link mark.
      if (!readOnly) crepe.editor.use(linkKeymapPlugin());
    } catch (err) {
      console.warn("link keymap registration failed:", err);
    }
    try {
      crepe.editor.use(youtubeEmbedPlugin());
    } catch (err) {
      console.warn("youtube embed plugin registration failed:", err);
    }
    try {
      crepe.editor.use(videoEmbedPlugin());
    } catch (err) {
      console.warn("video embed plugin registration failed:", err);
    }

    crepe
      .create()
      .then(() => {
        if (cancelled || !crepe) return;
        if (readOnly) {
          crepe.setReadonly(true);
        }
        crepe.on((listener) => {
          listener.markdownUpdated((_ctx, markdown) => {
            // Programmatic replacement (external file change) — not a user
            // edit. Reporting it would mark the card dirty and save it back.
            if (applyingExternalRef.current) return;
            onChangeRef.current(normalizeWikilinkBrackets(unescapeLinkUrls(widenListIndent(markdown))));
          });
        });
        // Replace ProseMirror's default text/plain clipboard serializer
        // with one that hands out our own markdown for the selection.
        // The default emits each block separated by a blank line, so a
        // copied list pastes into a plain-text app with newlines between
        // every item; markdown puts them on consecutive lines.
        //
        // setProps alone isn't enough in practice: @milkdown/plugin-
        // clipboard ships its own clipboardTextSerializer, so we ALSO
        // attach a `copy` listener on view.dom (after ProseMirror's
        // own) that tightens whatever text/plain ProseMirror wrote.
        try {
          crepe.editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const serialize = ctx.get(serializerCtx);
            const parser = ctx.get(parserCtx);
            view.setProps({
              clipboardTextSerializer: (slice) => {
                try {
                  // Wrap the selection slice in a doc node so the
                  // serializer can walk it. doc.type.create with the
                  // slice's content fragment is sufficient.
                  const docNode = view.state.doc.type.create(null, slice.content);
                  const md = serialize(docNode);
                  // Milkdown's serializer emits "loose" lists with a
                  // blank line between every item; tighten them so a
                  // copied list pastes the way the source file reads.
                  return stripMarkdownEscapes(normalizeWikilinkBrackets(tightenListSpacing(widenListIndent(md))));
                } catch {
                  // Fall back to the slice's text content with newline-
                  // joined blocks rather than the default double-newline.
                  return slice.content.textBetween(0, slice.content.size, "\n", " ");
                }
              },
              // Paste of a bare YouTube URL → drop in `![](url)`
              // (Obsidian's YouTube embed syntax). The MutationObserver
              // in milkdown-youtube swaps the resulting image-block for
              // an iframe. Returning true tells ProseMirror we've
              // handled the paste so Crepe's autolinker doesn't also
              // insert a plain link.
              handlePaste: (_view, event) => {
                const cd = (event as ClipboardEvent).clipboardData;
                if (!cd) return false;
                const text = cd.getData("text/plain")?.trim();
                if (!text || /\s/.test(text)) return false;
                if (!youtubeId(text)) return false;
                const md = `![](${text})\n`;
                const doc = parser(md);
                if (!doc) return false;
                _view.dispatch(
                  _view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView(),
                );
                return true;
              },
            });
            // Copy interceptor: attach to view.dom (the ProseMirror
            // element, same target ProseMirror itself listens on) AFTER
            // ProseMirror's own listener. Same-element listeners fire
            // in registration order, so ours runs after ProseMirror has
            // written text/plain + text/html. We just tighten the
            // text/plain in place; text/html stays untouched so rich-
            // text targets still get structure. Bulletproof against any
            // plugin's clipboardTextSerializer (Milkdown ships one).
            const onCopy = (e: ClipboardEvent) => {
              if (!e.clipboardData) return;
              const text = e.clipboardData.getData("text/plain");
              if (!text) return;
              const cleaned = stripMarkdownEscapes(tightenListSpacing(text));
              if (cleaned !== text) e.clipboardData.setData("text/plain", cleaned);
            };
            view.dom.addEventListener("copy", onCopy, false);
            copyCleanup = () => view.dom.removeEventListener("copy", onCopy, false);
          });
        } catch (err) {
          console.warn("clipboard serializer override failed:", err);
        }
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
      copyCleanup?.();
      copyCleanup = null;
      crepe?.destroy();
      crepe = null;
      crepeRef.current = null;
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
      // An embedded image (`![[img]]`) → open the fullscreen zoom viewer.
      const img = t.closest("img");
      if (img instanceof HTMLImageElement && img.src && !img.closest("a")) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("order:view-image", { detail: { url: img.src } }));
        return;
      }
      // Wikilink decoration spans carry data-wikilink — navigate on
      // click. Exception: when the link target is an image file
      // (`[[X.png]]` — bare wiki-link to an image, NOT embedded),
      // open the image with the OS handler instead of trying to
      // navigate to a note named "X.png".
      const wiki = t.closest("[data-wikilink]");
      if (wiki instanceof HTMLElement) {
        const name = wiki.getAttribute("data-wikilink");
        if (name) {
          if (isImagePath(name) && isTauri()) {
            // Desktop: open image with the OS handler (Preview etc.).
            // Browser viewer has no `open_path` Tauri command — fall
            // through and let the wikilink navigate-to-note handler
            // run (it'll resolve to no-op for a missing image-name
            // note, which is the least-surprising web behavior).
            e.preventDefault();
            e.stopPropagation();
            try {
              const vault = await vaultRoot();
              const noteDir = pathDirRef.current;
              const local = await join(vault, noteDir, name);
              const inAttachments = await join(vault, ATTACHMENTS_DIRNAME, name);
              try { await invoke("open_path", { path: local }); }
              catch { await invoke("open_path", { path: inAttachments }); }
            } catch (err) {
              console.warn("open image wikilink failed:", err);
            }
            return;
          }
          if (onWikiNavigateRef.current) {
            e.preventDefault();
            e.stopPropagation();
            onWikiNavigateRef.current(name);
            return;
          }
        }
      }
      const anchor = t.closest("a");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      // YouTube card anchors wire their own platform-cascading
      // open handler directly on the element (lib/milkdown-youtube.ts).
      // Letting this capture-phase handler also fire would either
      // double-open the URL on desktop (two browser tabs) or race
      // with the card's iOS path. Skip them.
      if (anchor.classList.contains("order-youtube-card")) return;
      const raw = anchor.getAttribute("href") ?? "";
      if (!raw) return;
      // External http(s) / mailto / tel URLs: route through the Tauri
      // shell so they open in the user's default browser. The WebView
      // would otherwise navigate inside Order itself (no chrome, no
      // way back), which is never what the user wants for a body link.
      // In the published web viewer there's no Tauri — fall through to
      // native browser behavior so window.open / location does the right
      // thing (mailto/tel hand off to the OS; http(s) opens a tab).
      if (/^(https?|mailto|tel):/i.test(raw)) {
        if (!isTauri()) {
          // Published web viewer: force a new tab so the visitor
          // doesn't lose the page they were reading. The bare anchor
          // would otherwise navigate the current tab.
          e.preventDefault();
          e.stopPropagation();
          window.open(raw, "_blank", "noopener,noreferrer");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        // Fire-and-forget: awaiting `open_url` on iOS blocks the
        // click handler until UIApplication.open's completion fires,
        // which is after the user confirms the app-switch prompt —
        // during that window the UI appeared frozen. The fallback
        // chain (window.open → location.href) runs only if invoke
        // outright rejects, which only happens on a platform with no
        // shell at all (the published web viewer takes the
        // !isTauri branch above and never reaches this code).
        void invoke("open_url", { url: raw }).catch((err) => {
          console.warn("open_url failed, trying window.open:", err);
          const opened = window.open(raw, "_blank");
          if (!opened) window.location.href = raw;
        });
        return;
      }
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
      // A bare relative link with a file extension (e.g. a dropped `[doc.pdf]
      // (doc.pdf)`) — resolve it against the note's own directory and open it in
      // the system default viewer.
      if (!absolute && !/^[a-z]+:\/\//i.test(raw) && /\.[a-z0-9]{1,8}$/i.test(raw)) {
        try {
          const vault = await vaultRoot();
          let decoded = raw;
          try { decoded = decodeURI(raw); } catch { /* keep raw */ }
          absolute = await join(vault, pathDirRef.current, decoded);
        } catch (err) {
          console.warn("relative file resolve failed:", err);
        }
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
    // iOS WKWebView often DOESN'T fire `click` on anchors inside
    // ProseMirror widgets — the touchstart gesture gets consumed by
    // PM's selection plumbing and never escalates to a click event.
    // Catching `touchend` in capture phase reaches those taps; we
    // dedupe against `click` via a short cooldown so a single tap on
    // desktop (touchend → click, both fire) doesn't double-handle.
    let lastHandled = 0;
    const wrappedOnClick = (e: Event) => {
      const now = Date.now();
      if (now - lastHandled < 600) return;
      lastHandled = now;
      void onClick(e as MouseEvent);
    };
    root.addEventListener("click", wrappedOnClick, true);
    root.addEventListener("touchend", wrappedOnClick, true);
    return () => {
      root.removeEventListener("click", wrappedOnClick, true);
      root.removeEventListener("touchend", wrappedOnClick, true);
    };
  }, []);

  // Image paste/drop handler. Capture phase so it runs before Milkdown's
  // built-in clipboard handler — preventDefault stops Crepe from
  // converting the image to base64 or otherwise mangling it.
  useEffect(() => {
    const root = host.current;
    if (!root) return;

    // Insert markdown as real nodes via Milkdown's parser at the current
    // selection. execCommand("insertText") only drops literal text that
    // Crepe never turns into an image node — so the upload appeared to do
    // nothing. This parses `![](url)` into an actual image node.
    function insertMarkdown(md: string) {
      const crepe = crepeRef.current;
      if (!crepe) return;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const doc = ctx.get(parserCtx)(md);
        if (!doc) return;
        view.dispatch(view.state.tr.replaceSelection(new Slice(doc.content, 0, 0)).scrollIntoView());
        view.focus();
      });
    }

    async function handleImageFiles(files: File[]): Promise<boolean> {
      const upload = onImageUploadRef.current;
      if (!upload) return false;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return false;
      for (const file of images) {
        try {
          const url = await upload(file);
          insertMarkdown(`![](${url})`);
        } catch (err) {
          console.error("image upload failed:", err);
        }
      }
      return true;
    }

    // NOTE: suppression MUST be synchronous. Crepe's own paste/drop
    // handler runs in the SAME tick, before any `await` resolves — so a
    // deferred preventDefault is too late and Crepe also inserts the image
    // as a stray `![](blob:…)`. We detect image files, stop the event dead
    // here, then kick off the (async) upload separately.
    function onPaste(e: ClipboardEvent) {
      // 1) Plain-text YouTube URL → drop in `![](url)` (Obsidian's
      //    YouTube embed syntax). The MutationObserver in
      //    milkdown-youtube swaps the image-block for an iframe.
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text && !/\s/.test(text) && youtubeId(text)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        insertMarkdown(`![](${text})\n`);
        return;
      }
      // 2) Pasted image file → existing upload flow.
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void handleImageFiles(files);
    }

    function onDrop(e: DragEvent) {
      const dropped = e.dataTransfer?.files;
      if (!dropped || dropped.length === 0) return;
      const images = Array.from(dropped).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void handleImageFiles(images);
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
});
