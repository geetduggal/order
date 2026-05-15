import { useState } from "react";
import type { Note } from "../lib/types";
import { folderOf, isPublic } from "../lib/types";
import { CMEditor } from "./CMEditor";

type Props = {
  note: Note;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (body: string) => void;
};

export function NoteCard({ note, editing, onOpen, onClose, onChange }: Props) {
  const [localBody, setLocalBody] = useState(note.body);
  const day = note.frontmatter?.date as string | undefined;
  const time = note.frontmatter?.startTime as string | undefined;
  const folder = folderOf(note);
  const pub = isPublic(note);

  function update(doc: string) {
    setLocalBody(doc);
    onChange(doc);
  }

  return (
    <article
      className={"note" + (editing ? " editing" : "")}
      data-folder={folder}
      onDoubleClick={(e) => {
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
        <CMEditor
          doc={localBody}
          onChange={update}
          onBlur={onClose}
          autofocus
        />
      ) : (
        <div className="note-body">
          {note.title && <h3>{note.title}</h3>}
          <p>{firstParagraph(note.body, 240)}</p>
        </div>
      )}
    </article>
  );
}

function firstParagraph(body: string, max: number): string {
  const cleaned = body
    .replace(/^#+\s+.*$/gm, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) + "…" : cleaned;
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
