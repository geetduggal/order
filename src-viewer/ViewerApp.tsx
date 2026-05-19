// Root of the read-only viewer. Hash routes:
//
//   #/                        → Stream (default)
//   #/stream?folders=A,B,C    → Stream filtered to folder refs
//   #/note/<ref>              → single note view
//   #/folder/<ref>            → single Notable Folder view
//
// Reuses Order's Sidebar + ListView + CommandPalette as-is. Their
// add/remove/edit handlers are wired to no-ops so the UI never tries
// to mutate disk (there's no disk here).

import { useEffect, useMemo, useState } from "react";
import type { PublishedSite, PublishedNote } from "../src/lib/publish";
import { Sidebar, type NotableFolder } from "../src/components/Sidebar";
import { CommandPalette } from "../src/components/CommandPalette";
import { Card } from "../src/components/Card";
import { CalendarView, type NoteMeta } from "../src/components/CalendarView";
import { YearLinearView } from "../src/components/YearLinearView";
import type { ListNoteRef } from "../src/lib/list-folder";
import { useGridLayout } from "../src/lib/grid-layout";
import { folderColor } from "../src/lib/folders";
import { Home as HouseIcon, ChevronsDown, ChevronsUp } from "lucide-react";

// The viewer has one view — the stream — same as Order's app. Old
// `#/note/<ref>` and `#/folder/<ref>` URLs collapse into a stream
// filtered to that ref so external links keep working.
type Route = { kind: "stream"; filters: string[] };

function parseHash(h: string): Route {
  if (h.startsWith("#/note/")) {
    return { kind: "stream", filters: [decodeURIComponent(h.slice("#/note/".length))] };
  }
  if (h.startsWith("#/folder/")) {
    return { kind: "stream", filters: [decodeURIComponent(h.slice("#/folder/".length))] };
  }
  if (h.startsWith("#/stream")) {
    const q = h.split("?")[1] ?? "";
    const params = new URLSearchParams(q);
    const folders = (params.get("folders") ?? "").split(",").filter(Boolean);
    return { kind: "stream", filters: folders };
  }
  return { kind: "stream", filters: [] };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash || "#/"));
  useEffect(() => {
    function onHash() { setRoute(parseHash(window.location.hash || "#/")); }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

type View = "stream" | "week" | "month" | "year";

export function ViewerApp({ data }: { data: PublishedSite }) {
  const route = useHashRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Sidebar hidden by default on the published page — viewers
  // shouldn't have a wall of UI on first paint. Toggle via the
  // top-right › / ‹ button or Cmd+;.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [view, setView] = useState<View>("stream");
  const [jumpedDown, setJumpedDown] = useState(false);

  // index by ref for fast lookup
  const byRef = useMemo(() => {
    const m = new Map<string, PublishedNote>();
    for (const n of data.notes) m.set(n.ref.toLowerCase(), n);
    return m;
  }, [data.notes]);

  // Category → Area from the published chain. Lets us fill in each
  // Notable Folder's area without requiring each note's YAML to
  // repeat it (same trick Order's CardGrid uses).
  const areaByCategory = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data.taxonomy.areas) {
      for (const c of a.categories) m.set(c.ref, a.ref);
    }
    return m;
  }, [data.taxonomy]);

  // Build NotableFolder[] for Sidebar from notes with category set.
  // Area is inferred from the chain so Sidebar's grouping populates.
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

  // Build the chain-derived stored taxonomy Sidebar expects.
  const storedAreas = data.taxonomy.areas.map((a) => a.ref);
  const storedCategories = data.taxonomy.areas.flatMap((a) =>
    a.categories.map((c) => ({ area: a.ref, name: c.ref })),
  );

  // Folder filter from the URL → Sidebar's `selected` Set. Toggling
  // updates the URL.
  const selectedSet = useMemo(() => new Set(route.filters), [route]);

  function toggleFolder(name: string) {
    const current = route.filters;
    const next = current.includes(name)
      ? current.filter((x) => x !== name)
      : [...current, name];
    window.location.hash = next.length
      ? `#/stream?folders=${next.map(encodeURIComponent).join(",")}`
      : "#/";
  }
  function clearFolders() { window.location.hash = "#/"; }
  function navigate(ref: string) {
    // Wikilink click → filter the stream to that ref. Mirrors
    // Order's `navigateToRef` behaviour exactly.
    window.location.hash = `#/stream?folders=${encodeURIComponent(ref)}`;
  }

  // Calendar event projection mirrors Order's CardGrid: every note
  // with a date becomes an event, color comes from its folder.
  const filterSet = useMemo(
    () => new Set(
      (route.filters.length === 0 ? [data.home.name] : route.filters).map((f) => f.toLowerCase()),
    ),
    [route.filters, data.home.name],
  );
  const calendarNotes: NoteMeta[] = useMemo(() => {
    const hidden = new Set(data.hiddenRefs.map((r) => r.toLowerCase()));
    return data.notes
      .filter((n) => {
        if (hidden.has(n.ref.toLowerCase())) return false;
        if (filterSet.has(n.ref.toLowerCase())) return true;
        if (n.folder && filterSet.has(n.folder.toLowerCase())) return true;
        return false;
      })
      .map((n) => ({
        path: `${n.ref}.md`,
        filename: `${n.ref}.md`,
        title: n.title,
        frontmatter: n.frontmatter,
        color: n.folder ? folderColor(n.folder) : (n.category ? folderColor(n.ref) : undefined),
      }));
  }, [data.notes, data.hiddenRefs, filterSet]);

  // Clicking a calendar event → switch to stream + filter to that
  // note's ref. Read-only, so no event-drag / event-create handlers.
  const onEventClick = (path: string) => {
    const ref = path.replace(/\.md$/i, "").replace(/^.*\//, "");
    setView("stream");
    navigate(ref);
  };
  const noopMove = async () => { /* read-only */ };
  const noopCreate = async () => { /* read-only */ };

  function jumpToNotes() {
    if (jumpedDown) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      setJumpedDown(false);
      return;
    }
    const grid = document.querySelector(".card-grid");
    const cell = grid?.querySelector<HTMLElement>(".card-grid-cell:not(.is-full-width)");
    if (cell) {
      cell.scrollIntoView({ behavior: "smooth", block: "start" });
      setJumpedDown(true);
    }
  }
  function resetToHome() {
    window.location.hash = "#/";
    setJumpedDown(false);
  }

  // Cmd+K opens the palette (mirroring Order). Esc closes it.
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
        onClick={resetToHome}
        title="Reset filter to home"
        aria-label="Reset filter to home"
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
            data={data}
            byRef={byRef}
            filters={route.filters.length === 0 ? [data.home.name] : route.filters}
            onNavigate={navigate}
            onRemoveFromFilter={toggleFolder}
          />
        )}
        {view === "week" && (
          <CalendarView
            key="week"
            notes={calendarNotes}
            initialView="timeGridWeek"
            onMoveEvent={noopMove}
            onEventClick={onEventClick}
            onCreate={noopCreate}
          />
        )}
        {view === "month" && (
          <CalendarView
            key="month"
            notes={calendarNotes}
            initialView="dayGridMonth"
            onMoveEvent={noopMove}
            onEventClick={onEventClick}
            onCreate={noopCreate}
          />
        )}
        {view === "year" && (
          <YearLinearView
            key="year"
            notes={calendarNotes}
            onMoveEvent={noopMove}
            onEventClick={onEventClick}
            onCreate={noopCreate}
          />
        )}
      </main>

      {sidebarOpen && (
        <Sidebar
          view={view}
          onSelectView={setView}
          folders={notableFolders}
          selected={selectedSet}
          onToggle={toggleFolder}
          onClear={clearFolders}
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
          selected={selectedSet}
          onToggle={(name) => { toggleFolder(name); }}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}

// ---------- Stream view ----------

function StreamView({
  data, byRef, filters, onNavigate, onRemoveFromFilter,
}: {
  data: PublishedSite;
  byRef: Map<string, PublishedNote>;
  filters: string[];
  onNavigate: (ref: string) => void;
  /** Drop a ref from the current filter set. Each card with its
   *  ref in the active filter shows the same top-right × the app
   *  card shows. */
  onRemoveFromFilter: (ref: string) => void;
}) {
  // Callback-ref state so useGridLayout fires once the .card-grid
  // div is actually in the DOM (a plain useRef is stable and the
  // effect would never re-run).
  const [gridEl, setGridEl] = useState<HTMLDivElement | null>(null);
  useGridLayout(gridEl);
  const hidden = useMemo(() => new Set(data.hiddenRefs.map((r) => r.toLowerCase())), [data.hiddenRefs]);
  const filterSet = useMemo(() => new Set(filters.map((f) => f.toLowerCase())), [filters]);

  // Shared vault index for `<ListView>` so wikilink bullets resolve
  // and list-of-lists expansion can find sub-lists by name.
  const vaultNotes: ListNoteRef[] = useMemo(
    () => data.notes.map((n) => ({
      filename: `${n.ref}.md`,
      frontmatter: n.frontmatter,
      body: n.body,
    })),
    [data.notes],
  );

  // Apply the filter, hide intermediate list files, and sort like
  // Order's stream: NF Main Documents pinned at the top, regular
  // notes by date (desc).
  const sorted = useMemo(() => {
    const filtered = data.notes.filter((n) => {
      if (hidden.has(n.ref.toLowerCase())) return false;
      if (filterSet.size === 0) return true;
      if (filterSet.has(n.ref.toLowerCase())) return true;
      if (n.folder && filterSet.has(n.folder.toLowerCase())) return true;
      return false;
    });
    const dateKey = (n: PublishedNote) => {
      const d = typeof n.frontmatter.date === "string" ? n.frontmatter.date : "0000-00-00";
      const t = typeof n.frontmatter.startTime === "string" ? n.frontmatter.startTime : "00:00";
      return `${d} ${t}`;
    };
    return [
      ...filtered.filter((n) => !!n.category),
      ...filtered
        .filter((n) => !n.category)
        .sort((a, b) => dateKey(b).localeCompare(dateKey(a))),
    ];
  }, [data.notes, hidden, filterSet]);

  // The viewer reuses Order's actual `<Card>` component. We hand
  // each note's body + frontmatter in as props so Card skips the
  // Tauri disk read entirely, and pass `readOnly` so Milkdown comes
  // up read-only and the edit/save/delete plumbing short-circuits.
  return (
    <div className="card-grid" ref={setGridEl}>
      {sorted.map((n) => {
        const isMain = !!n.category;
        const areaRaw = n.frontmatter.area;
        const areaName = typeof areaRaw === "string"
          ? areaRaw.replace(/^\[\[|\]\]$/g, "").trim()
          : "";
        const colorSource = isMain ? n.ref : n.folder;
        const cardColor = colorSource ? folderColor(colorSource) : undefined;
        return (
          <div
            key={n.ref}
            className={"card-grid-cell" + (isMain ? " is-full-width" : "")}
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
              onRemoveFromFilter={filterSet.has(n.ref.toLowerCase())
                ? () => onRemoveFromFilter(n.ref)
                : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

// Single-note / single-folder routes used to render bespoke views.
// Those are gone — every URL now resolves to a StreamView with the
// appropriate filter set, exactly the way Order's app works. Old
// hash links (#/note/X, #/folder/X) are translated in parseHash.
