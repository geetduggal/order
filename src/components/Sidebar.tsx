// Right sidebar — View pill at top, Notable Folder drill-down below.
//
// Per mockup: only one of three views is visible at a time:
//   1. Areas grid  →  2. Categories grid (for that Area)
//                   →  3. Notable Folders list (for that Category)
//
// Back chevron pops back up the chain. Search bar at top adds folders
// to the filter directly (works at any level).
//
// Areas and Categories are derived from the Notable Folders themselves:
// a Notable Folder's `area` and `category` YAML fields drive what
// appears in the grids. No separate storage — the YAML is the source
// of truth.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Check, ChevronLeft, Search, X } from "lucide-react";
import { folderColor, folderIcon } from "../lib/folders";
import type { Frontmatter } from "../lib/frontmatter";

export type View = "stream" | "week" | "month" | "year";

const VIEWS: { id: View; label: string }[] = [
  { id: "stream", label: "Stream" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

const MAX_SLOTS = 10;
const NO_AREA = "(unassigned)";
const NO_CATEGORY = "(uncategorized)";

export interface NotableFolder {
  name: string;
  area: string;
  category: string;
  frontmatter: Frontmatter;
  path: string;
}

type DrillState =
  | { kind: "areas" }
  | { kind: "categories"; areaName: string }
  | { kind: "folders"; areaName: string; categoryName: string };

interface Props {
  view: View;
  onSelectView: (v: View) => void;
  folders: NotableFolder[];
  selected: Set<string>;
  onToggle: (folderName: string) => void;
  onClear: () => void;
  /** Create a new Notable Folder Main Document under the drilled
   *  (area, category). The sidebar surfaces this as a "+ New folder"
   *  row at the bottom of the folders drill view. */
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void>;
  /** Stored Areas and Categories the user has explicitly added (vs
   *  derived from a Notable Folder's YAML). Used to decide whether
   *  the × remove button shows on a tile. */
  storedAreas: string[];
  storedCategories: { area: string; name: string }[];
  onAddArea: (name: string) => void;
  onRemoveArea: (name: string) => void;
  onAddCategory: (name: string, area: string) => void;
  onRemoveCategory: (name: string, area: string) => void;
  /** Monotonically increasing counter: each change focuses + selects
   *  the search input. Lets Cmd+O drop focus into the sidebar without
   *  the parent needing a ref into our internals. */
  focusSearchSignal?: number;
}

interface Taxonomy {
  areaNames: string[];
  categoriesByArea: Map<string, string[]>;
  foldersByCategory: Map<string, NotableFolder[]>;
  isAreaStored: (name: string) => boolean;
  isCategoryStored: (area: string, name: string) => boolean;
}

function eqi(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

function buildTaxonomy(
  folders: NotableFolder[],
  storedAreas: string[],
  storedCategories: { area: string; name: string }[],
): Taxonomy {
  const areaSet = new Set<string>([...storedAreas]);
  for (const f of folders) if (f.area) areaSet.add(f.area);

  const categoriesByArea = new Map<string, Set<string>>();
  for (const c of storedCategories) {
    const set = categoriesByArea.get(c.area) ?? new Set();
    set.add(c.name);
    categoriesByArea.set(c.area, set);
  }
  for (const f of folders) {
    if (!f.area || !f.category) continue;
    const set = categoriesByArea.get(f.area) ?? new Set();
    set.add(f.category);
    categoriesByArea.set(f.area, set);
  }

  const foldersByCategory = new Map<string, NotableFolder[]>();
  for (const f of folders) {
    const a = f.area || NO_AREA;
    const c = f.category || NO_CATEGORY;
    const key = `${a}::${c}`;
    const list = foldersByCategory.get(key) ?? [];
    list.push(f);
    foldersByCategory.set(key, list);
  }

  return {
    areaNames: [...areaSet].sort(),
    categoriesByArea: new Map(
      [...categoriesByArea].map(([a, set]) => [a, [...set].sort()]),
    ),
    foldersByCategory: new Map(
      [...foldersByCategory].map(([k, list]) => [
        k,
        list.sort((x, y) => x.name.localeCompare(y.name)),
      ]),
    ),
    isAreaStored: (name) => storedAreas.some((a) => eqi(a, name)),
    isCategoryStored: (area, name) =>
      storedCategories.some((c) => eqi(c.area, area) && eqi(c.name, name)),
  };
}

export function Sidebar({
  view,
  onSelectView,
  folders,
  selected,
  onToggle,
  onClear,
  onCreateFolder,
  storedAreas,
  storedCategories,
  onAddArea,
  onRemoveArea,
  onAddCategory,
  onRemoveCategory,
  focusSearchSignal,
}: Props) {
  const [drill, setDrill] = useState<DrillState>({ kind: "areas" });
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusSearchSignal === undefined) return;
    const el = searchInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [focusSearchSignal]);

  const taxonomy = useMemo(
    () => buildTaxonomy(folders, storedAreas, storedCategories),
    [folders, storedAreas, storedCategories],
  );

  // Sanity: if a drilled-into entity disappears (rare), pop back.
  if (drill.kind === "categories" && !taxonomy.areaNames.includes(drill.areaName)) {
    queueMicrotask(() => setDrill({ kind: "areas" }));
  }
  if (drill.kind === "folders") {
    const cats = taxonomy.categoriesByArea.get(drill.areaName) ?? [];
    if (!cats.includes(drill.categoryName)) {
      queueMicrotask(() => setDrill({ kind: "categories", areaName: drill.areaName }));
    }
  }

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return folders.filter((f) => {
      const t = f.frontmatter.title;
      const haystack = (f.name + " " + (typeof t === "string" ? t : "")).toLowerCase();
      return haystack.includes(q);
    }).slice(0, 8);
  }, [folders, query]);

  return (
    <aside className="pane-right">
      <section className="sb-section">
        <h2 className="sb-title">View</h2>
        <div className="view-switch">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={view === v.id ? "active" : ""}
              onClick={() => onSelectView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </section>

      <section className="sb-section sb-filters">
        <div className="sb-search">
          <Search size={12} strokeWidth={2} className="sb-search-icon" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search folders…"
            className="sb-search-input"
          />
          {selected.size > 0 && (
            <button
              type="button"
              className="sb-clear-inline"
              onClick={onClear}
              title="Clear filters"
              aria-label="Clear filters"
            >
              <X size={11} strokeWidth={2} />
            </button>
          )}
        </div>

        {query && searchMatches.length === 0 && (
          <p className="sb-empty-small">No folders match.</p>
        )}
        {query && searchMatches.length > 0 && (
          <ul className="sb-folder-list sb-search-results">
            {searchMatches.map((f) => (
              <FolderRow
                key={f.path}
                folder={f}
                checked={selected.has(f.name)}
                onToggle={() => { onToggle(f.name); setQuery(""); }}
              />
            ))}
          </ul>
        )}

        {!query && (
          <DrillView
            drill={drill}
            setDrill={setDrill}
            taxonomy={taxonomy}
            selected={selected}
            onToggle={onToggle}
            onCreateFolder={onCreateFolder}
            onAddArea={onAddArea}
            onRemoveArea={onRemoveArea}
            onAddCategory={onAddCategory}
            onRemoveCategory={onRemoveCategory}
          />
        )}
      </section>
    </aside>
  );
}

function DrillView({
  drill, setDrill, taxonomy, selected, onToggle, onCreateFolder,
  onAddArea, onRemoveArea, onAddCategory, onRemoveCategory,
}: {
  drill: DrillState;
  setDrill: (s: DrillState) => void;
  taxonomy: Taxonomy;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void>;
  onAddArea: (name: string) => void;
  onRemoveArea: (name: string) => void;
  onAddCategory: (name: string, area: string) => void;
  onRemoveCategory: (name: string, area: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftActive = draft !== null;

  function startDraft() { setDraft(""); }
  function cancelDraft() { setDraft(null); }
  function commitDraft(area: string | null) {
    const trimmed = (draft ?? "").trim();
    if (trimmed) {
      if (area === null) onAddArea(trimmed);
      else onAddCategory(trimmed, area);
    }
    setDraft(null);
  }

  if (drill.kind === "areas") {
    const empties = Math.max(0, MAX_SLOTS - taxonomy.areaNames.length - (draftActive ? 1 : 0));
    return (
      <>
        <SectionTitle label="Areas" count={taxonomy.areaNames.length} max={MAX_SLOTS} />
        <BoxGrid>
          {taxonomy.areaNames.map((a, i) => (
            <AreaTile
              key={a}
              label={a}
              coral={i % 2 === 1}
              onClick={() => setDrill({ kind: "categories", areaName: a })}
              onRemove={
                taxonomy.isAreaStored(a) && !hasNotableFolderInArea(taxonomy, a)
                  ? () => onRemoveArea(a)
                  : undefined
              }
            />
          ))}
          {draftActive && (
            <DraftTile
              value={draft ?? ""}
              onChange={setDraft}
              onCommit={() => commitDraft(null)}
              onCancel={cancelDraft}
              placeholder="Area name"
            />
          )}
          {Array.from({ length: empties }).map((_, i) => (
            <EmptySlot key={`e-${i}`} onClick={!draftActive ? startDraft : undefined} />
          ))}
        </BoxGrid>
      </>
    );
  }

  if (drill.kind === "categories") {
    const cats = taxonomy.categoriesByArea.get(drill.areaName) ?? [];
    const empties = Math.max(0, MAX_SLOTS - cats.length - (draftActive ? 1 : 0));
    return (
      <>
        <BackBar label={drill.areaName} onBack={() => setDrill({ kind: "areas" })} />
        <SectionTitle label="Categories" count={cats.length} max={MAX_SLOTS} />
        <BoxGrid>
          {cats.map((c, i) => (
            <AreaTile
              key={c}
              label={c}
              coral={i % 2 === 1}
              onClick={() => setDrill({ kind: "folders", areaName: drill.areaName, categoryName: c })}
              onRemove={
                taxonomy.isCategoryStored(drill.areaName, c) && !hasFolderInCategory(taxonomy, drill.areaName, c)
                  ? () => onRemoveCategory(c, drill.areaName)
                  : undefined
              }
            />
          ))}
          {draftActive && (
            <DraftTile
              value={draft ?? ""}
              onChange={setDraft}
              onCommit={() => commitDraft(drill.areaName)}
              onCancel={cancelDraft}
              placeholder="Category name"
            />
          )}
          {Array.from({ length: empties }).map((_, i) => (
            <EmptySlot key={`e-${i}`} onClick={!draftActive ? startDraft : undefined} />
          ))}
        </BoxGrid>
      </>
    );
  }

  // drill.kind === "folders"
  const folders = taxonomy.foldersByCategory.get(`${drill.areaName}::${drill.categoryName}`) ?? [];
  return (
    <>
      <BackBar
        label={drill.categoryName}
        onBack={() => setDrill({ kind: "categories", areaName: drill.areaName })}
      />
      <SectionTitle label="Notable Folders" count={folders.length} />
      <ul className="sb-folder-list">
        {folders.map((f) => (
          <FolderRow
            key={f.path}
            folder={f}
            checked={selected.has(f.name)}
            onToggle={() => onToggle(f.name)}
          />
        ))}
      </ul>
      {onCreateFolder && (
        <CreateFolderRow
          onCreate={(name) => onCreateFolder(name, drill.areaName, drill.categoryName)}
        />
      )}
    </>
  );
}

function CreateFolderRow({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!editing) {
    return (
      <button type="button" className="sb-create-folder" onClick={() => { setEditing(true); setName(""); }}>
        + New folder
      </button>
    );
  }
  return (
    <div className="sb-create-folder-row">
      <input
        autoFocus
        className="sb-create-folder-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed) void onCreate(trimmed);
            setEditing(false); setName("");
          }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); setName(""); }
        }}
        onBlur={() => {
          const trimmed = name.trim();
          if (trimmed) void onCreate(trimmed);
          setEditing(false); setName("");
        }}
        placeholder="Folder name…"
      />
    </div>
  );
}

function SectionTitle({ label, count, max }: { label: string; count: number; max?: number }) {
  return (
    <div className="sb-title-row">
      <h2 className="sb-title">{label}</h2>
      <span className="sb-count">{count}{max != null ? ` / ${max}` : ""}</span>
    </div>
  );
}

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="sb-back" onClick={onBack}>
      <ChevronLeft size={12} strokeWidth={2} />
      <span>{label}</span>
    </button>
  );
}

function BoxGrid({ children }: { children: React.ReactNode }) {
  return <div className="box-grid">{children}</div>;
}

function AreaTile({ label, coral, onClick, onRemove }: {
  label: string;
  coral: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  const Icon: LucideIcon = folderIcon(label);
  const color = folderColor(label);
  // The remove × is a sibling of the open-tile button rather than a
  // child — buttons can't nest in HTML. .box-wrapper carries the
  // aspect-ratio so both children can size themselves freely.
  return (
    <div className="box-wrapper">
      <button
        type="button"
        className={"box no-image" + (coral ? " coral" : "")}
        onClick={onClick}
        title={`Open ${label}`}
      >
        <span className="box-icon-wrap" style={{ color }}>
          <Icon size={20} strokeWidth={1.8} />
        </span>
        <span className="box-label">{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="box-remove"
          onClick={onRemove}
          title="Remove"
          aria-label="Remove"
        >
          <X size={10} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}

function EmptySlot({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      className="box empty"
      onClick={onClick}
      disabled={!onClick}
      aria-label={onClick ? "Add" : undefined}
    >
      +
    </button>
  );
}

function DraftTile({ value, onChange, onCommit, onCancel, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder: string;
}) {
  return (
    <div className="box draft">
      <input
        autoFocus
        className="box-draft-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={() => {
          if (!value.trim()) onCancel(); else onCommit();
        }}
        placeholder={placeholder}
      />
    </div>
  );
}

// Helpers: derived areas/categories (those backed only by a Notable
// Folder's YAML, never explicitly added) shouldn't get an × button —
// removing the storage entry wouldn't actually drop the tile because
// the Notable Folder still references it. We hide × in those cases.
function hasNotableFolderInArea(taxonomy: Taxonomy, area: string): boolean {
  for (const [key] of taxonomy.foldersByCategory) {
    if (key.startsWith(`${area}::`)) return true;
  }
  return false;
}
function hasFolderInCategory(taxonomy: Taxonomy, area: string, category: string): boolean {
  return (taxonomy.foldersByCategory.get(`${area}::${category}`)?.length ?? 0) > 0;
}

function FolderRow({ folder, checked, onToggle }: {
  folder: NotableFolder;
  checked: boolean;
  onToggle: () => void;
}) {
  const Icon: LucideIcon = folderIcon(folder.name, folder.frontmatter.icon);
  const color = folderColor(folder.name, folder.frontmatter.color);
  const titleFm = folder.frontmatter.title;
  const label = typeof titleFm === "string" && titleFm.trim() ? titleFm : folder.name;
  return (
    <li>
      <button
        type="button"
        className={"sb-folder-item" + (checked ? " checked" : "")}
        onClick={onToggle}
      >
        <span
          className="sb-folder-icon"
          style={{ color, backgroundColor: color + "1A" }}
        >
          <Icon size={13} strokeWidth={2} />
        </span>
        <span className="sb-folder-name">{label}</span>
        {checked && (
          <span className="sb-folder-check" style={{ color }}>
            <Check size={12} strokeWidth={2.5} />
          </span>
        )}
      </button>
    </li>
  );
}
