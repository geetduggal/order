import { useEffect, useState } from "react";
import type { Note, NoteWithBody } from "../lib/types";
import { folderOf, isPublic } from "../lib/types";
import { CMEditor } from "./CMEditor";

type Props = {
  note: Note;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (body: string) => void;
  readBody: (path: string) => Promise<NoteWithBody>;
  onStartResize: (e: React.MouseEvent, axis: "x" | "y" | "xy") => void;
};

export function NoteCard({ note, editing, onOpen, onClose, onChange, readBody, onStartResize }: Props) {
  const [body, setBody] = useState<string | null>(null);
  const day = note.frontmatter?.date as string | undefined;
  const time = note.frontmatter?.startTime as string | undefined;
  const folder = folderOf(note);
  const pub = isPublic(note);

  // Lazy-load full body when entering edit mode.
  useEffect(() => {
    if (!editing || body !== null) return;
    let cancelled = false;
    readBody(note.path).then(n => { if (!cancelled) setBody(n.body); }).catch(console.error);
    return () => { cancelled = true; };
  }, [editing, note.path, body, readBody]);

  function update(doc: string) {
    setBody(doc);
    onChange(doc);
  }

  return (
    <article
      className={"note" + (editing ? " editing" : "")}
      data-folder={folder}
      onDoubleClick={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest(".resize-handle, .note-edit-btn")) return;
        if (!editing) { e.stopPropagation(); onOpen(); }
      }}
    >
      <div className="note-meta">
        {day && <span className="day">{relativeDay(day)}</span>}
        {time && <span>{time}</span>}
        <span className="dot-sep">·</span>
        <span><em>{folder}</em></span>
        {pub && <><span className="dot-sep">·</span><span className="pub">● Public</span></>}
      </div>
      {editing ? (
        body === null
          ? <div className="note-loading">Loading…</div>
          : <CMEditor doc={body} onChange={update} onBlur={onClose} autofocus />
      ) : (
        <div className="note-body">
          {hasTitle(note) && <h3>{note.title}</h3>}
          <p>{note.snippet}</p>
        </div>
      )}
      {!editing && (
        <button className="note-edit-btn" onClick={(e) => { e.stopPropagation(); onOpen(); }} title="Edit (or double-click)">
          ✎
        </button>
      )}
      <div className="resize-handle resize-h" onMouseDown={e => onStartResize(e, "x")} />
      <div className="resize-handle resize-v" onMouseDown={e => onStartResize(e, "y")} />
      <div className="resize-handle resize-c" onMouseDown={e => onStartResize(e, "xy")} />
    </article>
  );
}

function hasTitle(n: Note): boolean {
  // Render a title above the body only if the title isn't already the same as
  // the snippet's leading sentence — avoids "Cold this morning… / Cold this
  // morning. Light came in…" duplication for log notes with no headings.
  const t = n.title.trim();
  if (!t) return false;
  return !n.snippet.toLowerCase().startsWith(t.toLowerCase());
}

function relativeDay(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.floor((today.getTime() - d.getTime()) / 86400000);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return d.toLocaleDateString("en-US", { weekday: "short" });
  return iso;
}
