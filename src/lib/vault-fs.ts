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
  /** iOS: present the folder picker, mint + persist a bookmark, return
   *  the resolved path + name (path null if cancelled). */
  pickFolder: () => invoke<VaultFolder>("plugin:vault|pick_folder"),
  /** iOS: resolve the saved bookmark, open scoped access for the
   *  session, return its path (null if none/stale → re-pick). */
  restore: () => invoke<VaultFolder>("plugin:vault|restore"),
  readText: (rel: string) => invoke<string>("vault_read_text", { rel }),
  writeText: (rel: string, content: string) =>
    invoke<void>("vault_write_text", { rel, content }),
  writeBinary: (rel: string, bytes: number[]) =>
    invoke<void>("vault_write_binary", { rel, bytes }),
  readDir: (rel: string) =>
    invoke<{ name: string; is_dir: boolean }[]>("vault_read_dir", { rel }).then((es) =>
      es.map((e): VaultDirEntry => ({ name: e.name, isDir: e.is_dir })),
    ),
  exists: (rel: string) => invoke<boolean>("vault_exists", { rel }),
  stat: (rel: string) => invoke<VaultStat>("vault_stat", { rel }),
  rename: (from: string, to: string) => invoke<void>("vault_rename", { from, to }),
  remove: (rel: string) => invoke<void>("vault_remove", { rel }),
};
