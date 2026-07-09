// Notable Folder utilities — structural folder identity, deterministic
// per-folder color, and name-based icon auto-selection.
//
// Hierarchy (per design doc):
//   Areas → Categories → Notable Folders → notes
//
// Identity is STRUCTURAL: a Notable Folder's Main Document is the note
// named after its own parent directory (`<NF>/<NF>.md`), and a note
// belongs to the folder whose directory it lives in. There is no
// `folder:` / `category:` / `area:` YAML — spacetime.md plus the
// directory tree are the only sources of truth for placement.

import type { LucideIcon } from "lucide-react";
import {
  BookOpen, Briefcase, Brush, Camera, Code, Coffee, Compass,
  Feather, Flame, Folder, Footprints, Heart, Home, Hourglass,
  Layers, Leaf, Mountain, Music, PenLine, Sparkles, Sun, Tag, Users,
  Wallet, Wrench,
} from "lucide-react";

/** A `[[Wiki Link]]` value or plain string both resolve to the bare name. */
export function parseRef(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^\[\[(.+)\]\]$/);
  return (m ? m[1] : trimmed).trim() || null;
}

/** A Notable Folder main document, identified STRUCTURALLY from its path: a
 *  note named after its own parent directory — `<NF>/<NF>.md`. Prefer this over
 *  isNotableFolder(frontmatter) so main-doc identity comes from structure
 *  (which mirrors spacetime), not the note's `category:` YAML. Returns false
 *  for synthetic paths (e.g. `mw-event:…`) with no parent directory. */
export function isMainDocPath(path: string): boolean {
  const parts = path.split("/");
  if (parts.length < 2) return false;
  const file = parts[parts.length - 1].replace(/\.md$/i, "");
  const dir = parts[parts.length - 2];
  return folderMatchKey(file) === folderMatchKey(dir);
}

/** Normalized comparison key so look-alike folder names collapse to one
 *  identity: Unicode NFC, no-break spaces -> normal space, en/em/figure dashes
 *  -> hyphen, spaces around a hyphen dropped, whitespace collapsed, lowercased.
 *  Lets a directory match its spacetime.mw entry and keeps re-adds idempotent:
 *  "Tech Habits — X", "Tech Habits- X" and "Tech Habits - X" all map to the
 *  same key. For MATCHING only — keep the original spelling for display. */
export function folderKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[   ]/g, " ")        // no-break / figure / narrow-no-break space
    .replace(/[‒–—―]/g, "-")  // figure / en / em / horizontal dash
    .replace(/\s*-\s*/g, "-")                      // drop spaces around hyphens
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The on-disk directory name for a folder: unsafe chars → "-", capped at 78
 *  chars. spacetime.mw stores the FULL name, but the directory is truncated, so
 *  matching a directory to its mw entry must go through this. Mirrors the cap
 *  used when folders are created. */
export function folderDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 78).trim();
}

/** Canonical identity for matching a folder across its full mw name and its
 *  (possibly truncated / differently-dashed) on-disk directory: `folderDirName`
 *  first (the 78-char truncation), then `folderKey` (dash/space/case). Two names
 *  that resolve to the same directory share this key. */
export function folderMatchKey(name: string): string {
  return folderKey(folderDirName(name));
}

/** Structural main-doc test for index shapes that carry the parent
 *  directory name instead of a full path (ListNoteRef / WikiRef): the
 *  note IS a Notable Folder's Main Document when its filename matches
 *  its parent directory. Same identity rule as isMainDocPath. */
export function isMainDocRef(n: { filename: string; folder?: string }): boolean {
  if (!n.folder) return false;
  return folderMatchKey(n.filename.replace(/\.md$/i, "")) === folderMatchKey(n.folder);
}

/** Normalise a slug-style token (CamelCase / PascalCase / kebab-case /
 *  snake_case / mixed) to lowercase words separated by single spaces.
 *  Used by todo.txt's `+project` resolver to fuzzy-match against the
 *  Notable Folder name list. */
export function expandSlugWords(token: string): string {
  return token
    // Insert a separator between a lowercase or digit and a following
    // uppercase letter (camelCase / PascalCase boundary).
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Separator between consecutive uppercase letters when followed by
    // a lowercase one ("HTMLEditor" -> "HTML Editor").
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Letter <-> digit boundaries become word boundaries too, so
    // "NotableFolder1" lines up with "Notable Folder 1".
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    // Treat hyphens / underscores / dots as word separators.
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Resolve a todo.txt `+project` token to a Notable Folder name. Returns
 *  the canonical NF name when a match exists, else null. Matching is
 *  exact after both sides are slug-normalised — "myProject" matches
 *  "My Project" but not "My Big Project". Used by the todo.txt event
 *  layer to associate a calendar item with its parent NF. */
export function resolveProjectToNf(
  token: string,
  nfNames: readonly string[],
): string | null {
  if (!token) return null;
  const needle = expandSlugWords(token);
  for (const name of nfNames) {
    if (expandSlugWords(name) === needle) return name;
  }
  return null;
}

/** Inverse: turn an NF name into the kebab-case form Order writes back
 *  into todo.txt for a newly assigned project. Idempotent — slug-style
 *  inputs survive untouched. */
export function nfNameToProjectSlug(name: string): string {
  return expandSlugWords(name).replace(/\s+/g, "-");
}

// ---------- Curated palette (12 muted tones, readable on white) ----------

const PALETTE = [
  "#A06B7D", // dusty rose
  "#7B91B0", // periwinkle
  "#84A07C", // sage
  "#C19A8B", // dusty tan
  "#9F8DA8", // mauve
  "#3F8A8D", // teal
  "#8E9E5F", // olive
  "#B58A5A", // ochre
  "#6B8AA5", // slate blue
  "#A07A6B", // clay
  "#7AA59E", // muted aqua
  "#9B7B62", // brown
];

/** Stable, deterministic name → palette color. */
export function folderColor(name: string, override?: unknown): string {
  if (typeof override === "string" && override.trim()) return override.trim();
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(h) % PALETTE.length];
}

/** Soft tint of the folder color, for backgrounds. */
export function folderTint(name: string, override?: unknown): string {
  const base = folderColor(name, override);
  // Add 16% alpha — readable on white without overpowering the text.
  return `${base}29`;
}

// ---------- Icon auto-mapping ----------

interface IconRule { rx: RegExp; icon: LucideIcon }

// Order matters: first match wins. Keyword regexes are word-bounded.
const ICON_RULES: IconRule[] = [
  { rx: /\b(book|read|library|literature)/i, icon: BookOpen },
  { rx: /\b(walk|hik|trail|run|jog)/i, icon: Footprints },
  { rx: /\b(people|family|friend|relations?hip)/i, icon: Users },
  { rx: /\b(project|work|task|todo)/i, icon: Briefcase },
  { rx: /\b(health|fit|exercise|body|run)/i, icon: Heart },
  { rx: /\b(home|house|space|room|place)/i, icon: Home },
  { rx: /\b(money|finance|budget|cash|wallet)/i, icon: Wallet },
  { rx: /\b(craft|art|paint|draw|sketch)/i, icon: Brush },
  { rx: /\b(code|tech|programming|dev|software)/i, icon: Code },
  { rx: /\b(write|journal|note|essay|diary|log)/i, icon: PenLine },
  { rx: /\b(photo|camera|picture|image)/i, icon: Camera },
  { rx: /\b(music|song|sound|audio)/i, icon: Music },
  { rx: /\b(food|coffee|cook|meal|drink)/i, icon: Coffee },
  { rx: /\b(plant|garden|nature)/i, icon: Leaf },
  { rx: /\b(travel|map|explor|adventure|trip)/i, icon: Compass },
  { rx: /\b(mountain|outdoor|wild)/i, icon: Mountain },
  { rx: /\b(idea|spark|insight|flash)/i, icon: Sparkles },
  { rx: /\b(habit|routine|daily|practice)/i, icon: Hourglass },
  { rx: /\b(fire|passion|energy|spark)/i, icon: Flame },
  { rx: /\b(weather|sun|morning)/i, icon: Sun },
  { rx: /\b(tool|build|fix|repair)/i, icon: Wrench },
  { rx: /\b(stack|layer|category|group)/i, icon: Layers },
  { rx: /\b(feather|light)/i, icon: Feather },
];

const NAME_TO_LUCIDE: Record<string, LucideIcon> = {
  book: BookOpen, "book-open": BookOpen,
  briefcase: Briefcase,
  brush: Brush, paintbrush: Brush,
  camera: Camera,
  code: Code,
  coffee: Coffee,
  compass: Compass,
  feather: Feather,
  flame: Flame,
  folder: Folder,
  footprints: Footprints,
  heart: Heart,
  home: Home, house: Home,
  hourglass: Hourglass,
  layers: Layers,
  leaf: Leaf,
  mountain: Mountain,
  music: Music,
  pen: PenLine, "pen-line": PenLine, write: PenLine,
  sparkles: Sparkles,
  sun: Sun,
  users: Users, people: Users,
  wallet: Wallet, money: Wallet,
  wrench: Wrench,
};

export function folderIcon(name: string, override?: unknown): LucideIcon {
  if (typeof override === "string" && override.trim()) {
    const key = override.trim().toLowerCase();
    const explicit = NAME_TO_LUCIDE[key];
    if (explicit) return explicit;
  }
  for (const rule of ICON_RULES) {
    if (rule.rx.test(name)) return rule.icon;
  }
  return Folder;
}

/** Icon for a plain list-card item (not a Notable Folder). Same
 *  keyword matcher as folderIcon — "Cal Newport Books" → BookOpen — but
 *  falls back to a neutral Tag glyph instead of Folder, since these rows
 *  don't point at a folder. An explicit `icon:` name still wins. Used by
 *  ListCards so text / non-NF bullets get a large, name-relevant cover
 *  glyph rather than a bare dot. */
export function listItemIcon(name: string, override?: unknown): LucideIcon {
  if (typeof override === "string" && override.trim()) {
    const explicit = NAME_TO_LUCIDE[override.trim().toLowerCase()];
    if (explicit) return explicit;
  }
  for (const rule of ICON_RULES) {
    if (rule.rx.test(name)) return rule.icon;
  }
  return Tag;
}
