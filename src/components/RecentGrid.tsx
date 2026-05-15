// Recent notes — 2D card grid with NYT-style hairline dividers and per-card
// resize handles. Grid is CSS Grid with auto row spans computed from content
// height. Pseudo-element dividers on cards reflow with them.

import { useEffect, useRef, useState, useCallback } from "react";
import type { Note, NoteWithBody } from "../lib/types";
import { folderOf, isMainDocument } from "../lib/types";
import { NoteCard } from "./NoteCard";

type Props = {
  notes: Note[];
  selected: Set<string>;
  editingPath: string | null;
  saving: boolean;
  onOpen: (n: Note) => void;
  onClose: () => void;
  onChange: (n: Note, body: string) => void;
  onQuickCapture: (text: string) => Promise<void>;
  readBody: (path: string) => Promise<NoteWithBody>;
  loading: boolean;
};

export function RecentGrid({ notes, selected, editingPath, saving, onOpen, onClose, onChange, onQuickCapture, readBody, loading }: Props) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [capture, setCapture] = useState("");

  const visible = notes
    .filter(n => !isMainDocument(n))
    .filter(n => selected.has(folderOf(n)) || folderOf(n) === "Log");

  useEffect(() => { layout(gridRef.current); });
  useEffect(() => {
    const re = () => layout(gridRef.current);
    window.addEventListener("resize", re);
    return () => window.removeEventListener("resize", re);
  }, []);

  const startResize = useCallback((e: React.MouseEvent, axis: "x" | "y" | "xy") => {
    const card = (e.currentTarget as HTMLElement).closest(".note") as HTMLElement | null;
    const grid = gridRef.current;
    if (!card || !grid) return;
    e.preventDefault();
    e.stopPropagation();

    const cs = getComputedStyle(grid);
    const colGap = parseFloat(cs.columnGap || cs.gap) || 28;
    const rowGap = parseFloat(cs.rowGap || cs.gap) || 32;
    const rowH   = parseFloat(cs.gridAutoRows) || 8;
    const colW   = (grid.getBoundingClientRect().width - colGap * 5) / 6;

    const startX = e.clientX, startY = e.clientY;
    const startCols = readCols(card);
    const startRows = readRows(card);
    card.classList.add("resizing");

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (axis === "x" || axis === "xy") {
        const newCols = Math.max(1, Math.min(6, Math.round(startCols + dx / (colW + colGap))));
        card.classList.remove("wide", "full");
        if (newCols === 6) { card.style.gridColumn = "1 / -1"; card.classList.add("full"); }
        else if (newCols === 3) { card.style.gridColumn = "span 3"; card.classList.add("wide"); }
        else card.style.gridColumn = `span ${newCols}`;
      }
      if (axis === "y" || axis === "xy") {
        const newRows = Math.max(3, startRows + Math.round(dy / (rowH + rowGap)));
        card.style.gridRowEnd = `span ${newRows}`;
        card.dataset.userRows = String(newRows);
      }
      layout(grid);
    };
    const onUp = () => {
      card.classList.remove("resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (axis === "x" || axis === "xy") delete card.dataset.userRows;
      layout(grid);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
      {loading && notes.length === 0 && (
        <div className="empty-state">Scanning vault…</div>
      )}
      <div className="stream-grid" ref={gridRef}>
        {visible.map(n => (
          <NoteCard
            key={n.path}
            note={n}
            editing={editingPath === n.path}
            saving={saving && editingPath === n.path}
            onOpen={() => onOpen(n)}
            onClose={onClose}
            onChange={body => onChange(n, body)}
            readBody={readBody}
            onStartResize={startResize}
          />
        ))}
      </div>
    </section>
  );
}

function readCols(card: HTMLElement): number {
  if (card.classList.contains("full")) return 6;
  if (card.classList.contains("wide")) return 3;
  const gc = card.style.gridColumn || "";
  if (gc.includes("1 / -1")) return 6;
  const m = gc.match(/span\s+(\d+)/);
  return m ? parseInt(m[1]) : 2;
}
function readRows(card: HTMLElement): number {
  const gr = card.style.gridRowEnd || "";
  const m = gr.match(/span\s+(\d+)/);
  return m ? parseInt(m[1]) : 30;
}

function layout(grid: HTMLElement | null) {
  if (!grid) return;
  const cs = getComputedStyle(grid);
  const rowH = parseFloat(cs.gridAutoRows) || 8;
  const gap  = parseFloat(cs.rowGap || cs.gap) || 16;
  const cards = Array.from(grid.querySelectorAll<HTMLElement>(":scope > .note"));
  cards.forEach(c => {
    if (!c.dataset.userRows) {
      c.style.gridRowEnd = "";
      const rows = Math.max(3, Math.ceil((c.offsetHeight + gap) / (rowH + gap)));
      c.style.gridRowEnd = `span ${rows}`;
    }
    c.classList.remove("first-row", "first-col");
  });
  if (!cards.length) return;
  const minLeft = Math.min(...cards.map(c => c.offsetLeft));
  cards.forEach(c => { if (Math.abs(c.offsetLeft - minLeft) < 2) c.classList.add("first-col"); });
  const byCol = new Map<number, HTMLElement>();
  cards.forEach(c => {
    const key = Math.round(c.offsetLeft / 8) * 8;
    const cur = byCol.get(key);
    if (!cur || c.offsetTop < cur.offsetTop) byCol.set(key, c);
  });
  byCol.forEach(c => c.classList.add("first-row"));
}
