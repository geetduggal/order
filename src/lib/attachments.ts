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
const VIDEO_EXT_RE = /\.(mov|mp4|m4v|webm)$/i;

/** True if `name` looks like an image file (by extension). */
export function isImagePath(name: string): boolean {
  return IMAGE_EXT_RE.test(name.trim());
}

/** True if `name` looks like a video file Obsidian/Order can embed. */
export function isVideoPath(name: string): boolean {
  return VIDEO_EXT_RE.test(name.trim());
}

/** True if `name` is anything we round-trip as a `![[…]]` embed. */
export function isMediaPath(name: string): boolean {
  return isImagePath(name) || isVideoPath(name);
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

// `![[file.png]]` or `![[file.png|640]]` — embed syntax. The optional size
// token (Obsidian pixel width: "640" or "640x480") is captured so a resize
// survives the round-trip.
const IMG_EMBED_RE = /!\[\[\s*([^\]\n|]+?)\s*(?:\|\s*([^\]\n]*?)\s*)?\]\]/g;

// Crepe stores image size as a container-relative `ratio` (in the image's
// alt); Obsidian stores an absolute pixel width. We bridge with
// width = round(ratio * REF) on save and ratio = width / REF on load. The
// ratio round-trips exactly for any REF, so REF only sets the px number
// written for Obsidian — pick ~a content column so it reads sanely.
export const EMBED_REF_WIDTH = 720;

/** Leading positive integer of an Obsidian size token ("640", "640x480"),
 *  else null. */
export function parseEmbedWidth(token: string | undefined): number | null {
  const m = token?.match(/^\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `![[file.png]]` → `![](vaultasset://…/<noteDir>/file.png)` for image
 *  embeds, resolving the file in the note's own folder (`noteDir`,
 *  vault-relative, "" for root). A `|width` token is re-encoded as Crepe's
 *  size ratio (in the alt) so the resize is restored. Non-image embeds are
 *  left untouched. */
export function inflateImageEmbeds(body: string, noteDir: string): string {
  const dir = noteDir ? `${noteDir.replace(/\/+$/, "")}/` : "";
  return body.replace(IMG_EMBED_RE, (full, name: string, size?: string) => {
    const target = name.trim();
    if (isVideoPath(target)) {
      // Emit a bare HTML video block — Milkdown's commonmark turns
      // the open + close tag into one or two `html` schema nodes
      // whose value is the raw text. The video-embed PM plugin
      // (lib/milkdown-video.ts) finds those nodes, hides their
      // literal-text rendering via a node decoration, and mounts a
      // real <video controls playsinline> widget at the same spot.
      // Blank lines above and below make it a CommonMark type-7
      // HTML block so the parser keeps it intact instead of
      // shredding it into inline fragments.
      const url = assetUrl(`${dir}${target}`);
      return `\n\n<video class="order-vault-video" src="${url}" controls playsinline preload="metadata"></video>\n\n`;
    }
    if (!isImagePath(target)) return full;
    const url = assetUrl(`${dir}${target}`);
    const width = parseEmbedWidth(size);
    if (width) return `![${(width / EMBED_REF_WIDTH).toFixed(2)}](${url})`;
    const alt = size?.trim() ?? "";
    return alt ? `![${alt}](${url})` : `![](${url})`;
  });
}

/** Image AND video filenames referenced by `![[file]]` embeds (same-
 *  folder media), e.g. to move them alongside a relocated note.
 *  Legacy `![](Attachments/…)` images live in the shared dir and are
 *  intentionally excluded. */
export function embeddedImageFiles(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(IMG_EMBED_RE)) {
    const file = m[1]?.trim();
    if (file && isMediaPath(file)) out.push(file);
  }
  return out;
}

const VAULTASSET_IMG_RE = /!\[([^\]]*)\]\((vaultasset:\/\/localhost\/[^)\s]+)\)/g;

/** Reverse of inflate, covering BOTH conventions in one pass over the
 *  body's vaultasset image URLs:
 *   - inside the note's own folder   → Obsidian embed `![[file.png]]`
 *   - inside the legacy Attachments/  → markdown `![](Attachments/file.png)`
 *   - anywhere else in the vault      → markdown `![](vault/rel/path.png)`
 *  Supersedes deflateAttachmentUrls. */
export function deflateImageEmbeds(body: string, noteDir: string): string {
  const dir = noteDir ? `${noteDir.replace(/\/+$/, "")}/` : "";
  return body
    // Drop ephemeral blob: images — they can never resolve on disk (a
    // stray Crepe paste artifact). Also consume trailing blank space so
    // we don't leave a dangling empty paragraph.
    .replace(/!\[[^\]]*\]\(blob:[^)\s]+\)[ \t]*\n?/g, "")
    // <video src="vaultasset://…X.mov" ...></video> → ![[X.mov]]
    // (inverse of inflateImageEmbeds for video extensions). Also
    // accepts an optional legacy <div class="order-vault-video-wrap">
    // wrapper from earlier builds.
    .replace(/[ \t]*(?:<div[^>]*class="order-vault-video-wrap"[^>]*>\s*)?<video\b[^>]*?\bsrc="(vaultasset:\/\/localhost\/[^"]+)"[^>]*>\s*<\/video>(?:\s*<\/div>)?[ \t]*\n?/g,
      (_full, url: string) => {
        const rest = url.slice(VAULTASSET_BASE.length);
        let rel = rest;
        try { rel = decodeURI(rest); } catch { /* keep raw */ }
        if (dir && rel.startsWith(dir)) return `![[${rel.slice(dir.length)}]]\n`;
        if (!dir && !rel.includes("/")) return `![[${rel}]]\n`;
        return `![[${rel.split("/").pop()}]]\n`;
      })
    .replace(VAULTASSET_IMG_RE, (_full, alt: string, url: string) => {
    const rest = url.slice(VAULTASSET_BASE.length);
    let rel = rest;
    try { rel = decodeURI(rest); } catch { /* keep raw */ }
    if (rel.startsWith(`${ATTACHMENTS_DIRNAME}/`)) return `![](${rel})`;
    // Preserve a Crepe resize (ratio in the alt) as an Obsidian pixel
    // width; an unresized image (ratio ~1) stays a clean embed.
    const ratio = parseFloat(alt);
    const sized = Number.isFinite(ratio) && Math.abs(ratio - 1) > 0.02;
    const w = sized ? `|${Math.round(ratio * EMBED_REF_WIDTH)}` : "";
    if (dir && rel.startsWith(dir)) return `![[${rel.slice(dir.length)}${w}]]`;
    if (!dir && !rel.includes("/")) return `![[${rel}${w}]]`;
    return `![](${rel})`;
  });
}
