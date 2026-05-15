// Vault module: scan markdown files, read/write notes, patch YAML front matter.
// Filesystem is the source of truth; writes go through here before React state updates.

use std::fs;
use std::path::{Path, PathBuf};
use gray_matter::{Matter, engine::YAML};
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use walkdir::WalkDir;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub path: String,          // absolute path
    pub rel_path: String,      // path relative to vault root
    pub title: String,
    pub body: String,
    pub frontmatter: serde_json::Value,
    pub modified: i64,         // unix seconds
}

#[tauri::command]
pub fn set_vault(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    *state.vault_path.lock().unwrap() = Some(path);
    Ok(())
}

#[tauri::command]
pub fn scan_vault(path: String) -> Result<Vec<Note>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut notes = Vec::new();
    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() { continue; }
        if p.extension().and_then(|s| s.to_str()) != Some("md") { continue; }
        if let Ok(note) = parse_note(p, &root) {
            notes.push(note);
        }
    }
    Ok(notes)
}

#[tauri::command]
pub fn read_note(path: String) -> Result<Note, String> {
    let abs = PathBuf::from(&path);
    let root = abs.parent().map(Path::to_path_buf).unwrap_or_default();
    parse_note(&abs, &root).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_note(path: String, body: String, frontmatter: serde_json::Value) -> Result<(), String> {
    let yaml = json_to_yaml(&frontmatter).map_err(|e| e.to_string())?;
    let yaml_str = serde_yaml::to_string(&yaml).map_err(|e| e.to_string())?;
    let content = if frontmatter.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        format!("---\n{}---\n{}", yaml_str, body)
    } else {
        body
    };
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_frontmatter(path: String, patch: serde_json::Value) -> Result<Note, String> {
    let abs = PathBuf::from(&path);
    let root = abs.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut note = parse_note(&abs, &root).map_err(|e| e.to_string())?;
    if let (Some(obj), Some(patch_obj)) = (note.frontmatter.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    save_note(path, note.body.clone(), note.frontmatter.clone())?;
    Ok(note)
}

#[tauri::command]
pub fn delete_note(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())
}

fn parse_note(path: &Path, root: &Path) -> anyhow::Result<Note> {
    let raw = fs::read_to_string(path)?;
    let matter = Matter::<YAML>::new();
    let parsed = matter.parse(&raw);

    // gray_matter returns Pod; convert to serde_json::Value via JSON round-trip.
    let fm: serde_json::Value = match parsed.data {
        Some(pod) => {
            let s = serde_json::to_string(&pod).unwrap_or_else(|_| "{}".into());
            serde_json::from_str(&s).unwrap_or(serde_json::Value::Object(Default::default()))
        }
        None => serde_json::Value::Object(Default::default()),
    };

    let body = parsed.content;
    let title = fm.get("title")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| extract_h1(&body))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string()
        });

    let modified = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let rel_path = path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    Ok(Note {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        body,
        frontmatter: fm,
        modified,
    })
}

fn extract_h1(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim_start)
        .find(|l| l.starts_with("# "))
        .map(|l| l.trim_start_matches('#').trim().to_string())
}

// Convert serde_json::Value → serde_yaml::Value preserving structure.
fn json_to_yaml(v: &serde_json::Value) -> anyhow::Result<YamlValue> {
    let s = serde_json::to_string(v)?;
    Ok(serde_yaml::from_str(&s)?)
}
