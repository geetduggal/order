// Masonry list layout: each item is a box whose CONTENT is its text (or its
// image, for image items). Boxes grow with their content and flow into a
// column-based masonry grid — a clean 2D text layout where more content simply
// gets more space. Distinct from ListCards (which renders wikilink references
// as icon-cover cards).

import { useState } from "react";
import { Plus, X as XIcon } from "lucide-react";
import { assetUrl } from "../lib/attachments";
import type { ListItem, ListNoteRef } from "../lib/list-folder";

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

function imageUrl(item: ListItem, noteDir?: string): string | undefined {
  if (!item.image) return undefined;
  if (/^[a-z]+:\/\//i.test(item.image)) return item.image;
  return assetUrl(noteDir ? `${noteDir}/${item.image}` : item.image);
}

/** Parse an edit string: `[[Note]]` → a wikilink item, else a plain-text item. */
function itemFromText(t: string): ListItem {
  const wiki = t.match(/^\[\[(.+)\]\]$/);
  return wiki ? { ref: wiki[1].trim() } : { ref: t, text: t };
}

export function ListMasonry({ items, onChange, readOnly, readOnlyMembership, onNavigate, onAddFilter, noteDir }: Props) {
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const canEdit = !readOnly && !readOnlyMembership;

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
    <div className="mason-grid">
      {items.map((item, i) => {
        const img = imageUrl(item, noteDir);
        const isWiki = !item.text && !item.image; // ref is a wikilink target
        const text = item.text ?? item.ref;
        return (
          <div key={item.ref + i} className={"mason-item" + (img ? " is-image" : "")}>
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
            ) : (
              <div
                className={"mason-text" + (isWiki && (onNavigate || onAddFilter) ? " is-link" : "")}
                onClick={() => {
                  if (isWiki && onAddFilter) onAddFilter(item.ref);
                  else if (isWiki && onNavigate) onNavigate(item.ref);
                  else if (canEdit) { setEditIdx(i); setDraft(text); }
                }}
              >
                {text}
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
            placeholder="Text or [[Note]]"
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
