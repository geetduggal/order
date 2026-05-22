// Single source of truth for where the vault lives. Notes can sit
// at vault root or in nested per-Notable-Folder directories; the
// old `dirname(dirname(cardPath))` trick only worked at one depth.
// Calling vaultRoot() everywhere is robust to any layout.

import { homeDir, join } from "@tauri-apps/api/path";
import { readDir } from "@tauri-apps/plugin-fs";
import { ATTACHMENTS_DIRNAME } from "./attachments";
import { vaultFs } from "./vault-fs";

// Vault location relative to the home dir. Per-machine default via a
// gitignored `.env.local` (VITE_VAULT_SUBPATH=...); the in-app
// Settings folder picker overrides it (absolute path in localStorage)
// so moving between machines never needs a code or env edit.
export const VAULT_SUBPATH = import.meta.env.VITE_VAULT_SUBPATH ?? "Documents/Dropbox/Home";

const VAULT_PATH_KEY = "order.vaultPath";

/** Absolute vault path chosen in Settings, or null to use the default. */
export function getVaultOverride(): string | null {
  try { return localStorage.getItem(VAULT_PATH_KEY); } catch { return null; }
}
export function setVaultOverride(path: string | null): void {
  try {
    if (path) localStorage.setItem(VAULT_PATH_KEY, path);
    else localStorage.removeItem(VAULT_PATH_KEY);
  } catch { /* non-fatal */ }
}

/** The env/default vault path (ignores any Settings override). */
export async function defaultVaultRoot(): Promise<string> {
  const home = await homeDir();
  return join(home, VAULT_SUBPATH);
}

/** The effective vault root: a Settings override if set, else the
 *  env/default location. */
export async function vaultRoot(): Promise<string> {
  const override = getVaultOverride();
  if (override) return override;
  return defaultVaultRoot();
}

/** Resolve the effective vault root AND push it to the Rust FS bridge,
 *  so vault-relative commands (vaultFs.*) resolve correctly. Called at
 *  the start of every load and whenever the vault override changes.
 *  Returns the absolute root for callers that still need it. */
export async function syncVaultRoot(): Promise<string> {
  const root = await vaultRoot();
  await vaultFs.setRoot(root);
  return root;
}

/** Walk every `.md` file under the vault, skipping the Attachments
 *  dir and any dotfiles. Returns absolute paths + basenames.
 *  Recursive because Notable Folder Main Docs may live one or more
 *  directories deep. */
export async function walkVaultMarkdown(): Promise<{ path: string; filename: string }[]> {
  // syncVaultRoot (not vaultRoot) so the Rust FS bridge always has the
  // current root before any vault-relative op runs this load cycle.
  const root = await syncVaultRoot();
  const out: { path: string; filename: string }[] = [];
  await walk(root);
  return out;

  async function walk(dir: string): Promise<void> {
    let entries: { name?: string; isFile?: boolean; isDirectory?: boolean }[] = [];
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      if (!name) continue;
      if (name.startsWith(".")) continue;
      if (name === ATTACHMENTS_DIRNAME) continue;
      const full = await join(dir, name);
      if (e.isDirectory) {
        await walk(full);
      } else if (name.endsWith(".md")) {
        out.push({ path: full, filename: name });
      }
    }
  }
}
