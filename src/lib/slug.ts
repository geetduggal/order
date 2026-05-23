// Stable URL slugs. Derived once from a title and then pinned in
// frontmatter, never recomputed from the title, so renames don't orphan
// permalinks.

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "") // strip diacritics
      .replace(/[^a-z0-9]+/g, "-") // non-alphanumerics → hyphen
      .replace(/^-+|-+$/g, "") // trim hyphens
      .slice(0, 80) || "untitled"
  );
}

/** Append -2, -3, … until the slug is unique within `taken`. */
export function dedupeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
