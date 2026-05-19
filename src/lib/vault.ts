// Single source of truth for where the vault lives. Notes can sit
// at vault root or in nested per-Notable-Folder directories; the
// old `dirname(dirname(cardPath))` trick only worked at one depth.
// Calling vaultRoot() everywhere is robust to any layout.

import { homeDir, join } from "@tauri-apps/api/path";
import { readDir } from "@tauri-apps/plugin-fs";
import { ATTACHMENTS_DIRNAME } from "./attachments";

export const VAULT_SUBPATH = "Development/Home";

export async function vaultRoot(): Promise<string> {
  const home = await homeDir();
  return join(home, VAULT_SUBPATH);
}

/** Walk every `.md` file under the vault, skipping the Attachments
 *  dir and any dotfiles. Returns absolute paths + basenames.
 *  Recursive because Notable Folder Main Docs may live one or more
 *  directories deep. */
export async function walkVaultMarkdown(): Promise<{ path: string; filename: string }[]> {
  const root = await vaultRoot();
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
