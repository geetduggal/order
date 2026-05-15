import { useState, useMemo, useCallback } from "react";
import { useVault } from "./hooks/useVault";
import { useFilters } from "./hooks/useFilters";
import { useEditor } from "./hooks/useEditor";
import { isMainDocument, type Note } from "./lib/types";
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
  const [view, setView] = useState<"stream" | "calendar">("stream");

  const onPageFolders = useMemo(
    () => Array.from(filters.selected).filter(f => f !== "Log"),
    [filters.selected]
  );

  const notableSections = useMemo(
    () => vault.notes.filter(isMainDocument).filter(n => filters.selected.has(n.title)),
    [vault.notes, filters.selected]
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
                selected={filters.selected}
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
              selected={filters.selected}
              onUpdateNote={updateNoteFrontmatter}
            />
          )}
        </div>
      </main>
      <Sidebar
        notes={vault.notes}
        selected={filters.selected}
        onToggle={filters.toggle}
        onPick={n => { if (!filters.selected.has(n.title)) filters.toggle(n.title); }}
      />
    </div>
  );
}
