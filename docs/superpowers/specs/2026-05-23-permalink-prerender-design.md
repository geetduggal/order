# Permalinks via prerender plus takeover — design

## Goal

Give the published Order site real permalinks: each public note and Notable
Folder is a static HTML file at its own URL, containing its content as HTML,
so links resolve with no tricks, crawlers and previews see content, and the
existing Order viewer still takes over for the interactive experience.

## Spike result (the risk Decision 2 named)

Confirmed in Node: `marked` renders note markdown to HTML server-side;
Milkdown Crepe cannot (`new Crepe()` → `document is not defined`). So the
build-time renderer is `marked`; Crepe stays client-only. This avoids
jsdom/puppeteer entirely.

## Architecture: static prerender plus client takeover

This is a layer on top of today's publish, not a rewrite. `collectPublishedSite()`
and the viewer stay.

**Build pass** (in publish, Node-side): for each public note and Notable
Folder, render its body with `marked`, run a rewrite pass (wikilinks →
permalink anchors, `Attachments/...` → root-absolute URLs), wrap it in the
chrome shell + content, and write a real `index.html` at the page's permalink.

**Client takeover** (not strict hydration): every page loads the Order viewer
bundle, which reads the slug from the URL, clears the static `#viewer-root`,
and renders `ViewerApp` deep-linked to that page. Strict `hydrateRoot` is not
usable because the static DOM (marked: `<article>` of `<h1>/<p>`) cannot match
React's render (Crepe: a `.ProseMirror` contenteditable mounted in a
`useEffect` that does not run server-side). So the static layer owns first
paint + crawlability + a resolving permalink; the bundle owns interactivity by
replacing, not attaching.

Trade-off accepted: content renders twice (static, then the SPA swaps in), so a
brief flash is possible on slow loads. The swap lands on the same note, so it
reads as continuous.

## Slugs

A single `slug:` frontmatter field. At publish, any public note or Notable
Folder lacking one gets a slug generated from its title (kebab-case), deduped
against assigned slugs (`salmon`, `salmon-2`, …), and written back into that
file's YAML. Stable thereafter, so renames never orphan a permalink. Publish
therefore writes into vault files on first publish of a note (only the `slug:`
key, only when missing) — a deliberate change from publish being read-only of
the vault. Slugs live only in frontmatter, never in `[[ ]]` syntax.

## Pages, URLs, assets

- One page per public note, one per Notable Folder (its section page).
- Clean directory URLs: each page is written to `<slug>/index.html` (URL
  `/<slug>/`), under the existing publish target (e.g. `order-home/`). The home
  folder's page is the target root `index.html`.
- Attachment URLs are rewritten to root-absolute (`/<publish-path>/Attachments/x.png`)
  so images resolve from a page one level deep. Attachments are copied as today.
- The viewer bundle's own assets are already content-hashed by Vite.

## Wikilink and attachment rewrite

Two hops, per Decision 2: resolve `[[Name]]` to its target file by name via the
shared resolver (`src/lib/wikilink.ts`, now on `main`), read that file's pinned
`slug`, and emit `<a href="/<slug>/">display</a>`. Folder targets use the
folder slug, note targets the note slug. Unresolved links render as a muted
`<span>` with no href, matching the editor. Authoring uses the name; the public
URL uses the slug; publish is the only place the two meet.

## Client takeover handoff

`data.json` gains a `slug → ref` map so the boot can resolve the URL path to a
note/folder without guessing. On load the viewer reads the slug, looks up the
ref, clears `#viewer-root`, and renders `ViewerApp` focused on that page.

## Out of scope (first cut)

- Content-hashed flat `/assets/` for attachments (Decision 2's eventual form);
  root-absolute URLs already resolve, so this is a later caching refinement.
- Per-asset cache headers, sitemap.xml, RSS.
- Incremental publish (only-changed pages); the build re-emits all public pages.

## Build order

Each step is independently checkable; desktop and the existing publish stay
working throughout.

1. Slug auto-pin at publish (frontmatter write + dedupe).
2. Prerender note pages: `marked` → template → `<slug>/index.html`. Verify a
   real file with real content exists.
3. Prerender Notable Folder pages.
4. The wikilink + attachment rewrite pass.
5. Client takeover: URL-slug deep-link + static-content swap; `slug → ref` in
   `data.json`.
6. (Later) content-hashed flat `/assets/` for attachments.
