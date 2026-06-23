// Session-only ordering for a Notable Folder's card stream (File Piles).
// Pure + dependency-free so it can be unit-tested in isolation.
//
// Order: `front` paths first (in array order), then the default
// `datedNotePaths` not already emitted. Any path in `hidden` or equal to
// `mainDocPath` is removed. Deduplicated — first occurrence wins. The Main
// Document is rendered separately as the section centerpiece, so it is
// excluded here defensively.
export function computePileOrder(
  datedNotePaths: string[],
  front: string[],
  hidden: ReadonlySet<string>,
  mainDocPath?: string | null,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const skip = (p: string) =>
    hidden.has(p) || (mainDocPath != null && p === mainDocPath);
  for (const p of [...front, ...datedNotePaths]) {
    if (seen.has(p) || skip(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
