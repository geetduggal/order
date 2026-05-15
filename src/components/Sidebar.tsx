// Right sidebar: Areas → Categories → Notable Folders, each a togglable
// filter chip. `+ Add` next to each section header creates a new entry.
// Log/Public pins sit above the hierarchy. Toggling any chip updates the
// derived "on the page" folder set used by the Stream.

import { useState } from "react";
import type { Note } from "../lib/types";
import { categoryOf, folderOf, isMainDocument, isPublic } from "../lib/types";
import type { Area, Category } from "../hooks/useTaxonomy";
import type { FilterSelection } from "../hooks/useFilters";

type Props = {
  notes: Note[];
  areas: Area[];
  categories: Category[];
  selection: FilterSelection;
  onToggleFolder: (name: string) => void;
  onToggleCategory: (name: string) => void;
  onToggleArea: (name: string) => void;
  onAddArea: (name: string) => void;
  onAddCategory: (name: string, areaId: string | null) => void;
  onRemoveArea: (id: string) => void;
  onRemoveCategory: (id: string) => void;
  onPickFolder: (note: Note) => void;
};

interface PendingAdd {
  kind: "area" | "category";
  parentAreaId?: string | null;
}

export function Sidebar({
  notes,
  areas,
  categories,
  selection,
  onToggleFolder,
  onToggleCategory,
  onToggleArea,
  onAddArea,
  onAddCategory,
  onRemoveArea,
  onRemoveCategory,
  onPickFolder,
}: Props) {
  const folders = listFolders(notes);
  const logCount = notes.filter(n => folderOf(n) === "Log" && !isMainDocument(n)).length;
  const publicCount = notes.filter(isPublic).length;
  const [pending, setPending] = useState<PendingAdd | null>(null);
  const [draft, setDraft] = useState("");

  function commitDraft() {
    if (!pending) return;
    if (pending.kind === "area") onAddArea(draft);
    else onAddCategory(draft, pending.parentAreaId ?? null);
    setPending(null);
    setDraft("");
  }

  function cancelDraft() {
    setPending(null);
    setDraft("");
  }

  return (
    <aside className="sidebar">
      <div className="pin-row">
        <button
          className={"pin log" + (selection.folders.has("Log") ? " on" : "")}
          onClick={() => onToggleFolder("Log")}
        >
          <span className="glyph">L</span>
          <span className="name">Log</span>
          <span className="count">{logCount}</span>
        </button>
        <button className="pin public">
          <span className="glyph">●</span>
          <span className="name">Public</span>
          <span className="count">{publicCount}</span>
        </button>
      </div>

      <SectionHeader
        label="Areas"
        count={areas.length}
        onAdd={() => { setPending({ kind: "area" }); setDraft(""); }}
      />
      {pending?.kind === "area" && (
        <DraftRow
          value={draft}
          onChange={setDraft}
          placeholder="Area name"
          onCommit={commitDraft}
          onCancel={cancelDraft}
        />
      )}
      <div className="chip-list">
        {areas.length === 0 && pending?.kind !== "area" && (
          <p className="sb-empty">Group your work into life domains.</p>
        )}
        {areas.map(a => (
          <Chip
            key={a.id}
            label={a.name}
            on={selection.areas.has(a.name)}
            onToggle={() => onToggleArea(a.name)}
            onRemove={() => onRemoveArea(a.id)}
          />
        ))}
      </div>

      <SectionHeader
        label="Categories"
        count={categories.length}
        onAdd={() => {
          const onlyAreaId = areas.length === 1 ? areas[0].id : null;
          setPending({ kind: "category", parentAreaId: onlyAreaId });
          setDraft("");
        }}
      />
      {pending?.kind === "category" && (
        <DraftRow
          value={draft}
          onChange={setDraft}
          placeholder="Category name"
          onCommit={commitDraft}
          onCancel={cancelDraft}
          extra={
            areas.length > 1 ? (
              <select
                className="draft-parent"
                value={pending.parentAreaId ?? ""}
                onChange={(e) => setPending({ ...pending, parentAreaId: e.target.value || null })}
              >
                <option value="">— no Area —</option>
                {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : null
          }
        />
      )}
      <div className="chip-list">
        {categories.length === 0 && pending?.kind !== "category" && (
          <p className="sb-empty">Specific groupings within an Area.</p>
        )}
        {categories.map(c => {
          const area = c.areaId ? areas.find(a => a.id === c.areaId) ?? null : null;
          return (
            <Chip
              key={c.id}
              label={c.name}
              meta={area?.name ?? undefined}
              on={selection.categories.has(c.name)}
              onToggle={() => onToggleCategory(c.name)}
              onRemove={() => onRemoveCategory(c.id)}
            />
          );
        })}
      </div>

      <div className="sb-title"><span>Notable Folders</span><span className="count">{folders.length}</span></div>
      <div className="folder-list">
        {folders.length === 0 && (
          <p className="sb-empty">A folder's Main Document gets a Main Document section in the Stream. Add a `category:` field to any note's YAML to mark it.</p>
        )}
        {folders.map(({ note, category }) => {
          const on = selection.folders.has(note.title);
          return (
            <button
              key={note.path}
              className={"folder-card" + (on ? " on" : "")}
              onClick={() => onToggleFolder(note.title)}
              onDoubleClick={() => onPickFolder(note)}
            >
              <div className="fc-thumb"><span>{(note.title[0] || "·").toUpperCase()}</span></div>
              <div className="fc-body">
                <div className="fc-name">{note.title}</div>
                <div className="fc-desc">{category || "(uncategorized)"}</div>
              </div>
              <div className="fc-check">{on ? "✓" : ""}</div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function SectionHeader({ label, count, onAdd }: { label: string; count: number; onAdd: () => void }) {
  return (
    <div className="sb-title">
      <span>{label}</span>
      <span className="sb-title-right">
        <span className="count">{count}</span>
        <button className="sb-add" onClick={onAdd} title={`Add ${label.slice(0, -1)}`}>+</button>
      </span>
    </div>
  );
}

function DraftRow({
  value,
  onChange,
  placeholder,
  onCommit,
  onCancel,
  extra,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onCommit: () => void;
  onCancel: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="draft-row">
      <input
        autoFocus
        className="draft-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        placeholder={placeholder}
      />
      {extra}
      <button className="draft-action" onClick={onCommit}>add</button>
      <button className="draft-action ghost" onClick={onCancel}>esc</button>
    </div>
  );
}

function Chip({
  label,
  meta,
  on,
  onToggle,
  onRemove,
}: {
  label: string;
  meta?: string;
  on: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div className={"chip" + (on ? " on" : "")}>
      <button className="chip-toggle" onClick={onToggle}>
        <span className="chip-check">{on ? "●" : "○"}</span>
        <span className="chip-label">{label}</span>
        {meta && <span className="chip-meta">{meta}</span>}
      </button>
      <button
        className="chip-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Delete"
      >
        ×
      </button>
    </div>
  );
}

function listFolders(notes: Note[]): { note: Note; category: string | null }[] {
  return notes
    .filter(isMainDocument)
    .map(note => ({ note, category: categoryOf(note) }))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.note.title.localeCompare(b.note.title));
}
