// Vault migration: strip event YAML frontmatter from notes and archive the
// chain index files (Areas.md, Category.md, Seasons.md) that are superseded
// by spacetime.yml. Pure planning functions — no I/O; CardGrid wires the
// actual reads/writes so the migration runs through the same vault-fs bridge.

import { toIsoDateValue, joinFrontmatter, splitFrontmatter, type Frontmatter } from "./frontmatter";

/** Keys stripped from a note during event-frontmatter migration. `title` is
 *  included because event notes get their name from the filename / h1 body
 *  after migration — the frontmatter title is redundant. */
const EVENT_KEYS: ReadonlySet<string> = new Set([
  "date", "startTime", "endTime", "allDay", "endDate", "folder", "title",
]);

/** True when a note carries event frontmatter that should be stripped. Does
 *  NOT match chain index files — those are handled separately. */
export function isEventNote(fm: Frontmatter, filename: string): boolean {
  if (!toIsoDateValue(fm.date)) return false;
  if (fm.role) return false;              // Areas.md / Seasons.md guard
  if (fm.list === "cards" || fm.list === "lines") return false; // list notes
  if (typeof fm.category === "string" && fm.category) return false; // NF main doc
  if (filename === "spacetime.yml" || filename === "spacetime.mw") return false;
  return true;
}

/** True for chain index files superseded by spacetime.yml. */
export function isChainIndex(fm: Frontmatter, filename: string): boolean {
  if (fm.role === "areas" || filename === "Areas.md") return true;
  if (fm.role === "seasons" || filename === "Seasons.md") return true;
  // list: cards files that don't have a `category:` are Area/Category index
  // files (not NF main docs). NF main docs always carry `category:`.
  if ((fm.list === "cards" || fm.list === "lines") && !fm.category) return true;
  return false;
}

/** Strip only the event-related frontmatter keys from a raw note string.
 *  If the remaining frontmatter is empty, the frontmatter block is dropped
 *  entirely, leaving a clean body-only file. */
export function stripEventFrontmatter(raw: string): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  const rest: Frontmatter = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (!EVENT_KEYS.has(k)) rest[k] = v;
  }
  return Object.keys(rest).length > 0 ? joinFrontmatter(rest, body) : body;
}

export interface StripAction {
  kind: "stripFrontmatter";
  path: string;
  newContent: string;
}
export interface ArchiveAction {
  kind: "archiveChainFile";
  /** Vault-relative source path. */
  path: string;
  /** Vault-relative destination inside `.order-legacy/chain/`. */
  archivePath: string;
}
export type MigrationAction = StripAction | ArchiveAction;

/** Build the migration plan from a snapshot of the vault's notes. Pure —
 *  call with the current `notes` array (already has body + frontmatter).
 *  Returns the ordered list of actions to execute. */
export function planVaultMigration(
  notes: { path: string; filename: string; frontmatter: Frontmatter; body: string; raw: string }[],
  archiveDir = ".order-legacy/chain",
): MigrationAction[] {
  const actions: MigrationAction[] = [];
  for (const n of notes) {
    if (isChainIndex(n.frontmatter, n.filename)) {
      actions.push({
        kind: "archiveChainFile",
        path: n.path,
        archivePath: `${archiveDir}/${n.filename}`,
      });
    } else if (isEventNote(n.frontmatter, n.filename)) {
      const newContent = stripEventFrontmatter(n.raw);
      if (newContent !== n.raw) {
        actions.push({ kind: "stripFrontmatter", path: n.path, newContent });
      }
    }
  }
  return actions;
}
