// iOS attachment-image loader.
//
// On iOS, the `vaultasset://` custom URI scheme doesn't reach `<img>` elements
// in WKWebView (notes, which load over the IPC bridge, work fine — the scheme
// is the odd one out). So on iOS we route images through the SAME IPC path:
// fetch the bytes via `vault_read_asset_bytes` and swap the element's src for a
// blob: URL. A MutationObserver keeps up with Milkdown / React re-renders.
//
// Desktop is untouched — the scheme works there, so this never runs.

import { invoke } from "@tauri-apps/api/core";
import { isIos } from "./vault";

const cache = new Map<string, string>(); // vault-rel path → blob: URL
const inflight = new Set<string>();

function relFromVaultasset(url: string | null): string | null {
  if (!url) return null;
  const m = /^vaultasset:\/\/localhost\/(.+)$/.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function mimeFor(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "heic": return "image/heic";
    case "bmp": return "image/bmp";
    default: return "application/octet-stream";
  }
}

async function swap(img: HTMLImageElement): Promise<void> {
  const rel = relFromVaultasset(img.getAttribute("src"));
  if (!rel) return;
  const cached = cache.get(rel);
  if (cached) { if (img.src !== cached) img.src = cached; return; }
  if (inflight.has(rel)) return;
  inflight.add(rel);
  try {
    const buf = await invoke<ArrayBuffer>("vault_read_asset_bytes", { rel });
    const url = URL.createObjectURL(new Blob([buf], { type: mimeFor(rel) }));
    cache.set(rel, url);
    // Point every img still on this rel at the blob (there may be several).
    document.querySelectorAll<HTMLImageElement>('img[src^="vaultasset://"]').forEach((el) => {
      if (relFromVaultasset(el.getAttribute("src")) === rel) el.src = url;
    });
  } catch {
    /* leave the original src — nothing better to show */
  } finally {
    inflight.delete(rel);
  }
}

function scan(root: ParentNode): void {
  root.querySelectorAll('img[src^="vaultasset://"]').forEach((img) => void swap(img as HTMLImageElement));
}

/** Start the iOS image loader (no-op on desktop). */
export async function initIosImageLoader(): Promise<void> {
  if (!(await isIos())) return;
  scan(document);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === "attributes") {
        const t = m.target;
        if (t instanceof HTMLImageElement && t.getAttribute("src")?.startsWith("vaultasset://")) void swap(t);
        continue;
      }
      m.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n instanceof HTMLImageElement && n.getAttribute("src")?.startsWith("vaultasset://")) void swap(n);
        else scan(n);
      });
    }
  });
  obs.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src"],
  });
}
