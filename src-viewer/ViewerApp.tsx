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
import { ListView } from "../src/components/ListView";
import { CommandPalette } from "../src/components/CommandPalette";
import { ViewerNote } from "./ViewerNote";
import type { ListNoteRef } from "../src/lib/list-folder";

type Route =
  | { kind: "stream"; filters: string[] }
  | { kind: "note"; ref: string }
  | { kind: "folder"; ref: string };

function parseHash(h: string): Route {
  if (h.startsWith("#/note/")) {
    return { kind: "note", ref: decodeURIComponent(h.slice("#/note/".length)) };
  }
  if (h.startsWith("#/folder/")) {
    return { kind: "folder", ref: decodeURIComponent(h.slice("#/folder/".length)) };
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

export function ViewerApp({ data }: { data: PublishedSite }) {
  const route = useHashRoute();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // index by ref for fast lookup
  const byRef = useMemo(() => {
    const m = new Map<string, PublishedNote>();
    for (const n of data.notes) m.set(n.ref.toLowerCase(), n);
    return m;
  }, [data.notes]);

  // Build NotableFolder[] for Sidebar from notes with category set.
  const notableFolders: NotableFolder[] = useMemo(
    () => data.notes
      .filter((n) => n.category)
      .map((n) => ({
        name: n.ref,
        area: "",  // not needed for display — Sidebar derives from notes
        category: n.category ?? "",
        frontmatter: n.frontmatter,
        path: n.ref,
      })),
    [data.notes],
  );

  // Build the chain-derived stored taxonomy Sidebar expects.
  const storedAreas = data.taxonomy.areas.map((a) => a.ref);
  const storedCategories = data.taxonomy.areas.flatMap((a) =>
    a.categories.map((c) => ({ area: a.ref, name: c.ref })),
  );

  // Folder filter from the URL → Sidebar's `selected` Set. Toggling
  // updates the URL.
  const selectedSet = useMemo(() => {
    if (route.kind === "stream") return new Set(route.filters);
    return new Set<string>();
  }, [route]);

  function toggleFolder(name: string) {
    const current = route.kind === "stream" ? route.filters : [];
    const next = current.includes(name)
      ? current.filter((x) => x !== name)
      : [...current, name];
    window.location.hash = next.length
      ? `#/stream?folders=${next.map(encodeURIComponent).join(",")}`
      : "#/";
  }
  function clearFolders() { window.location.hash = "#/"; }
  function navigate(ref: string) {
    window.location.hash = `#/note/${encodeURIComponent(ref)}`;
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
        className="sidebar-toggle"
        onClick={() => setSidebarOpen((o) => !o)}
        title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
      >
        {sidebarOpen ? "›" : "‹"}
      </button>

      <main className="pane-main">
        {route.kind === "stream" && <StreamView data={data} byRef={byRef} filters={route.filters} onNavigate={navigate} />}
        {route.kind === "note" && <NoteView ref={route.ref} byRef={byRef} data={data} onNavigate={navigate} />}
        {route.kind === "folder" && <FolderView ref={route.ref} byRef={byRef} data={data} onNavigate={navigate} />}
      </main>

      {sidebarOpen && (
        <Sidebar
          view="stream"
          onSelectView={() => { /* read-only viewer is stream-only */ }}
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
  data, byRef, filters, onNavigate,
}: {
  data: PublishedSite;
  byRef: Map<string, PublishedNote>;
  filters: string[];
  onNavigate: (ref: string) => void;
}) {
  const hidden = useMemo(() => new Set(data.hiddenRefs.map((r) => r.toLowerCase())), [data.hiddenRefs]);
  const filterSet = useMemo(() => new Set(filters.map((f) => f.toLowerCase())), [filters]);

  const visible = useMemo(() => {
    if (filterSet.size > 0) {
      return data.notes.filter((n) => {
        if (filterSet.has(n.ref.toLowerCase())) return true;
        if (n.folder && filterSet.has(n.folder.toLowerCase())) return true;
        return false;
      });
    }
    return data.notes.filter((n) => !hidden.has(n.ref.toLowerCase()));
  }, [data.notes, hidden, filterSet]);

  return (
    <div className="card-grid">
      {visible.map((n) => (
        <div
          key={n.ref}
          className={"card-grid-cell" + (n.category || n.isHome ? " is-full-width" : "")}
        >
          <article className="order-card">
            <div className="order-card-body">
              <h2 className="viewer-card-title">
                <a href={`#/note/${encodeURIComponent(n.ref)}`} onClick={(e) => {
                  e.preventDefault(); onNavigate(n.ref);
                }}>{n.title}</a>
              </h2>
              {(n.category || n.folder) && (
                <div className="viewer-card-meta">
                  {n.category ?? n.folder}
                </div>
              )}
              <ViewerNote
                note={n}
                data={data}
                byRef={byRef}
                onNavigate={onNavigate}
                snippet
              />
            </div>
          </article>
        </div>
      ))}
    </div>
  );
}

// ---------- Single note view ----------

function NoteView({
  ref, byRef, data, onNavigate,
}: {
  ref: string;
  byRef: Map<string, PublishedNote>;
  data: PublishedSite;
  onNavigate: (ref: string) => void;
}) {
  const note = byRef.get(ref.toLowerCase());
  if (!note) {
    return (
      <div className="viewer-not-found">
        <h1>Not found</h1>
        <p>No public note named "{ref}".</p>
        <p><a href="#/">← back to stream</a></p>
      </div>
    );
  }
  return (
    <article className="order-card viewer-single">
      <div className="viewer-crumbs">
        <a href="#/" onClick={(e) => { e.preventDefault(); window.location.hash = "#/"; }}>{data.home.title}</a>
        {note.folder && (
          <>
            <span> › </span>
            <a
              href={`#/folder/${encodeURIComponent(note.folder)}`}
              onClick={(e) => { e.preventDefault(); window.location.hash = `#/folder/${encodeURIComponent(note.folder!)}`; }}
            >{note.folder}</a>
          </>
        )}
      </div>
      <ViewerNote note={note} data={data} byRef={byRef} onNavigate={onNavigate} />
    </article>
  );
}

// ---------- Folder view ----------

function FolderView({
  ref, byRef, data, onNavigate,
}: {
  ref: string;
  byRef: Map<string, PublishedNote>;
  data: PublishedSite;
  onNavigate: (ref: string) => void;
}) {
  const note = byRef.get(ref.toLowerCase());
  const children = useMemo(
    () => data.notes.filter((n) => n.folder?.toLowerCase() === ref.toLowerCase()),
    [data.notes, ref],
  );
  // Build a ListNoteRef view that the existing ListView understands.
  const vaultNotes: ListNoteRef[] = useMemo(
    () => data.notes.map((n) => ({
      filename: `${n.ref}.md`,
      frontmatter: n.frontmatter,
      body: n.body,
    })),
    [data.notes],
  );

  return (
    <article className="order-card viewer-single">
      <div className="viewer-crumbs">
        <a href="#/" onClick={(e) => { e.preventDefault(); window.location.hash = "#/"; }}>{data.home.title}</a>
        <span> › </span>
        <span>{note?.title ?? ref}</span>
      </div>
      {note && (
        <ViewerNote note={note} data={data} byRef={byRef} onNavigate={onNavigate} />
      )}
      {note?.listItems && note.listItems.length > 0 && note.listRender && (
        <ListView
          render={note.listRender}
          items={note.listItems}
          vaultNotes={vaultNotes}
          onChange={() => { /* no-op in viewer */ }}
          readOnlyMembership
          onNavigate={onNavigate}
          expandSublists={note.listItems.some((it) => {
            const sub = byRef.get(it.ref.toLowerCase());
            return !!sub?.listRender;
          })}
        />
      )}
      {children.length > 0 && (
        <>
          <h3 className="viewer-section-h">More in this folder</h3>
          <ul className="viewer-folder-list">
            {children.map((c) => (
              <li key={c.ref}>
                <a
                  href={`#/note/${encodeURIComponent(c.ref)}`}
                  onClick={(e) => { e.preventDefault(); onNavigate(c.ref); }}
                >{c.title}</a>
              </li>
            ))}
          </ul>
        </>
      )}
    </article>
  );
}
