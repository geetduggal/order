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
import { Plus, X as XIcon } from "lucide-react";
import { folderIcon, isNotableFolder } from "../lib/folders";
import { displayTitleFor, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { resolveNoteRef } from "../lib/wikilink";
import { useTileDrag } from "../lib/use-tile-drag";
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
}

function pickMeta(item: ListItem, note?: ListNoteRef): string {
  if (item.meta) return item.meta;
  if (!note) return "";
  const fm = note.frontmatter;
  if (typeof fm.author === "string") return fm.author;
  if (typeof fm.description === "string") return fm.description;
  return "";
}

export function ListCards({ items, vaultNotes, onChange, readOnly, readOnlyMembership, onNavigate, onAddFilter }: Props) {
  const [adding, setAdding] = useState(false);
  const hideControls = !!readOnly || !!readOnlyMembership;

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

  if (items.length === 0 && !adding) {
    if (hideControls) {
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
      {items.map((item, originalIdx) => {
        const note = resolveNoteRef(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const tintCls = originalIdx % 2 === 0 ? "is-royal" : "is-coral";
        const dragging = item.ref === draggingRef;
        return (
          <BaseCard
            key={item.ref}
            item={item}
            Icon={Icon}
            image={image}
            tintCls={tintCls}
            displayTitle={displayTitleFor(item, note)}
            metaSuggestion={pickMeta(item, note)}
            dragging={dragging}
            draggable={!readOnly}
            readOnly={hideControls}
            onNavigate={(() => {
              if (!note) return undefined;
              const isNF = isNotableFolder(note.frontmatter);
              if (isNF && onAddFilter) return () => onAddFilter(item.ref);
              if (onNavigate) return () => onNavigate(item.ref);
              return undefined;
            })()}
            onTilePointerDown={onTilePointerDown}
            onDelete={() => remove(originalIdx)}
            onMetaChange={(m) => updateMeta(originalIdx, m)}
            onRefChange={(r) => updateRef(originalIdx, r)}
          />
        );
      })}
      {!hideControls && (
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
  /** Visible label — prefers linked note's frontmatter `title:` over
   *  the bullet's wikilink ref so filenames-on-disk can be pretty
   *  while the displayed title keeps original punctuation. */
  displayTitle: string;
  metaSuggestion: string;
  dragging: boolean;
  draggable: boolean;
  readOnly: boolean;
  onNavigate?: () => void;
  onTilePointerDown: (e: React.PointerEvent, ref: string) => void;
  onDelete: () => void;
  onMetaChange: (meta: string) => void;
  onRefChange: (ref: string) => void;
}

function BaseCard({
  item, Icon, image, tintCls, displayTitle, metaSuggestion,
  dragging, draggable, readOnly, onNavigate,
  onTilePointerDown, onDelete, onMetaChange, onRefChange,
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
      className={"basecard" + (dragging ? " is-dragging" : "") + (draggable ? " draggable" : "")}
      data-tile-ref={item.ref}
      onPointerDown={draggable ? (e) => onTilePointerDown(e, item.ref) : undefined}
    >
      {/* basecard-frame holds all visuals so a "lift" scale during drag
          can live here. */}
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
