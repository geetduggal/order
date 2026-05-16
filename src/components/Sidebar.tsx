// Right sidebar — View pill at top, Notable Folder filter hierarchy
// below (Areas → Categories → Notable Folders). Search bar adds
// folders to the filter set directly; clear button drops all filters.

import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Check, Search, X } from "lucide-react";
import {
  folderColor,
  folderIcon,
  noteFolder,
  parseRef,
} from "../lib/folders";
import type { Frontmatter } from "../lib/frontmatter";

export type View = "stream" | "week" | "month" | "year";

const VIEWS: { id: View; label: string }[] = [
  { id: "stream", label: "Stream" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

const UNCATEGORIZED = "(uncategorized)";
const NO_AREA = "(unassigned)";

export interface NotableFolder {
  name: string;
  area: string;
  category: string;
  frontmatter: Frontmatter;
  /** Path to the Main Document so callers can pin / open it. */
  path: string;
}

interface Props {
  view: View;
  onSelectView: (v: View) => void;
  folders: NotableFolder[];
  selected: Set<string>;
  onToggle: (folderName: string) => void;
  onClear: () => void;
}

interface CategoryGroup { name: string; folders: NotableFolder[] }
interface AreaGroup { name: string; categories: CategoryGroup[] }

function buildTaxonomy(folders: NotableFolder[]): AreaGroup[] {
  const areaMap = new Map<string, Map<string, NotableFolder[]>>();
  for (const f of folders) {
    const a = f.area || NO_AREA;
    const c = f.category || UNCATEGORIZED;
    const byCat = areaMap.get(a) ?? new Map<string, NotableFolder[]>();
    const list = byCat.get(c) ?? [];
    list.push(f);
    byCat.set(c, list);
    areaMap.set(a, byCat);
  }
  const result: AreaGroup[] = [];
  for (const [areaName, byCat] of areaMap) {
    const cats: CategoryGroup[] = [];
    for (const [catName, list] of byCat) {
      cats.push({ name: catName, folders: list.sort((x, y) => x.name.localeCompare(y.name)) });
    }
    cats.sort((x, y) => x.name.localeCompare(y.name));
    result.push({ name: areaName, categories: cats });
  }
  result.sort((x, y) => x.name.localeCompare(y.name));
  return result;
}

export function Sidebar({ view, onSelectView, folders, selected, onToggle, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const taxonomy = useMemo(() => buildTaxonomy(folders), [folders]);

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [folders, query]);

  function toggleArea(name: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

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
        <div className="sb-title-row">
          <h2 className="sb-title">Folders</h2>
          {selected.size > 0 && (
            <button type="button" className="sb-clear" onClick={onClear} title="Clear filters">
              <X size={11} strokeWidth={2} />
              <span>clear</span>
            </button>
          )}
        </div>

        <div className="sb-search">
          <Search size={12} strokeWidth={2} className="sb-search-icon" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search folders…"
            className="sb-search-input"
          />
        </div>

        {query && searchMatches.length === 0 && (
          <p className="sb-empty-small">No folders match.</p>
        )}

        {query && searchMatches.length > 0 && (
          <ul className="sb-folder-list sb-search-results">
            {searchMatches.map((f) => (
              <SidebarFolderItem
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
            Add <code>category: [[Name]]</code> to a note's YAML to mark it as a Notable Folder.
          </p>
        )}

        {!query && taxonomy.map((area) => (
          <div key={area.name} className="sb-area">
            <button
              type="button"
              className="sb-area-header"
              onClick={() => toggleArea(area.name)}
              aria-expanded={!collapsed.has(area.name)}
            >
              <span className={"sb-disclosure" + (collapsed.has(area.name) ? "" : " open")}>›</span>
              <span className="sb-area-name">{area.name}</span>
            </button>
            {!collapsed.has(area.name) && (
              <div className="sb-area-body">
                {area.categories.map((cat) => (
                  <div key={cat.name} className="sb-cat">
                    <div className="sb-cat-name">{cat.name}</div>
                    <ul className="sb-folder-list">
                      {cat.folders.map((f) => (
                        <SidebarFolderItem
                          key={f.path}
                          folder={f}
                          checked={selected.has(f.name)}
                          onToggle={() => onToggle(f.name)}
                        />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </section>
    </aside>
  );
}

function SidebarFolderItem({ folder, checked, onToggle }: {
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

// Re-export the parseRef helper from folders.ts so CardGrid can build
// NotableFolder records without importing from two places.
export { parseRef, noteFolder };
