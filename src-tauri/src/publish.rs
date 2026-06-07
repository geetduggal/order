// Publishing pipeline: receive a pre-rendered index.html + the vault
// root from the frontend, clone (or pull) the target repo into the
// app data dir, wipe + repopulate the home-target subdirectory with
// the bundle and the vault's Attachments, then git commit + push.
//
// Auth uses the user's local git credentials (HTTPS cred helper or
// SSH key). No new auth flow.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "ios")]
use crate::publish_ios;

const CLONES_SUBDIR: &str = "publish-clones";

#[derive(serde::Deserialize)]
pub struct PublishInput {
    /// "<user>/<repo>/<path>" from the home Notable Folder's YAML.
    pub home_target: String,
    /// Absolute path to the vault root (used to find Attachments/).
    pub vault_path: String,
    /// Absolute path to the built viewer bundle (the dist-viewer/
    /// directory produced by `pnpm build:viewer`).
    pub viewer_bundle_path: String,
    /// JSON-serialized PublishedSite — the viewer fetches this at
    /// runtime via fetch("./data.json").
    pub data_json: String,
    /// Prerendered static pages (one per public note + folder). Each is
    /// wrapped in the bundle shell and written at its permalink.
    pub pages: Vec<Page>,
    /// Same-folder note images to copy next to their published page.
    #[serde(default)]
    pub assets: Vec<AssetCopy>,
    /// GitHub Personal Access Token. Required on iOS (no `git` CLI in
    /// the sandbox) so the HTTP-based publisher in publish_ios.rs can
    /// authenticate. Optional on desktop where the local git auth is
    /// used by `git clone / git push`.
    #[serde(default)]
    pub github_token: Option<String>,
    /// Optional commit message override (UI affordance for iOS, where
    /// the user types it inline). When None, a Unix timestamp is used.
    #[serde(default)]
    pub commit_message: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCopy {
    /// Vault-relative source path.
    pub from: String,
    /// Destination relative to the publish target dir (e.g. "salmon/x.png").
    pub to: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    /// Path relative to the publish target dir, e.g. "salmon/index.html".
    pub path: String,
    /// Prerendered body HTML, injected into #viewer-root.
    pub content_html: String,
    /// Page <title>.
    pub title: String,
}

#[derive(serde::Serialize)]
pub struct PublishResult {
    pub repo_url: String,
    pub branch: String,
    pub pushed_to: String,
    pub commit_message: String,
    pub had_changes: bool,
}

fn parse_target(s: &str) -> Result<(String, String, String), String> {
    let parts: Vec<&str> = s.splitn(3, '/').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty()) {
        return Err(format!(
            "invalid home target: {:?} (expected `<user>/<repo>/<path>`)",
            s
        ));
    }
    Ok((parts[0].to_string(), parts[1].to_string(), parts[2].to_string()))
}

/// A `git` invocation that can never block on an interactive prompt.
/// The app runs without a controlling terminal, so a credential or SSH
/// host-key prompt would hang the push forever; forcing non-interactive
/// turns an auth failure into a fast error the Publish panel can show.
fn git_base() -> Command {
    let mut cmd = Command::new("git");
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
        .stdin(Stdio::null());
    cmd
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = git_base()
        .current_dir(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git {:?} failed to spawn: {}", args, e))?;
    if !out.status.success() {
        return Err(format!(
            "git {:?} exited {}: {}",
            args,
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn clone_to(url: &str, dest: &Path) -> Result<(), String> {
    let out = git_base()
        .args(["clone", url])
        .arg(dest)
        .output()
        .map_err(|e| format!("git clone failed to spawn: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "git clone {} exited {}: {}",
            url,
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn timestamp_label() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

#[tauri::command]
pub async fn publish_site(
    app: tauri::AppHandle,
    input: PublishInput,
) -> Result<PublishResult, String> {
    // The body does blocking git + filesystem work. Tauri drives sync
    // command bodies on the main thread, which freezes the window (the
    // macOS "beach ball") for the whole clone/copy/push. Run it on a
    // blocking worker so the UI stays responsive while publishing.
    tauri::async_runtime::spawn_blocking(move || publish_site_inner(app, input))
        .await
        .map_err(|e| format!("publish task failed to join: {}", e))?
}

fn publish_site_inner(
    app: tauri::AppHandle,
    input: PublishInput,
) -> Result<PublishResult, String> {
    use tauri::Manager;

    let (user, repo, sub) = parse_target(&input.home_target)?;
    let repo_url = format!("https://github.com/{}/{}.git", user, repo);

    // iOS has no `git` CLI in the sandbox; route through the HTTP
    // commit path. Token is required up front and surfaced to the
    // user via PublishPanel.
    #[cfg(target_os = "ios")]
    {
        return publish_via_http(app, input);
    }
    #[cfg_attr(target_os = "ios", allow(unreachable_code))]
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not locate app data dir: {}", e))?;
    let clone_root = app_dir.join(CLONES_SUBDIR).join(&user).join(&repo);

    if !clone_root.join(".git").is_dir() {
        if clone_root.exists() {
            fs::remove_dir_all(&clone_root)
                .map_err(|e| format!("remove stale dir {}: {}", clone_root.display(), e))?;
        }
        if let Some(parent) = clone_root.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        clone_to(&repo_url, &clone_root)?;
    } else {
        run_git(&clone_root, &["fetch", "origin"])?;
        let branch = run_git(&clone_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        run_git(
            &clone_root,
            &["reset", "--hard", &format!("origin/{}", branch)],
        )
        .map_err(|e| format!("git reset to origin/{} failed: {}", branch, e))?;
    }

    let branch = run_git(&clone_root, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_string();

    let target_dir = clone_root.join(&sub);
    if target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .map_err(|e| format!("clear {}: {}", target_dir.display(), e))?;
    }
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    // Copy the viewer bundle in. The bundle is a directory of HTML
    // + JS + CSS produced by `pnpm build:viewer` at Order's project
    // root (in dev) or shipped as a Tauri resource (in production).
    // Prefer the path the frontend passed, but fall back to the dev
    // build dir next to this crate so publishing isn't tied to one
    // machine's checkout location (the frontend can't know the repo
    // root). Production (TODO) should resolve via the resource dir.
    let bundle = {
        let from_fe = PathBuf::from(&input.viewer_bundle_path);
        if from_fe.join("index.html").is_file() {
            from_fe
        } else {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .map(|p| p.join("dist-viewer"))
                .unwrap_or(from_fe)
        }
    };
    if !bundle.join("index.html").is_file() {
        return Err(format!(
            "viewer bundle not found at {} — run `pnpm build:viewer` first",
            bundle.display(),
        ));
    }
    copy_dir_recursive(&bundle, &target_dir)
        .map_err(|e| format!("copy viewer bundle: {}", e))?;

    // The viewer loads ./data.json at runtime; write the per-publish
    // payload next to index.html.
    fs::write(target_dir.join("data.json"), &input.data_json)
        .map_err(|e| format!("write data.json: {}", e))?;

    let attach = PathBuf::from(&input.vault_path).join("Attachments");
    if attach.is_dir() {
        copy_dir_recursive(&attach, &target_dir.join("Attachments"))
            .map_err(|e| format!("copy Attachments: {}", e))?;
    }

    // Same-folder note images: copy each from the vault to its slot next
    // to the note's published page (so /<sub>/<slug>/img.png resolves and
    // a direct image permalink works). Missing sources are skipped so one
    // stale reference can't fail the whole publish.
    for asset in &input.assets {
        let src = PathBuf::from(&input.vault_path).join(&asset.from);
        if !src.is_file() {
            continue;
        }
        let dest = target_dir.join(&asset.to);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::copy(&src, &dest).map_err(|e| format!("copy asset {}: {}", asset.from, e))?;
    }

    // Prerendered permalink pages. The bundle's index.html is the shell;
    // for each page we inject the content into #viewer-root, set the
    // title, point asset + data URLs at the publish root (pages live one
    // level deep so relative URLs would break), and expose
    // window.__ORDER__ for the viewer boot.
    if !input.pages.is_empty() {
        let shell = fs::read_to_string(target_dir.join("index.html"))
            .map_err(|e| format!("read bundle index.html: {}", e))?;
        let root_abs = format!("/{}/", sub);
        let shell = shell
            .replace("./assets/", &format!("{}assets/", root_abs))
            .replace("./data.json", &format!("{}data.json", root_abs))
            .replace("href=\"./", &format!("href=\"{}", root_abs));
        let data_url = format!("{}data.json", root_abs);
        for page in &input.pages {
            let slug = page.path.trim_end_matches("/index.html");
            let order_global = format!(
                "<script>window.__ORDER__={{\"slug\":{},\"dataUrl\":{}}}</script>",
                serde_json::to_string(slug).unwrap_or_else(|_| "\"\"".into()),
                serde_json::to_string(&data_url).unwrap_or_else(|_| "\"\"".into()),
            );
            let injected = format!(
                "<div id=\"viewer-root\"><article class=\"prerendered\">{}</article></div>{}",
                page.content_html, order_global,
            );
            let title_tag = format!(
                "<title>{}</title>",
                page.title.replace('<', "&lt;").replace('>', "&gt;"),
            );
            let html = shell
                .replacen("<div id=\"viewer-root\"></div>", &injected, 1)
                .replacen("<title>Order</title>", &title_tag, 1);
            let dest = target_dir.join(&page.path);
            if let Some(parent) = dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            fs::write(&dest, html).map_err(|e| format!("write {}: {}", page.path, e))?;
        }
    }

    run_git(&clone_root, &["add", "-A"])?;
    let status = run_git(&clone_root, &["status", "--porcelain"])?;
    let pushed_to = format!("{}/{}/{}", user, repo, sub);
    let commit_msg = format!("Publish: {}", timestamp_label());

    if status.trim().is_empty() {
        return Ok(PublishResult {
            repo_url,
            branch,
            pushed_to,
            commit_message: "(no changes)".to_string(),
            had_changes: false,
        });
    }

    run_git(&clone_root, &["commit", "-m", &commit_msg])?;
    run_git(&clone_root, &["push", "origin", &branch])?;

    Ok(PublishResult {
        repo_url,
        branch,
        pushed_to,
        commit_message: commit_msg,
        had_changes: true,
    })
}

/// iOS publish via the GitHub HTTP commit API. Same data shape as the
/// desktop path: the JS side serializes the viewer bundle (or we
/// resolve it from a bundled resource dir), writes pages + data.json
/// + assets, and we POST one commit to the user's repo. Falls back
/// to a clear error if the token is missing — PublishPanel surfaces
/// the message inline.
#[cfg(target_os = "ios")]
fn publish_via_http(
    app: tauri::AppHandle,
    input: PublishInput,
) -> Result<PublishResult, String> {
    use tauri::Manager;
    let token = input.github_token.as_deref().filter(|t| !t.is_empty()).ok_or(
        "A GitHub Personal Access Token is required to publish from iOS. Tap the i icon next to the token field for how to create one.",
    )?;
    let (user, repo, sub) = parse_target(&input.home_target)?;
    let repo_url = format!("https://github.com/{}/{}.git", user, repo);

    // Viewer bundle lives in the iOS app's Resources/ directory at
    // dist-viewer/ (declared via tauri.conf.json's bundle.resources).
    // Resolve via Tauri's resource_dir() so the lookup works on every
    // iOS device install.
    let bundle = app
        .path()
        .resource_dir()
        .map_err(|e| format!("could not locate resource dir: {e}"))?
        .join("dist-viewer");
    if !bundle.join("index.html").is_file() {
        return Err(format!(
            "viewer bundle not found at {} — rebuild with `pnpm tauri ios build` so the dist-viewer/ resource is shipped inside the app",
            bundle.display(),
        ));
    }

    // Walk the bundle into commit files keyed at `<sub>/...`.
    let mut files: Vec<publish_ios::CommitFile> = Vec::new();
    walk_into_files(&bundle, &sub, &mut files)?;

    // Inject data.json.
    files.push(publish_ios::CommitFile {
        path: format!("{}/data.json", sub),
        bytes: input.data_json.as_bytes().to_vec(),
    });

    // Same-folder note assets.
    for asset in &input.assets {
        let src = std::path::PathBuf::from(&input.vault_path).join(&asset.from);
        if !src.is_file() { continue; }
        if let Ok(bytes) = std::fs::read(&src) {
            files.push(publish_ios::CommitFile {
                path: format!("{}/{}", sub, asset.to),
                bytes,
            });
        }
    }

    // Prerendered pages — same shell-template substitution as desktop.
    if !input.pages.is_empty() {
        let shell_bytes = std::fs::read_to_string(bundle.join("index.html"))
            .map_err(|e| format!("read bundle index.html: {e}"))?;
        let root_abs = format!("/{}/", sub);
        let shell = shell_bytes
            .replace("./assets/", &format!("{}assets/", root_abs))
            .replace("./data.json", &format!("{}data.json", root_abs))
            .replace("href=\"./", &format!("href=\"{}", root_abs));
        let data_url = format!("{}data.json", root_abs);
        for page in &input.pages {
            let slug = page.path.trim_end_matches("/index.html");
            let order_global = format!(
                "<script>window.__ORDER__={{\"slug\":{},\"dataUrl\":{}}}</script>",
                serde_json::to_string(slug).unwrap_or_else(|_| "\"\"".into()),
                serde_json::to_string(&data_url).unwrap_or_else(|_| "\"\"".into()),
            );
            let injected = format!(
                "<div id=\"viewer-root\"><article class=\"prerendered\">{}</article></div>{}",
                page.content_html, order_global,
            );
            let title_tag = format!(
                "<title>{}</title>",
                page.title.replace('<', "&lt;").replace('>', "&gt;"),
            );
            let html = shell
                .replacen("<div id=\"viewer-root\"></div>", &injected, 1)
                .replacen("<title>Order</title>", &title_tag, 1);
            files.push(publish_ios::CommitFile {
                path: format!("{}/{}", sub, page.path),
                bytes: html.into_bytes(),
            });
        }
    }

    let commit_msg = input.commit_message.clone().unwrap_or_else(|| format!("Publish: {}", timestamp_label()));
    let branch = "main".to_string();
    publish_ios::commit_files(&user, &repo, &branch, token, &commit_msg, &files)
        .map_err(|e| format!("GitHub commit failed: {e}"))?;

    Ok(PublishResult {
        repo_url,
        branch,
        pushed_to: format!("{}/{}/{}", user, repo, sub),
        commit_message: commit_msg,
        had_changes: true,
    })
}

#[cfg(target_os = "ios")]
fn walk_into_files(
    root: &std::path::Path,
    prefix: &str,
    out: &mut Vec<publish_ios::CommitFile>,
) -> Result<(), String> {
    fn inner(dir: &std::path::Path, base: &std::path::Path, prefix: &str, out: &mut Vec<publish_ios::CommitFile>) -> Result<(), String> {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_dir() {
                inner(&p, base, prefix, out)?;
            } else if p.is_file() {
                let rel = p.strip_prefix(base).map_err(|e| e.to_string())?;
                let path = if prefix.is_empty() {
                    rel.to_string_lossy().to_string()
                } else {
                    format!("{}/{}", prefix, rel.to_string_lossy())
                };
                let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
                out.push(publish_ios::CommitFile { path, bytes });
            }
        }
        Ok(())
    }
    inner(root, root, prefix, out)
}
