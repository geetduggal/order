// "lines" render for a list folder. Dense one-per-row layout with the
// same operations the cards render supports: drag-reorder (via the
// shared useTileDrag hook — handle-only so the rest of the row stays
// tappable/scrollable on touch), inline title/meta edit, hover-×
// delete, "+ New" row at the end.
//
// Mirrors ListCards.tsx semantics so the dispatcher can swap freely.

import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, X as XIcon, Image as ImageIcon, ClipboardPaste } from "lucide-react";
import { folderColor, folderIcon, listItemIcon, isNotableFolder } from "../lib/folders";
import { displayTitleFor, isListFolder, listRender, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { WikiRefInput } from "./WikiRefInput";
import { resolveNoteRef } from "../lib/wikilink";
import { resolveListItems } from "../lib/list-resolve";
import { useTileDrag } from "../lib/use-tile-drag";
import { ListCards } from "./ListCards";
export type { ListNoteRef };

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  /** Fully static — no drag, no add, no delete, no inline edit.
   *  Used by the published viewer and display-only sub-lists. */
  readOnly?: boolean;
  /** Hide add row + per-item delete/inline-edit, but KEEP drag-reorder.
   *  Used for base-driven lists where membership is controlled by the
   *  base block. */
  readOnlyMembership?: boolean;
  /** When true, any row whose linked target is itself a list folder
   *  renders its items as a small indented sub-list beneath the row.
   *  Sub-lists are display-only — edit by navigating to that file. */
  expandSublists?: boolean;
  /** Click-on-title navigation. When omitted, title click falls back
   *  to inline rename for every row. */
  onNavigate?: (ref: string) => void;
  /** Additive filter — used when the linked target is a Notable
   *  Folder so a click ACCUMULATES filter chips instead of
   *  replacing the set. */
  onAddFilter?: (ref: string) => void;
  /** Paste / drop image upload. When the user pastes (or drops) an
   *  image onto the list, the file is persisted to the list folder's
   *  dir via this callback and an image-only bullet is appended. */
  onUploadImage?: (file: File) => Promise<string>;
}

function pickMeta(item: ListItem, note?: ListNoteRef): string {
  if (item.meta) return item.meta;
  if (!note) return "";
  const fm = note.frontmatter;
  if (typeof fm.author === "string") return fm.author;
  if (typeof fm.description === "string") return fm.description;
  return "";
}

// Pull a date/year out of a list item's meta so it can be pinned to the
// right of the row. `secondary` is any remaining text (e.g. an academic
// venue) to show as a dim subtitle that wraps under the title.
function splitDatedMeta(meta: string): { pinned: string; secondary: string } | null {
  const m = meta.trim();
  if (!m) return null;
  // Articles: a leading ISO date is the whole meta.
  if (/^\d{4}-\d{2}-\d{2}/.test(m)) return { pinned: m, secondary: "" };
  // Academic: "Venue · 2017" — pin the trailing 4-digit year.
  const parts = m.split(" · ");
  const last = parts[parts.length - 1].trim();
  if (parts.length > 1 && /^\d{4}$/.test(last)) {
    return { pinned: last, secondary: parts.slice(0, -1).join(" · ").trim() };
  }
  return null;
}

export function ListLines({ items, vaultNotes, onChange, readOnly, readOnlyMembership, expandSublists, onNavigate, onAddFilter, onUploadImage }: Props) {
  const [adding, setAdding] = useState(false);
  const [addingTop, setAddingTop] = useState(false);
  const hideControls = !!readOnly || !!readOnlyMembership;

  // Persist an image file as a new image-only list item.
  async function ingestImageFile(file: File, position: "start" | "end" = "end") {
    if (!onUploadImage) return;
    const url = await onUploadImage(file);
    const cleaned = url.split(/[?#]/)[0];
    let base = cleaned.split("/").pop() ?? cleaned;
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    addItem({ ref: base, image: base }, position);
  }

  // Map a reordered ref list back to items, then persist.
  function reorder(order: string[]) {
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const next = order.map((r) => byRef.get(r)).filter((i): i is ListItem => !!i);
    if (next.length === items.length) onChange(next);
  }
  const { gridRef, dragRef: draggingRef, onTilePointerDown } = useTileDrag(
    items.map((i) => i.ref),
    readOnly ? undefined : reorder,
    { handle: ".lr-handle" },
  );

  function remove(index: number) {
    const next = items.slice();
    next.splice(index, 1);
    onChange(next);
  }
  function add(ref: string, position: "start" | "end" = "end") {
    const t = ref.trim();
    if (!t) return;
    if (items.some((i) => i.ref.toLowerCase() === t.toLowerCase())) return;
    onChange(position === "start" ? [{ ref: t }, ...items] : [...items, { ref: t }]);
  }
  /** Add from the add-row input. Default is a PLAIN TEXT item; only a
   *  value that is exactly `[[Name]]` (the Milkdown-style trigger the
   *  add input now supports) becomes a wikilink. Mirrors updateTitle's
   *  text-vs-wikilink split. */
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
  function updateMeta(index: number, meta: string) {
    const next = items.slice();
    next[index] = { ...next[index], meta: meta.trim() || undefined };
    onChange(next);
  }
  function updateRef(index: number, ref: string) {
    const t = ref.trim();
    if (!t) return;
    const lower = t.toLowerCase();
    if (items.some((it, i) => i !== index && it.ref.toLowerCase() === lower)) return;
    const next = items.slice();
    next[index] = { ...next[index], ref: t };
    onChange(next);
  }
  /** Title commit that knows whether to write the value back as a
   *  wikilink (an NF the user picked from autocomplete) or as a plain
   *  text bullet. Wikilinks drop the text field; text items strip the
   *  meta because plain bullets don't carry the ` · meta` suffix. */
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
      return <div className="list-lines"><div className="list-line list-line-empty">No items match.</div></div>;
    }
    return (
      <div className="list-lines">
        <AddRow
          startOpen
          onAdd={(value) => addFromInput(value, "end")}
          onCancel={() => setAdding(false)}
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="list-lines"
    >
      {/* Top add row — collapsed to a thin "+ add to top" until clicked,
          so new items can land at the head of the list (parity with the
          cards view). The bottom row stays the primary add affordance. */}
      {!hideControls && (
        <AddRow
          slim
          startOpen={addingTop}
          onAdd={(value) => { addFromInput(value, "start"); setAddingTop(false); }}
          onCancel={() => setAddingTop(false)}
          onOpen={() => setAddingTop(true)}
          onImage={onUploadImage ? (f) => ingestImageFile(f, "start") : undefined}
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      )}
      {items.map((item, originalIdx) => {
        // Plain-text bullet — display its text, no navigation, no
        // resolve. The parser surfaces these so plain `- foo` bullets
        // become rows in the lines view alongside any wikilink rows.
        const isText = !!item.text;
        const note = isText ? null : resolveNoteRef(item.ref, vaultNotes);
        const color = folderColor(item.ref, note?.frontmatter.color);
        // Folder icon means "this row links to a Notable Folder". Other
        // rows (plain text, or a wikilink to a non-NF note) get a large,
        // name-relevant glyph — "Cal Newport Books" → an open book —
        // falling back to a neutral tag rather than a bare dot.
        const isNFRow = !!(note && isNotableFolder(note.frontmatter));
        const Icon = isNFRow
          ? folderIcon(item.ref, note?.frontmatter.icon)
          : listItemIcon(item.text ?? item.ref, note?.frontmatter.icon);
        const dragging = item.ref === draggingRef;
        const isNF = !!(note && isNotableFolder(note.frontmatter));
        const titleHandler = note
          ? (isNFRow && onAddFilter ? () => onAddFilter(item.ref)
              : onNavigate ? () => onNavigate(item.ref)
              : undefined)
          : undefined;
        // Expansion: when the linked target is itself a list folder,
        // show its items inline below the parent row. Render type
        // comes from the sub-list's own `list:` value — lines render
        // as a compact indented bullet list, cards as a small basecard
        // grid (read-only). Limit to 12 items so a long sub-list
        // doesn't crowd the parent.
        let expansion: React.ReactNode = null;
        if (expandSublists && note && note.body && isListFolder(note.frontmatter)) {
          const subItems = resolveListItems(note.frontmatter, note.body, vaultNotes);
          function metaText(sub: ListItem): string {
            const subNote = vaultNotes.find(
              (n) => n.filename.replace(/\.md$/i, "").toLowerCase() === sub.ref.toLowerCase(),
            );
            return sub.meta
              || (typeof subNote?.frontmatter.author === "string" ? subNote.frontmatter.author : "")
              || (typeof subNote?.frontmatter.description === "string" ? subNote.frontmatter.description : "");
          }
          if (subItems.length > 0) {
            const subRender = listRender(note.frontmatter) ?? "cards";
            if (subRender === "cards") {
              expansion = (
                <div className="lr-expansion-cards">
                  <ListCards
                    items={subItems}
                    vaultNotes={vaultNotes}
                    onChange={() => { /* sub-list edits are read-only here */ }}
                    readOnly
                    onNavigate={onNavigate}
                    onAddFilter={onAddFilter}
                  />
                </div>
              );
            } else {
              expansion = (
                <ul className="lr-sublist">
                  {subItems.map((sub) => {
                    const subNote = vaultNotes.find(
                      (n) => n.filename.replace(/\.md$/i, "").toLowerCase() === sub.ref.toLowerCase(),
                    );
                    const meta = metaText(sub);
                    const subIsNF = !!(subNote && isNotableFolder(subNote.frontmatter));
                    const subClick = subNote
                      ? (subIsNF && onAddFilter ? () => onAddFilter(sub.ref)
                          : onNavigate ? () => onNavigate(sub.ref)
                          : undefined)
                      : undefined;
                    const subTitle = displayTitleFor(sub, subNote);
                    // Pin a leading ISO date (Articles) or a trailing
                    // year (Academic: "Venue · 2017") to the right; the
                    // remainder, if any, wraps as a dim subtitle.
                    const dated = splitDatedMeta(meta);
                    const titleEl = subClick ? (
                      <button
                        type="button"
                        className="lr-sublist-title is-link"
                        onClick={subClick}
                        title={`Open ${subTitle}`}
                      >
                        {subTitle}
                      </button>
                    ) : (
                      <span className="lr-sublist-title">{subTitle}</span>
                    );
                    return (
                      <li key={sub.ref} className={"lr-sublist-item" + (dated ? " is-dated" : "")}>
                        {dated ? (
                          <span className="lr-sublist-main">
                            {titleEl}
                            {dated.secondary && <span className="lr-sublist-sub">{dated.secondary}</span>}
                          </span>
                        ) : titleEl}
                        {dated
                          ? <span className="lr-sublist-date">{dated.pinned}</span>
                          : (meta && <span className="lr-sublist-meta"> · {meta}</span>)}
                      </li>
                    );
                  })}
                </ul>
              );
            }
          }
        }
        return (
          <LineRow
            key={item.ref}
            item={item}
            color={color}
            Icon={Icon}
            displayTitle={isText ? item.text! : displayTitleFor(item, note ?? undefined)}
            metaSuggestion={isText ? "" : pickMeta(item, note ?? undefined)}
            dragging={dragging}
            draggable={!readOnly}
            readOnly={hideControls}
            expansion={expansion}
            onNavigate={isText ? undefined : titleHandler}
            onTilePointerDown={onTilePointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onTitleChange={(value, asWikilink) => updateTitle(originalIdx, value, asWikilink)}
            candidates={notableFolderCandidates}
            existingRefsLower={existingRefsLower}
          />
        );
      })}
      {!hideControls && (
        <AddRow
          startOpen={adding}
          onAdd={(value) => { addFromInput(value, "end"); setAdding(false); }}
          onCancel={() => setAdding(false)}
          onOpen={() => setAdding(true)}
          onImage={onUploadImage ? (f) => ingestImageFile(f, "end") : undefined}
          candidates={notableFolderCandidates}
          excludeRefs={existingRefsLower}
        />
      )}
    </div>
  );
}

interface LineRowProps {
  item: ListItem;
  color: string;
  Icon: ReturnType<typeof folderIcon>;
  /** Visible label; falls back to `item.ref` upstream when no
   *  frontmatter `title:` exists on the linked note. */
  displayTitle: string;
  metaSuggestion: string;
  dragging: boolean;
  draggable: boolean;
  readOnly: boolean;
  /** Pre-rendered sub-list to show below the row (cards grid or
   *  bullet list). Caller decides what to render based on the
   *  linked target's `list:` value. */
  expansion?: React.ReactNode;
  /** When provided, title click navigates instead of entering rename. */
  onNavigate?: () => void;
  onTilePointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
  /** Title commit. `asWikilink` is true when the user picked a Notable
   *  Folder name from the autocomplete; false when they typed plain
   *  text. The parent maps the two into ref-only vs ref+text items. */
  onTitleChange: (value: string, asWikilink: boolean) => void;
  /** NF refs available for autocomplete. Empty array disables the
   *  dropdown but the input still accepts plain-text edits. */
  candidates: string[];
  /** Lowercase refs already in the list — excluded from suggestions
   *  to avoid offering a duplicate. */
  existingRefsLower: Set<string>;
}

function LineRow({
  item, color, Icon, displayTitle, metaSuggestion, dragging, draggable, readOnly, expansion, onNavigate,
  onTilePointerDown, onDelete, onMetaChange, onTitleChange, candidates, existingRefsLower,
}: LineRowProps) {
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const metaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingMeta) {
      setMetaDraft(metaSuggestion);
      requestAnimationFrame(() => metaInputRef.current?.focus());
    }
  }, [editingMeta, metaSuggestion]);
  // Seed the title draft with the visible label (text bullets) or the
  // ref (wikilinks). When the user picks an NF from autocomplete the
  // commit fires with `asWikilink: true`; bare-typed text commits with
  // `asWikilink: false`. Either way the parent owns the on-disk shape.
  useEffect(() => {
    if (editingTitle) setTitleDraft(item.text ?? item.ref);
  }, [editingTitle, item.text, item.ref]);

  function commitMeta() {
    if (metaDraft !== metaSuggestion) onMetaChange(metaDraft);
    setEditingMeta(false);
  }
  // Exclude THIS row's own ref from the autocomplete-dup set so the
  // user can re-confirm the same name without it being treated as a
  // collision.
  const candidateExclude = useMemo(() => {
    const ex = new Set(existingRefsLower);
    ex.delete(item.ref.toLowerCase());
    return ex;
  }, [existingRefsLower, item.ref]);

  // When an expansion is present, wrap header row + expansion in a
  // section so the whole unit is the drag cell and the expansion
  // travels with its parent.
  const Wrapper = expansion ? "section" : "div";
  return (
    <Wrapper
      className={(expansion ? "list-line-section" : "list-line") + (dragging ? " is-dragging" : "") + (draggable ? " draggable" : "")}
      data-tile-ref={item.ref}
      onPointerDown={draggable ? (e) => onTilePointerDown(e, item.ref) : undefined}
    >
    <div className={"list-line" + (dragging && !expansion ? " is-dragging" : "")}>
      {draggable && (
        <span className="lr-handle" title="Drag to reorder">
          <GripVertical size={14} strokeWidth={1.6} />
        </span>
      )}
      <Icon size={14} strokeWidth={1.7} style={{ color, flexShrink: 0 }} />
      {editingTitle ? (
        <WikiRefInput
          autoFocus
          value={titleDraft}
          onChange={setTitleDraft}
          onCommit={(final) => {
            const t = final.trim();
            if (t) {
              // The whole row commits as a wikilink ONLY if the value
              // is exactly `[[Name]]` — the Milkdown-style trigger
              // model: free text stays free text; typing `[[…]]`
              // turns the row into a link. Anything else (text with
              // stray brackets, prose) saves as a plain text bullet.
              const wiki = t.match(/^\[\[([^\]\n]+)\]\]$/);
              if (wiki) onTitleChange(wiki[1].trim(), true);
              else onTitleChange(t, false);
            }
            setEditingTitle(false);
          }}
          onCancel={() => setEditingTitle(false)}
          candidates={candidates}
          exclude={candidateExclude}
          className="lr-title-input"
          placeholder="Text or [[Folder]]"
        />
      ) : (
        <button
          type="button"
          className={"lr-title" + (onNavigate ? " is-link" : "")}
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
      {(() => {
        // Pin a leading ISO date (Articles) or trailing year (Academic
        // "Venue · 2017") to a fixed right-side column so dates align
        // across rows. The remainder, if any, renders as a dim
        // description between the title and the date column.
        const dated = !editingMeta ? splitDatedMeta(metaSuggestion) : null;
        if (dated) {
          return (
            <>
              {dated.secondary && (
                <span className="lr-meta lr-meta-secondary" title={dated.secondary}>
                  {dated.secondary}
                </span>
              )}
              <span className="lr-date" title={dated.pinned}>{dated.pinned}</span>
            </>
          );
        }
        return editingMeta ? (
          <input
            ref={metaInputRef}
            className="lr-meta-input"
            value={metaDraft}
            placeholder={metaSuggestion || "Meta…"}
            onChange={(e) => setMetaDraft(e.target.value)}
            onBlur={commitMeta}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitMeta(); }
              if (e.key === "Escape") { e.preventDefault(); setEditingMeta(false); }
            }}
          />
        ) : (
          <button
            type="button"
            className={"lr-meta" + (metaSuggestion ? "" : " is-empty")}
            onClick={() => { if (!readOnly) setEditingMeta(true); }}
            onPointerDown={(e) => e.stopPropagation()}
            title={readOnly ? metaSuggestion : "Click to edit"}
          >
            {metaSuggestion || (readOnly ? "" : "Add meta…")}
          </button>
        );
      })()}
      {!readOnly && (
        <button
          type="button"
          className="lr-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          onPointerDown={(e) => e.stopPropagation()}
          title="Remove"
          aria-label="Remove"
        >
          <XIcon size={11} strokeWidth={2} />
        </button>
      )}
    </div>
      {expansion}
    </Wrapper>
  );
}

interface AddRowProps {
  startOpen?: boolean;
  /** Raw input value on commit. The parent applies the
   *  text-vs-`[[wikilink]]` rule (see addFromInput). */
  onAdd: (value: string) => void;
  onCancel: () => void;
  onOpen?: () => void;
  /** Compact variant for the top-of-list add (thinner, "add to top"
   *  label) so it reads as secondary to the main bottom add row. */
  slim?: boolean;
  /** When provided, surface image affordances (file picker + clipboard
   *  paste button) alongside the "+ Add" text. */
  onImage?: (file: File) => Promise<void> | void;
  /** Candidate refs for the autocomplete dropdown — typically every
   *  Notable Folder name. */
  candidates?: string[];
  /** Refs already in the list — kept out of the autocomplete to avoid
   *  proposing a duplicate item. */
  excludeRefs?: Set<string>;
}

function AddRow({ startOpen, onAdd, onCancel, onOpen, onImage, candidates, excludeRefs, slim }: AddRowProps) {
  const [open, setOpen] = useState(!!startOpen);
  const [draft, setDraft] = useState("");
  useEffect(() => { if (startOpen) setOpen(true); }, [startOpen]);
  function cancel() { setDraft(""); setOpen(false); onCancel(); }
  function commitFinal(final: string) {
    if (final.trim()) onAdd(final.trim());
    setDraft("");
    setOpen(false);
  }
  if (!open) {
    return (
      <div className={"list-line list-line-add" + (slim ? " is-slim" : "")}>
        <button
          type="button"
          className="basecard-add-text"
          onClick={() => { setOpen(true); onOpen?.(); }}
          title={slim ? "Add an item to the top" : "Add a list item (type [[ to link a folder)"}
        >
          <Plus size={14} strokeWidth={1.6} />
          <span>{slim ? "Add to top" : "Add"}</span>
        </button>
        {onImage && (
          <span className="basecard-add-image-group">
            <label
              className="basecard-add-image-btn"
              title="Pick an image to add as a new image item"
            >
              <ImageIcon size={14} strokeWidth={1.6} />
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
              <ClipboardPaste size={14} strokeWidth={1.6} />
              <span>Paste</span>
            </button>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className={"list-line list-line-add is-input" + (slim ? " is-slim" : "")}>
      <WikiRefInput
        autoFocus
        value={draft}
        onChange={setDraft}
        onCommit={commitFinal}
        onCancel={cancel}
        candidates={candidates ?? []}
        exclude={excludeRefs}
        className="lr-add-input"
        placeholder="Item name — type [[ to link a folder"
      />
    </div>
  );
}
