// Attachments live in <vault>/Attachments/ (Obsidian convention).
// On disk we store paths relative to the vault root so notes are
// portable; in the editor we display absolute asset:// URLs so the
// webview can actually load the bytes.

import { convertFileSrc } from "@tauri-apps/api/core";

export const ATTACHMENTS_DIRNAME = "Attachments";

/** A markdown vault root path → the asset-URL prefix that resolves to
 *  `<vaultRoot>/Attachments/`. Computed by asking convertFileSrc to
 *  encode a probe path and slicing off the probe segment. The probe
 *  uses only unreserved URL chars so it survives percent-encoding. */
export function attachmentAssetPrefix(vaultRoot: string): string {
  const probe = "PROBESENTINEL";
  const sample = convertFileSrc(`${vaultRoot}/${ATTACHMENTS_DIRNAME}/${probe}`);
  const idx = sample.lastIndexOf(probe);
  return idx === -1 ? sample : sample.slice(0, idx);
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
