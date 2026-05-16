// Interactive card grid for `type: list` Notable Folders.
//
// Drag model: pointer-down on a card seeds a candidate drag. Past a
// movement threshold we enter drag mode, computing an "insertion
// index" (between two cards, not on one) from the cursor's position
// relative to the nearest card's mid-x. We render a PREVIEW array
// with the dragged item moved to that insertion point, so the layout
// itself shows the target slot. A FLIP useLayoutEffect captures
// before/after positions and animates the displaced cards smoothly.
//
// On pointer-up the preview becomes the real items via onChange.
// Tauri's webview intercepts HTML5 drag-drop at the OS level, hence
// pointer events end-to-end.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import { folderIcon } from "../lib/folders";
import type { Frontmatter } from "../lib/frontmatter";
import type { ListItem } from "../lib/list-folder";

export interface ListNoteRef {
  filename: string;
  frontmatter: Frontmatter;
}

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
}

function resolve(ref: string, vaultNotes: ListNoteRef[]): ListNoteRef | undefined {
  const needle = ref.toLowerCase();
  return vaultNotes.find(
    (n) => n.filename.replace(/\.md$/i, "").toLowerCase() === needle,
  );
}

function pickMeta(item: ListItem, note?: ListNoteRef): string {
  if (item.meta) return item.meta;
  if (!note) return "";
  const fm = note.frontmatter;
  if (typeof fm.author === "string") return fm.author;
  if (typeof fm.description === "string") return fm.description;
  return "";
}

const DRAG_THRESHOLD_PX = 5;
const FLIP_DURATION_MS = 220;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export function ListCards({ items, vaultNotes, onChange }: Props) {
  const [draggedRef, setDraggedRef] = useState<string | null>(null);
  const [insertIdx, setInsertIdx] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const dragRef = useRef<{
    ref: string; startX: number; startY: number; started: boolean;
  } | null>(null);
  const insertIdxRef = useRef<number | null>(null);
  insertIdxRef.current = insertIdx;
  const draggedRefRef = useRef<string | null>(null);
  draggedRefRef.current = draggedRef;

  const previewItems = useMemo(() => {
    if (!draggedRef || insertIdx === null) return items;
    const fromIdx = items.findIndex((i) => i.ref === draggedRef);
    if (fromIdx < 0) return items;
    const arr = items.slice();
    const [picked] = arr.splice(fromIdx, 1);
    const insertAt = insertIdx > fromIdx ? insertIdx - 1 : insertIdx;
    arr.splice(insertAt, 0, picked);
    return arr;
  }, [items, draggedRef, insertIdx]);

  // FLIP: capture each card's screen position after every render.
  // If a card's position differs from the previous render, animate
  // the displacement from the previous spot back to zero. The
  // result is a smooth slide as the layout reshuffles during drag.
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = grid.querySelectorAll<HTMLElement>("[data-flip-key]");
    const seen = new Set<string>();
    cards.forEach((card) => {
      const key = card.dataset.flipKey!;
      seen.add(key);
      const curr = card.getBoundingClientRect();
      const prev = prevRects.current.get(key);
      if (prev) {
        const dx = prev.left - curr.left;
        const dy = prev.top - curr.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          card.getAnimations().forEach((a) => a.cancel());
          card.animate(
            [
              { transform: `translate(${dx}px, ${dy}px)` },
              { transform: "translate(0, 0)" },
            ],
            { duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "none" },
          );
        }
      }
      prevRects.current.set(key, curr);
    });
    // Drop stale entries so removed cards don't leak positions.
    for (const key of Array.from(prevRects.current.keys())) {
      if (!seen.has(key)) prevRects.current.delete(key);
    }
  });

  function move(fromRef: string, toIdx: number) {
    const current = itemsRef.current;
    const fromIdx = current.findIndex((i) => i.ref === fromRef);
    if (fromIdx < 0) return;
    if (fromIdx === toIdx || (fromIdx === toIdx - 1)) return; // no-op
    const next = current.slice();
    const [picked] = next.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    next.splice(insertAt, 0, picked);
    onChange(next);
  }

  function remove(index: number) {
    const next = items.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function add(ref: string) {
    const trimmed = ref.trim();
    if (!trimmed) return;
    if (items.some((i) => i.ref.toLowerCase() === trimmed.toLowerCase())) return;
    onChange([...items, { ref: trimmed }]);
  }

  function updateMeta(index: number, meta: string) {
    const next = items.slice();
    next[index] = { ...next[index], meta: meta.trim() || undefined };
    onChange(next);
  }

  function onPointerDown(e: React.PointerEvent, ref: string) {
    const t = e.target as HTMLElement;
    if (t.closest("input, button, .basecard-meta")) return;
    if (e.button !== 0) return;
    dragRef.current = {
      ref, startX: e.clientX, startY: e.clientY, started: false,
    };
  }

  useEffect(() => {
    function findInsertionIndex(x: number, y: number): number | null {
      const grid = gridRef.current;
      if (!grid) return null;
      const cards = grid.querySelectorAll<HTMLElement>("[data-list-card-index]");
      if (cards.length === 0) return 0;
      // Find the nearest card by squared distance to its center,
      // then split on its mid-x to decide before/after.
      let bestIdx = 0;
      let bestDist = Infinity;
      let bestRect: DOMRect | null = null;
      cards.forEach((card) => {
        const rect = card.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = parseInt(card.dataset.listCardIndex!, 10);
          bestRect = rect;
        }
      });
      if (!bestRect) return null;
      const r = bestRect as DOMRect;
      const midX = r.left + r.width / 2;
      return x < midX ? bestIdx : bestIdx + 1;
    }

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        const moved = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        d.started = true;
        setDraggedRef(d.ref);
      }
      const idx = findInsertionIndex(e.clientX, e.clientY);
      if (idx !== insertIdxRef.current) setInsertIdx(idx);
    }

    function commit() {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.started) {
        const to = insertIdxRef.current;
        if (to !== null) move(d.ref, to);
      }
      setDraggedRef(null);
      setInsertIdx(null);
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
    return (
      <div className="basecard-grid">
        <AddTile onCancel={() => setAdding(false)} onAdd={add} startOpen />
      </div>
    );
  }

  return (
    <div ref={gridRef} className="basecard-grid">
      {previewItems.map((item, displayIdx) => {
        const note = resolve(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        // Tint alternation follows the ORIGINAL items index so colors
        // stay stable per item across reorders (less visual noise).
        const originalIdx = items.findIndex((i) => i.ref === item.ref);
        const tintCls = originalIdx % 2 === 0 ? "is-royal" : "is-coral";
        const dragging = item.ref === draggedRef;
        return (
          <BaseCard
            key={item.ref}
            index={displayIdx}
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            onPointerDown={onPointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
          />
        );
      })}
      <AddTile
        startOpen={adding}
        onAdd={(name) => { add(name); setAdding(false); }}
        onCancel={() => setAdding(false)}
        onOpen={() => setAdding(true)}
      />
    </div>
  );
}

interface BaseCardProps {
  index: number;
  item: ListItem;
  Icon: ReturnType<typeof folderIcon>;
  image?: string;
  tintCls: string;
  metaSuggestion: string;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
}

function BaseCard({
  index, item, Icon, image, tintCls, metaSuggestion,
  dragging,
  onPointerDown, onDelete, onMetaChange,
}: BaseCardProps) {
  const [editingMeta, setEditingMeta] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingMeta) {
      setDraft(metaSuggestion);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editingMeta, metaSuggestion]);

  function commitMeta() {
    if (draft !== metaSuggestion) onMetaChange(draft);
    setEditingMeta(false);
  }

  return (
    <article
      className={"basecard" + (dragging ? " is-dragging" : "")}
      data-list-card-index={index}
      data-flip-key={item.ref}
      onPointerDown={(e) => onPointerDown(e, item.ref)}
    >
      {image ? (
        <div className="basecard-cover" style={{ backgroundImage: `url(${image})` }} />
      ) : (
        <div className={`basecard-cover is-fallback ${tintCls}`}>
          <Icon size={44} strokeWidth={1.3} />
        </div>
      )}
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
      <div className="basecard-body">
        <div className="basecard-title">{item.ref}</div>
        {editingMeta ? (
          <input
            ref={inputRef}
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
            onClick={() => setEditingMeta(true)}
            onPointerDown={(e) => e.stopPropagation()}
            title="Click to edit"
          >
            {metaSuggestion || "Add meta…"}
          </button>
        )}
      </div>
    </article>
  );
}

interface AddTileProps {
  startOpen?: boolean;
  onAdd: (name: string) => void;
  onCancel: () => void;
  onOpen?: () => void;
}

function AddTile({ startOpen, onAdd, onCancel, onOpen }: AddTileProps) {
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
  return (
    <div className="basecard basecard-add is-input">
      <input
        ref={inputRef}
        className="basecard-add-input"
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
