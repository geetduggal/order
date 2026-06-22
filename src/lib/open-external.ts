// Open an http(s) / mailto / tel URL in the user's DEFAULT app (Safari, Mail,
// Phone) — never inside Order's own WebView. On Tauri this shells out via the
// `open_url` command (iOS routes it to UIApplication.open → a real app switch);
// in the published web viewer it's a plain new tab.

/** Schemes we hand off to the OS instead of navigating inside the app. */
export const EXTERNAL_SCHEME_RE = /^(https?|mailto|tel):/i;

export function openExternalUrl(url: string): void {
  const u = url.trim();
  if (!u) return;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    // Dynamic import keeps the viewer build (no @tauri-apps/api) tree-shakeable.
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("open_url", { url: u }).catch((err) => {
        console.warn("open_url failed, falling back:", err);
        const opened = window.open(u, "_blank");
        if (!opened) window.location.href = u;
      }),
    );
    return;
  }
  window.open(u, "_blank", "noopener,noreferrer");
}
