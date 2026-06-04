// Root of the read-only web viewer. It mirrors Order's desktop app
// 1:1 — same Stream, same filter-pill model, same Card component —
// just read-only. There is one screen (the Stream) plus the calendar
// views; filtering is managed exclusively through the left-rail pills,
// identical to CardGrid.

import { useEffect, useMemo, useState } from "react";
import { Files, FileText, Folder as FolderIcon, Moon, MoonStar, Sun, Monitor, Flag, TreePine, Rocket, Search as SearchIcon, ChevronsRight, PanelRight, Settings as SettingsIcon, ZoomIn, ZoomOut, Home as HomeIcon, Calendar as CalendarIcon, CalendarDays, CalendarRange, CalendarClock, X as XCircle, Check, FilterX } from "lucide-react";
import { useTheme, toggleTheme, nextTheme, themeLabel } from "../src/lib/theme";
import { useTextScale, stepTextScale, TEXT_SCALE_MIN, TEXT_SCALE_MAX, TEXT_SCALE_STEP } from "../src/lib/text-scale";
import type { PublishedSite, PublishedNote } from "../src/lib/publish";
import { Sidebar, type NotableFolder } from "../src/components/Sidebar";
import { CommandPalette } from "../src/components/CommandPalette";
import { Card } from "../src/components/Card";
import { CalendarView, type NoteMeta } from "../src/components/CalendarView";
import { YearLinearView } from "../src/components/YearLinearView";
import { FilterPillStack } from "../src/components/FilterPillStack";
import { NotebookSection, type SectionCell } from "../src/components/NotebookSection";
import { LazyCell } from "../src/components/LazyCell";
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
  const textScale = useTextScale();
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  // View picker — same shape as the desktop app's: two parallel
  // selections (View: stream/day/week/month/year, Show: all/notes/
  // folders). Home button menu picks between home folder filter and
  // clearing all filters.
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [homeMenuOpen, setHomeMenuOpen] = useState(false);

  // Outside-click closes each popup.
  useEffect(() => {
    if (!toolsMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-settings, .dock-tools-popup")) setToolsMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [toolsMenuOpen]);
  useEffect(() => {
    if (!viewMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-view, .dock-view-popup")) setViewMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [viewMenuOpen]);
  useEffect(() => {
    if (!homeMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".dock-btn-home, .dock-home-popup")) setHomeMenuOpen(false);
    }
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [homeMenuOpen]);

  // Initial filters: a `?f=` query wins (in-app/back-forward URL), else
  // an arrival deep-link, else the home Notable Folder as the default
  // include. (The desktop app starts with no filters at all, but on the
  // published page the home folder is the canonical "what this site is
  // about" view — first-time visitors should land there, not on a flat
  // recency timeline.)
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
  // Stream mode — three states the prominent rail FAB cycles through.
  // "folders" is the default for the published home so visitors land
  // on a Notable-Folder card grid first; "notes" hides NF cards;
  // "all" shows both. Persisted across visits (shared key with the
  // in-app vault).
  type StreamMode = "all" | "notes" | "folders";
  const [streamMode, setStreamMode] = useState<StreamMode>(() => {
    try {
      const v = localStorage.getItem("order.streamMode");
      if (v === "all" || v === "notes" || v === "folders") return v;
    } catch { /* non-fatal */ }
    // Published web viewer defaults to "notes" — a visitor lands on
    // the home folder's section and reads the actual writing; the
    // Notable Folder grid is one tap away via the sidebar.
    return "notes";
  });
  const setStreamModePersist = (m: StreamMode) => {
    setStreamMode(m);
    try { localStorage.setItem("order.streamMode", m); } catch { /* non-fatal */ }
  };

  // Recently-pinned Notable Folders, most-recent first. The command
  // palette uses this on an empty query so the search button doubles
  // as a back-history through the pile of folders you've visited.
  const RECENT_KEY = "order.recentFolders";
  const RECENT_MAX = 20;
  const [recentFolders, setRecentFolders] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX);
    } catch { return []; }
  });
  const markFolderRecent = (ref: string) => {
    if (!ref) return;
    setRecentFolders((prev) => {
      const next = [ref, ...prev.filter((r) => r !== ref)].slice(0, RECENT_MAX);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* non-fatal */ }
      return next;
    });
  };

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
  // Pile-based navigation: every nav surface (palette, sidebar tile,
  // wikilink, filter-pill jump) moves the targeted Notable Folder to
  // the FRONT of the include set instead of appending. Excludes and
  // other includes stay put — the just-touched section sits at
  // scrollY ~0, the prior pile sinks underneath. Re-targeting an NF
  // already in the set bubbles it back to the top.
  function pinToFront(ref: string) {
    const next: Filter[] = [
      { kind: "include", ref },
      ...filters.filter((f) => !(f.kind === "include" && f.ref === ref)),
    ];
    commitFilters(next);
    markFolderRecent(ref);
  }
  function addInclude(ref: string) {
    pinToFront(ref);
  }
  function removeFilter(target: Filter) {
    commitFilters(filters.filter((f) => !(f.kind === target.kind && f.ref === target.ref)));
  }
  function resetToDefault() {
    // Match the desktop app: clear all filters outright. (Previously the
    // viewer restored the home folder as the sole include; the app
    // dropped that behaviour after the no-default-folder change.)
    commitFilters([]);
    setCollapseNonce((n) => n + 1);
  }
  // Wikilink / list-row click → open the target's permalink (matches
  // arriving at /<slug>/ directly). The old "accumulate filter + scroll"
  // buried regular notes in an empty extra section and never updated the
  // URL. The Sidebar / Cmd+K palette still use addInclude / focusFolder
  // for the explicit "build up a multi-folder filter" workflow.
  function navigate(ref: string) {
    setView("stream");
    const note = data.notes.find((n) => n.ref === ref);
    if (note && note.slug) {
      // Pile-based navigation: move the target NF to the FRONT of
      // the include set, preserving other includes and excludes.
      const targetRef = note.category ? note.ref : (note.folder ?? note.ref);
      const next: Filter[] = [
        { kind: "include", ref: targetRef },
        ...filters.filter((f) => !(f.kind === "include" && f.ref === targetRef)),
      ];
      if (note.category) {
        setSingleNoteRef(null);
      } else {
        // Regular note: solo-note view inside the parent folder filter.
        setSingleNoteRef(ref);
      }
      setFilters(next);
      markFolderRecent(targetRef);
      if (typeof history !== "undefined") {
        history.pushState({}, "", `${basePath}${note.slug}/`);
      }
      return;
    }
    // Fall back: unresolved or unpublished — pin to front (additive).
    pinToFront(ref);
    setScrollTarget(ref);
  }
  // Command palette pick → like navigate, but also pins the folder's
  // Main Document so Cmd+K lands you ON that page.
  function focusFolder(ref: string) {
    setView("stream");
    pinToFront(ref);
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
        // No slug, no ?f= query: restore the home folder seed — the
        // viewer's "default" view (see the initial filters useState).
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
      // Stream mode: "notes" drops NF cards; "folders" drops ordinary
      // notes (keep only NF main docs, which carry a `category`); "all"
      // keeps both.
      if (streamMode === "notes" && !!n.category) return false;
      if (streamMode === "folders" && !n.category) return false;
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
    // Notable Folder Main Documents float to the top of the Stream
    // by default — they're the "covers" of each folder and read
    // like a table of contents for the recency feed below. The
    // pinned folder cover (single-folder mode) sits above them.
    return [...filtered].sort((a, b) => {
      const am = isPinned(a);
      const bm = isPinned(b);
      if (am !== bm) return am ? -1 : 1;
      const aNF = !!a.category;
      const bNF = !!b.category;
      if (aNF !== bNF) return aNF ? -1 : 1;
      if (aNF && bNF) return a.ref.localeCompare(b.ref);
      return dateKey(b).localeCompare(dateKey(a));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.notes, hidden, filters, focusedFolder, streamMode]);

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
  // Calendar event click — match the desktop app's openEventNote:
  //   switch to Stream, scroll to the card, leave filters as-is so
  //   the timeline stays intact (the visitor "hops within" the Stream
  //   instead of collapsing to a single-note view). Also push the
  //   note's slug to the URL so the address bar reflects the focused
  //   note and the link is shareable — without touching pill state,
  //   which would otherwise filter the Stream to just that ref.
  const onEventClick = (path: string) => {
    const ref = path.replace(/\.md$/i, "").replace(/^.*\//, "");
    setView("stream");
    setSingleNoteRef(null);
    setScrollTarget(ref);
    if (typeof history !== "undefined") {
      const slug = refToSlug.get(ref.toLowerCase());
      if (slug) history.pushState({}, "", `${basePath}${slug}/`);
    }
  };
  const noop = async () => { /* read-only */ };

  // Smooth-scroll + coral flash to the target card after a filter
  // change has rendered it. Matches the desktop app:
  // - requestAnimationFrame-polls for the cell to mount (the masonry
  //   layout effect needs a few frames after a filter change)
  // - block: "start" with shared .card-grid-cell scroll-margin-top
  //   in styles.css lands the card below the top rail
  // - re-toggle .is-target with a forced reflow so a re-jump replays
  //   the pulse animation.
  useEffect(() => {
    if (view !== "stream" || !scrollTarget) return;
    const target = scrollTarget.toLowerCase();
    let cancelled = false;
    let attempts = 0;
    function tryScroll() {
      if (cancelled) return;
      const cell = Array.from(document.querySelectorAll<HTMLElement>(".card-grid-cell"))
        .find((c) => (c.dataset.path ?? "").toLowerCase() === target);
      if (cell) {
        cell.scrollIntoView({ behavior: "smooth", block: "start" });
        cell.classList.remove("is-target");
        void cell.offsetWidth; // restart animation
        cell.classList.add("is-target");
        setTimeout(() => cell.classList.remove("is-target"), 1400);
        setScrollTarget(null);
        return;
      }
      attempts += 1;
      if (attempts < 30) requestAnimationFrame(tryScroll);
      else setScrollTarget(null);
    }
    const raf = requestAnimationFrame(tryScroll);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
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
      {/* Bottom dock — viewer doesn't have new-note or publish, so
          just stream-mode + search. */}
      <div className="bottom-dock" role="toolbar" aria-label="Main controls">
        <button
          type="button"
          className={`dock-btn dock-btn-view is-${view}` + (viewMenuOpen ? " is-open" : "")}
          onClick={() => { setHomeMenuOpen(false); setViewMenuOpen((o) => !o); }}
          title="Pick view"
          aria-label="Pick view"
          aria-haspopup="menu"
          aria-expanded={viewMenuOpen}
        >
          {(() => {
            if (view === "day") return <CalendarClock size={20} strokeWidth={2.1} />;
            if (view === "week") return <CalendarRange size={20} strokeWidth={2.1} />;
            if (view === "month") return <CalendarDays size={20} strokeWidth={2.1} />;
            if (view === "year") return <CalendarIcon size={20} strokeWidth={2.1} />;
            if (streamMode === "folders") return <FolderIcon size={22} strokeWidth={2.1} />;
            if (streamMode === "notes") return <FileText size={22} strokeWidth={2.1} />;
            return <Files size={22} strokeWidth={2.1} />;
          })()}
        </button>
        {(() => {
          const home = data.home?.name ?? null;
          const noFilters = filters.length === 0;
          const homeFiltered = !!home && includeSet.size === 1 && includeSet.has(home);
          const stateClass = noFilters
            ? " is-no-filters"
            : homeFiltered
              ? " is-at-home"
              : "";
          const icon = noFilters
            ? <FilterX size={20} strokeWidth={2.1} />
            : <HomeIcon size={20} strokeWidth={2.1} />;
          const tip = noFilters
            ? "No filters — pick a home view"
            : homeFiltered
              ? `At home — ${home}`
              : home
                ? `Home — ${home}`
                : "Home — clear filters";
          return (
            <button
              type="button"
              className={"dock-btn dock-btn-home" + stateClass + (homeMenuOpen ? " is-open" : "")}
              onClick={() => { setViewMenuOpen(false); setHomeMenuOpen((o) => !o); }}
              title={tip}
              aria-label="Home menu"
              aria-haspopup="menu"
              aria-expanded={homeMenuOpen}
            >
              {icon}
            </button>
          );
        })()}
        <button
          type="button"
          className="dock-btn dock-btn-search"
          onClick={() => setPaletteOpen(true)}
          title="Search"
          aria-label="Search"
        >
          <SearchIcon size={20} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          className={"dock-btn dock-btn-settings" + (toolsMenuOpen ? " is-open" : "")}
          onClick={() => setToolsMenuOpen((o) => !o)}
          title="Theme and zoom"
          aria-label="Settings"
        >
          <SettingsIcon size={20} strokeWidth={2.1} />
        </button>
        <button
          type="button"
          className="dock-btn dock-btn-sidebar"
          onClick={() => setSidebarOpen((o) => !o)}
          title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        >
          {sidebarOpen ? <ChevronsRight size={20} strokeWidth={2.1} /> : <PanelRight size={20} strokeWidth={2.1} />}
        </button>
      </div>

      {viewMenuOpen && (() => {
        const pickStream = (mode: StreamMode) => { setStreamModePersist(mode); };
        const pickView = (v: View) => { setView(v); };
        const opt = (
          active: boolean,
          icon: React.ReactNode,
          label: string,
          onClick: () => void,
        ) => (
          <button
            type="button"
            className={"dock-tools-item" + (active ? " is-on" : "")}
            onClick={onClick}
          >
            {icon}
            <span>{label}</span>
            {active && <Check size={12} strokeWidth={2.4} className="dock-tools-check" />}
          </button>
        );
        return (
          <div className="dock-tools-popup dock-view-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dock-tools-group-label">View</div>
            {opt(view === "stream", <Files size={14} strokeWidth={2.1} />, "Stream", () => pickView("stream"))}
            {opt(view === "day", <CalendarClock size={14} strokeWidth={2.1} />, "Day", () => pickView("day"))}
            {opt(view === "week", <CalendarRange size={14} strokeWidth={2.1} />, "Week", () => pickView("week"))}
            {opt(view === "month", <CalendarDays size={14} strokeWidth={2.1} />, "Month", () => pickView("month"))}
            {opt(view === "year", <CalendarIcon size={14} strokeWidth={2.1} />, "Year", () => pickView("year"))}
            <div className="dock-tools-group-label">Show</div>
            {opt(streamMode === "all", <Files size={14} strokeWidth={2.1} />, "All notes + folders", () => pickStream("all"))}
            {opt(streamMode === "notes", <FileText size={14} strokeWidth={2.1} />, "Notes only", () => pickStream("notes"))}
            {opt(streamMode === "folders", <FolderIcon size={14} strokeWidth={2.1} />, "Notable folders only", () => pickStream("folders"))}
          </div>
        );
      })()}

      {homeMenuOpen && (() => {
        const home = data.home?.name ?? null;
        const goHome = () => {
          setHomeMenuOpen(false);
          if (home) {
            commitFilters([{ kind: "include", ref: home }]);
            navigate(home);
          }
        };
        const clearAll = () => {
          setHomeMenuOpen(false);
          resetToDefault();
        };
        return (
          <div className="dock-tools-popup dock-home-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className="dock-tools-item" onClick={goHome}>
              <HomeIcon size={14} strokeWidth={2.1} />
              <span>{home ? `Home — ${home}` : "Home page"}</span>
            </button>
            <button type="button" className="dock-tools-item" onClick={clearAll}>
              <XCircle size={14} strokeWidth={2.1} />
              <span>Clear all filters</span>
            </button>
          </div>
        );
      })()}

      {/* Tools popup — viewer version has only theme + zoom (no
          publish, no vault settings). Same anchor pattern as the app. */}
      {toolsMenuOpen && (
        <div className="dock-tools-popup" role="menu" onMouseDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="dock-tools-item"
            onClick={() => { toggleTheme(); }}
            title={`Theme: ${themeLabel(theme)} — click for ${themeLabel(nextTheme(theme))}`}
          >
            {(() => {
              const Icon = { light: Sun, dark: Moon, black: MoonStar, wordperfect: Monitor, america: Flag, christmas: TreePine, lcars: Rocket }[theme];
              return <Icon size={14} strokeWidth={2.1} />;
            })()}
            <span>Theme — {themeLabel(theme)}</span>
          </button>
          <div className="dock-tools-zoom">
            <button
              type="button"
              className="dock-tools-zoom-btn"
              onClick={() => stepTextScale(-TEXT_SCALE_STEP)}
              disabled={textScale <= TEXT_SCALE_MIN}
              aria-label="Smaller text"
            >
              <ZoomOut size={14} strokeWidth={2.1} />
            </button>
            <span className="dock-tools-zoom-label">{Math.round(textScale * 100)}%</span>
            <button
              type="button"
              className="dock-tools-zoom-btn"
              onClick={() => stepTextScale(TEXT_SCALE_STEP)}
              disabled={textScale >= TEXT_SCALE_MAX}
              aria-label="Larger text"
            >
              <ZoomIn size={14} strokeWidth={2.1} />
            </button>
          </div>
        </div>
      )}

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
          filteredRefs={includeSet}
          onToggleAreaFilter={(name) => {
            if (includeSet.has(name)) removeFilter({ kind: "include", ref: name });
            else addInclude(name);
          }}
          onToggleCategoryFilter={(name) => {
            if (includeSet.has(name)) removeFilter({ kind: "include", ref: name });
            else addInclude(name);
          }}
          filters={(
            <FilterPillStack
              filters={filters}
              onRemove={removeFilter}
              onClear={resetToDefault}
              onJump={(ref) => {
                setView("stream");
                pinToFront(ref);
                setFocusedFolder(ref);
                setScrollTarget(ref);
              }}
            />
          )}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          folders={notableFolders}
          selected={includeSet}
          onToggle={focusFolder}
          onClose={() => setPaletteOpen(false)}
          recents={recentFolders}
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
    () => data.notes.map((n) => {
      const dir = n.dir ?? "";
      const folder = dir.split("/").pop() ?? "";
      return {
        filename: `${n.ref}.md`,
        frontmatter: n.frontmatter,
        body: n.body,
        dir,
        folder,
        mtime: n.mtime,
        ctime: n.ctime,
      };
    }),
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

  // Flat temporal grid (no Notable Folder filtered in). With no
  // pagination on the published page, this would otherwise mount one
  // Milkdown Crepe instance per published note up front; LazyCell
  // defers each Card until its grid cell is within scroll reach.
  return (
    <div className="card-grid" ref={setGridEl}>
      {notes.map((n) => (
        <LazyCell key={n.ref} className="card-grid-cell" dataPath={n.ref}>
          {() => cardNode(n)}
        </LazyCell>
      ))}
    </div>
  );
}
