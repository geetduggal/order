// Single source of truth for where the vault lives. Notes can sit
// at vault root or in nested per-Notable-Folder directories; the
// old `dirname(dirname(cardPath))` trick only worked at one depth.
// Calling vaultRoot() everywhere is robust to any layout.

import { homeDir, join } from "@tauri-apps/api/path";
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

// Last absolute root pushed to the Rust bridge. Cached so toVaultRel can
// strip it synchronously at FS call sites without an await.
let cachedRoot: string | null = null;

// Cached platform check (iOS vs desktop) — the vault source differs.
let cachedIsIos: boolean | null = null;
export async function isIos(): Promise<boolean> {
  if (cachedIsIos === null) {
    try { cachedIsIos = await vaultFs.isIos(); } catch { cachedIsIos = false; }
  }
  return cachedIsIos;
}

/** Synchronous read of the cached platform flag — valid only after the
 *  first isIos()/syncVaultRoot() call (which the load path always runs
 *  before this is read). Returns false until then. */
export function isIosSync(): boolean {
  return cachedIsIos === true;
}

/** Resolve the effective vault root AND push it to the Rust FS bridge,
 *  so vault-relative commands (vaultFs.*) resolve correctly. Called at
 *  the start of every load. On desktop the root is the home-dir path (or
 *  Settings override); on iOS it's the security-scoped bookmark resolved
 *  by the native plugin, or "" when no vault has been picked yet (the
 *  caller then prompts a pick). Returns the absolute root. */
export async function syncVaultRoot(): Promise<string> {
  if (await isIos()) {
    let root = "";
    try { root = (await vaultFs.restore()).path ?? ""; } catch { root = ""; }
    cachedRoot = root;
    if (root) await vaultFs.setRoot(root);
    return root;
  }
  const root = await vaultRoot();
  cachedRoot = root;
  await vaultFs.setRoot(root);
  return root;
}

/** Convert an absolute path under the vault to a vault-relative path for
 *  the vaultFs bridge. Idempotent: an already-relative path (no leading
 *  cached root, no leading "/") passes through unchanged, so call sites
 *  can wrap any path without knowing which form they hold. */
export function toVaultRel(p: string): string {
  if (cachedRoot) {
    if (p === cachedRoot) return "";
    const prefix = cachedRoot.endsWith("/") ? cachedRoot : `${cachedRoot}/`;
    if (p.startsWith(prefix)) return p.slice(prefix.length);
  }
  return p.replace(/^\/+/, "");
}

/** Walk every `.md` file under the vault, skipping the Attachments
 *  dir and any dotfiles. Returns absolute paths + basenames.
 *  Recursive because Notable Folder Main Docs may live one or more
 *  directories deep. */
export async function walkVaultMarkdown(): Promise<{ path: string; filename: string }[]> {
  // syncVaultRoot first so the Rust bridge has the current root, then walk
  // via the Rust command (works on desktop and under iOS scoped access;
  // returns absolute paths). Empty root => no vault picked yet (iOS).
  const root = await syncVaultRoot();
  if (!root) return [];
  return vaultFs.walk();
}
