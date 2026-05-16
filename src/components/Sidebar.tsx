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

import { useMemo, useState } from "react";
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
}

interface Taxonomy {
  areaNames: string[];
  categoriesByArea: Map<string, string[]>;
  foldersByCategory: Map<string, NotableFolder[]>;
}

function buildTaxonomy(folders: NotableFolder[]): Taxonomy {
  const areaNames = new Set<string>();
  const categoriesByArea = new Map<string, Set<string>>();
  const foldersByCategory = new Map<string, NotableFolder[]>();
  for (const f of folders) {
    const a = f.area || NO_AREA;
    const c = f.category || NO_CATEGORY;
    areaNames.add(a);
    const cats = categoriesByArea.get(a) ?? new Set();
    cats.add(c);
    categoriesByArea.set(a, cats);
    const key = `${a}::${c}`;
    const list = foldersByCategory.get(key) ?? [];
    list.push(f);
    foldersByCategory.set(key, list);
  }
  return {
    areaNames: [...areaNames].sort(),
    categoriesByArea: new Map(
      [...categoriesByArea].map(([a, set]) => [a, [...set].sort()]),
    ),
    foldersByCategory: new Map(
      [...foldersByCategory].map(([k, list]) => [
        k,
        list.sort((x, y) => x.name.localeCompare(y.name)),
      ]),
    ),
  };
}

export function Sidebar({ view, onSelectView, folders, selected, onToggle, onClear, onCreateFolder }: Props) {
  const [drill, setDrill] = useState<DrillState>({ kind: "areas" });
  const [query, setQuery] = useState("");

  const taxonomy = useMemo(() => buildTaxonomy(folders), [folders]);

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
    return folders.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 8);
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

        {!query && folders.length === 0 && (
          <p className="sb-empty">
            Add <code>category: [[Name]]</code> and <code>area: [[Name]]</code> to a note's YAML to mark it as a Notable Folder.
          </p>
        )}

        {!query && folders.length > 0 && (
          <DrillView
            drill={drill}
            setDrill={setDrill}
            taxonomy={taxonomy}
            selected={selected}
            onToggle={onToggle}
            onCreateFolder={onCreateFolder}
          />
        )}
      </section>
    </aside>
  );
}

function DrillView({ drill, setDrill, taxonomy, selected, onToggle, onCreateFolder }: {
  drill: DrillState;
  setDrill: (s: DrillState) => void;
  taxonomy: Taxonomy;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void>;
}) {
  if (drill.kind === "areas") {
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
            />
          ))}
          {Array.from({ length: Math.max(0, MAX_SLOTS - taxonomy.areaNames.length) }).map((_, i) => (
            <EmptySlot key={`e-${i}`} />
          ))}
        </BoxGrid>
      </>
    );
  }

  if (drill.kind === "categories") {
    const cats = taxonomy.categoriesByArea.get(drill.areaName) ?? [];
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
            />
          ))}
          {Array.from({ length: Math.max(0, MAX_SLOTS - cats.length) }).map((_, i) => (
            <EmptySlot key={`e-${i}`} />
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

function AreaTile({ label, coral, onClick }: {
  label: string;
  coral: boolean;
  onClick: () => void;
}) {
  const Icon: LucideIcon = folderIcon(label);
  const color = folderColor(label);
  return (
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
  );
}

function EmptySlot() {
  return <div className="box empty" aria-hidden="true">+</div>;
}

function FolderRow({ folder, checked, onToggle }: {
  folder: NotableFolder;
  checked: boolean;
  onToggle: () => void;
}) {
  const Icon: LucideIcon = folderIcon(folder.name, folder.frontmatter.icon);
  const color = folderColor(folder.name, folder.frontmatter.color);
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
        <span className="sb-folder-name">{folder.name}</span>
        {checked && (
          <span className="sb-folder-check" style={{ color }}>
            <Check size={12} strokeWidth={2.5} />
          </span>
        )}
      </button>
    </li>
  );
}
