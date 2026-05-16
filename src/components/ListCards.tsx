// Read-only card grid for `type: list` Notable Folders. Each bullet
// becomes a basecard. Real cover image when the referenced note has
// `image:` in its YAML; otherwise a tinted fallback with a Lucide
// icon, alternating royal / coral across the grid.

import { folderIcon } from "../lib/folders";
import type { Frontmatter } from "../lib/frontmatter";
import type { ListItem } from "../lib/list-folder";

export interface ListNoteRef {
  filename: string;
  frontmatter: Frontmatter;
}

interface Props {
  items: ListItem[];
  vaultNotes: ListNoteRef[];
}

function resolve(ref: string, vaultNotes: ListNoteRef[]): ListNoteRef | undefined {
  const needle = ref.toLowerCase();
  return vaultNotes.find(
    (n) => n.filename.replace(/\.md$/i, "").toLowerCase() === needle,
  );
}

function pickMeta(item: ListItem, note?: ListNoteRef): string | undefined {
  if (item.meta) return item.meta;
  if (!note) return undefined;
  const fm = note.frontmatter;
  const parts: string[] = [];
  if (typeof fm.author === "string") parts.push(fm.author);
  if (typeof fm.description === "string" && parts.length === 0) parts.push(fm.description);
  return parts.length ? parts.join(" · ") : undefined;
}

export function ListCards({ items, vaultNotes }: Props) {
  if (items.length === 0) return null;
  return (
    <div className="basecard-grid">
      {items.map((item, i) => {
        const note = resolve(item.ref, vaultNotes);
        const image = note && typeof note.frontmatter.image === "string"
          ? note.frontmatter.image as string
          : undefined;
        const Icon = folderIcon(item.ref, note?.frontmatter.icon);
        const tintCls = i % 2 === 0 ? "is-royal" : "is-coral";
        const meta = pickMeta(item, note);
        return (
          <article key={`${item.ref}-${i}`} className="basecard">
            {image ? (
              <div
                className="basecard-cover"
                style={{ backgroundImage: `url(${image})` }}
              />
            ) : (
              <div className={`basecard-cover is-fallback ${tintCls}`}>
                <Icon size={44} strokeWidth={1.3} />
              </div>
            )}
            <div className="basecard-body">
              <div className="basecard-title">{item.ref}</div>
              {meta && <div className="basecard-meta">{meta}</div>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
