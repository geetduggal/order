// Masonry list layout: each item is a box whose CONTENT is its text (or its
// image, for image items). Boxes grow with their content and flow into a
// column-based masonry grid — a clean 2D text layout where more content simply
// gets more space. Distinct from ListCards (which renders wikilink references
// as icon-cover cards).
//
// Inline `[[links]]`, `![[images]]` and bare URLs inside an item's text render
// as functional links/images; whole-item wikilinks and image items work too.
// Reorder by dragging a card's grip (shared useTileDrag, handle-only so the
// text stays selectable/editable).

import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import { assetUrl, attachmentName } from "../lib/attachments";
import { vaultFs } from "../lib/vault-fs";
import { resolveNoteRef } from "../lib/wikilink";
import { isMainDocRef } from "../lib/folders";
import { displayTitleFor, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { openExternalUrl } from "../lib/open-external";
import { useTileDrag } from "../lib/use-tile-drag";
import { calendarDropTarget, useEventToListAppend } from "../lib/list-cal-dnd";

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
  onChange: (next: ListItem[]) => void;
  readOnly?: boolean;
  readOnlyMembership?: boolean;
  onNavigate?: (ref: string) => void;
  onAddFilter?: (ref: string) => void;
  noteDir?: string;
}

function assetFor(rel: string, noteDir?: string): string {
  if (/^[a-z]+:\/\//i.test(rel)) return rel;
  return assetUrl(noteDir ? `${noteDir}/${rel}` : rel);
}

/** Parse an edit string: `[[Note]]` → a wikilink item, else a plain-text item. */
function itemFromText(t: string): ListItem {
  const wiki = t.match(/^\[\[(.+)\]\]$/);
  return wiki ? { ref: wiki[1].trim() } : { ref: t, text: t };
}

/** Route a wikilink ref: Notable Folders accumulate into the filter, plain
 *  notes navigate. Mirrors the whole-item click behaviour. */
function useGo(vaultNotes: ListNoteRef[], onNavigate?: (r: string) => void, onAddFilter?: (r: string) => void) {
  return (ref: string) => {
    const note = resolveNoteRef(ref, vaultNotes);
    if (note && isMainDocRef(note) && onAddFilter) onAddFilter(ref);
    else if (onNavigate) onNavigate(ref);
    else if (onAddFilter) onAddFilter(ref);
  };
}

// Split a text run into plain text + inline media / links. Handles, in order:
//   1  ![[file]]        wiki image        4  [label](url)   markdown link
//   2  ![alt](url)      markdown image    5  https://…       bare URL
//   3  [[ref|label]]    wiki link
const INLINE_RE =
  /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)\s]+)\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
function renderInline(
  text: string,
  noteDir: string | undefined,
  go: (ref: string) => void,
): React.ReactNode {
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  const link = (label: string, onClick: (e: React.MouseEvent) => void, href?: string) => (
    <a key={key++} className="mason-link" href={href} onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(e); }}>{label}</a>
  );
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {                       // wiki image ![[file]]
      out.push(<img key={key++} className="mason-inline-img" src={assetFor(m[1].trim(), noteDir)} alt="" loading="lazy" />);
    } else if (m[2] != null) {                // markdown image ![alt](url)
      out.push(<img key={key++} className="mason-inline-img" src={assetFor(m[2].trim(), noteDir)} alt="" loading="lazy" />);
    } else if (m[3] != null) {                // wiki link [[ref|label]]
      const ref = m[3].trim();
      out.push(link(m[4]?.trim() || ref, () => go(ref)));
    } else if (m[5] != null) {                // markdown link [label](url)
      const url = m[6];
      out.push(link(m[5], () => openExternalUrl(url), url));
    } else if (m[7] != null) {                // bare URL
      const url = m[7];
      out.push(link(url, () => openExternalUrl(url), url));
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ListMasonry({ items, vaultNotes, onChange, readOnly, readOnlyMembership, onNavigate, onAddFilter, noteDir }: Props) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  // Enter commits the card but keeps the Add box open + focused for the next
  // one. When the layout re-packs the Add box into another column it briefly
  // unmounts (firing blur); this flag tells that blur NOT to close the box —
  // the remounted box auto-focuses. Cleared next frame so a real click-away
  // still commits + closes.
  const keepAddingRef = useRef(false);
  const canEdit = !readOnly && !readOnlyMembership;
  const go = useGo(vaultNotes, onNavigate, onAddFilter);

  // --- Balanced JS masonry -------------------------------------------------
  // CSS `columns` packs cards into the fewest columns and wastes the width; a
  // stretch grid fills the width but aligns cards into rows (gaps under short
  // ones). So we lay out ourselves: pick a column count from the container
  // width, then greedily drop each card into the currently-shortest column —
  // real staggered masonry that also uses the full width. Refs feed live card
  // heights back in; a nonce re-runs the pass when images finish loading.
  const MASON_GAP = 10;
  const MASON_TARGET_COL = 168;
  const [colCount, setColCount] = useState(1);
  const [assign, setAssign] = useState<number[]>([]); // item index -> column
  const [addCol, setAddCol] = useState(0);
  const [measureNonce, setMeasureNonce] = useState(0);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Re-pack once per image when it first loads (its height jumps). Guarded by a
  // Set so a re-pack that remounts the <img> (moving it to another column)
  // doesn't re-fire onLoad → re-pack → … in a loop.
  const loadedImgs = useRef<Set<string>>(new Set());
  const onImgLoad = (ref: string) => {
    if (loadedImgs.current.has(ref)) return;
    loadedImgs.current.add(ref);
    setMeasureNonce((n) => n + 1);
  };

  // Paste an image → a new image card. Handled at the document level (a bare
  // div gets no paste events of its own) but gated so only the masonry the
  // user is actually pointing at / typing in reacts: pointer is over the grid,
  // or focus is inside it (e.g. the Add box). Refs keep the listener stable
  // while reading fresh state on each paste.
  const hoverRef = useRef(false);
  const noteDirRef = useRef(noteDir);
  noteDirRef.current = noteDir;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const addImageFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (imgs.length === 0) return;
    const dir = noteDirRef.current;
    // Avoid clobbering an existing attachment (or another file in this same
    // paste) that hashes to the same stamped name.
    const taken = new Set(itemsRef.current.filter((i) => i.image).map((i) => i.ref));
    const added: ListItem[] = [];
    for (const file of imgs) {
      try {
        let name = attachmentName(file);
        if (taken.has(name)) {
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : "";
          let n = 2;
          while (taken.has(`${stem}-${n}${ext}`)) n++;
          name = `${stem}-${n}${ext}`;
        }
        taken.add(name);
        const rel = dir ? `${dir}/${name}` : name;
        const bytes = new Uint8Array(await file.arrayBuffer());
        await vaultFs.writeBinary(rel, Array.from(bytes));
        added.push({ ref: name, image: name });
      } catch (err) {
        console.error("masonry image paste failed:", err);
      }
    }
    if (added.length) onChangeRef.current([...itemsRef.current, ...added]);
  }, []);

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (!canEditRef.current) return;
      const grid = gridRef.current;
      if (!grid) return;
      if (!(hoverRef.current || grid.contains(document.activeElement))) return;
      const clip = e.clipboardData?.items;
      if (!clip) return;
      const files: File[] = [];
      for (const it of clip) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length === 0) return;
      // Stop the image also landing as stray text in a focused Add box.
      e.preventDefault();
      e.stopPropagation();
      void addImageFiles(files);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addImageFiles]);

  // Reorder: map the new ref order back onto the items and persist.
  function reorder(order: string[]) {
    const byRef = new Map(items.map((i) => [i.ref, i]));
    const next = order.map((r) => byRef.get(r)).filter((i): i is ListItem => !!i);
    if (next.length === items.length) onChange(next);
  }
  // Press anywhere on a card to drag it; interactive bits (links, the edit
  // box, the delete button) are excluded so they still click/type normally.
  const { gridRef, dragRef, onTilePointerDown } = useTileDrag(
    items.map((i) => i.ref),
    canEdit ? reorder : undefined,
    {
      exclude: "a, button, textarea, input, .mason-link, .mason-del, .mason-edit",
      // Drop a card onto the Week calendar → create a 30-min event (title = the
      // card's text) and remove the card. CardGrid makes the event.
      dropTarget: canEdit ? calendarDropTarget(() => itemsRef.current, (n) => onChangeRef.current(n)) : undefined,
    },
  );

  // Calendar event dragged onto the Week hub list → append it here.
  useEventToListAppend(gridRef, () => itemsRef.current, (n) => onChangeRef.current(n), canEdit);

  // Column count from the live container width (min column ≈ target px).
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth || 0;
      const byWidth = Math.max(1, Math.floor((w + MASON_GAP) / (MASON_TARGET_COL + MASON_GAP)));
      const cap = Math.max(1, items.length + (canEdit ? 1 : 0));
      setColCount(Math.min(byWidth, cap));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [items.length, canEdit]);

  // Greedy shortest-column packing, measured from the rendered card heights.
  // Runs after layout (heights depend on the column width, which is fixed by
  // colCount) so a re-pack never changes heights — it converges in one step.
  useLayoutEffect(() => {
    const n = Math.max(1, colCount);
    const heights = new Array(n).fill(0);
    const shortest = () => { let m = 0; for (let c = 1; c < n; c++) if (heights[c] < heights[m]) m = c; return m; };
    const next: number[] = [];
    for (const it of items) {
      const el = itemRefs.current.get(it.ref);
      const h = el ? el.offsetHeight : MASON_TARGET_COL;
      const c = shortest();
      next.push(c);
      heights[c] += h + MASON_GAP;
    }
    setAddCol(shortest());
    setAssign((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next));
  }, [items, colCount, measureNonce]);

  const commitEdit = (i: number) => {
    const t = draft.trim();
    setEditIdx(null);
    if (!t) return;
    onChange(items.map((it, j) => (j === i ? { ...itemFromText(t), meta: it.meta } : it)));
  };
  const del = (i: number) => onChange(items.filter((_, j) => j !== i));
  const commitAdd = () => {
    const t = addDraft.trim();
    setAdding(false);
    setAddDraft("");
    if (t) onChange([...items, itemFromText(t)]);
  };
  // Enter: commit this card and stay in the Add box for the next one.
  const addAnother = () => {
    const t = addDraft.trim();
    if (!t) return;
    keepAddingRef.current = true;
    onChange([...items, itemFromText(t)]);
    setAddDraft("");
    requestAnimationFrame(() => { keepAddingRef.current = false; });
  };

  const renderItem = (item: ListItem, i: number) => {
    const img = item.image ? assetFor(item.image, noteDir) : undefined;
    // A wikilink item (ref only, no text/image): show the linked note's
    // display title and navigate on click.
    const isWiki = !item.text && !item.image;
    const note = isWiki ? resolveNoteRef(item.ref, vaultNotes) : undefined;
    const text = item.text ?? (note ? displayTitleFor(item, note) : item.ref);
    const dragging = item.ref === dragRef;
    return (
      <div
        key={item.ref + i}
        ref={(el) => { const m = itemRefs.current; if (el) m.set(item.ref, el); else m.delete(item.ref); }}
        className={"mason-item" + (img ? " is-image" : "") + (dragging ? " is-dragging" : "") + (canEdit ? " draggable" : "")}
        data-tile-ref={item.ref}
        onPointerDown={canEdit ? (e) => onTilePointerDown(e, item.ref) : undefined}
      >
        {canEdit && (
          <button type="button" className="mason-del" onClick={() => del(i)} title="Remove" aria-label="Remove item">
            <XIcon size={12} strokeWidth={2.4} />
          </button>
        )}
        {img ? (
          <img className="mason-img" src={img} alt={item.caption ?? ""} loading="lazy" onLoad={() => onImgLoad(item.ref)} />
        ) : editIdx === i ? (
          <textarea
            autoFocus
            className="mason-edit"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitEdit(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(i); }
              if (e.key === "Escape") { e.preventDefault(); setEditIdx(null); }
            }}
          />
        ) : isWiki ? (
          <div
            className="mason-text is-link"
            onClick={() => go(item.ref)}
            onDoubleClick={() => { if (canEdit) { setEditIdx(i); setDraft(`[[${item.ref}]]`); } }}
            title={`Open ${text}`}
          >
            {text}
          </div>
        ) : (
          <div
            className="mason-text"
            onDoubleClick={() => { if (canEdit) { setEditIdx(i); setDraft(text); } }}
          >
            {renderInline(text, noteDir, go)}
          </div>
        )}
        {item.caption && img && <div className="mason-meta">{item.caption}</div>}
        {item.meta && !img && <div className="mason-meta">{item.meta}</div>}
      </div>
    );
  };

  const renderAdd = () => (adding ? (
    <div className="mason-item">
      <textarea
        autoFocus
        className="mason-edit"
        value={addDraft}
        placeholder="Text, [[Note]] or ![[image]]"
        onChange={(e) => setAddDraft(e.target.value)}
        onBlur={() => { if (keepAddingRef.current) return; commitAdd(); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addAnother(); }
          if (e.key === "Escape") { e.preventDefault(); setAdding(false); setAddDraft(""); }
        }}
      />
    </div>
  ) : (
    <button type="button" className="mason-item mason-add" onClick={() => setAdding(true)}>
      <Plus size={15} strokeWidth={2} /> Add
    </button>
  ));

  // Distribute items into the computed columns (fallback round-robin while the
  // balanced pass catches up or an assignment is stale after a resize).
  const cols: { item: ListItem; i: number }[][] = Array.from({ length: Math.max(1, colCount) }, () => []);
  items.forEach((item, i) => {
    let c = assign[i];
    if (c == null || c >= cols.length) c = i % cols.length;
    cols[c].push({ item, i });
  });
  const safeAddCol = addCol < cols.length ? addCol : cols.length - 1;

  return (
    <div
      className="mason-grid"
      ref={gridRef}
      onPointerEnter={() => { hoverRef.current = true; }}
      onPointerLeave={() => { hoverRef.current = false; }}
    >
      {cols.map((colItems, c) => (
        <div className="mason-col" key={c}>
          {colItems.map(({ item, i }) => renderItem(item, i))}
          {canEdit && c === safeAddCol && renderAdd()}
        </div>
      ))}
    </div>
  );
}
