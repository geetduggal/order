// Given a list folder's body + frontmatter + the vault index, return
// its rendered items — manual bullets when no base block is present,
// smart-merged base results otherwise. Pure module: no I/O, no React.

import { extractBaseBlock, parseBase } from "./list-base";
import {
  isListFolder,
  splitBodyAndBullets,
  type ListItem,
  type ListNoteRef,
} from "./list-folder";
import { smartMerge } from "./list-merge";
import type { Frontmatter } from "./frontmatter";

export function resolveListItems(
  frontmatter: Frontmatter,
  body: string,
  vaultNotes: ListNoteRef[],
): ListItem[] {
  if (!isListFolder(frontmatter)) return [];
  const block = extractBaseBlock(body);
  if (block) {
    const parsed = parseBase(block);
    if (!parsed) return [];
    const fmOrder = frontmatter.manual_order;
    const savedOrder = Array.isArray(fmOrder)
      ? fmOrder.filter((x): x is string => typeof x === "string")
      : [];
    return smartMerge(parsed, vaultNotes, savedOrder).map((ref) => ({ ref }));
  }
  return splitBodyAndBullets(body).items;
}
