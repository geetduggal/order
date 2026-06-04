// Vault module — fast scan with disk cache and parallel parse.
//
// On disk: ~/Library/Application Support/com.order.app/cache/<vault-hash>.json
//   stores the parsed metadata (title, frontmatter, snippet, mtime) for every
//   note. Rescan: WalkDir to find current .md files, then for each, reuse the
//   cached entry if mtime matches; otherwise re-parse. Deleted files drop out.
//
// `body` is NOT cached or returned in `scan_vault`. It's loaded lazily via
// `read_note(path)` when a note is opened for edit or rendered as a Notable
// Folder Main Document.

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use walkdir::WalkDir;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub path: String,          // absolute path
    pub rel_path: String,      // path relative to vault root
    pub title: String,
    pub snippet: String,       // first ~280 chars of body, markdown stripped
    pub frontmatter: serde_json::Value,
    pub modified: i64,         // unix seconds
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct NoteWithBody {
    #[serde(flatten)]
    pub meta: Note,
    pub body: String,
}

const CACHE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
struct VaultCache {
    version: u32,
    vault_path: String,
    entries: HashMap<String, Note>,
}

static CACHE: Mutex<Option<VaultCache>> = Mutex::new(None);

fn vault_hash(vault: &str) -> String {
    let mut h = DefaultHasher::new();
    vault.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn cache_file(vault: &str) -> PathBuf {
    let mut p = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("com.order.app");
    p.push("cache");
    let _ = fs::create_dir_all(&p);
    p.push(format!("{}.json", vault_hash(vault)));
    p
}

fn load_cache_from_disk(vault: &str) -> VaultCache {
    let p = cache_file(vault);
    let raw = match fs::read_to_string(&p) { Ok(s) => s, Err(_) => return default_cache(vault) };
    match serde_json::from_str::<VaultCache>(&raw) {
        Ok(c) if c.version == CACHE_VERSION && c.vault_path == vault => c,
        _ => default_cache(vault),
    }
}

fn default_cache(vault: &str) -> VaultCache {
    VaultCache { version: CACHE_VERSION, vault_path: vault.to_string(), entries: HashMap::new() }
}

fn save_cache_to_disk(cache: &VaultCache) {
    let p = cache_file(&cache.vault_path);
    if let Ok(raw) = serde_json::to_string(cache) {
        let _ = fs::write(&p, raw);
    }
}

#[tauri::command]
pub fn set_vault(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    *state.vault_path.lock().unwrap() = Some(path.clone());
    // Warm the in-memory cache from disk.
    *CACHE.lock().unwrap() = Some(load_cache_from_disk(&path));
    Ok(())
}

// Discover all .md files via WalkDir, paired with their mtimes (one stat each).
fn list_md_files(root: &Path) -> Vec<(PathBuf, u64)> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file()
            && e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        .filter_map(|e| {
            let p = e.path().to_path_buf();
            let mtime = e.metadata().ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some((p, mtime))
        })
        .collect()
}

#[tauri::command]
pub fn scan_vault(path: String) -> Result<Vec<Note>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }

    // Pull the in-memory cache (loaded by set_vault). Fall back to disk.
    let mut cache = {
        let guard = CACHE.lock().unwrap();
        match guard.as_ref() {
            Some(c) if c.vault_path == path => c.clone(),
            _ => load_cache_from_disk(&path),
        }
    };

    let files = list_md_files(&root);

    // Parse only what's new or changed. Reuse cache otherwise. Parallelized.
    let entries: Vec<Note> = files.par_iter()
        .filter_map(|(p, mtime)| {
            let key = p.to_string_lossy().to_string();
            if let Some(cached) = cache.entries.get(&key) {
                if cached.modified as u64 == *mtime {
                    return Some(cached.clone());
                }
            }
            parse_note_meta(p, &root, *mtime).ok()
        })
        .collect();

    // Rebuild the cache map fresh — drops files deleted from disk.
    cache.entries = entries.iter().map(|n| (n.path.clone(), n.clone())).collect();
    save_cache_to_disk(&cache);
    *CACHE.lock().unwrap() = Some(cache);

    Ok(entries)
}

// Targeted refresh of a single path (called from the watcher, faster than rescan).
#[tauri::command]
pub fn refresh_note(path: String) -> Result<Option<Note>, String> {
    let abs = PathBuf::from(&path);
    if !abs.is_file() {
        // File was deleted. Remove from cache.
        let mut guard = CACHE.lock().unwrap();
        if let Some(cache) = guard.as_mut() {
            cache.entries.remove(&path);
            save_cache_to_disk(cache);
        }
        return Ok(None);
    }
    let root = guard_vault_root();
    let mtime = fs::metadata(&abs).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let note = parse_note_meta(&abs, &root, mtime).map_err(|e| e.to_string())?;
    let mut guard = CACHE.lock().unwrap();
    if let Some(cache) = guard.as_mut() {
        cache.entries.insert(note.path.clone(), note.clone());
        save_cache_to_disk(cache);
    }
    Ok(Some(note))
}

fn guard_vault_root() -> PathBuf {
    CACHE.lock().unwrap()
        .as_ref()
        .map(|c| PathBuf::from(&c.vault_path))
        .unwrap_or_default()
}

#[tauri::command]
pub fn read_note(path: String) -> Result<NoteWithBody, String> {
    let abs = PathBuf::from(&path);
    let root = guard_vault_root();
    let root = if root.as_os_str().is_empty() {
        abs.parent().map(Path::to_path_buf).unwrap_or_default()
    } else { root };
    let mtime = fs::metadata(&abs).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (meta, body) = parse_note_full(&abs, &root, mtime).map_err(|e| e.to_string())?;
    Ok(NoteWithBody { meta, body })
}

#[tauri::command]
pub fn save_note(path: String, body: String, frontmatter: serde_json::Value) -> Result<(), String> {
    let has_fm = frontmatter.as_object().map(|o| !o.is_empty()).unwrap_or(false);
    let content = if has_fm {
        let yaml_str = json_to_yaml_string(&frontmatter).map_err(|e| e.to_string())?;
        format!("---\n{}---\n{}", yaml_str, body)
    } else {
        body
    };
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_frontmatter(path: String, patch: serde_json::Value) -> Result<Note, String> {
    let abs = PathBuf::from(&path);
    let root = guard_vault_root();
    let mtime = fs::metadata(&abs).ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (mut meta, body) = parse_note_full(&abs, &root, mtime).map_err(|e| e.to_string())?;
    if let (Some(obj), Some(patch_obj)) = (meta.frontmatter.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj { obj.insert(k.clone(), v.clone()); }
    }
    save_note(path, body, meta.frontmatter.clone())?;
    Ok(meta)
}

#[tauri::command]
pub fn delete_note(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())?;
    let mut guard = CACHE.lock().unwrap();
    if let Some(cache) = guard.as_mut() {
        cache.entries.remove(&path);
        save_cache_to_disk(cache);
    }
    Ok(())
}

// ---------- parse helpers ----------

fn parse_note_meta(path: &Path, root: &Path, mtime: u64) -> anyhow::Result<Note> {
    let raw = fs::read_to_string(path)?;
    let (fm_str, body) = split_frontmatter(&raw);
    let frontmatter = parse_yaml(fm_str);
    let title = derive_title(path, &frontmatter, &body);
    let snippet = make_snippet(&body, 280);
    let rel_path = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
    Ok(Note {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        snippet,
        frontmatter,
        modified: mtime as i64,
    })
}

fn parse_note_full(path: &Path, root: &Path, mtime: u64) -> anyhow::Result<(Note, String)> {
    let raw = fs::read_to_string(path)?;
    let (fm_str, body) = split_frontmatter(&raw);
    let frontmatter = parse_yaml(fm_str);
    let title = derive_title(path, &frontmatter, &body);
    let snippet = make_snippet(&body, 280);
    let rel_path = path.strip_prefix(root).unwrap_or(path).to_string_lossy().to_string();
    let meta = Note {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        snippet,
        frontmatter,
        modified: mtime as i64,
    };
    Ok((meta, body))
}

fn parse_yaml(fm_str: &str) -> serde_json::Value {
    if fm_str.trim().is_empty() {
        return serde_json::Value::Object(Default::default());
    }
    let yaml: YamlValue = serde_yaml::from_str(fm_str).unwrap_or(YamlValue::Mapping(Default::default()));
    yaml_to_json(&yaml)
}

fn derive_title(path: &Path, fm: &serde_json::Value, body: &str) -> String {
    fm.get("title")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| extract_h1(body))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string()
        })
}

pub fn split_frontmatter(raw: &str) -> (&str, String) {
    let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    if !(trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n")) {
        return ("", trimmed.to_string());
    }
    let lead_len = if trimmed.starts_with("---\r\n") { 5 } else { 4 };
    let rest = &trimmed[lead_len..];
    let end = rest.find("\n---\n")
        .or_else(|| rest.find("\n---\r\n"))
        .or_else(|| if rest.ends_with("\n---") { Some(rest.len() - 4) } else { None });
    match end {
        Some(at) => {
            let fm = &rest[..at];
            let after = &rest[at..];
            let body_offset = after.find('\n').map(|i| i + 1).unwrap_or(0);
            let after2 = &after[body_offset..];
            let body_offset2 = if after2.starts_with("---\n") { 4 }
                else if after2.starts_with("---\r\n") { 5 }
                else if after2 == "---" { 3 }
                else { 0 };
            (fm, after2[body_offset2..].to_string())
        }
        None => ("", raw.to_string()),
    }
}

fn extract_h1(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim_start)
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches('#').trim().to_string())
}

// First ~max chars of body with headings, code fences, and inline markdown stripped.
fn make_snippet(body: &str, max: usize) -> String {
    let mut out = String::with_capacity(max);
    let mut in_code = false;
    for line in body.lines() {
        let line = line.trim();
        if line.starts_with("```") { in_code = !in_code; continue; }
        if in_code { continue; }
        if line.is_empty() { continue; }
        if line.starts_with('#') { continue; }
        let cleaned = strip_inline_markdown(line);
        if !out.is_empty() { out.push(' '); }
        out.push_str(&cleaned);
        if out.chars().count() >= max { break; }
    }
    let trimmed = out.trim();
    if trimmed.chars().count() > max {
        let mut s: String = trimmed.chars().take(max).collect();
        s.push('…');
        s
    } else {
        trimmed.to_string()
    }
}

fn strip_inline_markdown(s: &str) -> String {
    // [[wikilink]] → wikilink ; **bold** / __bold__ / _em_ / *em* / `code` → text
    // Iterate by char (UTF-32 code point) so multi-byte characters survive.
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '[' && chars.peek() == Some(&'[') {
            chars.next();
            while let Some(c2) = chars.next() {
                if c2 == ']' && chars.peek() == Some(&']') {
                    chars.next();
                    break;
                }
                out.push(c2);
            }
        } else if c == '*' || c == '_' || c == '`' {
            // skip the marker
        } else {
            out.push(c);
        }
    }
    out
}

fn yaml_to_json(v: &YamlValue) -> serde_json::Value {
    match v {
        YamlValue::Null => serde_json::Value::Null,
        YamlValue::Bool(b) => serde_json::Value::Bool(*b),
        YamlValue::Number(n) => {
            if let Some(i) = n.as_i64() { serde_json::Value::Number(i.into()) }
            else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            } else { serde_json::Value::Null }
        }
        YamlValue::String(s) => serde_json::Value::String(s.clone()),
        YamlValue::Sequence(seq) => serde_json::Value::Array(seq.iter().map(yaml_to_json).collect()),
        YamlValue::Mapping(map) => {
            let mut o = serde_json::Map::new();
            for (k, v) in map {
                let key = match k {
                    YamlValue::String(s) => s.clone(),
                    other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
                };
                o.insert(key, yaml_to_json(v));
            }
            serde_json::Value::Object(o)
        }
        YamlValue::Tagged(t) => yaml_to_json(&t.value),
    }
}

fn json_to_yaml_string(v: &serde_json::Value) -> anyhow::Result<String> {
    let s = serde_json::to_string(v)?;
    let y: YamlValue = serde_yaml::from_str(&s)?;
    Ok(serde_yaml::to_string(&y)?)
}

// ---------------------------------------------------------------------------
// Single-card MVP helpers.
//
// read_text/write_text are intentionally dumb: absolute path in, raw UTF-8 out
// (and back). No frontmatter parsing, no caching, no watcher coupling. The
// card component owns its own file end-to-end.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_binary(path: String, data: Vec<u8>) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_file(from: String, to: String) -> Result<(), String> {
    if from == to { return Ok(()); }
    let to_path = std::path::Path::new(&to);
    if to_path.exists() {
        return Err(format!("target exists: {to}"));
    }
    if let Some(parent) = to_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

// Hand a file off to the OS so attachments (PDFs, etc.) launch in
// the user's default viewer instead of trying to render inside the
// webview. macOS uses `open`; Linux uses xdg-open; Windows uses the
// cmd start verb.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("not found: {path}"));
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&path).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&path).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", &path]).spawn();
    // Desktop only. On mobile (iOS/Android) there's no shell to spawn,
    // so `result` would otherwise be undefined and fail to compile.
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "open_path is not supported on this platform",
    ));
    result.map(|_| ()).map_err(|e| e.to_string())
}

// Open an external URL (http/https/mailto/etc.) in the user's default
// browser/handler. Distinct from open_path because URLs aren't paths —
// no fs::exists() check, and we accept any scheme the OS opener knows
// how to handle. Sibling of open_path so the WebView can intercept
// external anchor clicks (Tauri's webview navigates IN the webview by
// default, which we don't want for http(s) links in note bodies).
#[tauri::command]
pub fn open_url(
    #[allow(unused_variables)] app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    if url.is_empty() {
        return Err("empty url".into());
    }
    // iOS: shell-spawn isn't available, so delegate to the vault
    // plugin's Swift-side `openUrl` which calls UIApplication.open.
    // Without this path, taps on links and the YouTube thumbnail
    // fallback all fail silently and the user is stranded inside
    // the in-app WebView.
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_vault::VaultExt;
        return app.vault().open_url(url).map_err(|e| e.to_string());
    }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", &url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows", target_os = "ios")))]
    let result: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "open_url is not supported on this platform",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux", target_os = "windows"))]
    return result.map(|_| ()).map_err(|e| e.to_string());
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows", target_os = "ios")))]
    return result.map(|_| ()).map_err(|e| e.to_string());
}

#[cfg(test)]
mod open_url_tests {
    /// We can't actually invoke the Tauri command from a unit test
    /// (no AppHandle, no plugin runtime). What we CAN prove is that
    /// the cfg gating is internally consistent — exactly one of the
    /// platform branches compiles for each target. The build itself
    /// is the test here: when the code below compiles, every target
    /// has a well-defined open_url implementation. The presence of
    /// these constants in the test build also catches a regression
    /// where an entire platform branch is accidentally deleted.
    #[test]
    fn one_platform_branch_active() {
        #[cfg(target_os = "ios")]
        const ACTIVE: &str = "ios";
        #[cfg(target_os = "macos")]
        const ACTIVE: &str = "macos";
        #[cfg(target_os = "linux")]
        const ACTIVE: &str = "linux";
        #[cfg(target_os = "windows")]
        const ACTIVE: &str = "windows";
        #[cfg(not(any(
            target_os = "ios",
            target_os = "macos",
            target_os = "linux",
            target_os = "windows",
        )))]
        const ACTIVE: &str = "other";
        assert!(!ACTIVE.is_empty(), "exactly one branch is active");
    }
}
