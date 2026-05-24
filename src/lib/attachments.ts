// Attachments live in <vault>/Attachments/ (Obsidian convention).
// On disk we store paths relative to the vault root so notes are
// portable; in the editor we display vaultasset:// URLs so the webview
// can load the bytes through the custom URI-scheme handler.

export const ATTACHMENTS_DIRNAME = "Attachments";

/** The runtime URL prefix that resolves to the vault's `Attachments/`
 *  dir, served by the custom `vaultasset` URI-scheme handler (lib.rs).
 *  Vault-relative, so it no longer depends on the absolute root — the
 *  Rust side resolves it against the bookmarked / absolute vault. The
 *  `vaultRoot` arg is retained for call-site compatibility but unused. */
export function attachmentAssetPrefix(_vaultRoot?: string): string {
  return `vaultasset://localhost/${ATTACHMENTS_DIRNAME}/`;
}

const MD_IMG_RE = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;

/** Rewrite markdown image URLs that point at the vault's Attachments
 *  dir into the runtime asset:// URL. Leaves all other URLs alone.
 *  encodeURI preserves slashes (for nested subfolders) but escapes
 *  spaces / unicode so the resulting URL is valid. */
export function inflateAttachmentUrls(body: string, assetPrefix: string): string {
  return body.replace(MD_IMG_RE, (full, open, url, close) => {
    if (url.startsWith(`${ATTACHMENTS_DIRNAME}/`)) {
      const rel = url.slice(ATTACHMENTS_DIRNAME.length + 1);
      return `${open}${assetPrefix}${encodeURI(rel)}${close}`;
    }
    return full;
  });
}

/** Reverse of inflate — collapse any asset URL that points inside the
 *  vault's Attachments dir back to its relative form before persisting. */
export function deflateAttachmentUrls(body: string, assetPrefix: string): string {
  return body.replace(MD_IMG_RE, (full, open, url, close) => {
    if (url.startsWith(assetPrefix)) {
      const rest = url.slice(assetPrefix.length);
      // Percent-decoded filename for the on-disk path. The decoded form
      // is what the user (and Obsidian) will see in the markdown.
      let decoded = rest;
      try { decoded = decodeURI(rest); } catch { /* keep raw */ }
      return `${open}${ATTACHMENTS_DIRNAME}/${decoded}${close}`;
    }
    return full;
  });
}

// ---------------------------------------------------------------------------
// Obsidian-style image embeds: `![[file.png]]`, with the file living in the
// SAME folder as the note (Obsidian's attachmentFolderPath: "./", wikilink
// embeds). On disk we keep the `![[…]]` form; in the editor we swap to a
// vaultasset:// URL so the webview can load the bytes. Legacy global
// `![](Attachments/…)` images keep working (coexistence).
// ---------------------------------------------------------------------------

const VAULTASSET_BASE = "vaultasset://localhost/";
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?|heic|heif)$/i;

/** True if `name` looks like an image file (by extension). */
export function isImagePath(name: string): boolean {
  return IMAGE_EXT_RE.test(name.trim());
}

/** Build the vaultasset:// URL for a vault-relative path. encodeURI keeps
 *  slashes (nested folders) but escapes spaces / unicode. */
export function assetUrl(vaultRelPath: string): string {
  return `${VAULTASSET_BASE}${encodeURI(vaultRelPath)}`;
}

/** Vault-relative directory of a path ("" for a root-level note). */
export function vaultDir(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

// `![[file.png]]` or `![[file.png|alias-or-size]]` — embed syntax.
const IMG_EMBED_RE = /!\[\[\s*([^\]\n|]+?)\s*(?:\|[^\]\n]*)?\]\]/g;

/** `![[file.png]]` → `![](vaultasset://…/<noteDir>/file.png)` for image
 *  embeds, resolving the file in the note's own folder (`noteDir`,
 *  vault-relative, "" for root). Non-image embeds are left untouched. */
export function inflateImageEmbeds(body: string, noteDir: string): string {
  const dir = noteDir ? `${noteDir.replace(/\/+$/, "")}/` : "";
  return body.replace(IMG_EMBED_RE, (full, name: string) => {
    const target = name.trim();
    if (!isImagePath(target)) return full;
    return `![](${assetUrl(`${dir}${target}`)})`;
  });
}

const VAULTASSET_IMG_RE = /!\[[^\]]*\]\((vaultasset:\/\/localhost\/[^)\s]+)\)/g;

/** Reverse of inflate, covering BOTH conventions in one pass over the
 *  body's vaultasset image URLs:
 *   - inside the note's own folder   → Obsidian embed `![[file.png]]`
 *   - inside the legacy Attachments/  → markdown `![](Attachments/file.png)`
 *   - anywhere else in the vault      → markdown `![](vault/rel/path.png)`
 *  Supersedes deflateAttachmentUrls. */
export function deflateImageEmbeds(body: string, noteDir: string): string {
  const dir = noteDir ? `${noteDir.replace(/\/+$/, "")}/` : "";
  return body.replace(VAULTASSET_IMG_RE, (_full, url: string) => {
    const rest = url.slice(VAULTASSET_BASE.length);
    let rel = rest;
    try { rel = decodeURI(rest); } catch { /* keep raw */ }
    if (rel.startsWith(`${ATTACHMENTS_DIRNAME}/`)) return `![](${rel})`;
    if (dir && rel.startsWith(dir)) return `![[${rel.slice(dir.length)}]]`;
    if (!dir && !rel.includes("/")) return `![[${rel}]]`;
    return `![](${rel})`;
  });
}
