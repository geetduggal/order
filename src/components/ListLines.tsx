// "lines" render for a list folder. Dense one-per-row layout with the
// same operations the cards render supports: drag-reorder (snapshot
// + insertion-by-row-midY + FLIP slide), inline title/meta edit,
// hover-× delete, "+ New" row at the end.
//
// Mirrors ListCards.tsx semantics so the dispatcher can swap freely.

import type React from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GripVertical, Plus, X as XIcon } from "lucide-react";
import { folderColor, folderIcon } from "../lib/folders";
import { displayTitleFor, isListFolder, listRender, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { resolveListItems } from "../lib/list-resolve";
import { ListCards } from "./ListCards";
export type { ListNoteRef };

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  /** Hide add row + per-item delete/inline-edit. Drag still works. */
  readOnlyMembership?: boolean;
  /** When true, any row whose linked target is itself a list folder
   *  renders its items as a small indented sub-list beneath the row.
   *  Sub-lists are display-only — edit by navigating to that file. */
  expandSublists?: boolean;
  /** Click-on-title navigation. When omitted, title click falls back
   *  to inline rename for every row. */
  onNavigate?: (ref: string) => void;
}

interface InsertPoint { beforeRef: string | null }

const DRAG_THRESHOLD_PX = 5;
const FLIP_DURATION_MS = 220;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

function resolve(ref: string, vault: ListNoteRef[]): ListNoteRef | undefined {
  const needle = ref.toLowerCase();
  return vault.find((n) => n.filename.replace(/\.md$/i, "").toLowerCase() === needle);
}

function pickMeta(item: ListItem, note?: ListNoteRef): string {
  if (item.meta) return item.meta;
  if (!note) return "";
  const fm = note.frontmatter;
  if (typeof fm.author === "string") return fm.author;
  if (typeof fm.description === "string") return fm.description;
  return "";
}

export function ListLines({ items, vaultNotes, onChange, readOnlyMembership, expandSublists, onNavigate }: Props) {
  const [draggedRef, setDraggedRef] = useState<string | null>(null);
  const [insertPoint, setInsertPoint] = useState<InsertPoint | null>(null);
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const draggedRefRef = useRef<string | null>(null);
  draggedRefRef.current = draggedRef;
  const insertPointRef = useRef<InsertPoint | null>(null);
  insertPointRef.current = insertPoint;
  const dragRef = useRef<{
    ref: string; startX: number; startY: number; started: boolean;
  } | null>(null);
  const snapshotRef = useRef<Map<string, DOMRect> | null>(null);

  const previewItems = useMemo(() => {
    if (!draggedRef || !insertPoint) return items;
    const dragged = items.find((i) => i.ref === draggedRef);
    if (!dragged) return items;
    const arr = items.filter((i) => i.ref !== draggedRef);
    if (insertPoint.beforeRef === null) return [...arr, dragged];
    const at = arr.findIndex((i) => i.ref === insertPoint.beforeRef);
    if (at < 0) return [...arr, dragged];
    arr.splice(at, 0, dragged);
    return arr;
  }, [items, draggedRef, insertPoint]);

  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = list.querySelectorAll<HTMLElement>("[data-flip-key]");
    const seen = new Set<string>();
    rows.forEach((row) => {
      const key = row.dataset.flipKey!;
      seen.add(key);
      row.getAnimations().forEach((a) => a.cancel());
      const curr = row.getBoundingClientRect();
      const prev = prevRects.current.get(key);
      if (prev) {
        const dy = prev.top - curr.top;
        if (Math.abs(dy) > 0.5) {
          row.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
            { duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "none" },
          );
        }
      }
      prevRects.current.set(key, curr);
    });
    for (const key of Array.from(prevRects.current.keys())) {
      if (!seen.has(key)) prevRects.current.delete(key);
    }
  });

  function commitReorder(fromRef: string, ip: InsertPoint) {
    const cur = itemsRef.current;
    const fromIdx = cur.findIndex((i) => i.ref === fromRef);
    if (fromIdx < 0) return;
    const arr = cur.filter((i) => i.ref !== fromRef);
    const picked = cur[fromIdx];
    if (ip.beforeRef === null) { onChange([...arr, picked]); return; }
    const at = arr.findIndex((i) => i.ref === ip.beforeRef);
    if (at < 0) return;
    arr.splice(at, 0, picked);
    if (arr.every((it, i) => it.ref === cur[i].ref)) return;
    onChange(arr);
  }

  function remove(index: number) {
    const next = items.slice();
    next.splice(index, 1);
    onChange(next);
  }
  function add(ref: string) {
    const t = ref.trim();
    if (!t) return;
    if (items.some((i) => i.ref.toLowerCase() === t.toLowerCase())) return;
    onChange([...items, { ref: t }]);
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

  function onPointerDown(e: React.PointerEvent, ref: string) {
    const t = e.target as HTMLElement;
    // Drag only from the handle. Title/meta clicks edit instead.
    if (!t.closest(".lr-handle")) return;
    if (e.button !== 0) return;
    dragRef.current = { ref, startX: e.clientX, startY: e.clientY, started: false };
  }

  useEffect(() => {
    function captureSnapshot() {
      const list = listRef.current;
      if (!list) return;
      const m = new Map<string, DOMRect>();
      list.querySelectorAll<HTMLElement>("[data-flip-key]").forEach((row) => {
        m.set(row.dataset.flipKey!, row.getBoundingClientRect());
      });
      snapshotRef.current = m;
    }

    function findInsertPoint(_x: number, y: number): InsertPoint | null {
      const snap = snapshotRef.current;
      const draggedR = draggedRefRef.current;
      if (!snap || !draggedR) return null;
      let bestRef: string | null = null;
      let bestRect: DOMRect | null = null;
      let bestDist = Infinity;
      snap.forEach((rect, ref) => {
        if (ref === draggedR) return;
        const cy = rect.top + rect.height / 2;
        const d = Math.abs(y - cy);
        if (d < bestDist) { bestDist = d; bestRef = ref; bestRect = rect; }
      });
      if (bestRef === null || !bestRect) return null;
      const r = bestRect as DOMRect;
      const midY = r.top + r.height / 2;
      if (y < midY) return { beforeRef: bestRef };
      const list = itemsRef.current;
      const bi = list.findIndex((it) => it.ref === bestRef);
      if (bi < 0) return { beforeRef: null };
      for (let i = bi + 1; i < list.length; i++) {
        if (list[i].ref !== draggedR) return { beforeRef: list[i].ref };
      }
      return { beforeRef: null };
    }

    function samePoint(a: InsertPoint | null, b: InsertPoint | null) {
      if (a === b) return true;
      if (!a || !b) return false;
      return a.beforeRef === b.beforeRef;
    }

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        const moved = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        d.started = true;
        captureSnapshot();
        setDraggedRef(d.ref);
      }
      const next = findInsertPoint(e.clientX, e.clientY);
      if (!samePoint(next, insertPointRef.current)) setInsertPoint(next);
    }
    function commit() {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.started) {
        const ip = insertPointRef.current;
        if (ip) commitReorder(d.ref, ip);
      }
      snapshotRef.current = null;
      setDraggedRef(null);
      setInsertPoint(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", commit);
    window.addEventListener("pointercancel", commit);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", commit);
      window.removeEventListener("pointercancel", commit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (items.length === 0 && !adding) {
    if (readOnlyMembership) {
      return <div className="list-lines"><div className="list-line list-line-empty">No items match.</div></div>;
    }
    return (
      <div className="list-lines">
        <AddRow startOpen onAdd={add} onCancel={() => setAdding(false)} />
      </div>
    );
  }

  return (
    <div ref={listRef} className="list-lines">
      {previewItems.map((item) => {
        const note = resolve(item.ref, vaultNotes);
        const originalIdx = items.findIndex((i) => i.ref === item.ref);
        const color = folderColor(item.ref, note?.frontmatter.color);
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const dragging = item.ref === draggedRef;
        // Expansion: when the linked target is itself a list folder,
        // show its items inline below the parent row. Render type
        // comes from the sub-list's own `list:` value — lines render
        // as a compact indented bullet list, cards as a small basecard
        // grid (read-only). Limit to 12 items so a long sub-list
        // doesn't crowd the parent.
        let expansion: React.ReactNode = null;
        if (expandSublists && note && note.body && isListFolder(note.frontmatter)) {
          const subItems = resolveListItems(note.frontmatter, note.body, vaultNotes).slice(0, 12);
          if (subItems.length > 0) {
            const subRender = listRender(note.frontmatter) ?? "cards";
            if (subRender === "cards") {
              expansion = (
                <div className="lr-expansion-cards">
                  <ListCards
                    items={subItems}
                    vaultNotes={vaultNotes}
                    onChange={() => { /* sub-list edits are read-only here */ }}
                    readOnlyMembership
                    onNavigate={onNavigate}
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
                    const metaText = sub.meta
                      || (typeof subNote?.frontmatter.author === "string" ? subNote.frontmatter.author : "")
                      || (typeof subNote?.frontmatter.description === "string" ? subNote.frontmatter.description : "");
                    const canNav = !!(subNote && onNavigate);
                    const subTitle = displayTitleFor(sub, subNote);
                    return (
                      <li key={sub.ref} className="lr-sublist-item">
                        <span className="lr-sublist-bullet">•</span>
                        {canNav ? (
                          <button
                            type="button"
                            className="lr-sublist-title is-link"
                            onClick={() => onNavigate!(sub.ref)}
                            title={`Open ${subTitle}`}
                          >
                            {subTitle}
                          </button>
                        ) : (
                          <span className="lr-sublist-title">{subTitle}</span>
                        )}
                        {metaText && <span className="lr-sublist-meta">{metaText}</span>}
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
            readOnly={!!readOnlyMembership}
            expansion={expansion}
            onNavigate={note && onNavigate ? () => onNavigate(item.ref) : undefined}
            onPointerDown={onPointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onRefChange={(r) => updateRef(originalIdx, r)}
          />
        );
      })}
      {!readOnlyMembership && (
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
  readOnly: boolean;
  /** Pre-rendered sub-list to show below the row (cards grid or
   *  bullet list). Caller decides what to render based on the
   *  linked target's `list:` value. */
  expansion?: React.ReactNode;
  /** When provided, title click navigates instead of entering rename. */
  onNavigate?: () => void;
  onPointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
  onRefChange: (ref: string) => void;
}

function LineRow({
  item, color, Icon, displayTitle, metaSuggestion, dragging, readOnly, expansion, onNavigate,
  onPointerDown, onDelete, onMetaChange, onRefChange,
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
  // section so FLIP tracks the whole section as one unit and the
  // expansion animates with its parent.
  const Wrapper = expansion ? "section" : "div";
  return (
    <Wrapper
      className={(expansion ? "list-line-section" : "list-line") + (dragging ? " is-dragging" : "")}
      data-flip-key={item.ref}
      onPointerDown={expansion ? undefined : (e) => onPointerDown(e, item.ref)}
    >
    <div
      className={"list-line" + (dragging && !expansion ? " is-dragging" : "")}
      onPointerDown={expansion ? (e) => onPointerDown(e, item.ref) : undefined}
    >
      <span className="lr-handle" title="Drag to reorder">
        <GripVertical size={14} strokeWidth={1.6} />
      </span>
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
