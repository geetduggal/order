// Interactive card grid for `type: list` Notable Folders.
// Pointer-based reorder (HTML5 drag-drop is intercepted by Tauri's
// native drag layer and never fires drop), hover-× to delete,
// inline editable meta, "+ New" tile at the end. All edits flow up
// through onChange so the Card owner can debounce a save.

import { useEffect, useRef, useState } from "react";
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

export function ListCards({ items, vaultNotes, onChange }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // Window-level pointer tracking. Refs hold the live state so the
  // listeners (registered once) always see the current drag.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const dragRef = useRef<{
    index: number; startX: number; startY: number; started: boolean;
  } | null>(null);
  const dropAtRef = useRef<number | null>(null);
  dropAtRef.current = dropAt;

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = itemsRef.current.slice();
    const [picked] = next.splice(from, 1);
    const insertAt = from < to ? to - 1 : to;
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

  function onPointerDown(e: React.PointerEvent, index: number) {
    // Don't start a drag if the user is clicking an editable / actionable
    // element inside the card (delete button, meta input/button, etc.).
    const t = e.target as HTMLElement;
    if (t.closest("input, button, .basecard-meta")) return;
    if (e.button !== 0) return;
    dragRef.current = {
      index, startX: e.clientX, startY: e.clientY, started: false,
    };
  }

  useEffect(() => {
    function findCardIndex(x: number, y: number): number | null {
      // elementFromPoint returns the topmost element at the viewport
      // coords; walk up to find a basecard with our index dataset.
      const el = document.elementFromPoint(x, y);
      const card = (el as HTMLElement | null)?.closest("[data-list-card-index]");
      if (!card) return null;
      const raw = (card as HTMLElement).dataset.listCardIndex;
      const idx = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(idx) ? idx : null;
    }

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (!d.started) {
        const moved = Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY);
        if (moved < DRAG_THRESHOLD_PX) return;
        d.started = true;
        setDragFrom(d.index);
      }
      const idx = findCardIndex(e.clientX, e.clientY);
      setDropAt(idx);
    }

    function onUp() {
      const d = dragRef.current;
      dragRef.current = null;
      if (d?.started) {
        const to = dropAtRef.current;
        if (to !== null && to !== d.index) move(d.index, to);
      }
      setDragFrom(null);
      setDropAt(null);
    }

    function onCancel() {
      dragRef.current = null;
      setDragFrom(null);
      setDropAt(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // onChange identity may change per render but move closes over
    // refs, so the listeners can stay attached for the component's
    // lifetime.
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
      {items.map((item, i) => {
        const note = resolve(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const tintCls = i % 2 === 0 ? "is-royal" : "is-coral";
        const dropTarget = dropAt === i && dragFrom !== null && dragFrom !== i;
        const dragging = dragFrom === i;
        return (
          <BaseCard
            key={`${item.ref}-${i}`}
            index={i}
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            dropTarget={dropTarget}
            onPointerDown={onPointerDown}
            onDelete={() => remove(i)}
            onMetaChange={(m) => updateMeta(i, m)}
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
  dropTarget: boolean;
  onPointerDown: (e: React.PointerEvent, index: number) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
}

function BaseCard({
  index, item, Icon, image, tintCls, metaSuggestion,
  dragging, dropTarget,
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
      className={
        "basecard"
        + (dragging ? " is-dragging" : "")
        + (dropTarget ? " is-drop-target" : "")
      }
      data-list-card-index={index}
      onPointerDown={(e) => onPointerDown(e, index)}
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
