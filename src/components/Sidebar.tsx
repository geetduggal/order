// Right sidebar: Johnny Decimal drill-down. Areas → Categories → Notable
// Folders. Each level is a 10-slot box grid (2 columns) with empty `+`
// slots visible until the user fills them. Click a filled box to toggle
// it as a filter; double-click to drill in. The folder leaf is rendered
// as a 1D vertical card list (per the design doc), not a box grid.

import { useMemo, useState } from "react";
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

type Drill =
  | { view: "areas" }
  | { view: "categories"; areaId: string }
  | { view: "folders"; categoryName: string };

const MAX_SLOTS = 10;

export function Sidebar(props: Props) {
  const [drill, setDrill] = useState<Drill>({ view: "areas" });
  const [draft, setDraft] = useState<string | null>(null);

  const logCount = props.notes.filter(n => folderOf(n) === "Log" && !isMainDocument(n)).length;
  const publicCount = props.notes.filter(isPublic).length;

  // If a drilled-into entity disappears (deleted), reset to areas view.
  const activeArea = drill.view === "categories" ? props.areas.find(a => a.id === drill.areaId) ?? null : null;
  const activeCategory = drill.view === "folders" ? props.categories.find(c => c.name === drill.categoryName) ?? null : null;
  if (drill.view === "categories" && !activeArea) {
    queueMicrotask(() => setDrill({ view: "areas" }));
  }
  if (drill.view === "folders" && !activeCategory) {
    queueMicrotask(() => setDrill({ view: "areas" }));
  }

  function commitDraft(): void {
    if (!draft) return;
    const name = draft.trim();
    if (!name) { setDraft(null); return; }
    if (drill.view === "areas") props.onAddArea(name);
    else if (drill.view === "categories") props.onAddCategory(name, drill.areaId);
    setDraft(null);
  }

  return (
    <aside className="sidebar">
      <div className="pin-row">
        <button
          className={"pin log" + (props.selection.folders.has("Log") ? " on" : "")}
          onClick={() => props.onToggleFolder("Log")}
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

      {drill.view !== "areas" && (
        <button
          className="sb-back"
          onClick={() => {
            if (drill.view === "folders" && activeCategory?.areaId) {
              setDrill({ view: "categories", areaId: activeCategory.areaId });
            } else {
              setDrill({ view: "areas" });
            }
          }}
        >
          ← {drill.view === "categories" ? "Areas" : (activeArea?.name ?? "Areas")}
        </button>
      )}

      {drill.view === "areas" && (
        <AreasView
          areas={props.areas}
          selection={props.selection}
          draft={draft}
          setDraft={setDraft}
          onCommitDraft={commitDraft}
          onToggle={props.onToggleArea}
          onDrill={(areaId) => setDrill({ view: "categories", areaId })}
          onRemove={props.onRemoveArea}
        />
      )}

      {drill.view === "categories" && activeArea && (
        <CategoriesView
          area={activeArea}
          categories={props.categories.filter(c => c.areaId === activeArea.id)}
          selection={props.selection}
          draft={draft}
          setDraft={setDraft}
          onCommitDraft={commitDraft}
          onToggle={props.onToggleCategory}
          onDrill={(categoryName) => setDrill({ view: "folders", categoryName })}
          onRemove={props.onRemoveCategory}
        />
      )}

      {drill.view === "folders" && activeCategory && (
        <FoldersView
          category={activeCategory}
          notes={props.notes}
          selection={props.selection}
          onToggle={props.onToggleFolder}
          onPick={props.onPickFolder}
        />
      )}
    </aside>
  );
}

// ----- Areas / Categories views (shared 10-box grid) -----

interface BoxViewProps {
  selection: FilterSelection;
  draft: string | null;
  setDraft: (v: string | null) => void;
  onCommitDraft: () => void;
}

function AreasView(props: BoxViewProps & {
  areas: Area[];
  onToggle: (name: string) => void;
  onDrill: (areaId: string) => void;
  onRemove: (id: string) => void;
}) {
  const empties = Math.max(0, MAX_SLOTS - props.areas.length - (props.draft !== null ? 1 : 0));
  return (
    <section className="sb-section">
      <div className="sb-title">
        <span>Areas</span>
        <span className="count">{props.areas.length} / {MAX_SLOTS}</span>
      </div>
      <div className="box-grid">
        {props.areas.map((a, i) => (
          <BoxTile
            key={a.id}
            label={a.name}
            coral={i % 2 === 1}
            checked={props.selection.areas.has(a.name)}
            onToggle={() => props.onToggle(a.name)}
            onDrill={() => props.onDrill(a.id)}
            onRemove={() => props.onRemove(a.id)}
          />
        ))}
        {props.draft !== null && (
          <DraftBox value={props.draft} onChange={props.setDraft} onCommit={props.onCommitDraft} onCancel={() => props.setDraft(null)} />
        )}
        {Array.from({ length: empties }).map((_, i) => (
          <EmptyBox key={`empty-${i}`} disabled={props.draft !== null} onClick={() => props.setDraft("")} />
        ))}
      </div>
    </section>
  );
}

function CategoriesView(props: BoxViewProps & {
  area: Area;
  categories: Category[];
  onToggle: (name: string) => void;
  onDrill: (categoryName: string) => void;
  onRemove: (id: string) => void;
}) {
  const empties = Math.max(0, MAX_SLOTS - props.categories.length - (props.draft !== null ? 1 : 0));
  return (
    <section className="sb-section">
      <div className="sb-title">
        <span>{props.area.name}</span>
        <span className="count">{props.categories.length} / {MAX_SLOTS}</span>
      </div>
      <div className="box-grid">
        {props.categories.map((c, i) => (
          <BoxTile
            key={c.id}
            label={c.name}
            coral={i % 2 === 1}
            checked={props.selection.categories.has(c.name)}
            onToggle={() => props.onToggle(c.name)}
            onDrill={() => props.onDrill(c.name)}
            onRemove={() => props.onRemove(c.id)}
          />
        ))}
        {props.draft !== null && (
          <DraftBox value={props.draft} onChange={props.setDraft} onCommit={props.onCommitDraft} onCancel={() => props.setDraft(null)} />
        )}
        {Array.from({ length: empties }).map((_, i) => (
          <EmptyBox key={`empty-${i}`} disabled={props.draft !== null} onClick={() => props.setDraft("")} />
        ))}
      </div>
    </section>
  );
}

function FoldersView(props: {
  category: Category;
  notes: Note[];
  selection: FilterSelection;
  onToggle: (name: string) => void;
  onPick: (note: Note) => void;
}) {
  const folders = useMemo(() => (
    props.notes
      .filter(isMainDocument)
      .filter(n => categoryOf(n) === props.category.name)
      .sort((a, b) => a.title.localeCompare(b.title))
  ), [props.notes, props.category.name]);

  return (
    <section className="sb-section">
      <div className="sb-title">
        <span>{props.category.name}</span>
        <span className="count">{folders.length}</span>
      </div>
      <div className="folder-list">
        {folders.length === 0 && (
          <p className="sb-empty">
            No Notable Folders in <em>{props.category.name}</em> yet. Add <code>category: [[{props.category.name}]]</code> to a note's YAML to mark it the Main Document of a folder.
          </p>
        )}
        {folders.map(note => {
          const on = props.selection.folders.has(note.title);
          return (
            <button
              key={note.path}
              className={"folder-card" + (on ? " on" : "")}
              onClick={() => props.onToggle(note.title)}
              onDoubleClick={() => props.onPick(note)}
            >
              <div className="fc-thumb"><span>{(note.title[0] || "·").toUpperCase()}</span></div>
              <div className="fc-body">
                <div className="fc-name">{note.title}</div>
                <div className="fc-desc">{props.category.name}</div>
              </div>
              <div className="fc-check">{on ? "✓" : ""}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ----- Box atoms -----

function BoxTile({ label, coral, checked, onToggle, onDrill, onRemove }: {
  label: string;
  coral: boolean;
  checked: boolean;
  onToggle: () => void;
  onDrill: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={"box no-image" + (coral ? " coral" : "") + (checked ? " checked" : "")}
      title={`Click to filter · double-click to drill in`}
      onClick={onToggle}
      onDoubleClick={(e) => { e.stopPropagation(); onDrill(); }}
    >
      <div className="box-check">{checked ? "✓" : ""}</div>
      <button
        className="box-remove"
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
        title="Delete"
      >
        ×
      </button>
      <div className="box-label">{label}</div>
    </div>
  );
}

function EmptyBox({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <div className={"box empty" + (disabled ? " disabled" : "")} onClick={disabled ? undefined : onClick}>
      +
    </div>
  );
}

function DraftBox({ value, onChange, onCommit, onCancel }: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="box no-image draft">
      <input
        autoFocus
        className="box-draft-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => { if (!value.trim()) onCancel(); else onCommit(); }}
        placeholder="Name…"
      />
    </div>
  );
}
