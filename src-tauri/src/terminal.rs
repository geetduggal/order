// In-app terminal backend: a real PTY per session via portable-pty.
//
// Unlike a pipe-backed runner, a pseudo-terminal gives programs a real
// tty — so vim, htop, less, colors, and line editing all work. Each
// frontend terminal instance owns one session: open spawns the shell in
// a PTY, a reader thread streams bytes to the webview as
// `terminal://data` events, and write/resize/close drive it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use tauri::{AppHandle, Emitter, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Clone, serde::Serialize)]
struct DataEvent {
    session: String,
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct ExitEvent {
    session: String,
}

/// Open a PTY for `session`, spawn the user's login shell in `cwd`, and
/// start streaming its output. Idempotent per session id (a re-open
/// closes the old one first). Desktop only.
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session: String,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let dir = std::path::Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("not a directory: {cwd}"));
    }
    // Replace any existing session with this id.
    close_session(&state, &session);

    let pty = NativePtySystem::default();
    let pair = pty
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // login shell: rc files, PATH, aliases
    cmd.cwd(dir);
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The slave is owned by the child now; drop our handle so EOF
    // propagates correctly when the shell exits.
    drop(pair.slave);

    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // Reader thread: stream PTY bytes to the webview as UTF-8 (lossy,
    // so partial multibyte sequences at chunk boundaries don't panic;
    // xterm reassembles fine in practice for our line rates).
    {
        let app = app.clone();
        let session = session.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        if app
                            .emit("terminal://data", DataEvent { session: session.clone(), data })
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = app.emit("terminal://exit", ExitEvent { session });
        });
    }

    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(session, Session { writer, master: pair.master, child });
    Ok(())
}

/// Send keystrokes / input bytes to a session's PTY.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get_mut(&session) {
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize a session's PTY (cols/rows) so full-screen apps reflow.
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get(&session) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill a session's shell and drop it.
#[tauri::command]
pub fn terminal_close(state: State<'_, TerminalState>, session: String) -> Result<(), String> {
    close_session(&state, &session);
    Ok(())
}

fn close_session(state: &State<'_, TerminalState>, session: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(mut s) = sessions.remove(session) {
            let _ = s.child.kill();
        }
    }
}
