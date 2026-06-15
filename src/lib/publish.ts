// Frontend half of the publish pipeline: walk the loaded vault,
// collect every public-flagged note + the chain taxonomy + the
// chosen home, return a JSON-serializable snapshot. The viewer
// (a separate Vite-built React bundle in src-viewer/) consumes this
// at runtime via fetch("./data.json"). Rust copies the bundle and
// writes data.json into the target GitHub repo path.

import type { Frontmatter } from "./frontmatter";
import { splitBodyAndBullets, tightenListSpacing } from "./list-folder";
import { extractBaseBlock, parseBase } from "./list-base";
import { smartMerge } from "./list-merge";
import type { ListNoteRef } from "./list-folder";
import { rewritePublishedImages, type AssetCopy } from "./publish-images";

export interface CollectInput {
  /** Every note in the vault, with bodies. `dir` is the note's vault-
   *  relative directory ("" for root), used to resolve same-folder images.
   *  `mtime` / `ctime` (ms since epoch, optional) flow into the published
   *  payload so base-block sorts on file.mtime / file.ctime work in the
   *  viewer the same way they do in the desktop app. */
  vaultNotes: {
    filename: string;
    dir: string;
    frontmatter: Frontmatter;
    body: string;
    mtime?: number;
    ctime?: number;
  }[];
  /** The home Notable Folder selected for this publish. */
  home: { name: string; title: string; target: string };
  /** Publish subpath (e.g. "order-home") for root-absolute image URLs. */
  sub: string;
}

/** Output of collectPublishedSite: the viewer payload plus the list of
 *  same-folder image files to copy next to their note's published page. */
export interface CollectResult {
  site: PublishedSite;
  assets: AssetCopy[];
}

export interface PublishedNote {
  ref: string;
  title: string;
  /** Stable URL slug, pinned in frontmatter at publish (see CardGrid
   *  handlePublish). Permalinks derive from this, never the title. */
  slug: string;
  body: string;
  folder: string | null;
  category: string | null;
  listRender: "cards" | "lines" | null;
  listItems: { ref: string; meta?: string }[] | null;
  isHome: boolean;
  frontmatter: Frontmatter;
  /** Vault-relative directory of the source note (e.g.
   *  "Home/Stewardship/Stewardship Spaces/Readwise/Full Document
   *  Contents/Articles"). Required by published base blocks whose
   *  filters use `file.folder.contains(…)`. */
  dir: string;
  /** File timestamps (ms since epoch), captured at publish time, so
   *  base-block sorts on file.mtime / file.ctime work in the viewer. */
  mtime?: number;
  ctime?: number;
}

export interface PublishedSite {
  home: { name: string; title: string; target: string };
  notes: PublishedNote[];
  /** Pre-walked Areas.md → … so the viewer doesn't redo it. */
  taxonomy: {
    areas: { ref: string; categories: { ref: string; folders: string[] }[] }[];
  };
  /** Refs of intermediate Area / Category list files — the viewer
   *  hides them from the Pile like Order does. */
  hiddenRefs: string[];
  /** slug → ref, so a permalinked page can deep-link the viewer to the
   *  right note/folder from its URL. */
  slugMap: Record<string, string>;
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

export function collectPublishedSite(input: CollectInput): CollectResult {
  const { vaultNotes, home, sub } = input;
  const byRef = new Map(vaultNotes.map((n) => [refOf(n.filename), n]));

  const noteRefs: ListNoteRef[] = vaultNotes.map((n) => {
    const dir = n.dir ?? "";
    const folder = dir.split("/").pop() ?? "";
    return {
      filename: n.filename,
      frontmatter: n.frontmatter,
      body: n.body,
      dir,
      folder,
      mtime: n.mtime,
      ctime: n.ctime,
    };
  });

  const publics = vaultNotes.filter((n) => n.frontmatter.public === true);
  const assets: AssetCopy[] = [];
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
    const slug = typeof n.frontmatter.slug === "string" ? n.frontmatter.slug : "";
    const rewritten = rewritePublishedImages(tightenListSpacing(n.body), slug, n.dir, sub);
    assets.push(...rewritten.assets);
    return {
      ref: refOf(n.filename),
      title: pickTitle(n),
      slug,
      body: rewritten.body,
      folder: parseRef(n.frontmatter.folder),
      category: parseRef(n.frontmatter.category),
      listRender: lr,
      listItems: items,
      isHome: refOf(n.filename) === home.name,
      frontmatter: n.frontmatter,
      dir: n.dir ?? "",
      mtime: n.mtime,
      ctime: n.ctime,
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

  const slugMap: Record<string, string> = {};
  for (const n of notes) if (n.slug) slugMap[n.slug] = n.ref;

  const site: PublishedSite = {
    home,
    notes,
    taxonomy: { areas },
    hiddenRefs: Array.from(hidden),
    slugMap,
    generatedAt: new Date().toISOString(),
  };
  return { site, assets };
}
