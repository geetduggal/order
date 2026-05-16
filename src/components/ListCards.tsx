// Interactive card grid for `type: list` Notable Folders.
// Drag-and-drop reorder between cards, hover-× to delete, inline
// editable meta, "+ New" tile at the end. All edits flow up through
// onChange so the Card owner can debounce a save.

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

export function ListCards({ items, vaultNotes, onChange }: Props) {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = items.slice();
    const [picked] = next.splice(from, 1);
    // Inserting after splice shifts the target index by 1 when
    // moving forward; account for it so "drop on card N" lands the
    // card at visual slot N.
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

  if (items.length === 0 && !adding) {
    return (
      <div className="basecard-grid">
        <AddTile onCancel={() => setAdding(false)} onAdd={add} startOpen />
      </div>
    );
  }

  return (
    <div className="basecard-grid" onDragLeave={() => setDropAt(null)}>
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
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            dropTarget={dropTarget}
            onDragStart={() => setDragFrom(i)}
            onDragEnd={() => { setDragFrom(null); setDropAt(null); }}
            onDragOver={() => setDropAt(i)}
            onDrop={() => {
              if (dragFrom !== null) move(dragFrom, i);
              setDragFrom(null);
              setDropAt(null);
            }}
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
  item: ListItem;
  Icon: ReturnType<typeof folderIcon>;
  image?: string;
  tintCls: string;
  metaSuggestion: string;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
}

function BaseCard({
  item, Icon, image, tintCls, metaSuggestion,
  dragging, dropTarget,
  onDragStart, onDragEnd, onDragOver, onDrop,
  onDelete, onMetaChange,
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
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        // Firefox refuses to start a drag without setData.
        e.dataTransfer.setData("text/plain", item.ref);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => { e.preventDefault(); onDragOver(); }}
      onDrop={(e) => { e.preventDefault(); onDrop(); }}
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
            onDragStart={(e) => e.preventDefault()}
          />
        ) : (
          <button
            type="button"
            className={"basecard-meta" + (metaSuggestion ? "" : " is-empty")}
            onClick={() => setEditingMeta(true)}
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
