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
        _ => "application/octet-stream",
    }
}
