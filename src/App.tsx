import { useState, useMemo, useCallback } from "react";
import { useVault } from "./hooks/useVault";
import { useFilters } from "./hooks/useFilters";
import { useEditor } from "./hooks/useEditor";
import { useTaxonomy } from "./hooks/useTaxonomy";
import { categoryOf, isMainDocument, type Note } from "./lib/types";
import { VaultPicker } from "./components/VaultPicker";
import { Topbar } from "./components/Topbar";
import { FolderTabs } from "./components/FolderTabs";
import { RecentGrid } from "./components/RecentGrid";
import { NotableSection } from "./components/NotableSection";
import { CalendarView } from "./components/CalendarView";
import { Sidebar } from "./components/Sidebar";

export default function App() {
  // All hooks unconditionally at the top — never behind an early return.
  const vault = useVault();
  const filters = useFilters();
  const editor = useEditor(vault.saveNote);
  const taxonomy = useTaxonomy(vault.vaultPath);
  const [view, setView] = useState<"stream" | "calendar">("stream");

  // Build a map from each Notable Folder Main Document → its category name.
  // Then derive: which folders are "on the page" given the current Area /
  // Category / Folder selection. A folder is on if (a) it was directly
  // selected, (b) its category is selected, or (c) its category lives in a
  // selected Area. With no filters at all, only Log is visible (legacy
  // default preserved via filters.folders containing "Log" initially).
  const activeFolderNames = useMemo(() => {
    const result = new Set<string>(filters.selection.folders);

    // Map category name → area id (via taxonomy).
    const categoryAreaId = new Map<string, string | null>();
    for (const c of taxonomy.categories) categoryAreaId.set(c.name, c.areaId);

    // Map area id → area name for lookup against filter selection.
    const areaName = new Map<string, string>();
    for (const a of taxonomy.areas) areaName.set(a.id, a.name);

    for (const note of vault.notes) {
      if (!isMainDocument(note)) continue;
      const cat = categoryOf(note);
      if (!cat) continue;
      if (filters.selection.categories.has(cat)) {
        result.add(note.title);
        continue;
      }
      const areaId = categoryAreaId.get(cat);
      if (!areaId) continue;
      const aname = areaName.get(areaId);
      if (aname && filters.selection.areas.has(aname)) {
        result.add(note.title);
      }
    }
    return result;
  }, [filters.selection, taxonomy.areas, taxonomy.categories, vault.notes]);

  const onPageFolders = useMemo(
    () => Array.from(activeFolderNames).filter(f => f !== "Log"),
    [activeFolderNames]
  );

  const notableSections = useMemo(
    () => vault.notes.filter(isMainDocument).filter(n => activeFolderNames.has(n.title)),
    [vault.notes, activeFolderNames]
  );

  const changeBody = useCallback((n: Note, body: string) => {
    editor.queueSave(n, body);
  }, [editor]);

  const updateNoteFrontmatter = useCallback((n: Note, patch: Record<string, any>) => {
    vault.setFrontmatter(n.path, patch);
  }, [vault]);

  if (!vault.vaultPath) return <VaultPicker onPick={vault.setVault} />;

  return (
    <div className="shell">
      <main className="pane-left">
        <Topbar
          view={view}
          setView={setView}
          dirty={vault.dirty}
          onPublish={async () => { await vault.publish(); }}
          vaultPath={vault.vaultPath}
          onChangeVault={() => vault.setVault("")}
        />
        <div className="pane-inner">
          <FolderTabs folders={onPageFolders} onClear={filters.clear} />
          {view === "stream" && (
            <>
              <RecentGrid
                notes={vault.notes}
                selected={activeFolderNames}
                editingPath={editor.editingPath}
                saving={editor.saving}
                onOpen={editor.open}
                onClose={editor.close}
                onChange={changeBody}
                onQuickCapture={vault.createLogNote}
                readBody={vault.readBody}
                loading={vault.loading}
              />
              {notableSections.map(n => (
                <NotableSection
                  key={n.path}
                  note={n}
                  editing={editor.editingPath === n.path}
                  onOpen={() => editor.open(n)}
                  onClose={editor.close}
                  onChange={body => changeBody(n, body)}
                  readBody={vault.readBody}
                />
              ))}
            </>
          )}
          {view === "calendar" && (
            <CalendarView
              notes={vault.notes}
              selected={activeFolderNames}
              onUpdateNote={updateNoteFrontmatter}
            />
          )}
        </div>
      </main>
      <Sidebar
        notes={vault.notes}
        areas={taxonomy.areas}
        categories={taxonomy.categories}
        selection={filters.selection}
        onToggleFolder={filters.toggleFolder}
        onToggleCategory={filters.toggleCategory}
        onToggleArea={filters.toggleArea}
        onAddArea={taxonomy.addArea}
        onAddCategory={taxonomy.addCategory}
        onRemoveArea={taxonomy.removeArea}
        onRemoveCategory={taxonomy.removeCategory}
        onPickFolder={(n) => { if (!filters.selection.folders.has(n.title)) filters.toggleFolder(n.title); }}
      />
    </div>
  );
}
