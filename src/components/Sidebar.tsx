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
import { Check, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Trash2, X, FileCog, Check as CheckDone } from "lucide-react";
import { folderColor, folderIcon } from "../lib/folders";
import { useTileDrag } from "../lib/use-tile-drag";
import { CodeMirrorSurface } from "./CodeMirrorSurface";
import { firstMajorHeader, type Frontmatter } from "../lib/frontmatter";

export type View = "pile" | "day" | "week" | "month" | "year" | "season";

const MAX_SLOTS = 10;
const NO_AREA = "(unassigned)";
const NO_CATEGORY = "(uncategorized)";

export interface NotableFolder {
  name: string;
  area: string;
  category: string;
  frontmatter: Frontmatter;
  path: string;
  /** Main-doc body — lets the tile label by the note's first major header. */
  body?: string;
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
  /** Create a new Notable Folder Main Document under the drilled
   *  (area, category). The sidebar surfaces this as a "+ New folder"
   *  row at the bottom of the folders drill view. */
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void>;
  /** Stored Areas and Categories the user has explicitly added (vs
   *  derived from a Notable Folder's YAML). Used to decide whether
   *  the × remove button shows on a tile. */
  storedAreas: string[];
  storedCategories: { area: string; name: string }[];
  /** Add/remove handlers — optional so the read-only viewer can omit them
   *  (then no add slots / remove × render). */
  onAddArea?: (name: string) => void;
  onRemoveArea?: (name: string) => void;
  onAddCategory?: (name: string, area: string) => void;
  onRemoveCategory?: (name: string, area: string) => void;
  /** Reorder handlers (optional — when absent, e.g. the read-only viewer,
   *  no reorder/remove controls are shown). `dir` is "up" (earlier) or
   *  "down" (later) in the list. */
  onReorderArea?: (name: string, dir: "up" | "down") => void;
  onReorderCategory?: (name: string, area: string, dir: "up" | "down") => void;
  onReorderFolder?: (name: string, area: string, category: string, dir: "up" | "down") => void;
  /** Drag-reorder: rewrite the whole order (areas, or categories in an
   *  area) to the given ref sequence. */
  onReorderAreas?: (order: string[]) => void;
  onReorderCategories?: (area: string, order: string[]) => void;
  onReorderFolders?: (area: string, category: string, order: string[]) => void;
  /** Remove a Notable Folder from its Category (keeps the note). */
  onRemoveFolder?: (name: string, area: string, category: string) => void;
  /** Rename a Notable Folder in place — renames its dir + main-doc
   *  file + rewrites every inbound `[[Name]]` and `folder: [[Name]]`
   *  reference. CardGrid does the heavy lifting; the sidebar just
   *  surfaces the inline-edit affordance on the folder row. */
  onRenameFolder?: (oldName: string, newName: string) => void;
  /** Chain order (Areas → Categories → folder refs) so the lists render
   *  in the on-disk bullet order rather than alphabetically. */
  order?: { ref: string; categories: { ref: string; folders: string[] }[] }[];
  /** Optional content rendered above the View switcher. */
  header?: import("react").ReactNode;
  /** Optional content rendered between the View switcher and the
   *  Areas/Categories/Folders drill — the host uses this for the
   *  active filter pill stack so pills sit prominently at the top of
   *  the sidebar without obscuring the drill below. */
  filters?: import("react").ReactNode;
  /** Optional content rendered pinned to the bottom of the sidebar. */
  footer?: import("react").ReactNode;
  /** Toggle whether an Area or Category is in the include filter set.
   *  When omitted, the filter-toggle button on each tile is hidden. */
  onToggleAreaFilter?: (name: string) => void;
  onToggleCategoryFilter?: (name: string, area: string) => void;
  /** Refs currently in the filter (same set used for NF rows). */
  filteredRefs?: Set<string>;
  /** Current spacetime source (spacetime.md) body — enables the in-sidebar
   *  editor. When present alongside onEditSpacetime, an edit toggle shows. */
  spacetimeSource?: string;
  /** Persist an edited spacetime.md body (same save path as the pile editor:
   *  structural changes light the "spacetime · pending" review). */
  onEditSpacetime?: (text: string) => void;
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
  order?: { ref: string; categories: { ref: string; folders: string[] }[] }[],
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

  // Folder order from the chain (order prop): catRef → folderRef → index.
  // Used to render folders in their on-disk bullet order; anything not in
  // the chain falls back to alphabetical after the ordered ones.
  const folderRank = new Map<string, Map<string, number>>();
  if (order) {
    for (const a of order) {
      for (const c of a.categories) {
        const m = new Map<string, number>();
        c.folders.forEach((f, i) => m.set(f.toLowerCase(), i));
        folderRank.set(c.ref.toLowerCase(), m);
      }
    }
  }

  return {
    // Insertion order (stored/chain first, then YAML-derived) — NOT sorted,
    // so reordering in the chain files is reflected here.
    areaNames: [...areaSet],
    categoriesByArea: new Map(
      [...categoriesByArea].map(([a, set]) => [a, [...set]]),
    ),
    foldersByCategory: new Map(
      [...foldersByCategory].map(([k, list]) => {
        const catRef = (k.split("::")[1] ?? "").toLowerCase();
        const rank = folderRank.get(catRef);
        const sorted = [...list].sort((x, y) => {
          const rx = rank?.get(x.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          const ry = rank?.get(y.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
          return rx !== ry ? rx - ry : x.name.localeCompare(y.name);
        });
        return [k, sorted];
      }),
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
  onCreateFolder,
  storedAreas,
  storedCategories,
  onAddArea,
  onRemoveArea,
  onAddCategory,
  onRemoveCategory,
  onReorderArea,
  onReorderCategory,
  onReorderFolder,
  onReorderAreas,
  onReorderCategories,
  onReorderFolders,
  onRemoveFolder,
  onRenameFolder,
  order,
  header,
  filters,
  footer,
  onToggleAreaFilter,
  onToggleCategoryFilter,
  filteredRefs,
  spacetimeSource,
  onEditSpacetime,
}: Props) {
  const [drill, setDrill] = useState<DrillState>({ kind: "areas" });
  const [editingSpacetime, setEditingSpacetime] = useState(false);
  const canEditSpacetime = spacetimeSource !== undefined && !!onEditSpacetime;

  const taxonomy = useMemo(
    () => buildTaxonomy(folders, storedAreas, storedCategories, order),
    [folders, storedAreas, storedCategories, order],
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

  if (editingSpacetime && canEditSpacetime) {
    return (
      <aside className="pane-right is-editing-spacetime">
        {header && <section className="sb-section sb-header-slot">{header}</section>}
        <section className="sb-section sb-spacetime-edit">
          <div className="sb-spacetime-head">
            <span className="sb-spacetime-title">spacetime.md</span>
            <button
              type="button"
              className="sb-spacetime-done"
              onClick={() => setEditingSpacetime(false)}
              title="Done editing"
            >
              <CheckDone size={13} strokeWidth={2.2} /> Done
            </button>
          </div>
          <div className="sb-spacetime-editor">
            <CodeMirrorSurface
              value={spacetimeSource ?? ""}
              onChange={(t) => onEditSpacetime?.(t)}
              lang="markdown"
            />
          </div>
        </section>
      </aside>
    );
  }

  return (
    <aside className="pane-right">
      {header && <section className="sb-section sb-header-slot">{header}</section>}
      {/* View picker is in the calendar surface itself now; Sidebar
          stays focused on the taxonomy + filter pile. The view prop
          is still threaded so callers don't need to know we moved
          the UI. */}
      {filters && <section className="sb-section sb-filters-slot">{filters}</section>}

      {canEditSpacetime && (
        <div className="sb-spacetime-toolbar">
          <button
            type="button"
            className="sb-spacetime-edit-btn"
            onClick={() => setEditingSpacetime(true)}
            title="Edit spacetime.md"
          >
            <FileCog size={13} strokeWidth={2} /> Edit spacetime.md
          </button>
        </div>
      )}

      <section className="sb-section sb-filters">
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
          onReorderArea={onReorderArea}
          onReorderCategory={onReorderCategory}
          onToggleAreaFilter={onToggleAreaFilter}
          onToggleCategoryFilter={onToggleCategoryFilter}
          filteredRefs={filteredRefs}
          onReorderFolder={onReorderFolder}
          onReorderAreas={onReorderAreas}
          onReorderCategories={onReorderCategories}
          onReorderFolders={onReorderFolders}
          onRemoveFolder={onRemoveFolder}
          onRenameFolder={onRenameFolder}
        />
      </section>
      {footer && <section className="sb-section sb-footer-slot">{footer}</section>}
    </aside>
  );
}


function DrillView({
  drill, setDrill, taxonomy, selected, onToggle, onCreateFolder,
  onAddArea, onRemoveArea, onAddCategory, onRemoveCategory,
  onReorderArea, onReorderCategory, onReorderFolder,
  onReorderAreas, onReorderCategories, onReorderFolders, onRemoveFolder,
  onRenameFolder,
  onToggleAreaFilter, onToggleCategoryFilter, filteredRefs,
}: {
  drill: DrillState;
  setDrill: (s: DrillState) => void;
  taxonomy: Taxonomy;
  selected: Set<string>;
  onToggle: (name: string) => void;
  onCreateFolder?: (name: string, area: string, category: string) => Promise<void>;
  onAddArea?: (name: string) => void;
  onRemoveArea?: (name: string) => void;
  onAddCategory?: (name: string, area: string) => void;
  onRemoveCategory?: (name: string, area: string) => void;
  onReorderArea?: (name: string, dir: "up" | "down") => void;
  onReorderCategory?: (name: string, area: string, dir: "up" | "down") => void;
  onReorderFolder?: (name: string, area: string, category: string, dir: "up" | "down") => void;
  onReorderAreas?: (order: string[]) => void;
  onReorderCategories?: (area: string, order: string[]) => void;
  onReorderFolders?: (area: string, category: string, order: string[]) => void;
  onRemoveFolder?: (name: string, area: string, category: string) => void;
  onRenameFolder?: (oldName: string, newName: string) => void;
  onToggleAreaFilter?: (name: string) => void;
  onToggleCategoryFilter?: (name: string, area: string) => void;
  filteredRefs?: Set<string>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftActive = draft !== null;

  function startDraft() { setDraft(""); }
  function cancelDraft() { setDraft(null); }
  function commitDraft(area: string | null) {
    const trimmed = (draft ?? "").trim();
    if (trimmed) {
      if (area === null) onAddArea?.(trimmed);
      else onAddCategory?.(trimmed, area);
    }
    setDraft(null);
  }

  // Drag-reorder for the current grid (Areas tiles, or an Area's Categories).
  // Hooks run unconditionally, so compute the active list + handler first.
  let dragRefs: string[] = [];
  let dragHandler: ((order: string[]) => void) | undefined;
  if (drill.kind === "areas") {
    dragRefs = taxonomy.areaNames;
    dragHandler = onReorderAreas;
  } else if (drill.kind === "categories") {
    const areaName = drill.areaName;
    const reorderCats = onReorderCategories;
    dragRefs = taxonomy.categoriesByArea.get(areaName) ?? [];
    dragHandler = reorderCats ? (order) => reorderCats(areaName, order) : undefined;
  }
  const { gridRef, dragRef: draggingRef, onTilePointerDown } = useTileDrag(dragRefs, dragHandler, { exclude: ".box-remove, .box-move, .sb-folder-ctl, input" });

  // Drag-reorder for the Notable Folder list (vertical).
  let folderDragRefs: string[] = [];
  let folderReorder: ((order: string[]) => void) | undefined;
  if (drill.kind === "folders") {
    const a = drill.areaName;
    const c = drill.categoryName;
    const h = onReorderFolders;
    folderDragRefs = (taxonomy.foldersByCategory.get(`${a}::${c}`) ?? []).map((f) => f.name);
    folderReorder = h ? (order) => h(a, c, order) : undefined;
  }
  const folderDrag = useTileDrag(folderDragRefs, folderReorder, { vertical: true, exclude: ".box-remove, .box-move, .sb-folder-ctl, input" });

  if (drill.kind === "areas") {
    const empties = Math.max(0, MAX_SLOTS - taxonomy.areaNames.length - (draftActive ? 1 : 0));
    return (
      <>
        <SectionTitle label="Areas" count={taxonomy.areaNames.length} max={MAX_SLOTS} />
        <BoxGrid gridRef={gridRef}>
          {taxonomy.areaNames.map((a, i) => (
            <AreaTile
              key={a}
              label={a}
              coral={i % 2 === 1}
              onClick={() => setDrill({ kind: "categories", areaName: a })}
              onRemove={
                onRemoveArea && taxonomy.isAreaStored(a) && !hasNotableFolderInArea(taxonomy, a)
                  ? () => onRemoveArea(a)
                  : undefined
              }
              onMoveEarlier={onReorderArea && i > 0 ? () => onReorderArea(a, "up") : undefined}
              onMoveLater={onReorderArea && i < taxonomy.areaNames.length - 1 ? () => onReorderArea(a, "down") : undefined}
              tileRef={a}
              dragging={draggingRef === a}
              onTilePointerDown={onReorderAreas ? (e) => onTilePointerDown(e, a) : undefined}
              filtered={filteredRefs?.has(a)}
              onToggleFilter={onToggleAreaFilter ? () => onToggleAreaFilter(a) : undefined}
            />
          ))}
          {onAddArea && draftActive && (
            <DraftTile
              value={draft ?? ""}
              onChange={setDraft}
              onCommit={() => commitDraft(null)}
              onCancel={cancelDraft}
              placeholder="Area name"
            />
          )}
          {onAddArea && Array.from({ length: empties }).map((_, i) => (
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
        <BoxGrid gridRef={gridRef}>
          {cats.map((c, i) => (
            <AreaTile
              key={c}
              label={c}
              coral={i % 2 === 1}
              onClick={() => setDrill({ kind: "folders", areaName: drill.areaName, categoryName: c })}
              onRemove={
                onRemoveCategory && taxonomy.isCategoryStored(drill.areaName, c) && !hasFolderInCategory(taxonomy, drill.areaName, c)
                  ? () => onRemoveCategory(c, drill.areaName)
                  : undefined
              }
              onMoveEarlier={onReorderCategory && i > 0 ? () => onReorderCategory(c, drill.areaName, "up") : undefined}
              onMoveLater={onReorderCategory && i < cats.length - 1 ? () => onReorderCategory(c, drill.areaName, "down") : undefined}
              tileRef={c}
              dragging={draggingRef === c}
              onTilePointerDown={onReorderCategories ? (e) => onTilePointerDown(e, c) : undefined}
              filtered={filteredRefs?.has(c)}
              onToggleFilter={onToggleCategoryFilter ? () => onToggleCategoryFilter(c, drill.areaName) : undefined}
            />
          ))}
          {onAddCategory && draftActive && (
            <DraftTile
              value={draft ?? ""}
              onChange={setDraft}
              onCommit={() => commitDraft(drill.areaName)}
              onCancel={cancelDraft}
              placeholder="Category name"
            />
          )}
          {onAddCategory && Array.from({ length: empties }).map((_, i) => (
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
      <ul className="sb-folder-list" ref={folderDrag.gridRef}>
        {folders.map((f, i) => (
          <FolderRow
            key={f.path}
            folder={f}
            checked={selected.has(f.name)}
            onToggle={() => onToggle(f.name)}
            onMoveUp={onReorderFolder && i > 0 ? () => onReorderFolder(f.name, drill.areaName, drill.categoryName, "up") : undefined}
            onMoveDown={onReorderFolder && i < folders.length - 1 ? () => onReorderFolder(f.name, drill.areaName, drill.categoryName, "down") : undefined}
            onRemove={onRemoveFolder ? () => onRemoveFolder(f.name, drill.areaName, drill.categoryName) : undefined}
            onRename={onRenameFolder ? (newName) => onRenameFolder(f.name, newName) : undefined}
            dragging={folderDrag.dragRef === f.name}
            onTilePointerDown={onReorderFolders ? (e) => folderDrag.onTilePointerDown(e, f.name) : undefined}
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

function BoxGrid({ children, gridRef }: { children: React.ReactNode; gridRef?: React.Ref<HTMLDivElement> }) {
  return <div className="box-grid" ref={gridRef}>{children}</div>;
}

function AreaTile({ label, coral, onClick, onRemove, onMoveEarlier, onMoveLater, tileRef, dragging, onTilePointerDown, filtered, onToggleFilter }: {
  label: string;
  coral: boolean;
  onClick: () => void;
  onRemove?: () => void;
  onMoveEarlier?: () => void;
  onMoveLater?: () => void;
  tileRef?: string;
  dragging?: boolean;
  onTilePointerDown?: (e: React.PointerEvent) => void;
  /** Whether this area/category is currently in the include filter. */
  filtered?: boolean;
  /** Add or remove this area/category from the include filter. When
   *  omitted, the filter toggle button isn't rendered. */
  onToggleFilter?: () => void;
}) {
  const Icon: LucideIcon = folderIcon(label);
  const color = folderColor(label);
  // The remove ×, reorder arrows, and filter toggle are siblings of
  // the open-tile button rather than children — buttons can't nest in
  // HTML. .box-wrapper carries the aspect-ratio so the children size
  // themselves freely, and is the drag surface (data-tile-ref) for
  // pointer reordering.
  return (
    <div
      className={"box-wrapper" + (dragging ? " dragging" : "") + (onTilePointerDown ? " draggable" : "") + (filtered ? " is-filtered" : "")}
      data-tile-ref={tileRef}
      onPointerDown={onTilePointerDown}
    >
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
      {onToggleFilter && (
        <button
          type="button"
          className={"box-filter" + (filtered ? " is-on" : "")}
          onClick={(e) => { e.stopPropagation(); onToggleFilter(); }}
          onPointerDown={(e) => e.stopPropagation()}
          title={filtered ? `Stop filtering by ${label}` : `Filter by ${label}`}
          aria-label={filtered ? `Stop filtering by ${label}` : `Filter by ${label}`}
          aria-pressed={!!filtered}
        >
          <Check size={11} strokeWidth={2.5} />
        </button>
      )}
      {(onMoveEarlier || onMoveLater) && (
        <div className="box-reorder">
          <button
            type="button"
            className="box-move"
            disabled={!onMoveEarlier}
            onClick={onMoveEarlier}
            title="Move earlier"
            aria-label="Move earlier"
          >
            <ChevronLeft size={11} strokeWidth={2.5} />
          </button>
          <button
            type="button"
            className="box-move"
            disabled={!onMoveLater}
            onClick={onMoveLater}
            title="Move later"
            aria-label="Move later"
          >
            <ChevronRight size={11} strokeWidth={2.5} />
          </button>
        </div>
      )}
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

const REMOVE_CONFIRM_TIMEOUT_MS = 4000;

function FolderRow({ folder, checked, onToggle, onMoveUp, onMoveDown, onRemove, onRename, dragging, onTilePointerDown }: {
  folder: NotableFolder;
  checked: boolean;
  onToggle: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRemove?: () => void;
  /** Rename the folder ref (filename). The pretty `title:` lives in
   *  YAML and is edited via the card's FrontmatterInspector — this
   *  changes the on-disk name used by every inbound `[[Name]]` link. */
  onRename?: (newName: string) => void;
  dragging?: boolean;
  onTilePointerDown?: (e: React.PointerEvent) => void;
}) {
  const Icon: LucideIcon = folderIcon(folder.name, folder.frontmatter.icon);
  const color = folderColor(folder.name, folder.frontmatter.color);
  const titleFm = folder.frontmatter.title;
  // Label by the note's `title:`, then its first major header (`# Title`), then
  // the folder name. The ref (data-tile-ref / rename target) stays folder.name.
  const label = (typeof titleFm === "string" && titleFm.trim())
    ? titleFm.trim()
    : (firstMajorHeader(folder.body) ?? folder.name);
  const hasControls = !!(onMoveUp || onMoveDown || onRemove);
  // Inline rename — armed by double-click on the folder name; commit
  // on Enter / blur, cancel on Escape. The committed value is the
  // *filename ref* (what other notes link to), not the pretty title.
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(folder.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) {
      setRenameDraft(folder.name);
      requestAnimationFrame(() => renameInputRef.current?.select());
    }
  }, [renaming, folder.name]);
  const commitRename = () => {
    const next = renameDraft.trim();
    setRenaming(false);
    if (!next || next === folder.name) return;
    onRename?.(next);
  };
  // Two-click confirm for remove. First click arms; second click within
  // REMOVE_CONFIRM_TIMEOUT_MS fires onRemove. Timer auto-cancels armed
  // state. Matches the pattern used by Card's delete button.
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onRemoveClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onRemove) return;
    if (confirming) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setConfirming(false);
      onRemove();
      return;
    }
    setConfirming(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setConfirming(false), REMOVE_CONFIRM_TIMEOUT_MS);
  };
  return (
    <li
      className={"sb-folder-li" + (dragging ? " dragging" : "") + (onTilePointerDown ? " draggable" : "")}
      data-tile-ref={folder.name}
      onPointerDown={onTilePointerDown}
    >
      <button
        type="button"
        className={"sb-folder-item" + (checked ? " checked" : "")}
        onClick={renaming ? undefined : onToggle}
        onDoubleClick={onRename ? (e) => { e.preventDefault(); e.stopPropagation(); setRenaming(true); } : undefined}
        title={onRename ? `${label} — double-click to rename` : label}
      >
        <span
          className="sb-folder-icon"
          style={{ color, backgroundColor: color + "1A" }}
        >
          <Icon size={13} strokeWidth={2} />
        </span>
        {renaming ? (
          <input
            ref={renameInputRef}
            className="sb-folder-rename"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
              if (e.key === "Escape") { e.preventDefault(); setRenaming(false); }
            }}
            onBlur={commitRename}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="sb-folder-name">{label}</span>
        )}
        {checked && !renaming && (
          <span className="sb-folder-check" style={{ color }}>
            <Check size={12} strokeWidth={2.5} />
          </span>
        )}
      </button>
      {hasControls && (
        <span className="sb-folder-controls">
          <button type="button" className="sb-folder-ctl" disabled={!onMoveUp} onClick={onMoveUp} title="Move up" aria-label="Move up">
            <ChevronUp size={11} strokeWidth={2.5} />
          </button>
          <button type="button" className="sb-folder-ctl" disabled={!onMoveDown} onClick={onMoveDown} title="Move down" aria-label="Move down">
            <ChevronDown size={11} strokeWidth={2.5} />
          </button>
          {onRemove && (
            <button
              type="button"
              className={"sb-folder-ctl sb-folder-ctl-remove" + (confirming ? " is-confirming" : "")}
              onClick={onRemoveClick}
              title={confirming ? "Click again to remove from category" : "Remove from category"}
              aria-label={confirming ? "Confirm remove" : "Remove from category"}
            >
              {confirming ? <Trash2 size={11} strokeWidth={2.5} /> : <X size={11} strokeWidth={2.5} />}
            </button>
          )}
        </span>
      )}
    </li>
  );
}
