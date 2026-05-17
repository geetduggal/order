// Vault taxonomy: walks the chain of list folders rooted at Areas.md
// (or any note with `role: areas`) to build an Areas → Categories →
// Notable Folder Refs tree. Also: one-time migration that generates
// the chain from the legacy localStorage taxonomy + existing Notable
// Folder Main Docs.

import { extractBaseBlock } from "./list-base";
import {
  isListFolder,
  splitBodyAndBullets,
  serializeListItems,
  type ListItem,
} from "./list-folder";
import {
  joinFrontmatter,
  splitFrontmatter,
  type Frontmatter,
} from "./frontmatter";
import { parseRef } from "./folders";

export const AREAS_FILENAME = "Areas.md";

export interface CategoryNode {
  ref: string;        // filename without .md
  folders: string[];  // Notable Folder refs (filenames without .md)
}
export interface AreaNode {
  ref: string;
  categories: CategoryNode[];
}
export interface VaultTaxonomy {
  areas: AreaNode[];
  /** Refs (filenames without .md) of intermediate Area / Category
   *  list files. Stream view hides these. */
  hiddenRefs: Set<string>;
}

interface ChainNote {
  filename: string;
  body: string;
  frontmatter: Frontmatter;
}

function refOf(filename: string): string {
  return filename.replace(/\.md$/i, "");
}

function bulletsOf(note: ChainNote): string[] {
  // Chain walking is for manual lists only. If the user later turns
  // an Area or Category into a base-driven list, we treat it as
  // empty here (the base block governs membership, not the chain).
  if (extractBaseBlock(note.body)) return [];
  if (!isListFolder(note.frontmatter)) return [];
  return splitBodyAndBullets(note.body).items.map((i) => i.ref);
}

function findAreasNote(notes: ChainNote[]): ChainNote | undefined {
  return notes.find((n) => n.frontmatter.role === "areas")
    ?? notes.find((n) => n.filename === AREAS_FILENAME);
}

export function buildVaultTaxonomy(notes: ChainNote[]): VaultTaxonomy {
  const byRef = new Map(notes.map((n) => [refOf(n.filename), n]));
  const areasNote = findAreasNote(notes);
  if (!areasNote) return { areas: [], hiddenRefs: new Set() };

  const hidden = new Set<string>();
  hidden.add(refOf(areasNote.filename));

  const areaRefs = bulletsOf(areasNote);
  const areas: AreaNode[] = areaRefs.map((areaRef) => {
    hidden.add(areaRef);
    const areaNote = byRef.get(areaRef);
    const catRefs = areaNote ? bulletsOf(areaNote) : [];
    const categories: CategoryNode[] = catRefs.map((catRef) => {
      hidden.add(catRef);
      const catNote = byRef.get(catRef);
      const folderRefs = catNote ? bulletsOf(catNote) : [];
      return { ref: catRef, folders: folderRefs };
    });
    return { ref: areaRef, categories };
  });

  return { areas, hiddenRefs: hidden };
}

// ---------- migration ----------

export interface StoredTaxonomy {
  areas: string[];
  categories: { area: string; name: string }[];
}

export function readStoredTaxonomy(): StoredTaxonomy {
  try {
    const raw = localStorage.getItem("order.taxonomy");
    if (!raw) return { areas: [], categories: [] };
    const parsed = JSON.parse(raw);
    return {
      areas: Array.isArray(parsed.areas)
        ? parsed.areas.filter((x: unknown): x is string => typeof x === "string")
        : [],
      categories: Array.isArray(parsed.categories)
        ? parsed.categories.filter(
            (c: unknown): c is { area: string; name: string } =>
              !!c && typeof c === "object"
              && typeof (c as { area: unknown }).area === "string"
              && typeof (c as { name: unknown }).name === "string",
          )
        : [],
    };
  } catch { return { areas: [], categories: [] }; }
}

interface NoteForMigration {
  filename: string;
  path: string;
  body: string;
  frontmatter: Frontmatter;
}

export interface MigrationPlan {
  /** New files to create. Filename is relative to the cards dir. */
  newFiles: { filename: string; content: string }[];
  /** Notable Folder Main Doc YAML rewrites: absolute path → content. */
  rewrites: { path: string; content: string }[];
}

export function planMigration(
  notes: NoteForMigration[],
  stored: StoredTaxonomy,
): MigrationPlan {
  // Notable Folder Main Docs are notes with a `category` YAML field.
  interface NF { filename: string; path: string; area: string; category: string; frontmatter: Frontmatter; body: string }
  const nfs: NF[] = [];
  for (const n of notes) {
    const cat = parseRef(n.frontmatter.category);
    if (!cat) continue;
    const area = parseRef(n.frontmatter.area) ?? "(unassigned)";
    nfs.push({ filename: n.filename, path: n.path, area, category: cat, frontmatter: n.frontmatter, body: n.body });
  }

  // Union of areas + categories (stored + derived from NF Main Docs).
  const areasSet = new Set<string>(stored.areas);
  for (const nf of nfs) areasSet.add(nf.area);
  const categoriesByArea = new Map<string, Set<string>>();
  for (const a of areasSet) categoriesByArea.set(a, new Set());
  for (const c of stored.categories) {
    if (!categoriesByArea.has(c.area)) categoriesByArea.set(c.area, new Set());
    categoriesByArea.get(c.area)!.add(c.name);
  }
  for (const nf of nfs) {
    if (!categoriesByArea.has(nf.area)) categoriesByArea.set(nf.area, new Set());
    categoriesByArea.get(nf.area)!.add(nf.category);
  }
  const foldersByCategory = new Map<string, string[]>(); // key = `${area}__${category}`
  for (const nf of nfs) {
    const key = `${nf.area}__${nf.category}`;
    if (!foldersByCategory.has(key)) foldersByCategory.set(key, []);
    foldersByCategory.get(key)!.push(refOf(nf.filename));
  }

  const existing = new Set(notes.map((n) => n.filename));
  const newFiles: { filename: string; content: string }[] = [];

  function makeListFile(filename: string, title: string, items: ListItem[], extraFm: Frontmatter = {}) {
    if (existing.has(filename)) return; // don't clobber a real note
    if (newFiles.some((f) => f.filename === filename)) return;
    const body = items.length === 0
      ? `# ${title}\n`
      : `# ${title}\n\n${serializeListItems(items)}\n`;
    const fm: Frontmatter = { list: "cards", ...extraFm };
    newFiles.push({ filename, content: joinFrontmatter(fm, body) });
  }

  // Areas.md
  const orderedAreas = [
    ...stored.areas,
    ...Array.from(areasSet).filter((a) => !stored.areas.includes(a)),
  ];
  makeListFile(
    AREAS_FILENAME,
    "Areas",
    orderedAreas.map((a) => ({ ref: a })),
    { role: "areas" },
  );

  // Area files
  for (const area of areasSet) {
    const cats = Array.from(categoriesByArea.get(area) ?? []);
    makeListFile(`${area}.md`, area, cats.map((c) => ({ ref: c })));
  }

  // Category files. Filename = `${category}.md`; if two areas share a
  // category name, the second uses `${area} - ${category}.md`.
  const usedCatFilenames = new Set<string>();
  for (const [key, folders] of foldersByCategory) {
    const [area, category] = key.split("__");
    let fn = `${category}.md`;
    if (existing.has(fn) || usedCatFilenames.has(fn) || newFiles.some((f) => f.filename === fn)) {
      fn = `${area} - ${category}.md`;
    }
    usedCatFilenames.add(fn);
    makeListFile(fn, category, folders.map((f) => ({ ref: f })));
  }
  // Stored categories that have no folders yet
  for (const c of stored.categories) {
    let fn = `${c.name}.md`;
    if (existing.has(fn) || usedCatFilenames.has(fn) || newFiles.some((f) => f.filename === fn)) {
      fn = `${c.area} - ${c.name}.md`;
    }
    usedCatFilenames.add(fn);
    makeListFile(fn, c.name, []);
  }

  // Rewrites: NF Main Docs swap `type: list` → `list: cards`.
  const rewrites: { path: string; content: string }[] = [];
  for (const nf of nfs) {
    if (nf.frontmatter.type !== "list") continue;
    const fm: Frontmatter = { ...nf.frontmatter };
    delete fm.type;
    fm.list = "cards";
    rewrites.push({ path: nf.path, content: joinFrontmatter(fm, nf.body) });
  }

  return { newFiles, rewrites };
}

// ---------- bullet mutation helper ----------

/** Read a list file, transform its bullet items, write it back.
 *  Returns the new items so the caller can decide whether the
 *  operation succeeded (e.g., a cap-respecting transformer may
 *  return the original list unchanged). */
export async function mutateBullets(
  path: string,
  read: (path: string) => Promise<string>,
  write: (path: string, content: string) => Promise<void>,
  fn: (items: ListItem[]) => ListItem[] | null,
): Promise<boolean> {
  const raw = await read(path);
  const { frontmatter, body } = splitFrontmatter(raw);
  const { prose, items } = splitBodyAndBullets(body);
  const next = fn(items);
  if (next === null) return false;
  const bullets = serializeListItems(next);
  const newBody = bullets
    ? `${prose.replace(/\n+$/, "")}\n\n${bullets}\n`
    : `${prose}\n`;
  await write(path, joinFrontmatter(frontmatter, newBody));
  return true;
}
