// Publishing pipeline: copy public-flagged notes into vault/public/, commit, push.
// The Git remote and static site build happen outside this command (GitHub Actions).

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use walkdir::WalkDir;
use serde_yaml::Value as YamlValue;
use crate::vault::split_frontmatter;

#[tauri::command]
pub fn publish_public(vault: String) -> Result<u32, String> {
    let root = PathBuf::from(&vault);
    let public_dir = root.join("public");
    fs::create_dir_all(&public_dir).map_err(|e| e.to_string())?;

    let mut count = 0u32;

    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if !p.is_file() { continue; }
        if p.starts_with(&public_dir) { continue; }
        if p.extension().and_then(|s| s.to_str()) != Some("md") { continue; }

        let raw = match fs::read_to_string(p) { Ok(s) => s, Err(_) => continue };
        let (fm_str, _body) = split_frontmatter(&raw);
        let is_public = serde_yaml::from_str::<YamlValue>(fm_str)
            .ok()
            .and_then(|v| v.get("public").and_then(YamlValue::as_bool))
            .unwrap_or(false);

        if !is_public { continue; }

        let rel = p.strip_prefix(&root).unwrap_or(p);
        let dest = public_dir.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(p, &dest).map_err(|e| e.to_string())?;
        count += 1;
    }

    // Git commit + push if vault is a git repo. Failures here don't roll back
    // the staging copy — the user can retry the publish.
    if root.join(".git").is_dir() {
        let _ = Command::new("git").arg("-C").arg(&root).arg("add").arg("public/").status();
        let _ = Command::new("git").arg("-C").arg(&root).arg("commit").arg("-m").arg(format!("publish: {} notes", count)).status();
        let _ = Command::new("git").arg("-C").arg(&root).arg("push").status();
    }

    Ok(count)
}
