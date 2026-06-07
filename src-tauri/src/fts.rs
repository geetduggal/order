// Lightweight full-text search index. Holds {path, body, mtime} for
// every .md note in the vault, persisted as a single JSON file in the
// app's data dir so subsequent launches don't rebuild from scratch.
//
// Search is O(N * Q): a case-insensitive substring scan over every
// note's body. Order's vaults top out in the low thousands of notes,
// which is fine for a single-thread scan on a modern phone or laptop.
// If that ever changes, swap the scan for a trigram or tantivy
// index — the JS surface (build / search commands + result shape)
// won't need to change.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::vault_fs::VaultState;

#[derive(Default)]
pub struct FtsState {
    pub docs: Mutex<Vec<FtsDoc>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FtsDoc {
    pub path: String,
    pub body: String,
    pub mtime: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct FtsHit {
    pub path: String,
    pub snippet: String,
    pub match_offset: usize,
    pub match_length: usize,
}

fn index_file_for(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("fts-index.json"))
}

fn snippet_for(body: &str, offset: usize, query_len: usize) -> String {
    // Build a ~140-char window around the match. Trim by *char* boundary
    // (avoid splitting multibyte sequences mid-codepoint), prefix with …
    // when not at the start, suffix … when not at the end.
    const PRE: usize = 40;
    const POST: usize = 120;
    let start = offset.saturating_sub(PRE);
    let end = (offset + query_len + POST).min(body.len());
    // Walk to char boundaries.
    let mut s = start;
    while s > 0 && !body.is_char_boundary(s) { s -= 1; }
    let mut e = end;
    while e < body.len() && !body.is_char_boundary(e) { e += 1; }
    let slice = &body[s..e];
    let mut out = String::new();
    if s > 0 { out.push('…'); }
    // Collapse runs of whitespace so the snippet reads as one line.
    let mut last_ws = false;
    for ch in slice.chars() {
        if ch.is_whitespace() {
            if !last_ws { out.push(' '); }
            last_ws = true;
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    if e < body.len() { out.push('…'); }
    out
}

/// Walk the vault, read every .md body, persist {path, body, mtime}
/// to the on-disk index, AND update the in-memory state.
#[tauri::command]
pub fn fts_build_index(
    app: tauri::AppHandle,
    state: tauri::State<VaultState>,
    fts: tauri::State<FtsState>,
) -> Result<usize, String> {
    let root = {
        let guard = state.root.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("vault root not set")?.clone()
    };
    let mut docs = Vec::new();
    walk(&root, &mut docs);
    let n = docs.len();
    let json = serde_json::to_vec(&docs).map_err(|e| e.to_string())?;
    fs::write(index_file_for(&app)?, json).map_err(|e| e.to_string())?;
    *fts.docs.lock().map_err(|e| e.to_string())? = docs;
    Ok(n)
}

/// Load the persisted index into memory (or start empty if none).
#[tauri::command]
pub fn fts_load_index(
    app: tauri::AppHandle,
    fts: tauri::State<FtsState>,
) -> Result<usize, String> {
    let path = index_file_for(&app)?;
    if !path.exists() {
        *fts.docs.lock().map_err(|e| e.to_string())? = Vec::new();
        return Ok(0);
    }
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let docs: Vec<FtsDoc> = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let n = docs.len();
    *fts.docs.lock().map_err(|e| e.to_string())? = docs;
    Ok(n)
}

/// Case-insensitive substring search across every indexed body.
/// Returns up to `limit` hits with a snippet around the first match.
#[tauri::command]
pub fn fts_search(
    fts: tauri::State<FtsState>,
    query: String,
    limit: usize,
) -> Result<Vec<FtsHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let q_lower = q.to_lowercase();
    let q_len = q_lower.len();
    let docs = fts.docs.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in docs.iter() {
        // body.to_lowercase() allocates per-call — fine at vault scale.
        // For larger vaults, prebuild lowercased bodies at index time.
        let lower = d.body.to_lowercase();
        if let Some(offset) = lower.find(&q_lower) {
            out.push(FtsHit {
                path: d.path.clone(),
                snippet: snippet_for(&d.body, offset, q_len),
                match_offset: offset,
                match_length: q_len,
            });
            if out.len() >= limit { break; }
        }
    }
    Ok(out)
}

fn walk(dir: &std::path::Path, out: &mut Vec<FtsDoc>) {
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
            walk(&entry.path(), out);
        } else if name.ends_with(".md") {
            let p = entry.path();
            let body = fs::read_to_string(&p).unwrap_or_default();
            let mtime = fs::metadata(&p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(FtsDoc {
                path: p.to_string_lossy().to_string(),
                body,
                mtime,
            });
        }
    }
}
