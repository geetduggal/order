// Unused until the iOS dispatch in publish.rs is wired (needs the
// Keychain token source + bundled viewer, both built on-device). The
// commit logic itself is complete and type-checked on every build.
#![allow(dead_code)]

// GitHub publishing over HTTPS via the Git Data API. iOS forbids
// subprocesses, so the desktop's `git` CLI publisher can't run there;
// this commits a set of files into a repo with pure HTTP calls instead.
//
// Compiled on all targets so a desktop `cargo build` type-checks it; the
// platform-conditional dispatch in publish.rs decides when it's used
// (iOS). Pure logic: it takes the files + a token and performs
//   ref -> base commit -> base tree -> blobs -> tree -> commit -> ref.

use base64::Engine;
use serde_json::{json, Value};

const API: &str = "https://api.github.com";
const UA: &str = "Order";

/// One file to commit: a repo-relative path and its raw bytes.
pub struct CommitFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

fn get(url: &str, token: &str) -> Result<Value, String> {
    ureq::get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .into_json::<Value>()
        .map_err(|e| format!("GET {url} decode: {e}"))
}

fn send(method: &str, url: &str, token: &str, body: Value) -> Result<Value, String> {
    let req = match method {
        "POST" => ureq::post(url),
        "PATCH" => ureq::request("PATCH", url),
        other => return Err(format!("unsupported method {other}")),
    };
    req.set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .set("Accept", "application/vnd.github+json")
        .send_json(body)
        .map_err(|e| format!("{method} {url}: {e}"))?
        .into_json::<Value>()
        .map_err(|e| format!("{method} {url} decode: {e}"))
}

fn sha(v: &Value, ptr: &str) -> Result<String, String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing {ptr} in GitHub response: {v}"))
}

/// Commit `files` onto `owner/repo`'s `branch` in one commit and move the
/// branch ref to it. Returns the new commit sha. Paths in `files` are
/// repo-relative (already including any home subdirectory prefix).
pub fn commit_files(
    token: &str,
    owner: &str,
    repo: &str,
    branch: &str,
    message: &str,
    files: &[CommitFile],
) -> Result<String, String> {
    let base = format!("{API}/repos/{owner}/{repo}/git");

    // 1. Current branch commit + its base tree.
    let ref_obj = get(&format!("{base}/ref/heads/{branch}"), token)?;
    let parent = sha(&ref_obj, "/object/sha")?;
    let commit_obj = get(&format!("{base}/commits/{parent}"), token)?;
    let base_tree = sha(&commit_obj, "/tree/sha")?;

    // 2. A blob per file (base64 so binary attachments survive).
    let mut tree_entries: Vec<Value> = Vec::with_capacity(files.len());
    for f in files {
        let content = base64::engine::general_purpose::STANDARD.encode(&f.bytes);
        let blob = send(
            "POST",
            &format!("{base}/blobs"),
            token,
            json!({ "content": content, "encoding": "base64" }),
        )?;
        let blob_sha = sha(&blob, "/sha")?;
        tree_entries.push(json!({
            "path": f.path,
            "mode": "100644",
            "type": "blob",
            "sha": blob_sha,
        }));
    }

    // 3. New tree on top of the base tree.
    let tree = send(
        "POST",
        &format!("{base}/trees"),
        token,
        json!({ "base_tree": base_tree, "tree": tree_entries }),
    )?;
    let tree_sha = sha(&tree, "/sha")?;

    // 4. New commit, then move the branch ref to it.
    let commit = send(
        "POST",
        &format!("{base}/commits"),
        token,
        json!({ "message": message, "tree": tree_sha, "parents": [parent] }),
    )?;
    let commit_sha = sha(&commit, "/sha")?;

    send(
        "PATCH",
        &format!("{base}/refs/heads/{branch}"),
        token,
        json!({ "sha": commit_sha, "force": false }),
    )?;

    Ok(commit_sha)
}
