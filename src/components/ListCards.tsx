// Interactive card grid for `type: list` Notable Folders.
//
// Drag model:
// - pointerdown seeds a candidate drag.
// - At the 5px threshold we snapshot every card's screen rect. This
//   snapshot is the source of truth for cursor → slot mapping for
//   the rest of the drag. Reading live DOM positions instead would
//   feed the FLIP animation back into the slot calculation and the
//   layout would oscillate.
// - The "insertion point" is { beforeRef: string | null } — insert
//   the dragged item before this specific ref, or at the end. Stable
//   under reorder, no index arithmetic.
// - A preview items array (dragged item moved to the insertion slot)
//   drives rendering. A FLIP useLayoutEffect captures before/after
//   positions every render and slides displaced cards smoothly.
// - On pointerup, preview becomes the real items via onChange.
//
// HTML5 drag-drop is unusable here — Tauri's webview intercepts it
// at the OS level, so drop events never reach in-page handlers.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import { folderIcon } from "../lib/folders";
import type { ListItem, ListNoteRef } from "../lib/list-folder";
export type { ListNoteRef };

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  /** Hide add tile + per-item delete/inline-edit. Drag still works. */
  readOnlyMembership?: boolean;
}

interface InsertPoint {
  /** null = insert at end of list */
  beforeRef: string | null;
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
const FLIP_DURATION_MS = 280;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

export function ListCards({ items, vaultNotes, onChange, readOnlyMembership }: Props) {
  const [draggedRef, setDraggedRef] = useState<string | null>(null);
  const [insertPoint, setInsertPoint] = useState<InsertPoint | null>(null);
  const [adding, setAdding] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const draggedRefRef = useRef<string | null>(null);
  draggedRefRef.current = draggedRef;
  const insertPointRef = useRef<InsertPoint | null>(null);
  insertPointRef.current = insertPoint;

  const dragRef = useRef<{
    ref: string; startX: number; startY: number; started: boolean;
  } | null>(null);
  // Snapshot of card rects at drag start. Used for cursor → slot
  // mapping for the duration of the drag, so FLIP animations don't
  // change what "nearest card" means under the cursor.
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

  // FLIP: capture screen positions after every render. If a card's
  // current rect differs from the previous one, animate the inverse
  // displacement back to zero so the user sees a smooth slide.
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cards = grid.querySelectorAll<HTMLElement>("[data-flip-key]");
    const seen = new Set<string>();
    cards.forEach((card) => {
      const key = card.dataset.flipKey!;
      seen.add(key);
      // Cancel anything in-flight first so getBoundingClientRect
      // returns the natural (untransformed) position, not the
      // current visual position.
      card.getAnimations().forEach((a) => a.cancel());
      const curr = card.getBoundingClientRect();
      const prev = prevRects.current.get(key);
      if (prev) {
        const dx = prev.left - curr.left;
        const dy = prev.top - curr.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
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
    for (const key of Array.from(prevRects.current.keys())) {
      if (!seen.has(key)) prevRects.current.delete(key);
    }
  });

  function commitReorder(fromRef: string, ip: InsertPoint) {
    const current = itemsRef.current;
    const fromIdx = current.findIndex((i) => i.ref === fromRef);
    if (fromIdx < 0) return;
    const arr = current.filter((i) => i.ref !== fromRef);
    const picked = current[fromIdx];
    if (ip.beforeRef === null) {
      onChange([...arr, picked]);
      return;
    }
    const at = arr.findIndex((i) => i.ref === ip.beforeRef);
    if (at < 0) return;
    arr.splice(at, 0, picked);
    // No-op detection: if the resulting array equals current, skip.
    if (arr.every((it, i) => it.ref === current[i].ref)) return;
    onChange(arr);
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

  function onPointerDown(e: React.PointerEvent, ref: string) {
    const t = e.target as HTMLElement;
    if (t.closest("input, button, .basecard-meta")) return;
    if (e.button !== 0) return;
    dragRef.current = {
      ref, startX: e.clientX, startY: e.clientY, started: false,
    };
  }

  useEffect(() => {
    function captureSnapshot() {
      const grid = gridRef.current;
      if (!grid) return;
      const m = new Map<string, DOMRect>();
      grid.querySelectorAll<HTMLElement>("[data-flip-key]").forEach((c) => {
        m.set(c.dataset.flipKey!, c.getBoundingClientRect());
      });
      snapshotRef.current = m;
    }

    function findInsertPoint(x: number, y: number): InsertPoint | null {
      const snap = snapshotRef.current;
      const draggedR = draggedRefRef.current;
      if (!snap || !draggedR) return null;
      // Nearest non-dragged card by squared distance to center.
      let bestRef: string | null = null;
      let bestRect: DOMRect | null = null;
      let bestDist = Infinity;
      snap.forEach((rect, ref) => {
        if (ref === draggedR) return;
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < bestDist) { bestDist = d; bestRef = ref; bestRect = rect; }
      });
      if (bestRef === null || !bestRect) return null;
      const r = bestRect as DOMRect;
      const midX = r.left + r.width / 2;
      if (x < midX) return { beforeRef: bestRef };
      // Insert AFTER bestRef → before the next item in items order
      // that isn't the dragged item.
      const list = itemsRef.current;
      const bi = list.findIndex((it) => it.ref === bestRef);
      if (bi < 0) return { beforeRef: null };
      for (let i = bi + 1; i < list.length; i++) {
        if (list[i].ref !== draggedR) return { beforeRef: list[i].ref };
      }
      return { beforeRef: null };
    }

    function samePoint(a: InsertPoint | null, b: InsertPoint | null): boolean {
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
      return <div className="basecard-grid"><div className="basecard-empty">No items match.</div></div>;
    }
    return (
      <div className="basecard-grid">
        <AddTile onCancel={() => setAdding(false)} onAdd={add} startOpen />
      </div>
    );
  }

  return (
    <div ref={gridRef} className="basecard-grid">
      {previewItems.map((item) => {
        const note = resolve(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const originalIdx = items.findIndex((i) => i.ref === item.ref);
        const tintCls = originalIdx % 2 === 0 ? "is-royal" : "is-coral";
        const dragging = item.ref === draggedRef;
        return (
          <BaseCard
            key={item.ref}
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            readOnly={!!readOnlyMembership}
            onPointerDown={onPointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onRefChange={(r) => updateRef(originalIdx, r)}
          />
        );
      })}
      {!readOnlyMembership && (
        <AddTile
          startOpen={adding}
          onAdd={(name) => { add(name); setAdding(false); }}
          onCancel={() => setAdding(false)}
          onOpen={() => setAdding(true)}
        />
      )}
    </div>
  );
}

interface BaseCardProps {
  item: ListItem;
  Icon: ReturnType<typeof folderIcon>;
  image?: string;
  tintCls: string;
  metaSuggestion: string;
  dragging: boolean;
  readOnly: boolean;
  onPointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
  onRefChange: (ref: string) => void;
}

function BaseCard({
  item, Icon, image, tintCls, metaSuggestion,
  dragging, readOnly,
  onPointerDown, onDelete, onMetaChange, onRefChange,
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
    if (editingTitle) {
      setTitleDraft(item.ref);
      requestAnimationFrame(() => {
        const el = titleInputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      });
    }
  }, [editingTitle, item.ref]);

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
      className={"basecard" + (dragging ? " is-dragging" : "")}
      data-flip-key={item.ref}
      onPointerDown={(e) => onPointerDown(e, item.ref)}
    >
      {/* basecard-frame holds all visuals so a "lift" scale during drag
          can live here, leaving the article free for FLIP's translate
          transform without the two fighting each other. */}
      <div className="basecard-frame">
        {image ? (
          <div className="basecard-cover" style={{ backgroundImage: `url(${image})` }} />
        ) : (
          <div className={`basecard-cover is-fallback ${tintCls}`}>
            <Icon size={44} strokeWidth={1.3} />
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
        <div className="basecard-body">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="basecard-title-input"
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
              className="basecard-title"
              onClick={() => { if (!readOnly) setEditingTitle(true); }}
              onPointerDown={(e) => e.stopPropagation()}
              title={readOnly ? item.ref : "Click to rename"}
            >
              {item.ref}
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
