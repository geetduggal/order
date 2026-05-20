// Root of the read-only web viewer. It mirrors Order's desktop app
// 1:1 — same Stream, same filter-pill model, same Card component —
// just read-only. There is one screen (the Stream) plus the calendar
// views; filtering is managed exclusively through the left-rail pills,
// identical to CardGrid.

import { useEffect, useMemo, useState } from "react";
import type { PublishedSite, PublishedNote } from "../src/lib/publish";
import { Sidebar, type NotableFolder } from "../src/components/Sidebar";
import { CommandPalette } from "../src/components/CommandPalette";
import { Card } from "../src/components/Card";
import { CalendarView, type NoteMeta } from "../src/components/CalendarView";
import { YearLinearView } from "../src/components/YearLinearView";
import { FilterPillStack } from "../src/components/FilterPillStack";
import type { Filter } from "../src/lib/filters";
import type { ListNoteRef } from "../src/lib/list-folder";
import { useGridLayout } from "../src/lib/grid-layout";
import { folderColor } from "../src/lib/folders";
import { Home as HouseIcon, ChevronsDown, ChevronsUp } from "lucide-react";

type View = "stream" | "week" | "month" | "year";

export function ViewerApp({ data }: { data: PublishedSite }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar hidden by default — viewers shouldn't get a wall of UI on
  // first paint. Toggle via the › / ‹ button or Cmd+;.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("stream");
  const [jumpedDown, setJumpedDown] = useState(false);

  // Default view = the home Notable Folder focused (single include),
  // exactly like the desktop app's first-launch default.
  const [filters, setFilters] = useState<Filter[]>(
    () => data.home.name ? [{ kind: "include", ref: data.home.name }] : [],
  );
  // The folder whose Main Document is pinned to the top of the Stream.
  // Set by clicking a pill; cleared when the filter set changes.
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  useEffect(() => { setFocusedFolder(null); }, [filters]);
  // Ref of the card to smooth-scroll to (+ coral flash). Cleared once
  // the scroll fires.
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  const includeSet = useMemo(
    () => new Set(filters.filter((f) => f.kind === "include").map((f) => f.ref)),
    [filters],
  );

  function addInclude(ref: string) {
    setFilters((prev) =>
      prev.some((f) => f.kind === "include" && f.ref === ref)
        ? prev
        : [...prev, { kind: "include", ref }],
    );
  }
  function removeFilter(target: Filter) {
    setFilters((prev) => prev.filter(
      (f) => !(f.kind === target.kind && f.ref === target.ref),
    ));
  }
  function resetToDefault() {
    setFilters(data.home.name ? [{ kind: "include", ref: data.home.name }] : []);
    setJumpedDown(false);
  }
  // Wikilink / list-row click → add an include + scroll to it.
  function navigate(ref: string) {
    setView("stream");
    addInclude(ref);
    setScrollTarget(ref);
  }

  // Category → Area from the published chain, so Sidebar grouping
  // populates without each note repeating its area in YAML.
  const areaByCategory = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data.taxonomy.areas) {
      for (const c of a.categories) m.set(c.ref, a.ref);
    }
    return m;
  }, [data.taxonomy]);

  const notableFolders: NotableFolder[] = useMemo(
    () => data.notes
      .filter((n) => n.category)
      .map((n) => ({
        name: n.ref,
        area: n.category ? (areaByCategory.get(n.category) ?? "") : "",
        category: n.category ?? "",
        frontmatter: n.frontmatter,
        path: n.ref,
      })),
    [data.notes, areaByCategory],
  );
  const storedAreas = data.taxonomy.areas.map((a) => a.ref);
  const storedCategories = data.taxonomy.areas.flatMap((a) =>
    a.categories.map((c) => ({ area: a.ref, name: c.ref })),
  );

  // ---- Stream filtering + sort (mirrors CardGrid) ----
  const hidden = useMemo(
    () => new Set(data.hiddenRefs.map((r) => r.toLowerCase())),
    [data.hiddenRefs],
  );
  const includeRefs = filters.filter((f) => f.kind === "include").map((f) => f.ref);
  const excludeRefs = filters.filter((f) => f.kind === "exclude").map((f) => f.ref);
  // Single-folder mode = exactly one include → full-width Main Doc
  // "cover" + notes below. Otherwise NFs render as ordinary cards.
  const singleFolderMode = includeRefs.length === 1;
  const pinnedRef = singleFolderMode ? (focusedFolder ?? includeRefs[0]) : null;
  const belongsTo = (n: PublishedNote, ref: string) =>
    n.ref === ref || n.folder === ref;

  const visible = useMemo(() => {
    const filtered = data.notes.filter((n) => {
      if (hidden.has(n.ref.toLowerCase())) return false;
      if (includeRefs.length > 0 && !includeRefs.some((r) => belongsTo(n, r))) return false;
      if (excludeRefs.some((r) => belongsTo(n, r))) return false;
      return true;
    });
    // Single-folder mode pins that folder's Main Doc to the top (its
    // "cover"); any other state is a flat recency timeline.
    const isPinned = (n: PublishedNote) => !!n.category && pinnedRef !== null && n.ref === pinnedRef;
    return [...filtered].sort((a, b) => {
      const am = isPinned(a);
      const bm = isPinned(b);
      if (am !== bm) return am ? -1 : 1;
      return (b.mtime ?? 0) - (a.mtime ?? 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.notes, hidden, filters, focusedFolder]);

  // Calendar projection from the same filtered set.
  const calendarNotes: NoteMeta[] = useMemo(
    () => visible.map((n) => ({
      path: `${n.ref}.md`,
      filename: `${n.ref}.md`,
      title: n.title,
      frontmatter: n.frontmatter,
      color: n.folder ? folderColor(n.folder) : (n.category ? folderColor(n.ref) : undefined),
    })),
    [visible],
  );
  const onEventClick = (path: string) => {
    const ref = path.replace(/\.md$/i, "").replace(/^.*\//, "");
    navigate(ref);
  };
  const noop = async () => { /* read-only */ };

  // Smooth-scroll + coral flash to the target card after a filter
  // change has rendered it.
  useEffect(() => {
    if (view !== "stream" || !scrollTarget) return;
    const target = scrollTarget.toLowerCase();
    const timer = setTimeout(() => {
      const cells = document.querySelectorAll<HTMLElement>(".card-grid-cell");
      const cell = Array.from(cells).find(
        (c) => (c.dataset.path ?? "").toLowerCase() === target,
      );
      if (cell) {
        cell.scrollIntoView({ behavior: "smooth", block: "start" });
        cell.classList.add("is-target");
        setTimeout(() => cell.classList.remove("is-target"), 1400);
      }
      setScrollTarget(null);
    }, 120);
    return () => clearTimeout(timer);
  }, [view, scrollTarget, filters]);

  function jumpToNotes() {
    if (jumpedDown) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setJumpedDown(false);
      return;
    }
    const cell = document.querySelector<HTMLElement>(".card-grid-cell:not(.is-full-width)");
    if (cell) {
      cell.scrollIntoView({ behavior: "smooth", block: "start" });
      setJumpedDown(true);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ";") {
        e.preventDefault();
        setSidebarOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={"shell" + (sidebarOpen ? " sidebar-open" : " sidebar-closed")}>
      <button
        type="button"
        className="home-reset"
        onClick={resetToDefault}
        title="Reset filters (home view)"
        aria-label="Reset filters to the default home view"
      >
        <HouseIcon size={13} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="jump-to-notes"
        onClick={jumpToNotes}
        title={jumpedDown ? "Back to top" : "Jump to notes"}
        aria-label={jumpedDown ? "Back to top" : "Jump to notes for this folder"}
      >
        {jumpedDown
          ? <ChevronsUp size={13} strokeWidth={1.8} />
          : <ChevronsDown size={13} strokeWidth={1.8} />}
      </button>

      <FilterPillStack
        filters={filters}
        onRemove={removeFilter}
        onJump={(ref) => {
          setView("stream");
          setFocusedFolder(ref);
          setScrollTarget(ref);
        }}
      />

      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setSidebarOpen((o) => !o)}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      >
        {sidebarOpen ? "›" : "‹"}
      </button>

      <main className="pane-main">
        {view === "stream" && (
          <StreamView
            notes={visible}
            data={data}
            includeSet={includeSet}
            fullWidthRef={singleFolderMode ? pinnedRef : null}
            onNavigate={navigate}
            onRemoveInclude={(ref) => removeFilter({ kind: "include", ref })}
          />
        )}
        {view === "week" && (
          <CalendarView key="week" notes={calendarNotes} initialView="timeGridWeek"
            onMoveEvent={noop} onEventClick={onEventClick} onCreate={noop} />
        )}
        {view === "month" && (
          <CalendarView key="month" notes={calendarNotes} initialView="dayGridMonth"
            onMoveEvent={noop} onEventClick={onEventClick} onCreate={noop} />
        )}
        {view === "year" && (
          <YearLinearView key="year" notes={calendarNotes}
            onMoveEvent={noop} onEventClick={onEventClick} onCreate={noop} />
        )}
      </main>

      {sidebarOpen && (
        <Sidebar
          view={view}
          onSelectView={setView}
          folders={notableFolders}
          // Pure navigation: clicking a folder ADDS an include pill.
          selected={includeSet}
          onToggle={addInclude}
          onClear={resetToDefault}
          storedAreas={storedAreas}
          storedCategories={storedCategories}
          onAddArea={() => { /* no-op */ }}
          onRemoveArea={() => { /* no-op */ }}
          onAddCategory={() => { /* no-op */ }}
          onRemoveCategory={() => { /* no-op */ }}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={notableFolders}
          selected={includeSet}
          onToggle={addInclude}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- Stream view ----------

function StreamView({
  notes, data, includeSet, fullWidthRef, onNavigate, onRemoveInclude,
}: {
  notes: PublishedNote[];
  data: PublishedSite;
  includeSet: Set<string>;
  /** The single Notable Folder whose Main Doc gets full-width cover
   *  treatment (only set in single-folder mode); null otherwise. */
  fullWidthRef: string | null;
  onNavigate: (ref: string) => void;
  onRemoveInclude: (ref: string) => void;
}) {
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  useGridLayout(gridEl);

  const vaultNotes: ListNoteRef[] = useMemo(
    () => data.notes.map((n) => ({
      filename: `${n.ref}.md`,
      frontmatter: n.frontmatter,
      body: n.body,
    })),
    [data.notes],
  );

  return (
    <div className="card-grid" ref={setGridEl}>
      {notes.map((n) => {
        const isMain = !!n.category;
        const areaRaw = n.frontmatter.area;
        const areaName = typeof areaRaw === "string"
          ? areaRaw.replace(/^\[\[|\]\]$/g, "").trim()
          : "";
        const colorSource = isMain ? n.ref : n.folder;
        const cardColor = colorSource ? folderColor(colorSource) : undefined;
        const fullWidth = isMain && n.ref === fullWidthRef;
        return (
          <div
            key={n.ref}
            className={"card-grid-cell" + (fullWidth ? " is-full-width" : "")}
            data-path={n.ref}
          >
            <Card
              path={`${n.ref}.md`}
              initialBody={n.body}
              initialFrontmatter={n.frontmatter}
              readOnly
              color={cardColor}
              area={isMain ? (areaName || undefined) : undefined}
              category={isMain ? (n.category ?? undefined) : undefined}
              currentFolder={isMain ? undefined : (n.folder ?? null)}
              isPublic={n.frontmatter.public === true}
              vaultNotes={vaultNotes}
              onNavigate={onNavigate}
              onAddFilter={onNavigate}
              onRemoveFromFilter={includeSet.has(n.ref)
                ? () => onRemoveInclude(n.ref)
                : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
