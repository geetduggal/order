// Frontend half of the publish pipeline: walk the loaded vault,
// collect every public-flagged note + the chain taxonomy + the
// chosen home, return a JSON-serializable snapshot. The viewer
// (a separate Vite-built React bundle in src-viewer/) consumes this
// at runtime via fetch("./data.json"). Rust copies the bundle and
// writes data.json into the target GitHub repo path.

import type { Frontmatter } from "./frontmatter";
import { splitBodyAndBullets } from "./list-folder";
import { extractBaseBlock, parseBase } from "./list-base";
import { smartMerge } from "./list-merge";
import type { ListNoteRef } from "./list-folder";

export interface CollectInput {
  /** Every note in the vault, with bodies. */
  vaultNotes: { filename: string; frontmatter: Frontmatter; body: string }[];
  /** The home Notable Folder selected for this publish. */
  home: { name: string; title: string; target: string };
}

export interface PublishedNote {
  ref: string;
  title: string;
  body: string;
  folder: string | null;
  category: string | null;
  listRender: "cards" | "lines" | null;
  listItems: { ref: string; meta?: string }[] | null;
  isHome: boolean;
  frontmatter: Frontmatter;
}

export interface PublishedSite {
  home: { name: string; title: string; target: string };
  notes: PublishedNote[];
  /** Pre-walked Areas.md → … so the viewer doesn't redo it. */
  taxonomy: {
    areas: { ref: string; categories: { ref: string; folders: string[] }[] }[];
  };
  /** Refs of intermediate Area / Category list files — the viewer
   *  hides them from the Stream like Order does. */
  hiddenRefs: string[];
  generatedAt: string;
}

function parseRef(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const m = val.match(/^\s*\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]\s*$/);
  return m ? m[1].trim() : val.trim() || null;
}

function refOf(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

function pickTitle(n: { filename: string; frontmatter: Frontmatter }): string {
  const t = n.frontmatter.title;
  return typeof t === "string" && t.trim() ? t : refOf(n.filename);
}

function listRenderOf(fm: Frontmatter): "cards" | "lines" | null {
  const v = fm.list;
  if (v === "cards" || v === "lines") return v;
  if (fm.type === "list") return "cards";
  return null;
}

function bulletsOf(body: string): string[] {
  return splitBodyAndBullets(body).items.map((i) => i.ref);
}

export function collectPublishedSite(input: CollectInput): PublishedSite {
  const { vaultNotes, home } = input;
  const byRef = new Map(vaultNotes.map((n) => [refOf(n.filename), n]));

  const noteRefs: ListNoteRef[] = vaultNotes.map((n) => ({
    filename: n.filename,
    frontmatter: n.frontmatter,
    body: n.body,
  }));

  const publics = vaultNotes.filter((n) => n.frontmatter.public === true);
  const notes: PublishedNote[] = publics.map((n) => {
    const lr = listRenderOf(n.frontmatter);
    let items: { ref: string; meta?: string }[] | null = null;
    if (lr !== null) {
      const block = extractBaseBlock(n.body);
      if (block) {
        const parsed = parseBase(block);
        if (parsed) {
          const fmOrder = n.frontmatter.manual_order;
          const saved = Array.isArray(fmOrder)
            ? fmOrder.filter((x): x is string => typeof x === "string")
            : [];
          items = smartMerge(parsed, noteRefs, saved).map((ref) => ({ ref }));
        }
      } else {
        items = splitBodyAndBullets(n.body).items;
      }
    }
    return {
      ref: refOf(n.filename),
      title: pickTitle(n),
      body: n.body,
      folder: parseRef(n.frontmatter.folder),
      category: parseRef(n.frontmatter.category),
      listRender: lr,
      listItems: items,
      isHome: refOf(n.filename) === home.name,
      frontmatter: n.frontmatter,
    };
  });

  // Walk the chain rooted at Areas.md (or any role:areas note).
  const areasNote =
    vaultNotes.find((n) => n.frontmatter.role === "areas")
    ?? vaultNotes.find((n) => n.filename === "Areas.md");
  const areas: { ref: string; categories: { ref: string; folders: string[] }[] }[] = [];
  const hidden = new Set<string>();
  if (areasNote) {
    hidden.add(refOf(areasNote.filename));
    for (const areaRef of bulletsOf(areasNote.body)) {
      hidden.add(areaRef);
      const areaNote = byRef.get(areaRef);
      const cats: { ref: string; folders: string[] }[] = [];
      if (areaNote) {
        for (const catRef of bulletsOf(areaNote.body)) {
          hidden.add(catRef);
          const catNote = byRef.get(catRef);
          cats.push({
            ref: catRef,
            folders: catNote ? bulletsOf(catNote.body) : [],
          });
        }
      }
      areas.push({ ref: areaRef, categories: cats });
    }
  }

  return {
    home,
    notes,
    taxonomy: { areas },
    hiddenRefs: Array.from(hidden),
    generatedAt: new Date().toISOString(),
  };
}
