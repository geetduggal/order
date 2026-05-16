// Right sidebar — View pill at top, then the 3-level hierarchy from
// the design doc / mockups (Areas → Categories → Notable Folders).
// Areas + Categories render as 10-box grids (Johnny Decimal); Notable
// Folders are derived from any markdown file whose YAML frontmatter
// has a `category:` value (none yet in the seed set — placeholder
// copy when empty).

import { useState } from "react";
import { useTaxonomy } from "../hooks/useTaxonomy";

export type View = "stream" | "week" | "month" | "year";

const VIEWS: { id: View; label: string }[] = [
  { id: "stream", label: "Stream" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

const MAX_SLOTS = 10;

interface Props {
  view: View;
  onSelectView: (v: View) => void;
}

export function Sidebar({ view, onSelectView }: Props) {
  const t = useTaxonomy();
  const [draft, setDraft] = useState<{ kind: "area" | "category"; areaId: string | null } | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [activeAreaId, setActiveAreaId] = useState<string | null>(null);

  function startAreaDraft() {
    setDraft({ kind: "area", areaId: null });
    setDraftValue("");
  }
  function startCategoryDraft() {
    setDraft({ kind: "category", areaId: activeAreaId });
    setDraftValue("");
  }
  function commitDraft() {
    if (!draft) return;
    if (draft.kind === "area") t.addArea(draftValue);
    else t.addCategory(draftValue, draft.areaId);
    setDraft(null);
    setDraftValue("");
  }
  function cancelDraft() {
    setDraft(null);
    setDraftValue("");
  }

  const categoriesForView = activeAreaId
    ? t.categories.filter((c) => c.areaId === activeAreaId)
    : t.categories;

  return (
    <aside className="pane-right">
      <section className="sb-section">
        <h2 className="sb-title">View</h2>
        <div className="view-switch">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={view === v.id ? "on" : ""}
              onClick={() => onSelectView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </section>

      <SectionHeader
        label="Areas"
        count={t.areas.length}
        max={MAX_SLOTS}
        onAdd={startAreaDraft}
      />
      <BoxGrid
        items={t.areas.map((a) => ({
          id: a.id,
          label: a.name,
          coral: false,
          checked: activeAreaId === a.id,
          onToggle: () => setActiveAreaId(activeAreaId === a.id ? null : a.id),
          onRemove: () => {
            if (activeAreaId === a.id) setActiveAreaId(null);
            t.removeArea(a.id);
          },
        }))}
        draft={draft?.kind === "area" ? { value: draftValue, onChange: setDraftValue, onCommit: commitDraft, onCancel: cancelDraft } : null}
        emptySlots={Math.max(0, MAX_SLOTS - t.areas.length - (draft?.kind === "area" ? 1 : 0))}
        onEmptyClick={startAreaDraft}
      />

      <SectionHeader
        label={activeAreaId ? `Categories · ${t.areas.find((a) => a.id === activeAreaId)?.name ?? ""}` : "Categories"}
        count={categoriesForView.length}
        max={MAX_SLOTS}
        onAdd={startCategoryDraft}
      />
      <BoxGrid
        items={categoriesForView.map((c, i) => ({
          id: c.id,
          label: c.name,
          coral: i % 2 === 1,
          checked: false,
          onToggle: () => { /* category filter wiring is next pass */ },
          onRemove: () => t.removeCategory(c.id),
        }))}
        draft={draft?.kind === "category" ? { value: draftValue, onChange: setDraftValue, onCommit: commitDraft, onCancel: cancelDraft } : null}
        emptySlots={Math.max(0, MAX_SLOTS - categoriesForView.length - (draft?.kind === "category" ? 1 : 0))}
        onEmptyClick={startCategoryDraft}
      />

      <section className="sb-section">
        <h2 className="sb-title">Notable Folders</h2>
        <p className="sb-empty">
          Add <code>category: [[Name]]</code> to a note's YAML to mark it the Main Document of a folder.
        </p>
      </section>
    </aside>
  );
}

function SectionHeader({ label, count, max, onAdd }: { label: string; count: number; max?: number; onAdd: () => void }) {
  return (
    <div className="sb-title-row">
      <h2 className="sb-title">{label}</h2>
      <span className="sb-title-right">
        <span className="sb-count">{count}{max != null ? ` / ${max}` : ""}</span>
        <button type="button" className="sb-add" onClick={onAdd} title="Add">+</button>
      </span>
    </div>
  );
}

interface BoxItem {
  id: string;
  label: string;
  coral: boolean;
  checked: boolean;
  onToggle: () => void;
  onRemove: () => void;
}
interface DraftState {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

function BoxGrid({ items, draft, emptySlots, onEmptyClick }: {
  items: BoxItem[];
  draft: DraftState | null;
  emptySlots: number;
  onEmptyClick: () => void;
}) {
  return (
    <div className="box-grid">
      {items.map((it, i) => (
        <BoxTile key={it.id} item={it} coralOverride={it.coral || i % 2 === 1} />
      ))}
      {draft && (
        <div className="box draft">
          <input
            autoFocus
            className="box-draft-input"
            value={draft.value}
            onChange={(e) => draft.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); draft.onCommit(); }
              if (e.key === "Escape") { e.preventDefault(); draft.onCancel(); }
            }}
            onBlur={() => { if (!draft.value.trim()) draft.onCancel(); else draft.onCommit(); }}
            placeholder="Name…"
          />
        </div>
      )}
      {Array.from({ length: emptySlots }).map((_, i) => (
        <button
          type="button"
          key={`empty-${i}`}
          className="box empty"
          onClick={onEmptyClick}
          aria-label="Add"
        >
          +
        </button>
      ))}
    </div>
  );
}

function BoxTile({ item, coralOverride }: { item: BoxItem; coralOverride: boolean }) {
  return (
    <div
      className={"box no-image" + (coralOverride ? " coral" : "") + (item.checked ? " checked" : "")}
      onClick={item.onToggle}
      title="Click to filter"
    >
      <div className="box-check">{item.checked ? "✓" : ""}</div>
      <button
        type="button"
        className="box-remove"
        onClick={(e) => { e.stopPropagation(); item.onRemove(); }}
        title="Delete"
        aria-label="Delete"
      >
        ×
      </button>
      <div className="box-label">{item.label}</div>
    </div>
  );
}
