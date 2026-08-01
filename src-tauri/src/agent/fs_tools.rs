//! Vault-relative filesystem tools for the agent. Every operation resolves a
//! vault-relative path against the vault root and REJECTS anything that would
//! escape it (absolute paths, `..`). These are plain functions taking the
//! resolved vault `root: &Path` so they run identically on macOS + iOS (the
//! caller passes the root from `VaultState`) and are unit-testable with a temp
//! dir. Every function returns a readable string the model can act on — success
//! detail or a recoverable error message.

use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// Result caps so a single tool call can't flood the model's context.
const MAX_READ_BYTES: usize = 200_000;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_LIST_ENTRIES: usize = 500;
const CONTEXT_LINES: usize = 1;

/// Resolve a vault-relative path to an absolute path under `root`, or reject it.
/// Rejects absolute paths and any `..` component so a path can never escape.
pub fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let trimmed = rel.trim();
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(format!("path must be vault-relative, not absolute: {rel}"));
    }
    // Windows-style drive letter, just in case.
    if trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':' {
        return Err(format!("path must be vault-relative: {rel}"));
    }
    let mut p = root.to_path_buf();
    for comp in trimmed.split(['/', '\\']) {
        match comp {
            "" | "." => continue,
            ".." => return Err(format!("path escapes the vault root: {rel}")),
            other => p.push(other),
        }
    }
    Ok(p)
}

/// Display a resolved path back as a clean vault-relative string.
fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

// ---- glob matching (no deps) ----------------------------------------------

/// Match `text` against a glob `pattern`: `*` = any run except `/`, `**` = any
/// run including `/`, `?` = one non-`/` char. Everything else is literal.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    fn m(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            '*' => {
                // `**` crosses `/`; a single `*` does not.
                let double = p.len() >= 2 && p[1] == '*';
                let rest = if double { &p[2..] } else { &p[1..] };
                // zero-width match
                if m(rest, t) {
                    return true;
                }
                let mut i = 0;
                while i < t.len() {
                    if !double && t[i] == '/' {
                        break;
                    }
                    i += 1;
                    if m(rest, &t[i..]) {
                        return true;
                    }
                }
                false
            }
            '?' => !t.is_empty() && t[0] != '/' && m(&p[1..], &t[1..]),
            c => !t.is_empty() && t[0] == c && m(&p[1..], &t[1..]),
        }
    }
    m(&p, &t)
}

// ---- tools -----------------------------------------------------------------

pub fn list_directory(root: &Path, rel: &str) -> Result<String, String> {
    let dir = resolve_in_vault(root, rel)?;
    if !dir.exists() {
        return Err(format!("directory not found: {rel}"));
    }
    if !dir.is_dir() {
        return Err(format!("not a directory: {rel}"));
    }
    let mut entries: Vec<(bool, String, u64)> = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| format!("read_dir {rel}: {e}"))? {
        let e = match e {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push((is_dir, name, size));
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let shown = entries.len().min(MAX_LIST_ENTRIES);
    let base = if rel.trim().is_empty() { "(vault root)".to_string() } else { rel.to_string() };
    let mut out = format!("{} entries in {}:\n", entries.len(), base);
    for (is_dir, name, size) in entries.iter().take(shown) {
        if *is_dir {
            out.push_str(&format!("  {}/\n", name));
        } else {
            out.push_str(&format!("  {} ({} bytes)\n", name, size));
        }
    }
    if entries.len() > shown {
        out.push_str(&format!("  … and {} more\n", entries.len() - shown));
    }
    Ok(out)
}

pub fn read_file(root: &Path, rel: &str) -> Result<String, String> {
    let p = resolve_in_vault(root, rel)?;
    if !p.exists() {
        return Err(format!("file not found: {rel}"));
    }
    if p.is_dir() {
        return Err(format!("is a directory, not a file: {rel}"));
    }
    let bytes = std::fs::read(&p).map_err(|e| format!("read {rel}: {e}"))?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = &bytes[..bytes.len().min(MAX_READ_BYTES)];
    match std::str::from_utf8(slice) {
        Ok(s) => {
            let mut out = s.to_string();
            if truncated {
                out.push_str(&format!("\n\n[truncated at {MAX_READ_BYTES} bytes of {} total]", bytes.len()));
            }
            Ok(out)
        }
        Err(_) => Err(format!("not a UTF-8 text file: {rel} ({} bytes)", bytes.len())),
    }
}

pub fn search_files(root: &Path, pattern: &str) -> Result<String, String> {
    // Match against the vault-relative path; a bare `foo.md` also matches by
    // basename so simple queries work without a leading `**/`.
    let pat = pattern.trim();
    let mut hits: Vec<String> = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_dir() {
            continue;
        }
        let rel = rel_of(root, entry.path());
        let name = entry.file_name().to_string_lossy();
        if glob_match(pat, &rel) || glob_match(pat, &name) {
            hits.push(rel);
            if hits.len() >= MAX_SEARCH_RESULTS {
                break;
            }
        }
    }
    hits.sort();
    if hits.is_empty() {
        return Ok(format!("No files match `{pattern}`."));
    }
    Ok(format!("{} file(s) matching `{}`:\n{}", hits.len(), pattern,
        hits.iter().map(|h| format!("  {h}")).collect::<Vec<_>>().join("\n")))
}

pub fn search_content(root: &Path, query: &str, path_glob: Option<&str>) -> Result<String, String> {
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return Err("empty search query".into());
    }
    let mut out = String::new();
    let mut total = 0usize;
    'files: for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_dir() {
            continue;
        }
        let rel = rel_of(root, entry.path());
        if let Some(g) = path_glob {
            if !(glob_match(g, &rel) || glob_match(g, &entry.file_name().to_string_lossy())) {
                continue;
            }
        }
        let bytes = match std::fs::read(entry.path()) {
            Ok(b) if b.len() <= MAX_READ_BYTES * 4 => b,
            _ => continue,
        };
        let text = match String::from_utf8(bytes) {
            Ok(t) => t,
            Err(_) => continue, // binary
        };
        let lines: Vec<&str> = text.lines().collect();
        let mut file_header = false;
        for (i, line) in lines.iter().enumerate() {
            if line.to_lowercase().contains(&needle) {
                if !file_header {
                    out.push_str(&format!("\n{rel}:\n"));
                    file_header = true;
                }
                let lo = i.saturating_sub(CONTEXT_LINES);
                let hi = (i + CONTEXT_LINES + 1).min(lines.len());
                for j in lo..hi {
                    let marker = if j == i { ">" } else { " " };
                    out.push_str(&format!("  {marker} {}: {}\n", j + 1, lines[j]));
                }
                total += 1;
                if total >= MAX_SEARCH_RESULTS {
                    out.push_str("\n[result cap reached]\n");
                    break 'files;
                }
            }
        }
    }
    if total == 0 {
        return Ok(format!("No matches for `{query}`."));
    }
    Ok(format!("{total} match(es) for `{query}`:{out}"))
}

pub fn write_file(root: &Path, rel: &str, content: &str) -> Result<String, String> {
    let p = resolve_in_vault(root, rel)?;
    if p.is_dir() {
        return Err(format!("is a directory, cannot write a file: {rel}"));
    }
    let existed = p.exists();
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent for {rel}: {e}"))?;
    }
    std::fs::write(&p, content).map_err(|e| format!("write {rel}: {e}"))?;
    Ok(format!("{} {rel} ({} bytes)", if existed { "Overwrote" } else { "Created" }, content.len()))
}

pub fn edit_file(root: &Path, rel: &str, old: &str, new: &str) -> Result<String, String> {
    if old.is_empty() {
        return Err("edit_file: the target string is empty".into());
    }
    let p = resolve_in_vault(root, rel)?;
    if !p.exists() {
        return Err(format!("file not found: {rel}"));
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("read {rel}: {e}"))?;
    let count = text.matches(old).count();
    if count == 0 {
        return Err(format!("edit_file: target string not found in {rel}. Read the file and match it exactly."));
    }
    if count > 1 {
        return Err(format!("edit_file: target string appears {count} times in {rel} — include more surrounding context so it's unique."));
    }
    let updated = text.replacen(old, new, 1);
    std::fs::write(&p, &updated).map_err(|e| format!("write {rel}: {e}"))?;
    Ok(format!("Edited {rel} (1 replacement)."))
}

pub fn create_directory(root: &Path, rel: &str) -> Result<String, String> {
    let p = resolve_in_vault(root, rel)?;
    std::fs::create_dir_all(&p).map_err(|e| format!("create_directory {rel}: {e}"))?;
    Ok(format!("Created directory {rel}."))
}

pub fn move_file(root: &Path, from: &str, to: &str) -> Result<String, String> {
    let src = resolve_in_vault(root, from)?;
    let dst = resolve_in_vault(root, to)?;
    if !src.exists() {
        return Err(format!("source not found: {from}"));
    }
    if dst.exists() {
        return Err(format!("destination already exists: {to}"));
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create parent for {to}: {e}"))?;
    }
    std::fs::rename(&src, &dst).map_err(|e| format!("move {from} → {to}: {e}"))?;
    Ok(format!("Moved {from} → {to}."))
}

pub fn delete_file(root: &Path, rel: &str) -> Result<String, String> {
    let p = resolve_in_vault(root, rel)?;
    if !p.exists() {
        return Err(format!("not found: {rel}"));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| format!("delete dir {rel}: {e}"))?;
        Ok(format!("Deleted directory {rel} (recursively)."))
    } else {
        std::fs::remove_file(&p).map_err(|e| format!("delete {rel}: {e}"))?;
        Ok(format!("Deleted {rel}."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "order-agent-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rejects_escapes() {
        let root = tmp();
        assert!(resolve_in_vault(&root, "../etc/passwd").is_err());
        assert!(resolve_in_vault(&root, "a/../../b").is_err());
        assert!(resolve_in_vault(&root, "/etc/passwd").is_err());
        assert!(resolve_in_vault(&root, "\\\\etc").is_err());
        assert!(resolve_in_vault(&root, "C:/x").is_err());
        // legal paths resolve under root
        assert!(resolve_in_vault(&root, "a/b.md").unwrap().starts_with(&root));
        assert!(resolve_in_vault(&root, "./a/./b").unwrap().starts_with(&root));
        assert_eq!(resolve_in_vault(&root, "").unwrap(), root);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn glob_basics() {
        assert!(glob_match("*.md", "note.md"));
        assert!(!glob_match("*.md", "a/note.md"));
        assert!(glob_match("**/*.md", "a/b/note.md"));
        assert!(glob_match("2026-*.chat.md", "2026-08-01 Chat.chat.md"));
        assert!(glob_match("note?.txt", "note1.txt"));
        assert!(!glob_match("note?.txt", "note12.txt"));
    }

    #[test]
    fn write_read_edit_move_delete() {
        let root = tmp();
        assert!(write_file(&root, "d/a.md", "hello world").unwrap().starts_with("Created"));
        assert_eq!(read_file(&root, "d/a.md").unwrap(), "hello world");
        assert!(write_file(&root, "d/a.md", "x").unwrap().starts_with("Overwrote"));
        // edit: unique
        write_file(&root, "d/a.md", "one two three").unwrap();
        assert!(edit_file(&root, "d/a.md", "two", "TWO").is_ok());
        assert_eq!(read_file(&root, "d/a.md").unwrap(), "one TWO three");
        // edit: missing + ambiguous
        assert!(edit_file(&root, "d/a.md", "nope", "x").is_err());
        write_file(&root, "d/a.md", "a a a").unwrap();
        assert!(edit_file(&root, "d/a.md", "a", "b").is_err());
        // move + delete
        write_file(&root, "d/b.md", "b").unwrap();
        assert!(move_file(&root, "d/b.md", "d/c.md").is_ok());
        assert!(read_file(&root, "d/b.md").is_err());
        assert!(read_file(&root, "d/c.md").is_ok());
        assert!(delete_file(&root, "d/c.md").is_ok());
        assert!(read_file(&root, "d/c.md").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn search_finds_files_and_content() {
        let root = tmp();
        write_file(&root, "notes/todo.md", "buy milk\ncall alice").unwrap();
        write_file(&root, "notes/log.md", "alice replied").unwrap();
        let f = search_files(&root, "*.md").unwrap();
        assert!(f.contains("notes/todo.md") && f.contains("notes/log.md"));
        let c = search_content(&root, "alice", None).unwrap();
        assert!(c.contains("notes/todo.md") && c.contains("notes/log.md") && c.contains("call alice"));
        let scoped = search_content(&root, "alice", Some("**/log.md")).unwrap();
        assert!(scoped.contains("log.md") && !scoped.contains("todo.md"));
        std::fs::remove_dir_all(&root).ok();
    }
}
