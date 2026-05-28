// Thin TS wrapper over the Rust vault-relative FS bridge (vault_fs.rs).
// Every file read/write/list/rename/remove the frontend does goes
// through here with paths RELATIVE to the vault root. The Rust side
// resolves them against the root set via setRoot (an absolute path on
// desktop; the bookmark-resolved path on iOS), so the frontend never
// handles absolute paths — which is what lets it run in the iOS sandbox.

import { invoke } from "@tauri-apps/api/core";

export interface VaultDirEntry { name: string; isDir: boolean }
export interface VaultStat { mtime: number; size: number }
export interface VaultFolder { path: string | null; name: string | null }

/** Frontmatter-only walk entry (see vault_walk_metadata in vault_fs.rs).
 *  Bodies are deliberately stripped on the Rust side — the per-note
 *  payload is just enough to drive filtering, sort, sidebar, taxonomy,
 *  and masonry size estimation. Bodies are fetched lazily per Card via
 *  readText once they're actually rendered. */
export interface VaultMetaEntry {
  path: string;
  filename: string;
  /** Raw YAML between the `---` fences, or "" when none. Parsed once on
   *  arrival by splitFrontmatter. */
  frontmatterYaml: string;
  /** Byte length of the body section — masonry row-span estimate. */
  bodyLen: number;
  /** Last-modified time in Unix-epoch ms; cache freshness key. */
  mtimeMs: number;
}

// Self-write tracking. When we write to a path, the Rust-side filesystem
// watcher (and our mtime poller) will shortly see the change — but that's
// our own write, not an external edit, and treating it like an external
// change would yank the editor out from under the user mid-keystroke.
// Every write through this bridge stamps the path with an expiration; the
// watcher and poller treat paths inside the window as self-changes and
// skip them. The TTL is intentionally long enough to cover the Rust 500ms
// debounce, slow-sync filesystems (Dropbox / iCloud), AND the next poller
// cycle — otherwise the watcher could consume the stamp before the poller
// gets to it, and the poller would re-classify the same mtime change as
// external. Re-stamping the same path resets the window.
const SELF_WRITE_TTL_MS = 6000;
const selfWrites = new Map<string, number>();
export function markSelfWrite(rel: string): void {
  selfWrites.set(rel, Date.now() + SELF_WRITE_TTL_MS);
}
/** Peek-only check: returns true if `absOrRel` matches a path we wrote
 *  within the TTL. Does NOT consume the stamp — both the watcher and
 *  the poller can see it through the window. Absolute paths are matched
 *  by suffix against any vault-relative entry, so the watcher (which
 *  reports absolute paths) can call this without knowing the vault root. */
export function consumeSelfWrite(absOrRel: string): boolean {
  const now = Date.now();
  for (const [p, exp] of selfWrites) if (exp <= now) selfWrites.delete(p);
  if (selfWrites.has(absOrRel)) return true;
  for (const p of selfWrites.keys()) {
    if (absOrRel.endsWith(p) || absOrRel.endsWith(`/${p}`)) return true;
  }
  return false;
}

export const vaultFs = {
  setRoot: (path: string) => invoke<void>("vault_set_root", { path }),
  isIos: () => invoke<boolean>("vault_is_ios"),
  /** Recursive .md walk under the root (absolute paths). Works on
   *  desktop and under iOS scoped access — the JS plugin-fs walk can't
   *  reach a bookmarked iOS folder. */
  walk: (): Promise<{ path: string; filename: string }[]> =>
    invoke<{ path: string; name: string }[]>("vault_walk").then((es) =>
      es.map((e) => ({ path: e.path, filename: e.name })),
    ),
  /** Frontmatter-only walk. Returns one MetaEntry per .md without
   *  shipping any body bytes across the bridge — the scaling-tier
   *  fast path for index loading. Use readText for bodies on demand. */
  walkMetadata: (): Promise<VaultMetaEntry[]> =>
    invoke<{ path: string; name: string; frontmatter: string; body_len: number; mtime_ms: number }[]>(
      "vault_walk_metadata",
    ).then((es) =>
      es.map((e): VaultMetaEntry => ({
        path: e.path,
        filename: e.name,
        frontmatterYaml: e.frontmatter,
        bodyLen: e.body_len,
        mtimeMs: e.mtime_ms,
      })),
    ),
  /** iOS: present the folder picker, mint + persist a bookmark, return
   *  the resolved path + name (path null if cancelled). */
  pickFolder: () => invoke<VaultFolder>("plugin:vault|pick_folder"),
  /** iOS: resolve the saved bookmark, open scoped access for the
   *  session, return its path (null if none/stale → re-pick). */
  restore: () => invoke<VaultFolder>("plugin:vault|restore"),
  readText: (rel: string) => invoke<string>("vault_read_text", { rel }),
  writeText: (rel: string, content: string) => {
    markSelfWrite(rel);
    return invoke<void>("vault_write_text", { rel, content });
  },
  writeBinary: (rel: string, bytes: number[]) => {
    markSelfWrite(rel);
    return invoke<void>("vault_write_binary", { rel, bytes });
  },
  readDir: (rel: string) =>
    invoke<{ name: string; is_dir: boolean }[]>("vault_read_dir", { rel }).then((es) =>
      es.map((e): VaultDirEntry => ({ name: e.name, isDir: e.is_dir })),
    ),
  exists: (rel: string) => invoke<boolean>("vault_exists", { rel }),
  stat: (rel: string) => invoke<VaultStat>("vault_stat", { rel }),
  rename: (from: string, to: string) => {
    markSelfWrite(from); markSelfWrite(to);
    return invoke<void>("vault_rename", { from, to });
  },
  remove: (rel: string) => {
    markSelfWrite(rel);
    return invoke<void>("vault_remove", { rel });
  },
};
