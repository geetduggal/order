// Notable Folder content: the Main Document of a folder rendered full-width.
// Double-click anywhere to edit inline. Body is lazy-loaded.

import { useEffect, useState, createElement, type ReactNode } from "react";
import type { Note, NoteWithBody } from "../lib/types";
import { CMEditor } from "./CMEditor";

type Props = {
  note: Note;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (body: string) => void;
  readBody: (path: string) => Promise<NoteWithBody>;
};

export function NotableSection({ note, editing, onOpen, onClose, onChange, readBody }: Props) {
  const [body, setBody] = useState<string | null>(null);
  const isPublic = note.frontmatter?.public === true;
  const category = (note.frontmatter?.category || "").toString().replace(/^\[\[|\]\]$/g, "");

  useEffect(() => {
    let cancelled = false;
    readBody(note.path).then(n => { if (!cancelled) setBody(n.body); }).catch(console.error);
    return () => { cancelled = true; };
  }, [note.path, readBody]);

  function update(doc: string) {
    setBody(doc);
    onChange(doc);
  }

  return (
    <section
      className={"notable-section" + (editing ? " editing" : "")}
      data-folder={note.title}
      onDoubleClick={e => { if (!editing) { e.stopPropagation(); onOpen(); } }}
    >
      <div className="notable-header">
        {isPublic && <span className="dot coral" />}
        <span className="notable-kind">
          Main Document {category && <>· <strong>{category}</strong></>}
        </span>
        <span className="notable-meta">
          {isPublic ? "Public" : "Private"} · updated {timeSince(note.modified)}
        </span>
        {!editing
          ? <button className="notable-edit-btn" onClick={onOpen} title="Edit (or double-click)">✎ Edit</button>
          : <button className="notable-edit-btn" onMouseDown={(e) => { e.preventDefault(); onClose() }} title="Done (Esc or ⌘↵)">Done</button>}
      </div>
      <h1 className="notable-title">{note.title}</h1>
      {editing ? (
        body === null ? <div className="note-loading">…</div>
          : <CMEditor doc={body} onChange={update} onDone={onClose} autofocus />
      ) : (
        <div className="notable-doc">
          {body === null
            ? <p style={{ color: "var(--ink-faint)", fontStyle: "italic" }}>Loading…</p>
            : renderMarkdown(body)}
        </div>
      )}
    </section>
  );
}

function timeSince(unix: number): string {
  const seconds = Math.floor(Date.now() / 1000 - unix);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderMarkdown(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = src.split("\n");
  let para: string[] = [];
  let ul: string[] = [];

  const flushPara = () => { if (para.length) { out.push(<p key={out.length}>{inline(para.join(" "))}</p>); para = []; } };
  const flushUl = () => { if (ul.length) { out.push(<ul key={out.length}>{ul.map((li, i) => <li key={i}>{inline(li)}</li>)}</ul>); ul = []; } };

  for (const line of lines) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    const li = line.match(/^[-*]\s+(.*)$/);
    if (h) {
      flushPara(); flushUl();
      const level = h[1].length;
      out.push(createElement(`h${level + 1}`, { key: out.length }, inline(h[2])));
    } else if (li) { flushPara(); ul.push(li[1]); }
    else if (line.trim() === "") { flushPara(); flushUl(); }
    else { flushUl(); para.push(line); }
  }
  flushPara(); flushUl();
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\[\[([^\]]+)\]\]|\*\*([^*]+)\*\*|_([^_]+)_|`([^`]+)`/g;
  let last = 0, i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<a key={i++} className="wikilink" href="#">{m[1]}</a>);
    else if (m[2]) parts.push(<strong key={i++}>{m[2]}</strong>);
    else if (m[3]) parts.push(<em key={i++}>{m[3]}</em>);
    else if (m[4]) parts.push(<code key={i++}>{m[4]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
