// Publish-time image rewriting. Notes store images two ways:
//   - Obsidian same-folder embeds: `![[img.png]]`  (Phase A)
//   - legacy global markdown:       `![](Attachments/img.png)`
// For the published site both must become root-absolute URLs so they
// resolve from a note's permalink page (which lives one level deep at
// `/<sub>/<slug>/`), and the same-folder files must be copied to sit
// next to that page so a direct image URL works.

import { isImagePath } from "./attachments";

/** A file to copy at publish time: `from` is vault-relative, `to` is
 *  relative to the publish target dir. */
export interface AssetCopy {
  from: string;
  to: string;
}

const IMG_EMBED_RE = /!\[\[\s*([^\]\n|]+?)\s*(?:\|[^\]\n]*)?\]\]/g;
const MD_ATTACH_RE = /(!\[[^\]]*\]\()(?:\.\/)?Attachments\/([^)\s]+)(\))/g;

/** Rewrite a note's image refs to published absolute URLs and collect the
 *  same-folder image files that must be copied next to the note's page.
 *
 *  - `![[img.png]]`       → `![](/<sub>/<slug>/img.png)`  (+ copy
 *    `<noteDir>/img.png` → `<slug>/img.png`)
 *  - `![](Attachments/x)` → `![](/<sub>/Attachments/x)`   (the Attachments
 *    dir is copied wholesale by the Rust side)
 *
 *  `noteDir` is the note's vault-relative directory ("" for root). When
 *  `slug` is empty (shouldn't happen post slug-pin) the body is returned
 *  unchanged.
 */
export function rewritePublishedImages(
  body: string,
  slug: string,
  noteDir: string,
  sub: string,
): { body: string; assets: AssetCopy[] } {
  const assets: AssetCopy[] = [];
  if (!slug) return { body, assets };
  const dir = noteDir ? `${noteDir.replace(/\/+$/, "")}/` : "";

  let out = body.replace(IMG_EMBED_RE, (full, name: string) => {
    const file = name.trim();
    if (!isImagePath(file)) return full; // non-image embed: leave it
    assets.push({ from: `${dir}${file}`, to: `${slug}/${file}` });
    return `![](/${sub}/${slug}/${encodeURI(file)})`;
  });

  out = out.replace(MD_ATTACH_RE, (_full, open: string, rest: string, close: string) =>
    `${open}/${sub}/Attachments/${rest}${close}`,
  );

  return { body: out, assets };
}
