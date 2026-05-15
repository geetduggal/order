// Recent notes — 2D card grid with NYT-style hairline dividers.
// CSS Grid with auto row spans computed from content height; pseudo-element
// dividers on cards move with them as the grid reflows.

import { useEffect, useRef, useState } from "react";
import type { Note } from "../lib/types";
import { folderOf, isMainDocument } from "../lib/types";
import { NoteCard } from "./NoteCard";

type Props = {
  notes: Note[];
  selected: Set<string>;
  editingPath: string | null;
  onOpen: (n: Note) => void;
  onClose: () => void;
  onChange: (n: Note, body: string) => void;
  onQuickCapture: (text: string) => Promise<void>;
  loading: boolean;
};

export function RecentGrid({ notes, selected, editingPath, onOpen, onClose, onChange, onQuickCapture, loading }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [capture, setCapture] = useState("");

  const visible = notes
    .filter(n => !isMainDocument(n))           // Main Documents render full-width below
    .filter(n => selected.has(folderOf(n)) || folderOf(n) === "Log");

  // Auto row-span + first-row/first-col marking.
  useEffect(() => { layout(gridRef.current); });
  useEffect(() => {
    const re = () => layout(gridRef.current);
    window.addEventListener("resize", re);
    return () => window.removeEventListener("resize", re);
  }, []);

  async function onCaptureKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      const text = capture.trim();
      if (!text) return;
      setCapture("");
      await onQuickCapture(text);
    }
  }

  return (
    <section className="recent-wrap">
      <div className="quick-capture">
        <label className="qc-hint" htmlFor="qc-input">
          <span className="plus">+</span> New post
          <span className="kbd">click and type, ⌘↵ to save</span>
        </label>
        <textarea
          id="qc-input"
          value={capture}
          onChange={e => setCapture(e.target.value)}
          onKeyDown={onCaptureKey}
          placeholder="What are you thinking?"
          rows={1}
        />
      </div>
      {visible.length === 0 && !loading && (
        <div className="empty-state">
          {notes.length === 0
            ? <>No markdown files in this vault yet. Type above and press <kbd>⌘ ↵</kbd> to create one in <em>Log</em>.</>
            : <>No notes match the current selection. Toggle a folder in the right sidebar.</>}
        </div>
      )}
      <div className="stream-grid" ref={gridRef}>
        {visible.map(n => (
          <NoteCard
            key={n.path}
            note={n}
            editing={editingPath === n.path}
            onOpen={() => onOpen(n)}
            onClose={onClose}
            onChange={body => onChange(n, body)}
          />
        ))}
      </div>
    </section>
  );
}

function layout(grid: HTMLElement | null) {
  if (!grid) return;
  const cs = getComputedStyle(grid);
  const rowH = parseFloat(cs.gridAutoRows) || 8;
  const gap = parseFloat(cs.rowGap || cs.gap) || 16;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .note"));
  cards.forEach(c => {
    c.style.gridRowEnd = "";
    const rows = Math.max(3, Math.ceil((c.offsetHeight + gap) / (rowH + gap)));
    c.style.gridRowEnd = `span ${rows}`;
    c.classList.remove("first-row", "first-col");
  });
  // first-col: cards with the minimum offsetLeft
  if (!cards.length) return;
  const minLeft = Math.min(...cards.map(c => c.offsetLeft));
  cards.forEach(c => { if (Math.abs(c.offsetLeft - minLeft) < 2) c.classList.add("first-col"); });
  // first-row per column: lowest offsetTop within each offsetLeft bucket
  const byCol = new Map<number, HTMLElement>();
  cards.forEach(c => {
    const key = Math.round(c.offsetLeft / 8) * 8;
    const cur = byCol.get(key);
    if (!cur || c.offsetTop < cur.offsetTop) byCol.set(key, c);
  });
  byCol.forEach(c => c.classList.add("first-row"));
}
