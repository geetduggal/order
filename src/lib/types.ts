// Metadata-only view of a note (snippet for preview, body lazy-loaded).
export type Note = {
  path: string;
  rel_path: string;
  title: string;
  snippet: string;
  frontmatter: Record<string, any>;
  modified: number;
};

// Same shape plus the full markdown body. Returned by read_note(path).
export type NoteWithBody = Note & { body: string };

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
