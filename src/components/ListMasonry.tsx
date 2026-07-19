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
import { useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import { assetUrl } from "../lib/attachments";
import { resolveNoteRef } from "../lib/wikilink";
import { isMainDocRef } from "../lib/folders";
import { displayTitleFor, type ListItem, type ListNoteRef } from "../lib/list-folder";
import { openExternalUrl } from "../lib/open-external";
import { useTileDrag } from "../lib/use-tile-drag";

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
  const canEdit = !readOnly && !readOnlyMembership;
  const go = useGo(vaultNotes, onNavigate, onAddFilter);

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
    { exclude: "a, button, textarea, input, .mason-link, .mason-del, .mason-edit" },
  );

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

  return (
    <div className="mason-grid" ref={gridRef}>
      {items.map((item, i) => {
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
              <img className="mason-img" src={img} alt={item.caption ?? ""} loading="lazy" />
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
      })}
      {canEdit && (adding ? (
        <div className="mason-item">
          <textarea
            autoFocus
            className="mason-edit"
            value={addDraft}
            placeholder="Text, [[Note]] or ![[image]]"
            onChange={(e) => setAddDraft(e.target.value)}
            onBlur={commitAdd}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitAdd(); }
              if (e.key === "Escape") { e.preventDefault(); setAdding(false); setAddDraft(""); }
            }}
          />
        </div>
      ) : (
        <button type="button" className="mason-item mason-add" onClick={() => setAdding(true)}>
          <Plus size={15} strokeWidth={2} /> Add
        </button>
      ))}
    </div>
  );
}
