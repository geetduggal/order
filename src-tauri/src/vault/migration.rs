use std::fs;
use std::path::Path;
use walkdir::WalkDir;

fn has_legacy_is_a(fm_content: &str) -> bool {
    fm_content.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with("is_a:")
            || t.starts_with("\"Is A\":")
            || t.starts_with("'Is A':")
            || t.starts_with("Is A:")
    })
}

/// Extract the value from a legacy `is_a` / `Is A` line.
fn extract_is_a_value(line: &str) -> Option<&str> {
    let t = line.trim_start();
    for prefix in &["is_a:", "\"Is A\":", "'Is A':", "Is A:"] {
        if let Some(rest) = t.strip_prefix(prefix) {
            let v = rest.trim();
            return Some(v);
        }
    }
    None
}

/// Migrate a single file's frontmatter from `is_a`/`Is A` to `type`.
/// Returns Ok(true) if the file was modified, Ok(false) if no migration needed.
fn migrate_file_is_a_to_type(path: &Path) -> Result<bool, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    if !content.starts_with("---\n") {
        return Ok(false);
    }
    let fm_end = match content[4..].find("\n---") {
        Some(i) => i + 4,
        None => return Ok(false),
    };
    let fm_content = &content[4..fm_end];

    if !has_legacy_is_a(fm_content) {
        return Ok(false);
    }

    // Check if `type:` already exists
    let has_type = fm_content.lines().any(|line| {
        let t = line.trim_start();
        t.starts_with("type:")
    });

    let mut new_lines: Vec<String> = Vec::new();
    let mut is_a_value: Option<String> = None;

    for line in fm_content.lines() {
        if let Some(val) = extract_is_a_value(line) {
            is_a_value = Some(val.to_string());
            // Skip list continuations after is_a
            continue;
        }
        new_lines.push(line.to_string());
    }

    // If type: doesn't exist and we found an is_a value, add type:
    if !has_type {
        if let Some(ref val) = is_a_value {
            // Insert type: at the beginning (after other keys is fine too, but beginning is clean)
            new_lines.insert(0, format!("type: {}", val));
        }
    }

    let rest = &content[fm_end + 4..];
    let new_content = format!("---\n{}\n---{}", new_lines.join("\n"), rest);

    fs::write(path, &new_content)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;

    Ok(true)
}

/// Migrate all markdown files in the vault from `is_a`/`Is A` to `type`.
/// Returns the number of files migrated.
pub fn migrate_is_a_to_type(vault_path: &str) -> Result<usize, String> {
    let vault = Path::new(vault_path);
    if !vault.exists() || !vault.is_dir() {
        return Err(format!(
            "Vault path does not exist or is not a directory: {}",
            vault_path
        ));
    }

    let mut migrated = 0;
    for entry in WalkDir::new(vault)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() || path.extension().map(|ext| ext != "md").unwrap_or(true) {
            continue;
        }

        match migrate_file_is_a_to_type(path) {
            Ok(true) => {
                log::info!("Migrated is_a → type: {}", path.display());
                migrated += 1;
            }
            Ok(false) => {}
            Err(e) => {
                log::warn!("Failed to migrate {}: {}", path.display(), e);
            }
        }
    }

    Ok(migrated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_file(dir: &std::path::Path, name: &str, content: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    // --- has_legacy_is_a ---

    #[test]
    fn test_has_legacy_is_a_detects_is_a_colon() {
        assert!(has_legacy_is_a("is_a: Person\nname: Alice"));
    }

    #[test]
    fn test_has_legacy_is_a_detects_quoted_is_a() {
        assert!(has_legacy_is_a("\"Is A\": Note\nname: Test"));
    }

    #[test]
    fn test_has_legacy_is_a_detects_bare_is_a() {
        assert!(has_legacy_is_a("Is A: Topic\n"));
    }

    #[test]
    fn test_has_legacy_is_a_returns_false_for_clean_frontmatter() {
        assert!(!has_legacy_is_a("type: Person\nname: Alice"));
    }

    // --- extract_is_a_value ---

    #[test]
    fn test_extract_is_a_value_from_is_a_colon() {
        assert_eq!(extract_is_a_value("is_a: Person"), Some("Person"));
    }

    #[test]
    fn test_extract_is_a_value_from_quoted() {
        assert_eq!(extract_is_a_value("\"Is A\": Note"), Some("Note"));
    }

    #[test]
    fn test_extract_is_a_value_returns_none_for_unrelated_line() {
        assert_eq!(extract_is_a_value("name: Alice"), None);
    }

    // --- migrate_file_is_a_to_type ---

    #[test]
    fn test_migrate_file_adds_type_and_removes_is_a() {
        let tmp = tempdir().unwrap();
        let path = write_file(
            tmp.path(),
            "note.md",
            "---\nis_a: Person\nname: Alice\n---\n# Alice\n",
        );
        let result = migrate_file_is_a_to_type(&path).unwrap();
        assert!(result, "file should be migrated");
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("type: Person"), "should have type field");
        assert!(!content.contains("is_a:"), "should not have is_a field");
    }

    #[test]
    fn test_migrate_file_skips_when_no_frontmatter() {
        let tmp = tempdir().unwrap();
        let path = write_file(
            tmp.path(),
            "note.md",
            "# Just a heading\nNo frontmatter here.\n",
        );
        let result = migrate_file_is_a_to_type(&path).unwrap();
        assert!(!result, "file without frontmatter should not be migrated");
    }

    #[test]
    fn test_migrate_file_skips_when_already_has_type() {
        let tmp = tempdir().unwrap();
        let path = write_file(
            tmp.path(),
            "note.md",
            "---\ntype: Person\nname: Alice\n---\n# Alice\n",
        );
        let result = migrate_file_is_a_to_type(&path).unwrap();
        assert!(!result, "file already with type should not be migrated");
    }

    #[test]
    fn test_migrate_file_skips_when_no_is_a_field() {
        let tmp = tempdir().unwrap();
        let path = write_file(
            tmp.path(),
            "note.md",
            "---\nname: Alice\ndate: 2024-01-01\n---\n# Alice\n",
        );
        let result = migrate_file_is_a_to_type(&path).unwrap();
        assert!(!result);
    }

    // --- migrate_is_a_to_type (public function) ---

    #[test]
    fn test_migrate_vault_returns_count_of_migrated_files() {
        let tmp = tempdir().unwrap();
        write_file(
            tmp.path(),
            "note1.md",
            "---\nis_a: Person\nname: Alice\n---\n",
        );
        write_file(tmp.path(), "note2.md", "---\nis_a: Topic\nname: AI\n---\n");
        write_file(
            tmp.path(),
            "note3.md",
            "---\ntype: Event\nname: Conf\n---\n",
        );
        let count = migrate_is_a_to_type(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(count, 2, "should migrate exactly 2 files");
    }

    #[test]
    fn test_migrate_vault_returns_error_for_nonexistent_path() {
        let result = migrate_is_a_to_type("/tmp/this-path-does-not-exist-laputa-test");
        assert!(result.is_err());
    }

    #[test]
    fn test_migrate_vault_ignores_non_markdown_files() {
        let tmp = tempdir().unwrap();
        write_file(tmp.path(), "image.png", "not a markdown file");
        write_file(tmp.path(), "data.json", "{\"is_a\": \"test\"}");
        let count = migrate_is_a_to_type(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(count, 0, "non-markdown files should be ignored");
    }
}
