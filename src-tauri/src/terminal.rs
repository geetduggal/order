// In-app terminal backend: a streaming shell-command runner.
//
// NOT a PTY — there's no raw mode, so full-screen programs (vim, htop)
// won't work. But every line-oriented command does: git, ls, grep,
// build scripts, claude-tool, etc. Output streams back line-by-line via
// Tauri events so a long build shows progress instead of blocking.
//
// Each run is tagged with a `session` id (the frontend's terminal
// instance) so multiple card terminals don't cross streams.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct OutputEvent {
    session: String,
    stream: String, // "stdout" | "stderr"
    line: String,
}

#[derive(Clone, serde::Serialize)]
struct ExitEvent {
    session: String,
    code: i32,
}

/// Run `command` through the user's shell in `cwd`, streaming output.
/// Returns immediately; the spawned threads emit `terminal://output`
/// per line and `terminal://exit` once the process finishes.
///
/// Desktop only — iOS has no shell in the sandbox and the frontend
/// disables the terminal there, so this is never invoked on iOS.
#[tauri::command]
pub fn terminal_run(
    app: AppHandle,
    session: String,
    cwd: String,
    command: String,
) -> Result<(), String> {
    let dir = std::path::Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }

    // Use the user's login shell so aliases / PATH / rc files apply,
    // matching what they'd get in a real terminal. Fall back to sh.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());

    let mut child = Command::new(&shell)
        .arg("-lc")
        .arg(&command)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start {shell}: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Stream stdout.
    if let Some(out) = stdout {
        let app = app.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let _ = app.emit(
                    "terminal://output",
                    OutputEvent { session: session.clone(), stream: "stdout".into(), line },
                );
            }
        });
    }
    // Stream stderr.
    if let Some(err) = stderr {
        let app = app.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let _ = app.emit(
                    "terminal://output",
                    OutputEvent { session: session.clone(), stream: "stderr".into(), line },
                );
            }
        });
    }

    // Wait for exit on its own thread so the command returns at once.
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
        let _ = app.emit("terminal://exit", ExitEvent { session, code });
    });

    Ok(())
}
