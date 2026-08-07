// A durable "open this card fullscreen" intent, decoupled from render timing.
//
// The prop-based `wantFullscreen` path (CardGrid's `fullscreenPath`) expires on
// an 800ms timer — fine for opening an already-mounted card (calendar → note),
// but a *freshly created* note/chat can take longer than that to mount on a
// phone (state batch → derive sections → expand the newspaper section → masonry
// layout → Card mount). By then the window has closed and it never opens.
//
// This intent has no expiry: it's held until the target Card mounts and consumes
// it, and a window event covers the already-mounted case. Keys are normalized to
// the vault-relative path so an absolute optimistic path and a reloaded/relative
// path (iOS) still match.

import { toVaultRel } from "./vault";

const pending = new Set<string>();
const EVENT = "order:want-fullscreen";
const norm = (p: string) => { try { return toVaultRel(p); } catch { return p; } };

// How long an unconsumed intent lives. Long enough to cover a slow-phone mount
// of a freshly created note/chat (the persistent re-arms run out to ~1.2s, then
// the card still has to mount), but short enough that an intent whose target
// never mounts in the current view can't fire much later — e.g. when the user
// switches to the Pile and that card finally mounts, reopening an event
// unexpectedly (#39).
const INTENT_TTL_MS = 6000;

/** Ask for `path` to open fullscreen — now if it's mounted, else on its mount. */
export function requestFullscreen(path: string): void {
  const key = norm(path);
  pending.add(key);
  // Auto-expire so a never-consumed intent doesn't leak into a later view.
  setTimeout(() => pending.delete(key), INTENT_TTL_MS);
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: key })); } catch { /* noop */ }
}

/** Like requestFullscreen, but re-arms a few times so a card that mounts late
 *  (slow phone) or briefly remounts (a reload minting a new id) still catches it. */
export function requestFullscreenPersistent(path: string): void {
  requestFullscreen(path);
  setTimeout(() => requestFullscreen(path), 350);
  setTimeout(() => requestFullscreen(path), 1200);
}

/** A mounting Card calls this; returns true if it was asked to open fullscreen. */
export function consumeFullscreenIntent(path: string): boolean {
  return pending.delete(norm(path));
}

/** A mounted Card subscribes to catch a request that arrives while it's alive.
 *  The handler fires when the requested (normalized) path matches this card. */
export function onFullscreenRequest(matchPath: string, handler: () => void): () => void {
  const want = norm(matchPath);
  const fn = (e: Event) => { if ((e as CustomEvent<string>).detail === want) handler(); };
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
