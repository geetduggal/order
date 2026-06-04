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
    // Reject traversal so a relative path can never escape the vault.
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

/// True on iOS — lets the frontend choose the bookmark-based vault flow
/// (vault plugin) vs the desktop home-dir path.
#[tauri::command]
pub fn vault_is_ios() -> bool {
    cfg!(target_os = "ios")
}

#[derive(serde::Serialize)]
pub struct WalkEntry {
    pub path: String,
    pub name: String,
}

/// Recursively list every `.md` file under the vault root (absolute
/// paths), skipping the Attachments dir and dotfiles. Runs through
/// std::fs so it works on desktop and under iOS scoped access alike —
/// the JS plugin-fs walk can't reach a bookmarked iOS folder.
#[tauri::command]
pub fn vault_walk(state: tauri::State<VaultState>) -> Result<Vec<WalkEntry>, String> {
    let root = {
        let guard = state.root.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("vault root not set")?.clone()
    };
    let mut out = Vec::new();
    walk_dir(&root, &mut out);
    Ok(out)
}

/// Per-note metadata returned by `vault_walk_metadata`. `frontmatter` is
/// the raw YAML between the `---` fences (or empty when none), parsed
/// once in JS via the existing js-yaml splitter. `body_len` is the byte
/// length of the body — enough to estimate masonry row spans for the
/// virtualized Stream without ever reading the body across the bridge.
/// `mtime_ms` is the last-modified time in Unix-epoch milliseconds so
/// callers can build an on-disk metadata cache keyed on freshness.
#[derive(serde::Serialize)]
pub struct MetaEntry {
    pub path: String,
    pub name: String,
    pub frontmatter: String,
    pub body_len: usize,
    pub mtime_ms: i64,
}

/// Frontmatter-only walker. Reads every `.md` file under the vault root
/// (same traversal as `vault_walk`) but **strips the body before crossing
/// the JS bridge** — at 10⁴ notes this is roughly the difference between
/// "few MB of payload" and "hundreds of MB." Bodies are loaded on-demand
/// per Card via `vault_read_text` once needed.
#[tauri::command]
pub fn vault_walk_metadata(state: tauri::State<VaultState>) -> Result<Vec<MetaEntry>, String> {
    let root = {
        let guard = state.root.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("vault root not set")?.clone()
    };
    let mut entries = Vec::new();
    walk_dir(&root, &mut entries);
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let p = std::path::PathBuf::from(&entry.path);
        let raw = match fs::read_to_string(&p) {
            Ok(s) => s,
            Err(_) => continue, // permission / vanished file — skip silently
        };
        let (frontmatter, body_len) = split_frontmatter_lite(&raw);
        let mtime_ms = fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(MetaEntry {
            path: entry.path,
            name: entry.name,
            frontmatter,
            body_len,
            mtime_ms,
        });
    }
    Ok(out)
}

/// Lightweight `---` frontmatter splitter — returns (yaml_text, body_byte_len)
/// without allocating the body itself. Mirrors js-yaml-based splitFrontmatter
/// in src/lib/frontmatter.ts. A file without an opening `---\n` is treated
/// as all body.
fn split_frontmatter_lite(raw: &str) -> (String, usize) {
    let prefix = "---\n";
    if let Some(rest) = raw.strip_prefix(prefix) {
        if let Some(end) = rest.find("\n---") {
            let yaml = &rest[..end];
            // Body starts after "\n---" and the next newline (if any).
            let after = &rest[end + 4..];
            let body_start = if after.starts_with('\n') { 1 } else { 0 };
            let body_len = after.len().saturating_sub(body_start);
            return (yaml.to_string(), body_len);
        }
    }
    (String::new(), raw.len())
}

fn walk_dir(dir: &std::path::Path, out: &mut Vec<WalkEntry>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "Attachments" {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            walk_dir(&entry.path(), out);
        } else if name.ends_with(".md") {
            out.push(WalkEntry {
                path: entry.path().to_string_lossy().to_string(),
                name,
            });
        }
    }
}

#[tauri::command]
pub fn vault_read_text(state: tauri::State<VaultState>, rel: String) -> Result<String, String> {
    fs::read_to_string(resolve(&state, &rel)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write_text(
    state: tauri::State<VaultState>,
    rel: String,
    content: String,
) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_write_binary(
    state: tauri::State<VaultState>,
    rel: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(p, bytes).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub fn vault_read_dir(
    state: tauri::State<VaultState>,
    rel: String,
) -> Result<Vec<DirEntry>, String> {
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
pub struct Stat {
    pub mtime: u64,
    pub size: u64,
}

#[tauri::command]
pub fn vault_stat(state: tauri::State<VaultState>, rel: String) -> Result<Stat, String> {
    let m = fs::metadata(resolve(&state, &rel)?).map_err(|e| e.to_string())?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Ok(Stat {
        mtime,
        size: m.len(),
    })
}

#[tauri::command]
pub fn vault_rename(
    state: tauri::State<VaultState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let from_p = resolve(&state, &from)?;
    let to_p = resolve(&state, &to)?;
    if let Some(parent) = to_p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::rename(from_p, to_p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_remove(state: tauri::State<VaultState>, rel: String) -> Result<(), String> {
    let p = resolve(&state, &rel)?;
    if p.is_dir() {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    }
    .map_err(|e| e.to_string())
}

/// Read raw bytes for a vault-relative path. Used by the `vaultasset`
/// URI-scheme handler to serve attachment images to the webview (the
/// stock asset:// protocol can't reach a bookmarked iOS folder).
pub fn read_asset(state: &VaultState, rel: &str) -> Result<Vec<u8>, String> {
    fs::read(resolve(state, rel)?).map_err(|e| e.to_string())
}

/// Read a byte range (start..=end inclusive) of a vault-relative file.
/// Used by the vaultasset handler to serve HTTP-Range requests for
/// video files — without this, WebKit can't stream a multi-MB .mov
/// efficiently and every seek triggers a full re-download that locks
/// the IPC bridge and stalls the UI.
pub fn read_asset_range(
    state: &VaultState,
    rel: &str,
    start: u64,
    end: u64,
) -> Result<(Vec<u8>, u64), String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = resolve(state, rel)?;
    let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let total = f.metadata().map_err(|e| e.to_string())?.len();
    let actual_end = end.min(total.saturating_sub(1));
    if start > actual_end {
        return Err(format!("range start {start} out of bounds (file size {total})"));
    }
    let len = (actual_end - start + 1) as usize;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok((buf, total))
}

/// File size in bytes for a vault-relative path, without reading any
/// content. Used by the vaultasset handler when answering Range
/// requests so it can populate Content-Range / Content-Length.
pub fn asset_size(state: &VaultState, rel: &str) -> Result<u64, String> {
    fs::metadata(resolve(state, rel)?).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Best-effort MIME from a file extension, for the asset handler.
pub fn mime_for(rel: &str) -> &'static str {
    match rel.rsplit('.').next().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("pdf") => "application/pdf",
        // QuickTime .mov and H.264/H.265 .mp4 both ride the mp4 container
        // in practice — Safari / WebKit play either as `video/mp4`.
        Some("mov") | Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}
