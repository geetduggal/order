use std::fs;
use std::path::Path;

use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};

use super::parsing::slug_to_title;
use super::rename::title_to_slug;

/// Result of a title sync check.
#[derive(Debug, PartialEq)]
pub enum SyncAction {
    /// Title and filename are already in sync.
    InSync,
    /// Title was absent or desynced; frontmatter was updated on disk.
    Updated { title: String },
}

/// Extract the raw `title:` value from frontmatter in file content.
fn extract_raw_title(content: &str) -> Option<String> {
    if !content.starts_with("---\n") {
        return None;
    }
    let fm = content[4..].split("\n---").next()?;
    for line in fm.lines() {
        let t = line.trim_start();
        for prefix in &["title:", "\"title\":"] {
            if let Some(rest) = t.strip_prefix(prefix) {
                let val = rest.trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Sync the `title` frontmatter field with the filename.
///
/// Rules (filename is source of truth):
/// - If `title` is absent → derive from filename, write to frontmatter
/// - If `title` is present but its slug doesn't match the filename stem → overwrite
/// - If both are in sync → no-op
pub fn sync_title_on_open(path: &Path) -> Result<SyncAction, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let stem = filename.strip_suffix(".md").unwrap_or(&filename);
    let expected_title = slug_to_title(stem);

    let fm_title = extract_raw_title(&content);

    match fm_title {
        Some(ref title) if title_to_slug(title) == stem => Ok(SyncAction::InSync),
        _ => {
            // Title absent or desynced — filename wins
            let value = FrontmatterValue::String(expected_title.clone());
            let updated = update_frontmatter_content(&content, "title", Some(value))
                .map_err(|e| format!("Failed to update frontmatter: {}", e))?;
            fs::write(path, &updated)
                .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
            Ok(SyncAction::Updated {
                title: expected_title,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_note(dir: &Path, name: &str, content: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    #[test]
    fn test_sync_adds_title_when_absent() {
        let dir = TempDir::new().unwrap();
        let path = write_note(
            dir.path(),
            "career-tracks.md",
            "---\ntype: Note\n---\n# Career Tracks\n",
        );
        let result = sync_title_on_open(&path).unwrap();
        assert_eq!(
            result,
            SyncAction::Updated {
                title: "Career Tracks".to_string()
            }
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("title: Career Tracks"));
    }

    #[test]
    fn test_sync_noop_when_in_sync() {
        let dir = TempDir::new().unwrap();
        let path = write_note(
            dir.path(),
            "my-note.md",
            "---\ntitle: My Note\ntype: Note\n---\n# My Note\n",
        );
        let result = sync_title_on_open(&path).unwrap();
        assert_eq!(result, SyncAction::InSync);
    }

    #[test]
    fn test_sync_overwrites_desynced_title() {
        let dir = TempDir::new().unwrap();
        // Filename says "new-name" but title says "Old Name"
        let path = write_note(
            dir.path(),
            "new-name.md",
            "---\ntitle: Old Name\ntype: Note\n---\n# Old Name\n",
        );
        let result = sync_title_on_open(&path).unwrap();
        assert_eq!(
            result,
            SyncAction::Updated {
                title: "New Name".to_string()
            }
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("title: New Name"));
        assert!(!content.contains("title: Old Name"));
    }

    #[test]
    fn test_sync_adds_frontmatter_when_none_exists() {
        let dir = TempDir::new().unwrap();
        let path = write_note(
            dir.path(),
            "plain-note.md",
            "# Plain Note\n\nSome content.\n",
        );
        let result = sync_title_on_open(&path).unwrap();
        assert_eq!(
            result,
            SyncAction::Updated {
                title: "Plain Note".to_string()
            }
        );
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("---\n"));
        assert!(content.contains("title: Plain Note"));
    }

    #[test]
    fn test_sync_e2e_filename() {
        let dir = TempDir::new().unwrap();
        let path = write_note(dir.path(), "e2e-test.md", "---\ntype: Note\n---\n");
        let result = sync_title_on_open(&path).unwrap();
        assert_eq!(
            result,
            SyncAction::Updated {
                title: "E2e Test".to_string()
            }
        );
    }

    #[test]
    fn test_sync_preserves_other_frontmatter() {
        let dir = TempDir::new().unwrap();
        let path = write_note(
            dir.path(),
            "my-note.md",
            "---\ntype: Project\nstatus: Active\n---\n# My Note\n",
        );
        sync_title_on_open(&path).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("type: Project"));
        assert!(content.contains("status: Active"));
        assert!(content.contains("title: My Note"));
    }
}
