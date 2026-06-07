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
use std::sync::{Arc, OnceLock};

const API: &str = "https://api.github.com";
const UA: &str = "Order";

/// Shared agent backed by native-tls (Secure Transport on iOS). ureq
/// 2 with default-features off doesn't auto-wire a TLS backend, so
/// we build one explicitly here.
fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let connector = native_tls::TlsConnector::new()
                .expect("native_tls connector init");
            ureq::AgentBuilder::new()
                .tls_connector(Arc::new(connector))
                .build()
        })
        .clone()
}

/// One file to commit: a repo-relative path and its raw bytes.
pub struct CommitFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// Convert a ureq response (success OR error) into (status, body).
/// On a 4xx/5xx the body has GitHub's structured error message, which
/// is exactly what we need to surface — ureq's Error::Status holds
/// the response so we don't lose it on non-2xx.
fn drain(result: Result<ureq::Response, ureq::Error>) -> Result<(u16, String), String> {
    match result {
        Ok(resp) => {
            let status = resp.status();
            let body = resp.into_string().map_err(|e| format!("read body: {e}"))?;
            Ok((status, body))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let body = resp.into_string().unwrap_or_default();
            Ok((status, body))
        }
        Err(other) => Err(format!("transport: {other}")),
    }
}

fn get(url: &str, token: &str) -> Result<Value, String> {
    let resp = agent().get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .set("Accept", "application/vnd.github+json")
        .set("Accept-Encoding", "identity")
        .call();
    let (status, body) = drain(resp).map_err(|e| format!("GET {url}: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("GET {url}: status {status}; body: {body}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("GET {url} decode: {e}; body: {body}"))
}

fn send(method: &str, url: &str, token: &str, body: Value) -> Result<Value, String> {
    let a = agent();
    let req = match method {
        "POST" => a.post(url),
        "PATCH" => a.request("PATCH", url),
        other => return Err(format!("unsupported method {other}")),
    };
    let resp = req
        .set("Authorization", &format!("Bearer {token}"))
        .set("User-Agent", UA)
        .set("Accept", "application/vnd.github+json")
        .set("Accept-Encoding", "identity")
        .send_json(body);
    let (status, response_body) = drain(resp).map_err(|e| format!("{method} {url}: {e}"))?;
    if !(200..300).contains(&status) {
        return Err(format!("{method} {url}: status {status}; body: {response_body}"));
    }
    serde_json::from_str(&response_body)
        .map_err(|e| format!("{method} {url} decode: {e}; body: {response_body}"))
}

fn sha(v: &Value, ptr: &str) -> Result<String, String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing {ptr} in GitHub response: {v}"))
}

/// Look up the repo's default branch via the GitHub REST API. Used
/// by the iOS publisher so we commit to whatever the user's repo
/// actually uses (`main`, `master`, `gh-pages`, …) rather than a
/// hardcoded guess.
pub fn default_branch(owner: &str, repo: &str, token: &str) -> Result<String, String> {
    let v = get(&format!("{API}/repos/{owner}/{repo}"), token)?;
    v.get("default_branch")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("no default_branch in repo response: {v}"))
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
