// Interactive card grid for `type: list` Notable Folders.
//
// Drag-reorder runs through the shared useTileDrag hook: pointerdown on
// a card seeds a drag (everywhere except the title/meta/delete controls,
// via `exclude`), the grabbed card lifts and follows, a drop indicator
// shows where it will land, and pointerup persists the new order. The
// hook uses setPointerCapture + touch-action:none so it works on iOS.
//
// HTML5 drag-drop is unusable here — Tauri's webview intercepts it at
// the OS level, so drop events never reach in-page handlers.

import { useEffect, useRef, useState } from "react";
import { Plus, X as XIcon, Image as ImageIcon, ClipboardPaste, Dot as DotIcon } from "lucide-react";
import { folderIcon, isNotableFolder } from "../lib/folders";
import { displayTitleFor, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { WikiRefInput } from "./WikiRefInput";
import { resolveNoteRef } from "../lib/wikilink";
import { useTileDrag } from "../lib/use-tile-drag";
import { assetUrl } from "../lib/attachments";
import { ImageInspector } from "./ImageInspector";
export type { ListNoteRef };

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  /** Fully static — no drag, no add, no delete, no inline edit.
   *  Used by the published viewer and display-only sub-lists. */
  readOnly?: boolean;
  /** Hide add tile + per-item delete/inline-edit, but KEEP drag-reorder. */
  readOnlyMembership?: boolean;
  /** Click-on-title navigation. When omitted, title click falls back
   *  to inline rename. */
  onNavigate?: (ref: string) => void;
  /** Additive filter — used when the linked target is a Notable
   *  Folder so a click accumulates filter chips. */
  onAddFilter?: (ref: string) => void;
  /** The list folder's vault-relative directory. Used to resolve
   *  image-only list items (`* ![[foo.jpg]]`) to a vaultasset:// URL
   *  against the folder containing the image. */
  noteDir?: string;
  /** Upload a file into the list folder's dir, returning the
   *  vaultasset:// URL of the stored image. Wired from Card so the
   *  image inspector's Replace button can swap the image. */
  onUploadImage?: (file: File) => Promise<string>;
}

/** Build the URL for an image-only list item.
 *   - Inflated form (`![](vaultasset://…)`) sets item.image to the
 *     full URL — pass through unchanged.
 *   - On-disk Obsidian form (`* ![[file.png]]`) sets item.image to the
 *     basename — resolve against the list folder's own directory,
 *     which is where Order's kanban-to-cards conversion put the file.
 *   - External http(s) URLs pass through too. */
function imageItemUrl(item: ListItem, noteDir?: string): string | undefined {
  if (!item.image) return undefined;
  if (/^[a-z]+:\/\//i.test(item.image)) return item.image;
  const rel = noteDir ? `${noteDir}/${item.image}` : item.image;
  return assetUrl(rel);
}

function pickMeta(item: ListItem, note?: ListNoteRef): string {
  if (item.meta) return item.meta;
  if (!note) return "";
  const fm = note.frontmatter;
  if (typeof fm.author === "string") return fm.author;
  if (typeof fm.description === "string") return fm.description;
  return "";
}

export function ListCards({ items, vaultNotes, onChange, readOnly, readOnlyMembership, onNavigate, onAddFilter, noteDir, onUploadImage }: Props) {
  const [adding, setAdding] = useState(false);
  const [addingTop, setAddingTop] = useState(false);
  /** Open image inspector for a specific image-only list item. */
  const [inspectingIdx, setInspectingIdx] = useState<number | null>(null);
  const hideControls = !!readOnly || !!readOnlyMembership;

  function updateCaption(index: number, caption: string) {
    const next = items.slice();
    const trimmed = caption.trim();
    next[index] = { ...next[index], caption: trimmed || undefined };
    onChange(next);
  }

  function reorder(order: string[]) {
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const next = order.map((r) => byRef.get(r)).filter((i): i is ListItem => !!i);
    if (next.length === items.length) onChange(next);
  }
  const { gridRef, dragRef: draggingRef, onTilePointerDown } = useTileDrag(
    items.map((i) => i.ref),
    readOnly ? undefined : reorder,
    { exclude: "input, button, .basecard-meta" },
  );

  function remove(index: number) {
    const next = items.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function add(ref: string, position: "start" | "end" = "end") {
    const trimmed = ref.trim();
    if (!trimmed) return;
    if (items.some((i) => i.ref.toLowerCase() === trimmed.toLowerCase())) return;
    onChange(position === "start" ? [{ ref: trimmed }, ...items] : [...items, { ref: trimmed }]);
  }
  /** Add from the add-tile input. Plain text by default; only an exact
   *  `[[Name]]` becomes a wikilink (same rule as inline title edits). */
  function addFromInput(value: string, position: "start" | "end" = "end") {
    const t = value.trim();
    if (!t) return;
    const wiki = t.match(/^\[\[([^\]\n]+)\]\]$/);
    if (wiki) { add(wiki[1].trim(), position); return; }
    const lower = t.toLowerCase();
    if (items.some((i) => (i.text ?? i.ref).toLowerCase() === lower)) return;
    const node: ListItem = { ref: t, text: t };
    onChange(position === "start" ? [node, ...items] : [...items, node]);
  }
  function addItem(item: ListItem, position: "start" | "end" = "end") {
    if (items.some((i) => i.ref.toLowerCase() === item.ref.toLowerCase())) return;
    onChange(position === "start" ? [item, ...items] : [...items, item]);
  }
  // Persist an image file as a new image-only list item.
  // `position` controls whether it lands at the start or the end.
  async function ingestImageFile(file: File, position: "start" | "end" = "end") {
    if (!onUploadImage) return;
    const url = await onUploadImage(file);
    const cleaned = url.split(/[?#]/)[0];
    let base = cleaned.split("/").pop() ?? cleaned;
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    addItem({ ref: base, image: base }, position);
  }

  function updateMeta(index: number, meta: string) {
    const next = items.slice();
    next[index] = { ...next[index], meta: meta.trim() || undefined };
    onChange(next);
  }

  function updateRef(index: number, ref: string) {
    const trimmed = ref.trim();
    if (!trimmed) return;
    // Reject a rename that collides with another item's ref (case-insensitive).
    const lower = trimmed.toLowerCase();
    if (items.some((it, i) => i !== index && it.ref.toLowerCase() === lower)) return;
    const next = items.slice();
    next[index] = { ...next[index], ref: trimmed };
    onChange(next);
  }
  /** Title commit aware of wikilink vs text. Mirror of ListLines's
   *  updateTitle — picking an NF from autocomplete writes back a
   *  wikilink item; raw text becomes a text bullet so it round-trips
   *  through the serializer as `- text` instead of `- [[text]]`. */
  function updateTitle(index: number, value: string, asWikilink: boolean) {
    const t = value.trim();
    if (!t) return;
    const lower = t.toLowerCase();
    if (items.some((it, i) => i !== index && it.ref.toLowerCase() === lower)) return;
    const next = items.slice();
    if (asWikilink) {
      const { text: _drop, ...rest } = next[index];
      next[index] = { ...rest, ref: t };
    } else {
      next[index] = { ref: t, text: t };
    }
    onChange(next);
  }

  // Autocomplete candidates: Notable Folder names from the vault
  // index, filtered to those that aren't already in this list.
  const notableFolderCandidates = vaultNotes
    .filter((n) => isNotableFolder(n.frontmatter))
    .map((n) => n.filename.replace(/\.md$/i, ""))
    .sort((a, b) => a.localeCompare(b));
  const existingRefsLower = new Set(items.map((i) => i.ref.toLowerCase()));

  if (items.length === 0 && !adding) {
    if (hideControls) {
      return <div className="basecard-grid"><div className="basecard-empty">No items match.</div></div>;
    }
    return (
      <div className="basecard-grid">
        <AddTile
          slim
          onCancel={() => setAdding(false)}
          onAdd={(value) => addFromInput(value, "end")}
          startOpen
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="basecard-grid"
    >
      {!hideControls && (
        <AddTile
          slim
          onImage={onUploadImage ? (f) => ingestImageFile(f, "start") : undefined}
          startOpen={addingTop}
          onAdd={(value) => { addFromInput(value, "start"); setAddingTop(false); }}
          onCancel={() => setAddingTop(false)}
          onOpen={() => setAddingTop(true)}
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      )}
      {items.map((item, originalIdx) => {
        // Image-only bullet (`* ![[foo.jpg]]`) — render the image as
        // the card's cover, no title/meta/navigation. Click opens an
        // inspector for zoom + caption editing. The image lives in
        // the list folder's own dir (or is an external URL).
        if (item.image) {
          const url = imageItemUrl(item, noteDir);
          const dragging = item.ref === draggingRef;
          return (
            <BaseCard
              key={item.ref}
              item={item}
              Icon={folderIcon(item.ref)}
              image={url}
              tintCls={originalIdx % 2 === 0 ? "is-royal" : "is-coral"}
              displayTitle=""
              metaSuggestion=""
              dragging={dragging}
              draggable={!readOnly}
              readOnly={hideControls}
              imageOnly
              onNavigate={url ? () => setInspectingIdx(originalIdx) : undefined}
              onTilePointerDown={onTilePointerDown}
              onDelete={() => remove(originalIdx)}
              onMetaChange={() => {}}
              onRefChange={() => {}}
            />
          );
        }
        const note = resolveNoteRef(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const tintCls = originalIdx % 2 === 0 ? "is-royal" : "is-coral";
        const dragging = item.ref === draggingRef;
        // Plain-text bullet — the parser surfaced it as a list item so
        // the user's `- foo` bullets show as cards, but there's no
        // backing note to navigate to. Render the text as the title,
        // no nav, no resolve-by-name machinery.
        const isText = !!item.text;
        // Folder glyph only when the row actually points at a Notable
        // Folder — otherwise a neutral dot, so the icon doesn't promise
        // navigation the row can't deliver. (Plain text bullets +
        // wikilinks to non-NF notes both fall through here.)
        const isNFRow = !!(note && isNotableFolder(note.frontmatter));
        const Icon = isNFRow ? folderIcon(item.ref, note?.frontmatter.icon) : DotIcon;
        return (
          <BaseCard
            key={item.ref}
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            displayTitle={isText ? item.text! : displayTitleFor(item, note)}
            metaSuggestion={isText ? "" : pickMeta(item, note)}
            dragging={dragging}
            draggable={!readOnly}
            readOnly={hideControls}
            onNavigate={(() => {
              if (isText) return undefined;
              if (!note) return undefined;
              if (isNFRow && onAddFilter) return () => onAddFilter(item.ref);
              if (onNavigate) return () => onNavigate(item.ref);
              return undefined;
            })()}
            onTilePointerDown={onTilePointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onRefChange={(r) => updateRef(originalIdx, r)}
            onTitleChange={(value, asWikilink) => updateTitle(originalIdx, value, asWikilink)}
            candidates={notableFolderCandidates}
            excludeCandidates={(() => {
              // Exclude every existing ref except this row's own, so
              // re-confirming the same name isn't flagged as a dup.
              const ex = new Set(existingRefsLower);
              ex.delete(item.ref.toLowerCase());
              return ex;
            })()}
          />
        );
      })}
      {!hideControls && (
        <AddTile
          slim
          onImage={onUploadImage ? (f) => ingestImageFile(f, "end") : undefined}
          startOpen={adding}
          onAdd={(value) => { addFromInput(value, "end"); setAdding(false); }}
          onCancel={() => setAdding(false)}
          onOpen={() => setAdding(true)}
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      )}
      {inspectingIdx !== null && items[inspectingIdx]?.image && (() => {
        const item = items[inspectingIdx];
        const url = imageItemUrl(item, noteDir);
        if (!url) return null;
        return (
          <ImageInspector
            imageUrl={url}
            initialCaption={item.caption}
            onCaptionChange={(c) => updateCaption(inspectingIdx, c)}
            onReplaceImage={!hideControls && onUploadImage ? async (file) => {
              const newUrl = await onUploadImage(file);
              // Derive the basename from the URL so item.ref/image
              // round-trip cleanly to `![[newfile.png]]` on save.
              const cleaned = newUrl.split(/[?#]/)[0];
              let base = cleaned.split("/").pop() ?? cleaned;
              try { base = decodeURIComponent(base); } catch { /* keep raw */ }
              const next = items.slice();
              next[inspectingIdx] = { ...next[inspectingIdx], ref: base, image: base };
              onChange(next);
              return base;
            } : undefined}
            onDeleteItem={!hideControls ? () => remove(inspectingIdx) : undefined}
            onClose={() => setInspectingIdx(null)}
            readOnly={hideControls}
          />
        );
      })()}
    </div>
  );
}

interface BaseCardProps {
  item: ListItem;
  Icon: ReturnType<typeof folderIcon>;
  image?: string;
  tintCls: string;
  /** Visible label — prefers linked note's frontmatter `title:` over
   *  the bullet's wikilink ref so filenames-on-disk can be pretty
   *  while the displayed title keeps original punctuation. */
  displayTitle: string;
  metaSuggestion: string;
  dragging: boolean;
  draggable: boolean;
  readOnly: boolean;
  /** Image-only list item (`* ![[foo.jpg]]`): render cover only, no
   *  title row, no meta row, no inline-rename affordance. */
  imageOnly?: boolean;
  onNavigate?: () => void;
  onTilePointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
  onRefChange: (ref: string) => void;
  /** Title commit aware of the wikilink-vs-text split. Wired up for the
   *  full-fat ListCards render; the image-only and other compact uses
   *  fall back to onRefChange when this is absent. */
  onTitleChange?: (value: string, asWikilink: boolean) => void;
  /** NF refs available to the autocomplete. Empty disables the
   *  dropdown but the plain-text fallback still works. */
  candidates?: string[];
  /** Lowercase refs in this list (excluding self) — fed to the
   *  autocomplete so already-used folders don't appear again. */
  excludeCandidates?: Set<string>;
}

function BaseCard({
  item, Icon, image, tintCls, displayTitle, metaSuggestion,
  dragging, draggable, readOnly, imageOnly, onNavigate,
  onTilePointerDown, onDelete, onMetaChange, onRefChange,
  onTitleChange, candidates, excludeCandidates,
}: BaseCardProps) {
  const [editingMeta, setEditingMeta] = useState(false);
  const [draft, setDraft] = useState("");
  const metaInputRef = useRef<HTMLInputElement>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingMeta) {
      setDraft(metaSuggestion);
      requestAnimationFrame(() => metaInputRef.current?.focus());
    }
  }, [editingMeta, metaSuggestion]);

  useEffect(() => {
    if (editingTitle) setTitleDraft(item.text ?? item.ref);
  }, [editingTitle, item.text, item.ref]);

  function commitMeta() {
    if (draft !== metaSuggestion) onMetaChange(draft);
    setEditingMeta(false);
  }

  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== item.ref) onRefChange(next);
    setEditingTitle(false);
  }

  return (
    <article
      className={"basecard" + (dragging ? " is-dragging" : "") + (draggable ? " draggable" : "")}
      data-tile-ref={item.ref}
      onPointerDown={draggable ? (e) => onTilePointerDown(e, item.ref) : undefined}
    >
      {/* basecard-frame holds all visuals so a "lift" scale during drag
          can live here. */}
      <div className="basecard-frame">
        {image ? (
          <div
            className={"basecard-cover" + (onNavigate ? " is-link" : "")}
            style={{ backgroundImage: `url(${image})` }}
            onClick={onNavigate ? (e) => { e.stopPropagation(); onNavigate(); } : undefined}
            role={onNavigate ? "link" : undefined}
            aria-label={onNavigate ? `Open ${displayTitle}` : undefined}
            title={onNavigate ? `Open ${displayTitle}` : undefined}
          />
        ) : (
          <div
            className={`basecard-cover is-fallback ${tintCls}` + (onNavigate ? " is-link" : "")}
            onClick={onNavigate ? (e) => { e.stopPropagation(); onNavigate(); } : undefined}
            role={onNavigate ? "link" : undefined}
            aria-label={onNavigate ? `Open ${displayTitle}` : undefined}
            title={onNavigate ? `Open ${displayTitle}` : undefined}
          >
            {/* Large text-relevant icon (folderIcon picks it from the
                item name). CSS sizes it to ~44% of the cover width so it
                reads as a deliberate cover next to image cards, at any
                column width. */}
            <Icon size={64} strokeWidth={1.3} className="basecard-fallback-icon" />
          </div>
        )}
        {!readOnly && (
          <button
            type="button"
            className="basecard-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Remove from list"
            aria-label="Remove from list"
          >
            <XIcon size={11} strokeWidth={2} />
          </button>
        )}
        {imageOnly ? (
          item.caption ? (
            <div className="basecard-body basecard-body-image">
              <span className="basecard-caption">{item.caption}</span>
            </div>
          ) : null
        ) : (
        <div className="basecard-body">
          {editingTitle ? (
            <WikiRefInput
              autoFocus
              value={titleDraft}
              onChange={setTitleDraft}
              onCommit={(final) => {
                const t = final.trim();
                if (t) {
                  if (onTitleChange) {
                    // Same Milkdown-style rule as ListLines: a value
                    // that is exactly `[[Name]]` saves as wikilink;
                    // anything else saves as plain text.
                    const wiki = t.match(/^\[\[([^\]\n]+)\]\]$/);
                    if (wiki) onTitleChange(wiki[1].trim(), true);
                    else onTitleChange(t, false);
                  } else if (t !== item.ref) {
                    onRefChange(t);
                  }
                }
                setEditingTitle(false);
              }}
              onCancel={() => setEditingTitle(false)}
              candidates={candidates ?? []}
              exclude={excludeCandidates}
              className="basecard-title-input"
              placeholder="Text or [[Folder]]"
            />
          ) : (
            <button
              type="button"
              className={"basecard-title" + (onNavigate ? " is-link" : "")}
              onClick={() => {
                if (onNavigate) onNavigate();
                else if (!readOnly) setEditingTitle(true);
              }}
              onPointerDown={(e) => e.stopPropagation()}
              title={onNavigate ? `Open ${displayTitle}` : (readOnly ? displayTitle : "Click to rename (link target)")}
            >
              {displayTitle}
            </button>
          )}
          {editingMeta ? (
            <input
              ref={metaInputRef}
              className="basecard-meta-input"
              value={draft}
              placeholder={metaSuggestion || "Meta…"}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitMeta}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitMeta(); }
                if (e.key === "Escape") { e.preventDefault(); setEditingMeta(false); }
              }}
            />
          ) : (
            <button
              type="button"
              className={"basecard-meta" + (metaSuggestion ? "" : " is-empty")}
              onClick={() => { if (!readOnly) setEditingMeta(true); }}
              onPointerDown={(e) => e.stopPropagation()}
              title={readOnly ? metaSuggestion : "Click to edit"}
            >
              {metaSuggestion || (readOnly ? "" : "Add meta…")}
            </button>
          )}
        </div>
        )}
      </div>
    </article>
  );
}

interface AddTileProps {
  startOpen?: boolean;
  /** Render as a slim full-width row instead of a full grid cell. */
  slim?: boolean;
  onAdd: (name: string) => void;
  onCancel: () => void;
  onOpen?: () => void;
  /** When provided, the slim row exposes two image affordances:
   *  a file picker (iOS Photos / desktop file dialog) and a clipboard
   *  paste button (navigator.clipboard.read for screenshot pastes). */
  onImage?: (file: File) => Promise<void> | void;
  /** Candidate refs for the autocomplete dropdown (NF names). */
  candidates?: string[];
  excludeRefs?: Set<string>;
}

function AddTile({ startOpen, slim, onAdd, onCancel, onOpen, onImage, candidates, excludeRefs }: AddTileProps) {
  const [open, setOpen] = useState(!!startOpen);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (startOpen) setOpen(true); }, [startOpen]);
  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current?.focus()); }, [open]);

  function commit() {
    if (draft.trim()) onAdd(draft.trim());
    setDraft("");
    setOpen(false);
  }
  function cancel() {
    setDraft("");
    setOpen(false);
    onCancel();
  }

  if (!open) {
    if (!slim) {
      return (
        <button
          type="button"
          className="basecard basecard-add"
          onClick={() => { setOpen(true); onOpen?.(); }}
        >
          <Plus size={20} strokeWidth={1.6} />
          <span className="basecard-add-label">New</span>
        </button>
      );
    }
    // Slim row: text "+ Add" button on the left, image affordances
    // (file picker + clipboard paste) on the right. Both image
    // controls are present on desktop AND iOS — the file picker maps
    // to the Photos picker on iOS, and clipboard-read works in iOS
    // WKWebView for screenshot pastes.
    return (
      <div className="basecard basecard-add is-slim">
        <button
          type="button"
          className="basecard-add-text"
          onClick={() => { setOpen(true); onOpen?.(); }}
          title="Add a wikilink list item"
        >
          <Plus size={14} strokeWidth={1.8} />
          <span className="basecard-add-label">Add note</span>
        </button>
        {onImage && (
          <span className="basecard-add-image-group">
            <label
              className="basecard-add-image-btn"
              title="Pick an image to add as a new image item"
            >
              <ImageIcon size={14} strokeWidth={1.8} />
              <span>Image</span>
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  for (const f of files) {
                    if (f.type.startsWith("image/")) await onImage(f);
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="basecard-add-image-btn"
              title="Paste image from clipboard"
              onClick={async () => {
                try {
                  if (!navigator.clipboard?.read) return;
                  const items = await navigator.clipboard.read();
                  for (const it of items) {
                    const imageType = it.types.find((t) => t.startsWith("image/"));
                    if (!imageType) continue;
                    const blob = await it.getType(imageType);
                    const ext = imageType.split("/")[1] ?? "png";
                    const file = new File([blob], `pasted-${Date.now()}.${ext}`, { type: imageType });
                    await onImage(file);
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error("clipboard paste failed:", err);
                }
              }}
            >
              <ClipboardPaste size={14} strokeWidth={1.8} />
              <span>Paste</span>
            </button>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className={"basecard basecard-add is-input" + (slim ? " is-slim" : "")}>
      <WikiRefInput
        autoFocus
        value={draft}
        onChange={setDraft}
        onCommit={(final) => {
          if (final.trim()) onAdd(final.trim());
          setDraft("");
          setOpen(false);
        }}
        onCancel={cancel}
        candidates={candidates ?? []}
        exclude={excludeRefs}
        className="basecard-add-input"
        placeholder="Item name — type [[ to link a folder"
      />
    </div>
  );
}
