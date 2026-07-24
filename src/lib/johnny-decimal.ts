// Johnny-Decimal Mode: prefix every Area, Category, and Notable Folder in the
// Spacetime space with a Johnny.Decimal ID.
//
//   Area      → a range         "10-19 Self-Care"    (areas: 10-19, 20-29, …)
//   Category  → area tens + n   "11 Selfish Projects" (11, 12, … within 10-19)
//   Folder    → category.NN     "11.01 Living Room Refresh"
//
// The transform is computed from the STRIPPED (base) names, so it is
// idempotent: enabling re-derives IDs from scratch, disabling removes them.
// Pure + dependency-light so the numbering is unit-testable in isolation; the
// directory/wikilink cascade lives in the caller.

import type { SpaceNode } from "./spacetime";

const STORAGE_KEY = "order.johnny_decimal";

/** Whether Johnny-Decimal Mode is currently enabled (per-machine setting). */
export function getJohnnyDecimal(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}
export function setJohnnyDecimal(enabled: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0"); } catch { /* non-fatal */ }
}

// A leading JD id: an area range ("10-19"), a folder id ("11.01"), or a bare
// category number ("11"), followed by whitespace.
const JD_PREFIX_RE = /^(?:\d{2,3}-\d{2,3}|\d{2,3}\.\d{2}|\d{2,3})\s+/;

/** True when a name already carries a Johnny.Decimal id prefix. */
export function isJohnnyDecimalName(name: string): boolean {
  return JD_PREFIX_RE.test(name);
}

/** The base name with any leading Johnny.Decimal id removed. Idempotent. */
export function stripJdPrefix(name: string): string {
  return name.replace(JD_PREFIX_RE, "");
}

/** The category's leading JD number ("52 Creative Projects" → "52",
 *  "11 Selfish Projects" → "11"), or null if the category isn't JD-numbered. */
export function categoryJdNumber(categoryName: string): string | null {
  const m = categoryName.match(/^(\d{2,3})[.\s]/);
  return m ? m[1] : null;
}

/** Next available Notable-Folder id for a JD category, e.g. "52.15". Returns
 *  null when the category has no JD number. `siblings` are the folder names
 *  already in that category; the next id is (highest existing NN) + 1 so it
 *  never collides with a kept id, even after deletions. */
export function nextJdFolderId(categoryName: string, siblings: string[]): string | null {
  const cat = categoryJdNumber(categoryName);
  if (!cat) return null;
  let max = 0;
  for (const s of siblings) {
    const m = s.match(/^\d{2,3}\.(\d{2,})\s/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${cat}.${pad2(max + 1)}`;
}

export interface JdMissingRename {
  area: string;
  category: string;
  oldName: string;
  newName: string;
}

/** Assign JD ids to Notable Folders that currently LACK one, WITHOUT disturbing
 *  folders that already have an id (unlike applyJohnnyDecimal, which renumbers
 *  everything positionally). Each un-prefixed folder takes the next free NN in
 *  its category. Only categories that are themselves JD-numbered are touched.
 *  Returns the folder-level renames to apply on disk. */
export function assignMissingJdIds(space: SpaceNode[]): JdMissingRename[] {
  const out: JdMissingRename[] = [];
  for (const area of space) {
    for (const cat of area.children ?? []) {
      const catNum = categoryJdNumber(cat.name);
      if (!catNum) continue;
      let max = 0;
      for (const f of cat.children ?? []) {
        const m = f.name.match(/^\d{2,3}\.(\d{2,})\s/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
      for (const f of cat.children ?? []) {
        if (isJohnnyDecimalName(f.name)) continue;
        max += 1;
        out.push({ area: area.name, category: cat.name, oldName: f.name, newName: `${catNum}.${pad2(max)} ${f.name}` });
      }
    }
  }
  return out;
}

export interface JdRename {
  level: "area" | "category" | "folder";
  /** Current directory segments from the vault root, leaf last — valid so long
   *  as renames are applied deepest-first (folders, then categories, then
   *  areas), which is the order `renames` is returned in. */
  oldSegs: string[];
  oldName: string;
  newName: string;
}

export interface JdResult {
  /** The space with names prefixed (enable) or stripped (disable). */
  space: SpaceNode[];
  /** Renames to apply on disk, ordered deepest-first (folders → categories →
   *  areas). Only entries where the name actually changes are included. */
  renames: JdRename[];
  /** Notable-Folder oldName → newName, for updating event `folder:` fields and
   *  inbound wikilinks. */
  folderRenames: Map<string, string>;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Compute the Johnny-Decimal prefixing (or its removal) for a space tree. */
export function applyJohnnyDecimal(space: SpaceNode[], enable: boolean): JdResult {
  const folderRenames = new Map<string, string>();
  const areaRenames: JdRename[] = [];
  const categoryRenames: JdRename[] = [];
  const folderRenameList: JdRename[] = [];

  const newSpace: SpaceNode[] = space.map((area, ai) => {
    const areaBase = stripJdPrefix(area.name);
    const areaTens = (ai + 1) * 10; // 10, 20, 30, …
    const newAreaName = enable ? `${areaTens}-${areaTens + 9} ${areaBase}` : areaBase;
    if (newAreaName !== area.name) {
      areaRenames.push({ level: "area", oldSegs: [area.name], oldName: area.name, newName: newAreaName });
    }

    const newChildren = area.children.map((cat, ci) => {
      const catBase = stripJdPrefix(cat.name);
      const catNum = areaTens + (ci + 1); // 11, 12, … within 10-19
      const newCatName = enable ? `${catNum} ${catBase}` : catBase;
      if (newCatName !== cat.name) {
        categoryRenames.push({
          level: "category",
          oldSegs: [area.name, cat.name],
          oldName: cat.name,
          newName: newCatName,
        });
      }

      const newFolders = cat.children.map((folder, fi) => {
        const folderBase = stripJdPrefix(folder.name);
        const newFolderName = enable ? `${catNum}.${pad2(fi + 1)} ${folderBase}` : folderBase;
        if (newFolderName !== folder.name) {
          folderRenameList.push({
            level: "folder",
            oldSegs: [area.name, cat.name, folder.name],
            oldName: folder.name,
            newName: newFolderName,
          });
          folderRenames.set(folder.name, newFolderName);
        }
        return { ...folder, name: newFolderName };
      });

      return { ...cat, name: newCatName, children: newFolders };
    });

    return { ...area, name: newAreaName, children: newChildren };
  });

  // Deepest-first: folders rename while their category/area dirs still hold
  // their current names; categories while areas are untouched; areas last.
  return {
    space: newSpace,
    renames: [...folderRenameList, ...categoryRenames, ...areaRenames],
    folderRenames,
  };
}
