export type Note = {
  path: string;
  rel_path: string;
  title: string;
  body: string;
  frontmatter: Record<string, any>;
  modified: number;
};

export type FolderName = string;

export function folderOf(n: Note): FolderName {
  const f = n.frontmatter?.folder;
  if (typeof f === "string") return f.replace(/^\[\[|\]\]$/g, "");
  return "Log";
}

export function categoryOf(n: Note): FolderName | null {
  const c = n.frontmatter?.category;
  if (typeof c === "string") return c.replace(/^\[\[|\]\]$/g, "");
  return null;
}

export function isPublic(n: Note): boolean {
  return n.frontmatter?.public === true;
}

export function isMainDocument(n: Note): boolean {
  return categoryOf(n) !== null;
}
