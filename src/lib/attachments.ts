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
