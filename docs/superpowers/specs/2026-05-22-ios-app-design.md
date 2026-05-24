# Order for iOS — MVP design

## Goal

Ship Order on iPhone with the same look and behavior as the desktop app,
diverging only where iOS forces it: vault access and publishing. The
React frontend is reused unchanged; all work lives at the JS↔native
boundary.

## Constraints (why iOS differs)

- iOS apps are sandboxed: no `$HOME`, no arbitrary filesystem paths. An
  external folder is reachable only through a **security-scoped
  bookmark**, which Tauri's stock `fs`/`asset` plugins don't understand.
- iOS forbids subprocesses, so the desktop publisher (which shells out to
  the `git` CLI) cannot run.
- Target: physical iPhone, paid Apple Developer account (stable signing,
  Keychain, Files/Dropbox providers available).

## Architecture

The frontend (`src/`, `src-viewer/`) stays platform-agnostic. Three
native seams change, all routed through one **vault root resolver** that
the whole app shares:

- Desktop resolver → an absolute path (today's `vaultRoot()` default /
  override). Resolve = `root.join(rel)`.
- iOS resolver → the stored bookmark resolved to a URL, with every
  operation wrapped in `startAccessingSecurityScopedResource` /
  `stopAccessingSecurityScopedResource`.

Everything below consults this one resolver, so desktop and iOS share a
single code path (Approach A: unify, not iOS-shim).

## 1. Vault FS bridge

One Rust module (`vault_fs.rs`) + a TS wrapper (`src/lib/vault-fs.ts`)
expose commands keyed on **vault-relative** paths:

```
vault_read_text(rel) -> string
vault_write_text(rel, content)
vault_write_binary(rel, bytes)
vault_read_dir(rel) -> [{ name, isDir }]
vault_exists(rel) -> bool
vault_stat(rel) -> { mtime, size }
vault_rename(from_rel, to_rel)
vault_remove(rel)
```

The frontend migration is mechanical: today's absolute-path `invoke`s
(`read_text`, `write_text`, `write_binary`, `rename_file`, `delete_file`)
and the `@tauri-apps/plugin-fs` calls (`readDir`, `exists`, `remove`,
`rename`, `stat`) all become `vaultFs.*` with relative paths.
`vaultRoot()` / `notePathByRef()` shift from emitting absolute paths to
relative ones — absolute paths stop appearing in the frontend at all,
which is what makes iOS work.

Invariant: the bridge rejects paths that escape the root (no `..`
traversal). `@tauri-apps/plugin-fs` and `@tauri-apps/plugin-dialog` are
dropped from the frontend, replaced by the bridge + native picker.

## 2. Image / attachment display

Replace the stock `asset://` protocol (scoped to `$HOME/**`, unreachable
on iOS) with a custom URI-scheme handler registered in Rust
(`register_uri_scheme_protocol`), e.g. `vaultasset://`. It takes a
vault-relative path, resolves it via the shared resolver, and streams the
bytes to the webview.

`attachments.ts` changes only in how it builds the prefix: it emits
`vaultasset://<rel>` instead of `convertFileSrc(absolute)`. The existing
inflate/deflate logic (markdown `Attachments/foo.png` ↔ runtime URL) is
unchanged. Desktop and iOS share this one image path. The
`protocol-asset` feature and `assetProtocol` scope are removed from
`tauri.conf.json` in favor of the handler. Whole-file responses are fine
for images; `Range` support is out of scope.

## 3. Vault selection & persistence (Swift plugin)

A small custom Tauri mobile plugin (Swift) handles what stock plugins
can't:

- **Pick:** `vault_pick_folder`. Desktop = `dialog.open({directory})`.
  iOS = `UIDocumentPickerViewController` in folder mode; on selection,
  mint a security-scoped bookmark (`URL.bookmarkData`) and persist it
  (bookmark blob + display name).
- **Resolve (every launch):** the iOS resolver restores the bookmark
  (`URL(resolvingBookmarkData:)`). The user picks once; it persists
  across launches. A stale bookmark (folder deleted, provider
  de-authorized) surfaces a "re-select your vault" prompt instead of
  failing silently.
- **Access:** scoped start/stop lives inside the resolver, not at call
  sites, so it can't be forgotten.

Settings UI is unchanged; on iOS the "choose folder" button calls this
plugin. This is the highest-uncertainty piece and is built and verified
on-device first.

## 4. Publishing via GitHub API

`collectPublishedSite()` (TS) already builds the full payload (rendered
site + `data.json` + attachment list) platform-agnostically; only the
transport changes. On iOS, `publish_site` is reimplemented over HTTPS
using GitHub's Git Data API:

```
GET   ref heads/<branch>      -> commit sha
GET   commit <sha>            -> base tree sha
POST  blobs (per file)        -> blob shas (bundle + data.json + Attachments)
POST  trees (base = base)     -> tree sha
POST  commits (tree + parent) -> commit sha
PATCH ref heads/<branch>      -> point branch at new commit
```

It targets the same `home: user/repo/path` the desktop uses, so the
published site is identical regardless of which device pushed. Auth is a
fine-grained personal access token (contents:write on the one repo),
entered once in Settings and stored in the iOS Keychain via the Swift
plugin. The viewer bundle (`dist-viewer`) ships inside the app as a
bundled resource (no `pnpm build:viewer` on a phone). Desktop keeps its
git-CLI publisher untouched; `publish_site` becomes platform-conditional.

## 5. Remaining native bits

- **`open_path`** (non-image attachments): map to the iOS share/preview
  sheet (Quick Look / `UIDocumentInteractionController`). Low priority;
  may stub for the first on-device build.
- **`start_watcher`** (`notify`): no-op on iOS for the MVP. The single
  app editing its own vault doesn't need live reload.

## Out of scope (MVP)

Background sync, conflict handling for external (Dropbox) edits
mid-session, multi-vault, iPad-specific layout, audio/video range
streaming, watcher-driven live reload.

## Build order

Proves the riskiest foundations first; desktop stays green throughout
(Approach A means desktop is the regression check).

1. `tauri ios init`; run the unmodified app on-device (baseline render).
2. Swift plugin: folder pick + bookmark resolve (§3) — prove persistent
   vault access in isolation.
3. Vault FS bridge (§1) — migrate the frontend to `vaultFs.*`.
4. Custom image protocol (§2).
5. GitHub API publish + Keychain token (§4).
6. `open_path` share sheet + `start_watcher` no-op (§5).
