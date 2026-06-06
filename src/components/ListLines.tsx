// "lines" render for a list folder. Dense one-per-row layout with the
// same operations the cards render supports: drag-reorder (via the
// shared useTileDrag hook — handle-only so the rest of the row stays
// tappable/scrollable on touch), inline title/meta edit, hover-×
// delete, "+ New" row at the end.
//
// Mirrors ListCards.tsx semantics so the dispatcher can swap freely.

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { GripVertical, Plus, X as XIcon } from "lucide-react";
import { folderColor, folderIcon, isNotableFolder } from "../lib/folders";
import { displayTitleFor, isListFolder, listRender, type ListItem, type ListNoteRef } from "../lib/list-folder";
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

  // Image paste / drop: write the file to the list folder's own dir
  // via onUploadImage, then insert an image-only list item at the end
  // (same shape as `* ![[file.png]]` in the source bullets). We watch
  // the surrounding container so the user doesn't have to click into
  // a specific input to make the paste work.
  async function ingestImageFile(file: File) {
    if (!onUploadImage) return;
    const url = await onUploadImage(file);
    const cleaned = url.split(/[?#]/)[0];
    let base = cleaned.split("/").pop() ?? cleaned;
    try { base = decodeURIComponent(base); } catch { /* keep raw */ }
    addItem({ ref: base, image: base }, "end");
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

  if (items.length === 0 && !adding) {
    if (hideControls) {
      return <div className="list-lines"><div className="list-line list-line-empty">No items match.</div></div>;
    }
    return (
      <div className="list-lines">
        <AddRow startOpen onAdd={add} onCancel={() => setAdding(false)} />
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="list-lines"
      tabIndex={hideControls ? undefined : -1}
      onClick={hideControls ? undefined : (e) => {
        // Focus the container on empty-area click so paste reaches
        // onPaste below — plain <div>s don't receive paste events
        // unless they're focusable AND focused.
        if (e.target === e.currentTarget) e.currentTarget.focus();
      }}
      onPaste={hideControls || !onUploadImage ? undefined : (e) => {
        // Use clipboardData.items, not .files — screenshot pastes from
        // macOS / Windows tools come through items only.
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const it of Array.from(items)) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f && f.type.startsWith("image/")) files.push(f);
          }
        }
        if (files.length === 0) return;
        e.preventDefault();
        void Promise.all(files.map(ingestImageFile));
      }}
    >
      {!hideControls && (
        <AddRow
          startOpen={addingTop}
          onAdd={(name) => { add(name, "start"); setAddingTop(false); }}
          onCancel={() => setAddingTop(false)}
          onOpen={() => setAddingTop(true)}
        />
      )}
      {items.map((item, originalIdx) => {
        const note = resolveNoteRef(item.ref, vaultNotes);
        const color = folderColor(item.ref, note?.frontmatter.color);
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const dragging = item.ref === draggingRef;
        // Click semantics: an NF target accumulates into the active
        // filter set (so multi-folder views build up by drilling);
        // any other resolved note replaces with a single-ref filter.
        const isNF = !!(note && isNotableFolder(note.frontmatter));
        const titleHandler = note
          ? (isNF && onAddFilter ? () => onAddFilter(item.ref)
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
            displayTitle={displayTitleFor(item, note)}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            draggable={!readOnly}
            readOnly={hideControls}
            expansion={expansion}
            onNavigate={titleHandler}
            onTilePointerDown={onTilePointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onRefChange={(r) => updateRef(originalIdx, r)}
          />
        );
      })}
      {!hideControls && (
        <AddRow
          startOpen={adding}
          onAdd={(name) => { add(name); setAdding(false); }}
          onCancel={() => setAdding(false)}
          onOpen={() => setAdding(true)}
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
  onRefChange: (ref: string) => void;
}

function LineRow({
  item, color, Icon, displayTitle, metaSuggestion, dragging, draggable, readOnly, expansion, onNavigate,
  onTilePointerDown, onDelete, onMetaChange, onRefChange,
}: LineRowProps) {
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const metaInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingMeta) {
      setMetaDraft(metaSuggestion);
      requestAnimationFrame(() => metaInputRef.current?.focus());
    }
  }, [editingMeta, metaSuggestion]);
  useEffect(() => {
    if (editingTitle) {
      setTitleDraft(item.ref);
      requestAnimationFrame(() => {
        titleInputRef.current?.focus();
        titleInputRef.current?.select();
      });
    }
  }, [editingTitle, item.ref]);

  function commitMeta() {
    if (metaDraft !== metaSuggestion) onMetaChange(metaDraft);
    setEditingMeta(false);
  }
  function commitTitle() {
    const next = titleDraft.trim();
    if (next && next !== item.ref) onRefChange(next);
    setEditingTitle(false);
  }

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
        <input
          ref={titleInputRef}
          className="lr-title-input"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitTitle(); }
            if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
          }}
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
      {editingMeta ? (
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
      )}
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
  onAdd: (name: string) => void;
  onCancel: () => void;
  onOpen?: () => void;
}

function AddRow({ startOpen, onAdd, onCancel, onOpen }: AddRowProps) {
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
  function cancel() { setDraft(""); setOpen(false); onCancel(); }
  if (!open) {
    return (
      <button
        type="button"
        className="list-line list-line-add"
        onClick={() => { setOpen(true); onOpen?.(); }}
      >
        <Plus size={14} strokeWidth={1.6} />
        <span>New</span>
      </button>
    );
  }
  return (
    <div className="list-line list-line-add is-input">
      <input
        ref={inputRef}
        className="lr-add-input"
        value={draft}
        placeholder="Note name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); cancel(); }
        }}
      />
    </div>
  );
}
