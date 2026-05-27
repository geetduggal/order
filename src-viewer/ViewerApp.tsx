// Root of the read-only web viewer. It mirrors Order's desktop app
// 1:1 — same Stream, same filter-pill model, same Card component —
// just read-only. There is one screen (the Stream) plus the calendar
// views; filtering is managed exclusively through the left-rail pills,
// identical to CardGrid.

import { useEffect, useMemo, useState } from "react";
import { Files, FileText, Moon, MoonStar, Sun, Monitor, Flag, TreePine, Rocket } from "lucide-react";
import { useTheme, toggleTheme, nextTheme, themeLabel } from "../src/lib/theme";
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

type View = "stream" | "day" | "week" | "month" | "year";

export function ViewerApp(
  { data, initialSlug, basePath = "/" }:
  { data: PublishedSite; initialSlug?: string | null; basePath?: string },
) {
  // ref → slug, so the active filter set can be encoded in the URL with
  // clean slugs (slug → ref via data.slugMap on the way back).
  const refToSlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const [slug, ref] of Object.entries(data.slugMap)) m.set(ref.toLowerCase(), slug);
    return m;
  }, [data.slugMap]);

  // Encode the pill set as `?f=<inc-slugs>&x=<exc-slugs>` (slugs, falling
  // back to the raw ref). Empty → just the base path.
  const filtersToUrl = (fs: Filter[]): string => {
    const incs = fs.filter((f) => f.kind === "include");
    const excs = fs.filter((f) => f.kind === "exclude");
    // A single folder/note with no excludes is a real prerendered page —
    // emit its crawlable `/slug/` permalink rather than a `?f=` query the
    // static host ignores (and serves the home page to crawlers for).
    // `?f=` is only for genuine multi-pill views, which aren't one page.
    if (incs.length === 1 && excs.length === 0) {
      const slug = refToSlug.get(incs[0].ref.toLowerCase());
      if (slug) return `${basePath}${slug}/`;
    }
    const enc = (list: Filter[]) =>
      list
        .map((f) => refToSlug.get(f.ref.toLowerCase()) ?? f.ref)
        .map(encodeURIComponent)
        .join(",");
    const inc = enc(incs);
    const exc = enc(excs);
    const qs = [inc && `f=${inc}`, exc && `x=${exc}`].filter(Boolean).join("&");
    return qs ? `${basePath}?${qs}` : basePath;
  };

  // Parse `?f=…&x=…` back into pills (slug → ref). Unknown slugs are
  // passed through as raw refs so hand-typed names still resolve.
  const filtersFromSearch = (search: string): Filter[] => {
    const p = new URLSearchParams(search);
    const dec = (key: string, kind: "include" | "exclude"): Filter[] =>
      (p.get(key) || "")
        .split(",")
        .map((s) => decodeURIComponent(s.trim()))
        .filter(Boolean)
        .map((s) => ({ kind, ref: data.slugMap[s] ?? s }));
    return [...dec("f", "include"), ...dec("x", "exclude")];
  };

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

  // Initial filters: a `?f=` query wins (in-app/back-forward URL), else
  // the arrival deep-link, else the home default.
  const fromSearch = typeof location !== "undefined" ? filtersFromSearch(location.search) : [];

  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar hidden by default — viewers shouldn't get a wall of UI on
  // first paint. Toggle via the › / ‹ button or Cmd+;.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("stream");
  // Bumped by resetToDefault to collapse Show-more expansions.
  const [collapseNonce, setCollapseNonce] = useState(0);
  // Light/dark theme — rail moon/sun button toggles it.
  const theme = useTheme();

  // Default view = the home Notable Folder focused (single include),
  // exactly like the desktop app's first-launch default. A deep-link
  // (permalink page) overrides it.
  const [filters, setFilters] = useState<Filter[]>(
    () => fromSearch.length > 0
      ? fromSearch
      : deeplink
        ? [{ kind: "include", ref: deeplink.include }]
        : (data.home.name ? [{ kind: "include", ref: data.home.name }] : []),
  );
  // Single-note permalink mode: a note's permalink renders only that note.
  // Set on arrival (a note page, with no ?f= override); cleared on any
  // filter change so exploring (folder chip, links, pills) returns to the
  // normal stream.
  const [singleNoteRef, setSingleNoteRef] = useState<string | null>(
    deeplink && deeplink.scroll && fromSearch.length === 0 ? deeplink.scroll : null,
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
  // "Notes only" toggle: hide Notable-Folder cards, show ordinary notes
  // only. Persisted across visits (shared key with the app).
  const [notesOnly, setNotesOnly] = useState<boolean>(() => {
    try { return localStorage.getItem("order.notesOnly") === "1"; } catch { return false; }
  });

  const includeSet = useMemo(
    () => new Set(filters.filter((f) => f.kind === "include").map((f) => f.ref)),
    [filters],
  );

  // Apply a new pill set AND mirror it into the URL (pushState), so the
  // address bar always matches the pills and is shareable / back-able.
  // Pills still ACCUMULATE — this only adds URL sync, it never replaces.
  function commitFilters(next: Filter[]) {
    setSingleNoteRef(null); // any filter change leaves single-note mode
    setFilters(next);
    if (typeof history !== "undefined") history.pushState({}, "", filtersToUrl(next));
  }
  function addInclude(ref: string) {
    if (filters.some((f) => f.kind === "include" && f.ref === ref)) return;
    commitFilters([...filters, { kind: "include", ref }]);
  }
  function removeFilter(target: Filter) {
    commitFilters(filters.filter((f) => !(f.kind === target.kind && f.ref === target.ref)));
  }
  function resetToDefault() {
    commitFilters(data.home.name ? [{ kind: "include", ref: data.home.name }] : []);
    setCollapseNonce((n) => n + 1);
  }
  // Wikilink / list-row click → accumulate an include + scroll to it.
  function navigate(ref: string) {
    setView("stream");
    if (!filters.some((f) => f.kind === "include" && f.ref === ref)) {
      commitFilters([...filters, { kind: "include", ref }]);
    }
    setScrollTarget(ref);
  }
  // Command palette pick → like navigate, but also pins the folder's
  // Main Document so Cmd+K lands you ON that page.
  function focusFolder(ref: string) {
    setView("stream");
    if (!filters.some((f) => f.kind === "include" && f.ref === ref)) {
      commitFilters([...filters, { kind: "include", ref }]);
    }
    setFocusedFolder(ref);
    setScrollTarget(ref);
  }

  // Back/forward: restore the pill set from the URL (no new history
  // entry). A `?f=` query is authoritative; otherwise fall back to a
  // `/slug/` path or the home default.
  useEffect(() => {
    function onPop() {
      const next = filtersFromSearch(location.search);
      if (next.length > 0) { setSingleNoteRef(null); setFilters(next); return; }
      const rest = location.pathname.startsWith(basePath)
        ? location.pathname.slice(basePath.length)
        : location.pathname.replace(/^\//, "");
      const slug = rest.replace(/\/+$/, "");
      const ref = slug ? data.slugMap[slug] : null;
      if (ref) {
        const note = data.notes.find((n) => n.ref === ref);
        const isNotePage = !!note && !note.category;
        setSingleNoteRef(isNotePage ? ref : null);
        const inc = isNotePage && note!.folder ? note!.folder : ref;
        setFilters([{ kind: "include", ref: inc }]);
      } else {
        setSingleNoteRef(null);
        setFilters(data.home.name ? [{ kind: "include", ref: data.home.name }] : []);
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // "Notes only": drop Notable-Folder cards (those carry a category).
      if (notesOnly && !!n.category) return false;
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
  }, [data.notes, hidden, filters, focusedFolder, notesOnly]);

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
        className={"notes-only-fab" + (notesOnly ? " is-on" : "")}
        onClick={() => setNotesOnly((v) => {
          const next = !v;
          try { localStorage.setItem("order.notesOnly", next ? "1" : "0"); } catch { /* non-fatal */ }
          return next;
        })}
        title={notesOnly ? "Notes only — click to include notable folders" : "Notes + notable folders — click for notes only"}
        aria-label={notesOnly ? "Showing notes only" : "Showing notes and notable folders"}
        aria-pressed={notesOnly}
      >
        {notesOnly
          ? <FileText size={14} strokeWidth={2.1} />
          : <Files size={14} strokeWidth={2.1} />}
      </button>

      <FilterPillStack
        filters={filters}
        onRemove={removeFilter}
        onClear={resetToDefault}
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

      <button
        type="button"
        className="theme-fab"
        onClick={() => toggleTheme()}
        title={`Theme: ${themeLabel(theme)} — next: ${themeLabel(nextTheme(theme))}`}
        aria-label={`Theme ${themeLabel(theme)}, switch to ${themeLabel(nextTheme(theme))}`}
      >
        {(() => {
          const Icon = { light: Sun, dark: Moon, black: MoonStar, wordperfect: Monitor, america: Flag, christmas: TreePine, lcars: Rocket }[theme];
          return <Icon size={14} strokeWidth={2.1} />;
        })()}
      </button>

      <main className="pane-main">
        {view === "stream" && (
          <StreamView
            notes={visible}
            data={data}
            basePath={basePath}
            includeRefs={includeRefs}
            includeSet={includeSet}
            collapseSignal={collapseNonce}
            onNavigate={navigate}
            onRemoveInclude={(ref) => removeFilter({ kind: "include", ref })}
            soloRef={singleNoteRef}
          />
        )}
        {view === "day" && (
          <CalendarView key="day" notes={calendarNotes} initialView="timeGridDay"
            onMoveEvent={noop} onEventClick={onEventClick} onCreate={noop} />
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
          storedAreas={storedAreas}
          storedCategories={storedCategories}
          order={data.taxonomy.areas}
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
  notes, data, basePath, includeRefs, includeSet, collapseSignal, onNavigate, onRemoveInclude, soloRef,
}: {
  notes: PublishedNote[];
  data: PublishedSite;
  basePath: string;
  /** Active include filters in order. ≥1 → newspaper sections;
   *  0 → flat temporal grid. */
  includeRefs: string[];
  includeSet: Set<string>;
  collapseSignal: number;
  onNavigate: (ref: string) => void;
  onRemoveInclude: (ref: string) => void;
  /** When set, render ONLY this note (a single-note permalink). */
  soloRef?: string | null;
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
    // Full public permalink (origin is the published domain at runtime).
    const permalink = n.slug ? `${location.origin}${basePath}${n.slug}/` : undefined;
    return (
      <Card
        path={`${n.ref}.md`}
        initialBody={n.body}
        initialFrontmatter={n.frontmatter}
        readOnly
        permalink={permalink}
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

  // Single-note permalink: render only that note (a note's permalink
  // shows the note itself and nothing else), full-width and uncapped.
  if (soloRef) {
    const solo = data.notes.find((n) => n.ref === soloRef);
    if (solo) {
      return (
        <div className="nf-sections solo-note">
          <div className="card-grid">
            <div className="card-grid-cell is-full-width" data-path={solo.ref}>
              {cardNode(solo)}
            </div>
          </div>
        </div>
      );
    }
  }

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
