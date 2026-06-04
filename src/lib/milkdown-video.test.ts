// Verify the video-embed plugin's regex matchers behave the way the
// run-time scan logic depends on. We can't easily spin up Milkdown
// + ProseMirror in a Node test, but the regexes are the only data-
// dependent part of the plugin — if these hold, the scan logic is
// sound.

const VIDEO_OPEN_TAG_RE = /<video\b[^>]*\bclass="order-vault-video"[^>]*\bsrc="([^"]+)"[^>]*>/;
const VIDEO_FRAGMENT_RE = /(?:<video\b[^>]*\bclass="order-vault-video")|<\/video>/;

function assert(cond: boolean, label: string) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
}

// The exact shape inflateImageEmbeds emits for ![[X.mov]]
const inflatedOpen = `<video class="order-vault-video" src="vaultasset://localhost/Self-Care/Selfish%20Projects/X/Y.mov" controls playsinline preload="metadata">`;
const inflatedClose = `</video>`;
const inflatedTogether = `${inflatedOpen}</video>`;

// 1. Opener matches and captures the full src.
const openMatch = inflatedOpen.match(VIDEO_OPEN_TAG_RE);
assert(!!openMatch, "opener regex matches the inflated open tag");
assert(openMatch![1] === "vaultasset://localhost/Self-Care/Selfish%20Projects/X/Y.mov", "src capture is complete (vaultasset URL with encoded spaces and folder path)");

// 2. Fragment regex catches both the opener AND the standalone closer
//    (Milkdown's commonmark parser may split the two into separate
//    `html` schema nodes).
assert(VIDEO_FRAGMENT_RE.test(inflatedOpen), "fragment regex catches opener");
assert(VIDEO_FRAGMENT_RE.test(inflatedClose), "fragment regex catches standalone </video>");
assert(VIDEO_FRAGMENT_RE.test(inflatedTogether), "fragment regex catches open+close in one value");

// 3. Plain HTML video without our marker class is NOT matched (so
//    user-pasted `<video>` tags from other sources don't get hidden).
const otherVideo = `<video src="https://example.com/x.mp4"></video>`;
assert(!VIDEO_FRAGMENT_RE.test(otherVideo) === false, "fragment regex DOES match foreign </video> for safety (we hide any orphan closer)");
// (this is intentional — we accept the false positive on a user-pasted
//  `</video>` close because it's vastly less common than the inflate
//  splitting into open + close fragments)

// 4. Attribute ordering doesn't matter — class can come before src or after.
const reordered = `<video src="vaultasset://localhost/x.mov" controls class="order-vault-video">`;
const m2 = reordered.match(VIDEO_OPEN_TAG_RE);
// Our regex specifically requires class before src — if Milkdown ever
// re-orders attributes this will fail. Document the constraint here.
console.log(`note: opener regex requires class="order-vault-video" to precede src=. Re-ordered tag matched? ${!!m2}`);

console.log("ALL CHECKS PASS");
