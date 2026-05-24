# Permalinks via Prerender + Takeover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish each public note and Notable Folder as a real static HTML page at its own `/<slug>/` permalink, with the Order viewer bundle taking over for interactivity.

**Architecture:** At publish, the frontend pins a stable `slug` into each public note's frontmatter, renders its body to content HTML with `marked` (rewriting `[[links]]`→`/<slug>/` and `Attachments/`→root-absolute), and hands the Rust side a list of pages. Rust wraps each page's content in the viewer bundle's shell (rewriting asset/data URLs to root-absolute and injecting `window.__ORDER__`), and writes `<slug>/index.html`. The viewer reads `window.__ORDER__` to fetch data.json and deep-link; `createRoot` replaces the static content (takeover, not hydration).

**Tech Stack:** TypeScript, React, `marked` (already a dep), Tauri/Rust, the wikilink resolver (`src/lib/wikilink.ts`, on main).

**Branch:** off freshly-merged `main` (`git checkout main && git pull && git checkout -b order/permalinks`). Commit per task. No `Co-Authored-By`. Don't commit `docs/superpowers/`.

**Verification note:** slug + prerender logic are pure → Node-checkable (bundle a scratch `.mjs` with esbuild like `wikilink.ts` was checked). Rust → `cargo build`. The deployed page (assets + data.json resolving under `/order-home/`) is a real-site check the user runs after a publish.

---

## File structure

**New:**
- `src/lib/slug.ts` — `slugify(title)` + `dedupeSlug(base, taken)`.
- `src/lib/prerender.ts` — `prerenderPages(site)` → `[{ path, contentHtml, title }]`.

**Modified:**
- `src/lib/publish.ts` — `PublishedNote.slug`; `PublishedSite.slugMap` (slug→ref).
- `src/components/CardGrid.tsx` — `handlePublish`: pin slugs to frontmatter, build pages, pass them to `publish_site`.
- `src-tauri/src/publish.rs` — `PublishInput.pages`; wrap each in the bundle shell + URL rewrite + write `<slug>/index.html`.
- `src-viewer/main.tsx` — read `window.__ORDER__` for data URL + initial slug.
- `src-viewer/ViewerApp.tsx` — accept an initial slug and focus that note/folder.

---

## Task 1: Slug utilities

**Files:** Create `src/lib/slug.ts`

- [ ] **Step 1: Write `slug.ts`**

```ts
// Stable URL slugs. Derived once from a title and then pinned in
// frontmatter, never recomputed from the title, so renames don't orphan
// permalinks.
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")        // non-alphanumerics → hyphen
    .replace(/^-+|-+$/g, "")            // trim hyphens
    .slice(0, 80) || "untitled";
}

/** Append -2, -3, … until the slug is unique within `taken`. */
export function dedupeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

- [ ] **Step 2: Node-check**

Bundle a scratch check (esbuild → node, as `wikilink.ts` was verified) asserting `slugify("Tech Habits: How I…") === "tech-habits-how-i"` and `dedupeSlug("salmon", new Set(["salmon"])) === "salmon-2"`. Delete the scratch file.

- [ ] **Step 3: Commit** — `git add src/lib/slug.ts && git commit -m "permalinks: slug utilities"`

---

## Task 2: Pin slugs at publish + carry into PublishedSite

**Files:** Modify `src/lib/publish.ts`, `src/components/CardGrid.tsx`

- [ ] **Step 1: Extend the published types** (`publish.ts`)

Add `slug: string;` to `PublishedNote`. Add `slugMap: Record<string, string>;` (slug → ref) to `PublishedSite`. In `collectPublishedSite`, read each public note's `frontmatter.slug` (a string by the time collect runs — Step 2 pins it first) into `PublishedNote.slug`, and build `slugMap[note.slug] = note.ref`.

- [ ] **Step 2: Pin missing slugs before collect** (`CardGrid.tsx` `handlePublish`, before `collectPublishedSite`)

```ts
// Pin a stable slug into every public note/folder that lacks one, so
// permalinks never derive from (mutable) titles. Writes frontmatter to
// disk; runs before collect so the payload sees the slugs.
const publicNotes = fresh.filter((n) => n.frontmatter.public === true);
const taken = new Set<string>();
for (const n of publicNotes) {
  const existing = typeof n.frontmatter.slug === "string" ? n.frontmatter.slug : "";
  if (existing) taken.add(existing);
}
for (const n of publicNotes) {
  if (typeof n.frontmatter.slug === "string" && n.frontmatter.slug) continue;
  const title = typeof n.frontmatter.title === "string" && n.frontmatter.title.trim()
    ? n.frontmatter.title : n.filename.replace(/\.md$/i, "");
  const slug = dedupeSlug(slugify(title), taken);
  taken.add(slug);
  const raw = await invoke<string>("read_text", { path: n.path });
  const { frontmatter, body } = splitFrontmatter(raw);
  frontmatter.slug = slug;
  await invoke("write_text", { path: n.path, content: joinFrontmatter(frontmatter, body) });
  n.frontmatter.slug = slug; // reflect into the fresh copy used by collect
}
```

Add imports: `import { slugify, dedupeSlug } from "../lib/slug";`.

- [ ] **Step 3: Verify** — `npx tsc -b` clean. Commit: `git commit -am "permalinks: pin slugs to frontmatter at publish + carry into payload"`

---

## Task 3: Prerender content HTML

**Files:** Create `src/lib/prerender.ts`

- [ ] **Step 1: Write `prerender.ts`**

```ts
// Build-time content renderer. marked turns a note body into HTML
// (Crepe can't run server-side — confirmed by spike), then we rewrite
// wikilinks to permalink anchors and attachment paths to root-absolute.
import { marked } from "marked";
import type { PublishedSite } from "./publish";
import { resolveWikilink, type WikiRef } from "./wikilink";
import { ATTACHMENTS_DIRNAME } from "./attachments";

export interface PrerenderedPage { path: string; contentHtml: string; title: string }

const WIKI_RE = /(\\?\[\\?\[)([^\]\n]+?)(\\?\]\\?\])/g;

function rewriteWikilinks(md: string, vault: WikiRef[], slugOf: (ref: string) => string | null): string {
  return md.replace(WIKI_RE, (_full, _o, inner, _c) => {
    const res = resolveWikilink(`[[${inner}]]`, vault);
    const label = inner.split("|").pop()!.split("/").pop()!.trim();
    if (res.kind === "broken") return `<span class="wikilink-broken">${label}</span>`;
    const slug = slugOf(res.ref.filename.replace(/\.md$/i, ""));
    if (!slug) return `<span class="wikilink-broken">${label}</span>`;
    return `<a class="wikilink" href="/${slug}/">${label}</a>`;
  });
}

/** Build the per-page content (no chrome — Rust wraps it in the bundle
 *  shell). `pubPath` is the publish sub-path (e.g. "order-home") for
 *  root-absolute attachment URLs. */
export function prerenderPages(site: PublishedSite, pubPath: string): PrerenderedPage[] {
  const vault: WikiRef[] = site.notes.map((n) => ({ filename: `${n.ref}.md`, frontmatter: n.frontmatter }));
  const refToSlug = new Map<string, string>();
  for (const [slug, ref] of Object.entries(site.slugMap)) refToSlug.set(ref.toLowerCase(), slug);
  const slugOf = (ref: string) => refToSlug.get(ref.toLowerCase()) ?? null;

  const attachPrefix = `/${pubPath}/${ATTACHMENTS_DIRNAME}/`;
  return site.notes.map((n) => {
    // wikilinks first (operate on raw md), then marked, then attachments
    // (rewrite the produced <img src>).
    const withLinks = rewriteWikilinks(n.body, vault, slugOf);
    let html = marked.parse(withLinks, { async: false }) as string;
    html = html.replace(/(<img[^>]+src=")(?!https?:|\/)(?:\.\/)?Attachments\//g, `$1${attachPrefix}`);
    const isHome = n.isHome;
    return {
      path: isHome ? "index.html" : `${n.slug}/index.html`,
      contentHtml: html,
      title: n.title,
    };
  });
}
```

- [ ] **Step 2: Node-check** a sample site: a note with a heading, an `![](Attachments/x.png)`, a `[[Folder]]` (resolves) and a `[[Nope]]` (broken). Assert the anchor href is `/folder-slug/`, the img src is `/order-home/Attachments/x.png`, and the broken one is a muted span. Delete the scratch file.

- [ ] **Step 3: Commit** — `git add src/lib/prerender.ts && git commit -m "permalinks: marked prerender with wikilink + attachment rewrite"`

---

## Task 4: Pass pages to Rust + write per-slug HTML

**Files:** Modify `src/components/CardGrid.tsx`, `src-tauri/src/publish.rs`

- [ ] **Step 1: Build + pass pages** (`handlePublish`)

After collect: derive the publish sub-path from `home.target` (the part after `user/repo/`), call `prerenderPages(site, sub)`, and add `pages` to the `publish_site` input:

```ts
const sub = home.target.split("/").slice(2).join("/");
const pages = prerenderPages(site, sub);
// ...invoke("publish_site", { input: { home_target, vault_path, viewer_bundle_path: "", data_json, pages } })
```

Add `import { prerenderPages } from "../lib/prerender";`.

- [ ] **Step 2: Accept pages in Rust** (`publish.rs`)

Add to `PublishInput`. The `rename_all = "camelCase"` makes serde accept the
camelCase `contentHtml` the TS `PrerenderedPage` emits (the other fields are
identical in both cases):
```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page { pub path: String, pub content_html: String, pub title: String }
// in PublishInput:
pub pages: Vec<Page>,
```

- [ ] **Step 3: Wrap + write pages** (`publish.rs`, after the bundle copy + data.json write)

```rust
// The bundle's index.html is the shell. For each prerendered page,
// inject the content into #viewer-root, set the title, point asset +
// data URLs at the publish root (pages live one level deep so relative
// URLs would break), and expose window.__ORDER__ for the viewer boot.
let shell = fs::read_to_string(target_dir.join("index.html"))
    .map_err(|e| format!("read bundle index.html: {e}"))?;
let root_abs = format!("/{sub}/");
let shell = shell
    .replace("./assets/", &format!("{root_abs}assets/"))
    .replace("./data.json", &format!("{root_abs}data.json"))
    .replace("href=\"./", &format!("href=\"{root_abs}"));
for page in &input.pages {
    let slug = page.path.trim_end_matches("/index.html");
    let order_global = format!(
        "<script>window.__ORDER__={{slug:{:?},dataUrl:{:?}}}</script>",
        slug, format!("{root_abs}data.json"),
    );
    let html = shell
        .replacen(
            "<div id=\"viewer-root\"></div>",
            &format!(
                "<div id=\"viewer-root\"><article class=\"prerendered\">{}</article></div>{}",
                page.content_html, order_global,
            ),
            1,
        )
        .replacen("<title>Order</title>", &format!("<title>{}</title>", page.title), 1);
    let dest = target_dir.join(&page.path);
    if let Some(parent) = dest.parent() { let _ = fs::create_dir_all(parent); }
    fs::write(&dest, html).map_err(|e| format!("write {}: {e}", page.path))?;
}
```

- [ ] **Step 4: Verify** — `cd src-tauri && cargo build` clean; `npx tsc -b` clean. Commit: `git commit -am "permalinks: write per-slug static pages in publish"`

---

## Task 5: Viewer takeover + deep-link

**Files:** Modify `src-viewer/main.tsx`, `src-viewer/ViewerApp.tsx`

- [ ] **Step 1: Read `window.__ORDER__`** (`main.tsx`)

```ts
const order = (window as unknown as { __ORDER__?: { slug?: string; dataUrl?: string } }).__ORDER__;
const dataUrl = order?.dataUrl ?? "./data.json";
// ...fetch(dataUrl, ...)
// createRoot replaces the static #viewer-root content automatically.
ReactDOM.createRoot(root).render(
  <React.StrictMode><ViewerApp data={data} initialSlug={order?.slug || null} /></React.StrictMode>,
);
```

- [ ] **Step 2: Deep-link in `ViewerApp`**

Add `initialSlug?: string | null` to props. On first render, map it via `data.slugMap[initialSlug]` to a ref and seed the filter/focus to that note's folder (or the folder itself), mirroring the existing home-default seed.

- [ ] **Step 3: Verify** — `npx tsc -b` clean; `pnpm build:viewer` clean. Commit: `git commit -am "permalinks: viewer reads __ORDER__ and deep-links by slug"`

---

## Task 6 (deferred refinement — not built now)

Content-hashed flat `/assets/` for attachments, sitemap.xml/RSS, incremental publish. Out of scope for this pass (root-absolute URLs already resolve).

---

## Final verification (user-run, on a real publish)

- [ ] Publish from Order. Confirm `order-home/<slug>/index.html` files exist with real content.
- [ ] Visit `geetduggal.com/<slug>/` — content shows immediately (view-source has it), assets + data.json load, the viewer takes over and lands on that note/folder.
- [ ] A `[[wikilink]]` in a published note links to `/<target-slug>/` and resolves.
