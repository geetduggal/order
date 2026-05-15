// Vault module: scan markdown files, read/write notes, patch YAML front matter.
// Filesystem is the source of truth; writes go through here before React state updates.

use std::fs;
use std::path::{Path, PathBuf};
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
    let (fm_str, body) = split_frontmatter(&raw);
    let frontmatter = if fm_str.trim().is_empty() {
        serde_json::Value::Object(Default::default())
    } else {
        let yaml: YamlValue = serde_yaml::from_str(fm_str)
            .unwrap_or(YamlValue::Mapping(Default::default()));
        yaml_to_json(&yaml)
    };

    let title = frontmatter.get("title")
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
        frontmatter,
        modified,
    })
}

// Split a markdown file into (front-matter YAML text, body).
// Accepts files with or without front matter.
pub fn split_frontmatter(raw: &str) -> (&str, String) {
    let trimmed = raw.strip_prefix('\u{FEFF}').unwrap_or(raw); // strip BOM if any
    if !(trimmed.starts_with("---\n") || trimmed.starts_with("---\r\n")) {
        return ("", trimmed.to_string());
    }
    let lead_len = if trimmed.starts_with("---\r\n") { 5 } else { 4 };
    let rest = &trimmed[lead_len..];
    // Find closing --- on its own line.
    let end = rest.find("\n---\n")
        .or_else(|| rest.find("\n---\r\n"))
        .or_else(|| if rest.ends_with("\n---") { Some(rest.len() - 4) } else { None });
    match end {
        Some(at) => {
            let fm = &rest[..at];
            // skip past "\n---\n" or similar to the body
            let after = &rest[at..];
            let body_offset = after.find('\n').map(|i| i + 1).unwrap_or(0);
            let after2 = &after[body_offset..];
            let body_offset2 = if after2.starts_with("---\n") { 4 }
                else if after2.starts_with("---\r\n") { 5 }
                else if after2 == "---" { 3 }
                else { 0 };
            let body = &after2[body_offset2..];
            (fm, body.to_string())
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

fn yaml_to_json(v: &YamlValue) -> serde_json::Value {
    match v {
        YamlValue::Null => serde_json::Value::Null,
        YamlValue::Bool(b) => serde_json::Value::Bool(*b),
        YamlValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_json::Value::Number(i.into())
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(f).map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null)
            } else {
                serde_json::Value::Null
            }
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
