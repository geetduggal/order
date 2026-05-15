// Right sidebar: Log/Public pins + a folder list grouped by category.
// Toggling a folder here is the actual filter control; tabs at top of content reflect.

import type { Note } from "../lib/types";
import { categoryOf, folderOf, isMainDocument, isPublic } from "../lib/types";

type Props = {
  notes: Note[];
  selected: Set<string>;
  onToggle: (folder: string) => void;
  onPick: (n: Note) => void;
};

export function Sidebar({ notes, selected, onToggle, onPick }: Props) {
  const folders = listFolders(notes);
  const logCount = notes.filter(n => folderOf(n) === "Log" && !isMainDocument(n)).length;
  const publicCount = notes.filter(isPublic).length;

  return (
    <aside className="sidebar">
      <div className="pin-row">
        <button className={"pin log" + (selected.has("Log") ? " on" : "")} onClick={() => onToggle("Log")}>
          <span className="glyph">L</span>
          <span className="name">Log</span>
          <span className="count">{logCount}</span>
        </button>
        <button className="pin public">
          <span className="glyph">●</span>
          <span className="name">Public</span>
          <span className="count">{publicCount}</span>
        </button>
      </div>

      <div className="sb-title"><span>Notable Folders</span><span className="count">{folders.length}</span></div>
      <div className="folder-list">
        {folders.map(({ note, category }) => {
          const on = selected.has(note.title);
          return (
            <button
              key={note.path}
              className={"folder-card" + (on ? " on" : "")}
              onClick={() => onToggle(note.title)}
              onDoubleClick={() => onPick(note)}
            >
              <div className="fc-thumb"><span>{(note.title[0] || "·").toUpperCase()}</span></div>
              <div className="fc-body">
                <div className="fc-name">{note.title}</div>
                <div className="fc-desc">{category || "(uncategorized)"}</div>
              </div>
              <div className="fc-check">{on ? "✓" : ""}</div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function listFolders(notes: Note[]): { note: Note; category: string | null }[] {
  return notes
    .filter(isMainDocument)
    .map(note => ({ note, category: categoryOf(note) }))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.note.title.localeCompare(b.note.title));
}
