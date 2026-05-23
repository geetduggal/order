// Root of the read-only web viewer. It mirrors Order's desktop app
// 1:1 — same Stream, same filter-pill model, same Card component —
// just read-only. There is one screen (the Stream) plus the calendar
// views; filtering is managed exclusively through the left-rail pills,
// identical to CardGrid.

import { useEffect, useMemo, useState } from "react";
import { ChevronsDown, ChevronsUp } from "lucide-react";
import type { PublishedSite, PublishedNote } from "../src/lib/publish";
import { Sidebar, type NotableFolder } from "../src/components/Sidebar";
import { CommandPalette } from "../src/components/CommandPalette";
import { Card } from "../src/components/Card";
import { CalendarView, type NoteMeta } from "../src/components/CalendarView";
import { YearLinearView } from "../src/components/YearLinearView";
import { FilterPillStack } from "../src/components/FilterPillStack";
import { NotebookSection, type SectionCell } from "../src/components/NotebookSection";
import type { Filter } from "../src/lib/filters";
import type { ListNoteRef } from "../src/lib/list-folder";
import { useGridLayout } from "../src/lib/grid-layout";
import { folderColor } from "../src/lib/folders";

type View = "stream" | "week" | "month" | "year";

export function ViewerApp({ data, initialSlug }: { data: PublishedSite; initialSlug?: string | null }) {
  // Deep-link from the permalink the page was served at. A folder slug
  // filters to that folder; a note slug filters to the note's folder and
  // scrolls to the note. Falls back to the home default.
  const deeplink = (() => {
    const ref = initialSlug ? data.slugMap[initialSlug] : undefined;
    if (!ref) return null;
    const note = data.notes.find((n) => n.ref === ref);
    if (!note) return null;
    if (note.category) return { include: note.ref, scroll: null as string | null }; // folder page
    return { include: note.folder ?? note.ref, scroll: note.ref };                   // note page
  })();

  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar hidden by default — viewers shouldn't get a wall of UI on
  // first paint. Toggle via the › / ‹ button or Cmd+;.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("stream");
  // Bumped by resetToDefault to collapse Show-more expansions.
  const [collapseNonce, setCollapseNonce] = useState(0);

  // Default view = the home Notable Folder focused (single include),
  // exactly like the desktop app's first-launch default. A deep-link
  // (permalink page) overrides it.
  const [filters, setFilters] = useState<Filter[]>(
    () => deeplink
      ? [{ kind: "include", ref: deeplink.include }]
      : (data.home.name ? [{ kind: "include", ref: data.home.name }] : []),
  );
  // The folder whose Main Document is pinned to the top of the Stream.
  // Set by clicking a pill or picking one in the palette. Cleared only
  // when it's no longer an active include, so adding it doesn't wipe
  // the focus we just set.
  const [focusedFolder, setFocusedFolder] = useState<string | null>(null);
  useEffect(() => {
    setFocusedFolder((cur) =>
      cur && filters.some((f) => f.kind === "include" && f.ref === cur) ? cur : null,
    );
  }, [filters]);
  // Ref of the card to smooth-scroll to (+ coral flash). Cleared once
  // the scroll fires. Seeded from a note-page deep-link.
  const [scrollTarget, setScrollTarget] = useState<string | null>(deeplink?.scroll ?? null);
  // Ref of the card the "jump to first note" toggle points at — its
  // border stays coral while jumped. Any filter change exits the state.
  const [coralRef, setCoralRef] = useState<string | null>(null);
  useEffect(() => { setCoralRef(null); }, [filters]);

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
    setCollapseNonce((n) => n + 1);
  }
  // Wikilink / list-row click → add an include + scroll to it.
  function navigate(ref: string) {
    setView("stream");
    addInclude(ref);
    setScrollTarget(ref);
  }
  // Command palette pick → like navigate, but also pins the folder's
  // Main Document so Cmd+K lands you ON that page.
  function focusFolder(ref: string) {
    setView("stream");
    addInclude(ref);
    setFocusedFolder(ref);
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
    // "cover"); any other state is a flat recency timeline keyed off
    // date + startTime frontmatter.
    const dateKey = (n: PublishedNote) => {
      const d = typeof n.frontmatter.date === "string" ? n.frontmatter.date : "0000-00-00";
      const t = typeof n.frontmatter.startTime === "string" ? n.frontmatter.startTime : "00:00";
      return `${d} ${t}`;
    };
    const isPinned = (n: PublishedNote) => !!n.category && pinnedRef !== null && n.ref === pinnedRef;
    return [...filtered].sort((a, b) => {
      const am = isPinned(a);
      const bm = isPinned(b);
      if (am !== bm) return am ? -1 : 1;
      return dateKey(b).localeCompare(dateKey(a));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.notes, hidden, filters, focusedFolder]);

  // "Jump to first note" toggle: scroll between the folder cover (its
  // Main Doc) and its first ordinary entry, marking that entry coral.
  const firstEntry = visible.find((n) => !n.category) ?? null;
  const folderTop = visible.find((n) => !!n.category) ?? null;
  function toggleFirstEntry() {
    if (coralRef) {
      if (folderTop) setScrollTarget(folderTop.ref);
      setCoralRef(null);
      return;
    }
    if (!firstEntry) return;
    setScrollTarget(firstEntry.ref);
    setCoralRef(firstEntry.ref);
  }

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

  // Persistent coral border on the card the "jump to first note" toggle
  // points at (works in both the newspaper and flat-grid renders).
  useEffect(() => {
    document.querySelectorAll(".card-grid-cell.is-coral-pinned")
      .forEach((el) => el.classList.remove("is-coral-pinned"));
    if (!coralRef) return;
    const target = coralRef.toLowerCase();
    Array.from(document.querySelectorAll<HTMLElement>(".card-grid-cell"))
      .find((c) => (c.dataset.path ?? "").toLowerCase() === target)
      ?.classList.add("is-coral-pinned");
  }, [coralRef, view, filters]);

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
    <div className={"shell viewer-shell" + (sidebarOpen ? " sidebar-open" : " sidebar-closed")}>
      <button
        type="button"
        className={"first-note-fab" + (coralRef ? " is-on" : "")}
        onClick={toggleFirstEntry}
        disabled={!coralRef && !firstEntry}
        title={coralRef ? "Back to folder" : "Jump to first note"}
        aria-label={coralRef ? "Back to folder" : "Jump to first note"}
        aria-pressed={!!coralRef}
      >
        {coralRef
          ? <ChevronsUp size={14} strokeWidth={2.1} />
          : <ChevronsDown size={14} strokeWidth={2.1} />}
      </button>

      <FilterPillStack
        filters={filters}
        onRemove={removeFilter}
        onSearch={() => setPaletteOpen(true)}
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
            includeRefs={includeRefs}
            includeSet={includeSet}
            collapseSignal={collapseNonce}
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
          onToggle={focusFolder}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- Stream view ----------

const MAIN_CAP = 1400;
const NOTE_CAP = 440;

function StreamView({
  notes, data, includeRefs, includeSet, collapseSignal, onNavigate, onRemoveInclude,
}: {
  notes: PublishedNote[];
  data: PublishedSite;
  /** Active include filters in order. ≥1 → newspaper sections;
   *  0 → flat temporal grid. */
  includeRefs: string[];
  includeSet: Set<string>;
  collapseSignal: number;
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

  const cardNode = (n: PublishedNote, capHeight?: number) => {
    const isMain = !!n.category;
    const areaRaw = n.frontmatter.area;
    const areaName = typeof areaRaw === "string"
      ? areaRaw.replace(/^\[\[|\]\]$/g, "").trim()
      : "";
    const colorSource = isMain ? n.ref : n.folder;
    const cardColor = colorSource ? folderColor(colorSource) : undefined;
    return (
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
        onRemoveFromFilter={includeSet.has(n.ref) ? () => onRemoveInclude(n.ref) : undefined}
        capHeight={capHeight}
      />
    );
  };

  // Newspaper mode: one section per included Notable Folder. A single
  // section (home page / one folder) shows its Main Doc uncapped;
  // multiple stacked sections cap each Main Doc for even weight.
  const mainCap = includeRefs.length > 1 ? MAIN_CAP : undefined;
  if (includeRefs.length >= 1) {
    return (
      <div className="nf-sections">
        {includeRefs.map((ref) => {
          const mainNote = notes.find((n) => !!n.category && n.ref === ref);
          const sectionNotes = notes.filter((n) => !n.category && n.folder === ref);
          const centerpiece: SectionCell | null = mainNote
            ? { key: mainNote.ref, dataPath: mainNote.ref, node: cardNode(mainNote, mainCap) }
            : null;
          const noteCells: SectionCell[] = sectionNotes.map((n) => ({
            key: n.ref, dataPath: n.ref, node: cardNode(n, NOTE_CAP),
          }));
          return (
            <NotebookSection
              key={ref}
              sectionRef={ref}
              centerpiece={centerpiece}
              notes={noteCells}
              collapseSignal={collapseSignal}
            />
          );
        })}
      </div>
    );
  }

  // Flat temporal grid (no Notable Folder filtered in).
  return (
    <div className="card-grid" ref={setGridEl}>
      {notes.map((n) => (
        <div key={n.ref} className="card-grid-cell" data-path={n.ref}>
          {cardNode(n)}
        </div>
      ))}
    </div>
  );
}
