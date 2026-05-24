# Order for iOS — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Order on iPhone with desktop-identical UI, reaching the vault via a security-scoped bookmark and publishing to GitHub over HTTPS.

**Architecture:** Reuse the React frontend unchanged. Route every file read/write/list/image through one vault-relative bridge backed by a shared root resolver (absolute path on desktop; bookmark-resolved path held open for the session on iOS). Publishing becomes platform-conditional: git CLI on desktop, GitHub Git Data API on iOS.

**Tech Stack:** Tauri v2, Rust, React/TS, Vite, Swift (custom iOS plugin), GitHub REST API (via `ureq`).

**Execution decisions (made during inline run, Phases 2–3 + Phase 5 core):**
- The vault FS bridge keeps `n.path` **absolute on desktop**; the walk-to-relative flip (replacing the JS `plugin-fs` walk) is deferred to Phase 4 where it's iOS-required and on-device testable. Desktop stays byte-identical.
- The GitHub publisher uses **`ureq`** (lightweight, pure-Rust, blocking, rustls) instead of `reqwest` — no async runtime, lighter build, compiles on all targets so desktop `cargo build` type-checks it.
- The publisher core (`publish_ios::commit_files`) is **done and compiled**; only its `cfg` dispatch + token/bundle wiring remain (Phase 5, on-device).

**Note on testing:** per the project's conventions this plan favors architectural steps with real build/run verification (`cargo build`, `npx tsc -b`, on-device runs) over unit-test ceremony. Native iOS steps that depend on the generated Xcode project are marked **[on-device discovery]** rather than pre-scripted with unverified Swift.

**Note on commits:** branch off fresh `main` first (`git checkout main && git pull && git checkout -b <ticket-or>/ios-mvp`). Commit after each task. No `Co-Authored-By` trailers. Do not commit the docs under `docs/superpowers/`.

---

## File structure

**New:**
- `src-tauri/src/vault_fs.rs` — `VaultState` (the shared root) + vault-relative FS commands + the `vaultasset` protocol resolver.
- `src/lib/vault-fs.ts` — TS wrapper: `vaultFs.*` over the Rust commands.
- `src-tauri/src/publish_ios.rs` — GitHub Git Data API publisher via `ureq` (compiled on all targets; core DONE).
- Swift plugin sources (path determined by `tauri ios init`, under `src-tauri/gen/apple` or a local Tauri plugin) — folder pick, bookmark resolve, Keychain, share sheet.

**Modified:**
- `src-tauri/src/lib.rs` — register `vault_fs` commands, the `vaultasset` protocol, manage `VaultState`; drop the stock asset protocol.
- `src-tauri/src/publish.rs` — make `publish_site` platform-conditional.
- `src-tauri/tauri.conf.json` — remove `protocol-asset` / `assetProtocol` scope.
- `src-tauri/Cargo.toml` — `ureq` + `base64` + `percent-encoding`, drop `protocol-asset` feature (DONE).
- `src/lib/vault.ts` — `vaultRoot()`/walk become relative; set the Rust root at startup.
- `src/lib/attachments.ts` — emit `vaultasset://` prefix instead of `convertFileSrc`.
- `src/components/CardGrid.tsx`, `Card.tsx`, `SettingsPanel.tsx` — migrate FS/dialog calls to `vaultFs.*`.

---

## Phase 1: iOS baseline

### Task 1: Initialize the iOS project and run unmodified on device

**Files:**
- Create: `src-tauri/gen/apple/*` (generated)

- [ ] **Step 1: Branch**

```bash
cd /Users/geet.duggal/Development/order
git checkout main && git pull && git checkout -b order/ios-mvp
```

- [ ] **Step 2: Init iOS**

Run: `pnpm tauri ios init`
Expected: creates `src-tauri/gen/apple/` with an Xcode project. If it errors on missing Xcode/CLT, resolve toolchain first.

- [ ] **Step 3: Open the Xcode project, set the Team + bundle id**

[on-device discovery] In Xcode (`src-tauri/gen/apple/*.xcodeproj`), set Signing Team (paid account) and confirm bundle id `com.order.app`.

- [ ] **Step 4: Run on device**

Run: `pnpm tauri ios dev --host` (or run from Xcode on the connected iPhone)
Expected: the Order React UI renders on the phone. Vault/image/publish will not work yet — this only proves the shell + frontend boot on iOS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/gen src-tauri/tauri.conf.json package.json
git commit -m "ios: initialize iOS project target"
```

---

## Phase 2: Vault FS bridge (desktop first, fully testable on Mac) — DONE (desktop-verified)

This phase is verifiable entirely on desktop; iOS just reuses it once the Swift plugin sets the root.

### Task 2: Add the Rust vault root + read/write/list commands

**Files:**
- Create: `src-tauri/src/vault_fs.rs`
- Modify: `src-tauri/src/lib.rs:1-40`

- [ ] **Step 1: Write `vault_fs.rs`**

```rust
// Vault-relative filesystem bridge. One resolver holds the vault root
// (an absolute path on desktop; the bookmark-resolved path the iOS Swift
// plugin sets after opening scoped access). All commands take paths
// RELATIVE to that root, so the frontend never deals in absolute paths —
// which is what lets the same code run inside the iOS sandbox.
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

#[derive(Default)]
pub struct VaultState {
    pub root: Mutex<Option<PathBuf>>,
}

fn resolve(state: &VaultState, rel: &str) -> Result<PathBuf, String> {
    let guard = state.root.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("vault root not set")?;
    if rel.split('/').any(|s| s == "..") {
        return Err(format!("path escapes vault: {rel}"));
    }
    Ok(root.join(rel))
}

#[tauri::command]
pub fn vault_set_root(state: tauri::State<VaultState>, path: String) -> Result<(), String> {
    *state.root.lock().map_err(|e| e.to_string())? = Some(PathBuf::from(path));
    Ok(())
}

#[tauri::command]
pub fn vault_read_text(state: tauri::State<VaultState>, rel: String) -> Result<String, String> {
    fs::read_to_string(resolve(&state, &rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write_text(state: tauri::State<VaultState>, rel: String, content: String) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write_binary(state: tauri::State<VaultState>, rel: String, bytes: Vec<u8>) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    fs::write(p, bytes).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct DirEntry { pub name: String, pub is_dir: bool }

#[tauri::command]
pub fn vault_read_dir(state: tauri::State<VaultState>, rel: String) -> Result<Vec<DirEntry>, String> {
    let p = resolve(&state, &rel)?;
    let mut out = Vec::new();
    for e in fs::read_dir(&p).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().to_string(),
            is_dir: e.file_type().map(|t| t.is_dir()).unwrap_or(false),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn vault_exists(state: tauri::State<VaultState>, rel: String) -> Result<bool, String> {
    Ok(resolve(&state, &rel)?.exists())
}

#[derive(serde::Serialize)]
pub struct Stat { pub mtime: u64, pub size: u64 }

#[tauri::command]
pub fn vault_stat(state: tauri::State<VaultState>, rel: String) -> Result<Stat, String> {
    let m = fs::metadata(resolve(&state, &rel)?).map_err(|e| e.to_string())?;
    let mtime = m.modified().ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs()).unwrap_or(0);
    Ok(Stat { mtime, size: m.len() })
}

#[tauri::command]
pub fn vault_rename(state: tauri::State<VaultState>, from: String, to: String) -> Result<(), String> {
    let from_p = resolve(&state, &from)?;
    let to_p = resolve(&state, &to)?;
    if let Some(parent) = to_p.parent() { let _ = fs::create_dir_all(parent); }
    fs::rename(from_p, to_p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_remove(state: tauri::State<VaultState>, rel: String) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register in `lib.rs`**

Add `mod vault_fs;`, `.manage(vault_fs::VaultState::default())`, and add all `vault_fs::vault_*` to `generate_handler!`.

- [ ] **Step 3: Build**

Run: `cd src-tauri && cargo build`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/vault_fs.rs src-tauri/src/lib.rs
git commit -m "vault-fs: vault-relative filesystem bridge (rust)"
```

### Task 3: TS wrapper + set the root at startup

**Files:**
- Create: `src/lib/vault-fs.ts`
- Modify: `src/lib/vault.ts`

- [ ] **Step 1: Write `vault-fs.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface VaultDirEntry { name: string; isDir: boolean }
export interface VaultStat { mtime: number; size: number }

export const vaultFs = {
  readText: (rel: string) => invoke<string>("vault_read_text", { rel }),
  writeText: (rel: string, content: string) => invoke<void>("vault_write_text", { rel, content }),
  writeBinary: (rel: string, bytes: number[]) => invoke<void>("vault_write_binary", { rel, bytes }),
  readDir: (rel: string) => invoke<{ name: string; is_dir: boolean }[]>("vault_read_dir", { rel })
    .then((es) => es.map((e) => ({ name: e.name, isDir: e.is_dir }) as VaultDirEntry)),
  exists: (rel: string) => invoke<boolean>("vault_exists", { rel }),
  stat: (rel: string) => invoke<VaultStat>("vault_stat", { rel }),
  rename: (from: string, to: string) => invoke<void>("vault_rename", { from, to }),
  remove: (rel: string) => invoke<void>("vault_remove", { rel }),
  setRoot: (path: string) => invoke<void>("vault_set_root", { path }),
};
```

- [ ] **Step 2: Set the root at startup (desktop)**

In `vault.ts`, after computing the effective absolute root (`vaultRoot()` today), call `vaultFs.setRoot(absoluteRoot)` once on app init (and again whenever the vault override changes). Keep `vaultRoot()` returning the absolute path for now; later tasks switch callers to relative paths against it.

- [ ] **Step 3: Build**

Run: `npx tsc -b`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/vault-fs.ts src/lib/vault.ts
git commit -m "vault-fs: TS wrapper + set rust root at startup"
```

### Task 4: Migrate frontend FS calls to `vaultFs.*` (vault-relative)

**Files:**
- Modify: `src/lib/vault.ts` (walk), `src/components/CardGrid.tsx`, `src/components/Card.tsx`

- [ ] **Step 1: Add a relative-path helper**

In `vault.ts`, add `toVaultRel(absOrRel: string): string` that strips the absolute root prefix when present, returning a vault-relative path. Update `notePathByRef()` and note records to carry relative paths.

- [ ] **Step 2: Replace `@tauri-apps/plugin-fs` calls**

Swap `readDir`/`exists`/`remove`/`rename`/`stat` (the plugin-fs imports across `vault.ts`, `CardGrid.tsx`, `Card.tsx`) for `vaultFs.*` with relative paths. Replace the `read_text`/`write_text`/`write_binary`/`rename_file`/`delete_file` `invoke`s in `CardGrid.tsx` with `vaultFs.readText/writeText/writeBinary/rename/remove`. `uniqueWrite` uses `vaultFs.exists` + `vaultFs.writeText`.

- [ ] **Step 3: Build + run desktop**

Run: `npx tsc -b && pnpm tauri dev`
Expected: app loads the vault, opens/edits/saves notes, reassign-move works — all through the bridge. This is the desktop regression gate.

- [ ] **Step 4: Commit**

```bash
git add src/lib/vault.ts src/components/CardGrid.tsx src/components/Card.tsx
git commit -m "vault-fs: route all frontend file ops through the bridge"
```

---

## Phase 3: Custom image protocol — DONE (desktop-verified)

### Task 5: Register the `vaultasset` protocol and switch attachments

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/vault_fs.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src/lib/attachments.ts`

- [ ] **Step 1: Add a protocol resolver in `vault_fs.rs`**

```rust
// Resolve a vaultasset:// request path (relative to the vault root) to
// bytes. Used by the custom URI scheme handler registered in lib.rs.
pub fn read_asset(state: &VaultState, rel: &str) -> Result<Vec<u8>, String> {
    fs::read(resolve(state, rel)?).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the scheme in `lib.rs`**

In the builder, add `.register_uri_scheme_protocol("vaultasset", |ctx, request| { ... })`: parse the request URL path, percent-decode, look up `VaultState` via `ctx.app_handle().state()`, call `vault_fs::read_asset`, guess the MIME from the extension, and return a `tauri::http::Response` with the bytes (200) or 404 on error.

- [ ] **Step 3: Drop the stock asset protocol**

Remove `protocol-asset` from `tauri = { features = [...] }` in `Cargo.toml`, remove the `custom-protocol`/`protocol-asset` reliance, and delete the `assetProtocol` block from `tauri.conf.json`.

- [ ] **Step 4: Switch `attachments.ts`**

Replace `attachmentAssetPrefix` to return `vaultasset://localhost/${ATTACHMENTS_DIRNAME}/` (no `convertFileSrc`). Inflate/deflate logic is otherwise unchanged (still maps markdown `Attachments/x.png` ↔ the runtime URL).

- [ ] **Step 5: Build + verify images on desktop**

Run: `cargo build && pnpm tauri dev`
Expected: attachment images render in cards and the editor via `vaultasset://`. Desktop parity confirmed before iOS depends on it.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/vault_fs.rs src-tauri/src/lib.rs src-tauri/tauri.conf.json src-tauri/Cargo.toml src/lib/attachments.ts
git commit -m "image: serve attachments via custom vaultasset protocol"
```

---

## Phase 4: iOS native — folder pick + bookmark + Keychain (Swift)

This is the highest-uncertainty phase; pin the Tauri-iOS plugin API against the generated project rather than guessing.

### Task 6: Swift plugin — pick folder + persist bookmark + set root

**Files:**
- Create/modify: Swift plugin sources under `src-tauri/gen/apple` (exact location per `tauri ios init`)
- Modify: `src/lib/vault-fs.ts` (add `pickFolder`), `src/components/SettingsPanel.tsx`

- [ ] **Step 1: [on-device discovery] Locate the iOS plugin entry point**

Inspect the generated Xcode project for where app-specific Swift commands register with the Tauri webview (Tauri v2 mobile plugin pattern). Confirm the current API for exposing a Swift command callable via `invoke`.

- [ ] **Step 2: Implement `vault_pick_folder` (Swift, iOS)**

Present `UIDocumentPickerViewController(forOpeningContentTypes: [.folder])`. On pick: call `startAccessingSecurityScopedResource()`, create `url.bookmarkData()`, persist the bookmark blob (UserDefaults/Keychain) + display name, and return `{ path: url.path, name }` to JS. Keep scoped access open for the session.

- [ ] **Step 3: Restore bookmark at launch (Swift, iOS)**

On app start, if a bookmark exists, resolve it (`URL(resolvingBookmarkData:bookmarkDataIsStale:)`), `startAccessingSecurityScopedResource()`, and call the Rust `vault_set_root` with the resolved path. If stale/unresolvable, signal the frontend to prompt a re-pick.

- [ ] **Step 4: Desktop `vault_pick_folder`**

On desktop, `vault_pick_folder` wraps the existing `dialog.open({ directory: true })` and returns `{ path, name }`. Add `pickFolder` to `vault-fs.ts` and have `SettingsPanel.tsx` call it (replacing the direct `plugin-dialog` import); on success, persist + `vaultFs.setRoot(path)`.

- [ ] **Step 5: Verify on device**

[on-device discovery] Run on iPhone: pick a Dropbox/iCloud folder, force-quit, relaunch → vault opens with no re-prompt (bookmark persisted). Browse/edit/save a note and confirm images render (Phases 2–3 over the scoped root).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "ios: folder pick + security-scoped bookmark + session root"
```

### Task 6b: Walk-to-relative flip (deferred from Phase 2)

**Files:**
- Modify: `src/lib/vault.ts` (walkVaultMarkdown), `src/components/CardGrid.tsx`, `src/components/Card.tsx`

Phase 2 kept `n.path` absolute and the JS `plugin-fs` walk for desktop. iOS can't read the scoped dir via `plugin-fs`, so the walk must move to the bridge and produce relative paths.

- [ ] **Step 1: Walk via the bridge, returning relative paths**

Rewrite `walkVaultMarkdown` to recurse with `vaultFs.readDir` (relative), returning vault-relative `path`s. `n.path` becomes relative everywhere.

- [ ] **Step 2: Drop absolute-root path construction**

Where code builds paths by joining `await vaultRoot()` (createNote, area helpers, image upload), switch to relative bases (root = `""`). `toVaultRel` is already idempotent, so the existing FS call sites keep working unchanged.

- [ ] **Step 3: Drop `@tauri-apps/plugin-fs`** from `vault.ts` (no longer used).

- [ ] **Step 4: Verify on device + desktop**

Run on iPhone (browse/edit/save over the bookmark) and re-run the desktop regression (`pnpm tauri dev`) since `n.path` semantics changed for both.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "vault-fs: walk via bridge with relative paths (ios + desktop)"
```

---

## Phase 5: GitHub API publishing

> Core DONE inline: `publish_ios::commit_files` (the ref→tree→commit→ref logic via `ureq`) is written, compiled, and type-checked. Remaining steps wire it on-device.

### Task 7: Implement the Git Data API publisher

**Files:**
- Create: `src-tauri/src/publish_ios.rs`
- Modify: `src-tauri/src/publish.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`

- [x] **Step 1: Add the HTTP client** — DONE: `ureq` + `base64` added to `Cargo.toml` (chosen over `reqwest`: lighter, no async runtime, compiles on all targets).

- [x] **Step 2: Write `publish_ios.rs`** — DONE: `commit_files(token, owner, repo, branch, message, files)` performs ref → base commit → base tree → blobs → tree → commit → update ref, returning the new commit sha. Compiled + type-checked (currently `#![allow(dead_code)]` until the dispatch below is wired).

- [ ] **(historical) Step 2 reference: Write `publish_ios.rs`**

Implement `publish_site_api(token, home_target, files: Vec<(String, Vec<u8>)>) -> Result<PublishResult, String>` performing: GET ref `heads/<branch>` → base commit sha; GET commit → base tree; POST a blob per file (base64); POST a tree (base = base tree) with each path + blob sha; POST a commit (tree + parent); PATCH the ref. Reuse `PublishResult` and the `home_target` parse from `publish.rs`.

- [ ] **Step 3: Make `publish_site` platform-conditional**

In `publish.rs`, gate the body: `#[cfg(not(any(target_os = "ios", target_os = "android")))]` keeps the git-CLI path; `#[cfg(target_os = "ios")]` calls `publish_ios::publish_site_api`, reading the bundled viewer (`dist-viewer` shipped as an iOS resource) + the vault Attachments via `VaultState`, and the token from Keychain.

- [ ] **Step 4: Bundle the viewer for iOS**

Ensure `dist-viewer` is built (`pnpm build:viewer`) and added as a Tauri iOS resource so `publish_ios` can read it without a filesystem build step.

- [ ] **Step 5: Token entry + Keychain**

Add a token field to Settings (iOS); store via the Swift plugin in Keychain. `publish_ios` reads it through a Swift command.

- [ ] **Step 6: Verify**

Run desktop: `cargo build` (confirms the cfg split compiles; desktop publish unchanged). [on-device discovery] On iPhone: enter token, Publish → confirm a new commit appears on the target repo and the live site updates.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "publish: GitHub Git Data API publisher for iOS"
```

---

## Phase 6: Remaining native bits

### Task 8: `open_path` share sheet + watcher no-op

**Files:**
- Modify: `src-tauri/src/lib.rs`, Swift plugin, `src-tauri/src/watcher.rs`

- [ ] **Step 1: `open_path` on iOS**

Route `open_path` to a Swift command presenting Quick Look / `UIDocumentInteractionController` for the resolved attachment path. Desktop keeps `open_path` as-is.

- [ ] **Step 2: Watcher no-op on iOS**

Gate `start_watcher` with `#[cfg(not(target_os = "ios"))]`; provide an iOS no-op so the frontend call resolves harmlessly.

- [ ] **Step 3: Build both targets**

Run: `cargo build` (desktop) and an iOS build.
Expected: both compile; desktop behavior unchanged.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "ios: open_path share sheet + watcher no-op"
```

---

## Final verification

- [ ] Desktop: full regression — open vault, edit/save, reassign-move, images, publish (git CLI). All green.
- [ ] iPhone: pick vault once (persists), browse/edit/save, images render, publish via GitHub API updates the live site.
- [ ] `npx tsc -b` clean; `cargo build` clean for desktop.
