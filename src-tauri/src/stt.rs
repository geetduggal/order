//! Speech-to-text — the input half of the voice chat.
//!
//! The mic is captured **natively** (AVAudioRecorder), not in the webview:
//! WKWebView doesn't expose `navigator.mediaDevices`/getUserMedia (tauri#10898),
//! so the browser path is a dead end on macOS and iOS. This mirrors the native
//! TTS decision — audio never goes through the browser.
//!
//! `stt_listen` records one hands-free utterance (it watches the input level and
//! stops when you pause), then transcribes it with one of two engines:
//!   - `whisper` (default): POST the audio to OpenAI, reusing the cloud-voice key.
//!   - `native`: Apple's on-device Speech framework — nothing leaves the machine.
//! Level updates stream to the UI as `stt-level` events for the meter.

use base64::Engine as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

/// Set by `stt_cancel` to break the recording loop early.
static CANCEL: AtomicBool = AtomicBool::new(false);

fn ext_for(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.contains("webm") { "webm" }
    else if m.contains("mp4") { "mp4" }
    else if m.contains("m4a") || m.contains("aac") || m.contains("x-m4a") { "m4a" }
    else if m.contains("mpeg") || m.contains("mp3") { "mp3" }
    else if m.contains("wav") { "wav" }
    else { "m4a" }
}

fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let connector = native_tls::TlsConnector::new().expect("native_tls connector init");
            ureq::AgentBuilder::new()
                .tls_connector(Arc::new(connector))
                .timeout_read(std::time::Duration::from_secs(120))
                .build()
        })
        .clone()
}

/// Transcribe audio bytes via OpenAI (multipart/form-data built by hand).
fn whisper(key: &str, audio: &[u8], mime: &str) -> Result<String, String> {
    if key.trim().is_empty() {
        return Err("No OpenAI API key set (add it under Read-aloud voices in Settings).".into());
    }
    let boundary = format!("----orderaudio{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0));
    let ext = ext_for(mime);
    let mut body: Vec<u8> = Vec::with_capacity(audio.len() + 512);
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"file\"; filename=\"audio.{ext}\"\r\nContent-Type: {mime}\r\n\r\n").as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(b"\r\n");
    let mut field = |name: &str, val: &str| {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n").as_bytes());
    };
    field("model", "whisper-1");
    field("response_format", "text");
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());

    match agent()
        .post("https://api.openai.com/v1/audio/transcriptions")
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", &format!("multipart/form-data; boundary={boundary}"))
        .send_bytes(&body)
    {
        Ok(r) => r.into_string().map(|s| s.trim().to_string()).map_err(|e| format!("read transcription: {e}")),
        Err(ureq::Error::Status(s, r)) => Err(format!("Whisper error {s}: {}", r.into_string().unwrap_or_default())),
        Err(e) => Err(format!("transport: {e}")),
    }
}

/// Delete a temp file when the guard drops (best-effort).
struct RemoveOnDrop(std::path::PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

// ---- native (Apple) capture + on-device recognition ------------------------
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod apple {
    use super::CANCEL;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use std::sync::mpsc::sync_channel;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};

    #[link(name = "AVFAudio", kind = "framework")]
    extern "C" {
        static AVFormatIDKey: *const AnyObject;
        static AVSampleRateKey: *const AnyObject;
        static AVNumberOfChannelsKey: *const AnyObject;
    }
    #[link(name = "Speech", kind = "framework")]
    extern "C" {}

    // kAudioFormatMPEG4AAC ('aac ')
    const AAC: i32 = 1_633_772_320;

    #[cfg(target_os = "ios")]
    extern "C" {
        static AVAudioSessionCategoryPlayAndRecord: *const AnyObject;
    }
    #[cfg(target_os = "ios")]
    unsafe fn prepare_session() {
        let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
        if session.is_null() { return; }
        let mut err: *mut AnyObject = std::ptr::null_mut();
        let _: objc2::runtime::Bool = msg_send![session, setCategory: AVAudioSessionCategoryPlayAndRecord, error: &mut err];
        let mut err2: *mut AnyObject = std::ptr::null_mut();
        let _: objc2::runtime::Bool = msg_send![session, setActive: true, error: &mut err2];
        // Ask for mic permission and wait (block until the user has decided once).
        let (tx, rx) = sync_channel::<bool>(1);
        let tx2 = tx.clone();
        let handler = block2::RcBlock::new(move |granted: objc2::runtime::Bool| { let _ = tx2.try_send(granted.as_bool()); });
        let _: () = msg_send![session, requestRecordPermission: &*handler];
        let _ = rx.recv_timeout(Duration::from_secs(60));
    }
    #[cfg(not(target_os = "ios"))]
    unsafe fn prepare_session() {}

    /// Record one hands-free utterance to an m4a temp file, emitting `stt-level`.
    /// Returns the file path, or None if the user cancelled / never spoke.
    pub fn record_utterance(app: &AppHandle) -> Result<Option<PathBuf>, String> {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("order-stt-{}.m4a", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let path_str = path.to_string_lossy().to_string();

        unsafe {
            prepare_session();

            // settings = { AVFormatIDKey: AAC, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1 }
            let num_fmt: *mut AnyObject = msg_send![class!(NSNumber), numberWithInt: AAC];
            let num_rate: *mut AnyObject = msg_send![class!(NSNumber), numberWithDouble: 16000.0f64];
            let num_ch: *mut AnyObject = msg_send![class!(NSNumber), numberWithInt: 1i32];
            let settings: *mut AnyObject = msg_send![class!(NSMutableDictionary), dictionary];
            let _: () = msg_send![settings, setObject: num_fmt, forKey: AVFormatIDKey];
            let _: () = msg_send![settings, setObject: num_rate, forKey: AVSampleRateKey];
            let _: () = msg_send![settings, setObject: num_ch, forKey: AVNumberOfChannelsKey];

            let ns_path = NSString::from_str(&path_str);
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*ns_path];

            let alloc: *mut AnyObject = msg_send![class!(AVAudioRecorder), alloc];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let recorder: *mut AnyObject = msg_send![alloc, initWithURL: url, settings: settings, error: &mut err];
            if recorder.is_null() {
                let msg = if err.is_null() { "recorder init failed".to_string() } else {
                    let d: Retained<NSString> = msg_send![err, localizedDescription];
                    d.to_string()
                };
                return Err(msg);
            }
            let _: objc2::runtime::Bool = msg_send![recorder, setMeteringEnabled: true];
            let ok: objc2::runtime::Bool = msg_send![recorder, record];
            if !ok.as_bool() {
                return Err("Couldn't start recording (microphone permission?).".into());
            }

            // VAD loop. AVAudioRecorder reports power in dBFS (-160 silent … 0 full
            // scale). We use PEAK power (far more responsive to speech onset than
            // average) and calibrate the noise floor for the first 400ms, so the
            // thresholds adapt to the mic + room instead of a fixed guess that
            // normal speech never reaches.
            let start = Instant::now();
            let calib = Duration::from_millis(400);
            let mut floor_min = 0.0f32;       // quietest peak seen during calibration
            let mut floor_any = false;
            let mut floor_db = -55.0f32;      // sensible default until calibrated
            let mut calibrated = false;
            let mut speech_started = false;
            let mut spoke = false;
            let mut last_voice = Instant::now();
            let mut peak_seen = -160.0f32;
            let silence = Duration::from_millis(1100);
            let max_wait = Duration::from_secs(20);   // nobody spoke
            let max_utter = Duration::from_secs(30);  // hard cap

            loop {
                std::thread::sleep(Duration::from_millis(40));
                if CANCEL.load(Ordering::Relaxed) {
                    let _: () = msg_send![recorder, stop];
                    return Ok(None);
                }
                let _: () = msg_send![recorder, updateMeters];
                let db: f32 = msg_send![recorder, peakPowerForChannel: 0usize];
                peak_seen = peak_seen.max(db);
                // Map -60…0 dBFS → 0…1 for the UI meter.
                let _ = app.emit("stt-level", ((db + 60.0) / 60.0).clamp(0.0, 1.0));

                let now = Instant::now();
                if now - start < calib {
                    if !floor_any || db < floor_min { floor_min = db; floor_any = true; }
                    continue; // establishing the noise floor
                }
                if !calibrated {
                    if floor_any { floor_db = floor_min.clamp(-60.0, -20.0); }
                    calibrated = true;
                }
                // Speech = clearly above the floor (and above an absolute minimum).
                let speak_thresh = (floor_db + 12.0).max(-40.0);
                let keep_thresh = (floor_db + 6.0).max(-48.0);

                if !speech_started {
                    // Fast fail: no signal at all after 3s ⇒ the mic isn't capturing.
                    if now - start > Duration::from_secs(3) && peak_seen < -140.0 {
                        let _: () = msg_send![recorder, stop];
                        let _ = app.emit("stt-level", 0.0f32);
                        return Err("No sound is reaching the microphone. Check Order's mic permission in System Settings → Privacy → Microphone.".into());
                    }
                    if db > speak_thresh {
                        speech_started = true; spoke = true; last_voice = now;
                        let _ = app.emit("stt-state", "heard");
                    } else if now - start > max_wait {
                        let _: () = msg_send![recorder, stop];
                        let _ = app.emit("stt-level", 0.0f32);
                        // If the mic never produced ANY signal, it's almost
                        // certainly a permission/hardware problem — say so rather
                        // than silently re-arming forever.
                        if peak_seen < -140.0 {
                            return Err("No sound is reaching the microphone. Check Order's mic permission in System Settings → Privacy → Microphone.".into());
                        }
                        return Ok(None);
                    }
                } else {
                    if db > keep_thresh { last_voice = now; }
                    if now - last_voice > silence || now - start > max_utter { break; }
                }
            }
            let _: () = msg_send![recorder, stop];
            let _ = app.emit("stt-level", 0.0f32);
            if !spoke { return Ok(None); }
        }
        Ok(Some(path))
    }

    /// On-device transcription of a recorded file via SFSpeechRecognizer.
    pub fn transcribe_file(path: &std::path::Path) -> Result<String, String> {
        use block2::RcBlock;
        unsafe {
            let status: isize = msg_send![class!(SFSpeechRecognizer), authorizationStatus];
            if status == 0 {
                let (tx, rx) = sync_channel::<isize>(1);
                let tx2 = tx.clone();
                let handler = RcBlock::new(move |st: isize| { let _ = tx2.try_send(st); });
                let _: () = msg_send![class!(SFSpeechRecognizer), requestAuthorization: &*handler];
                let _ = rx.recv_timeout(Duration::from_secs(60));
            }
            let status: isize = msg_send![class!(SFSpeechRecognizer), authorizationStatus];
            if status != 3 {
                return Err("Speech recognition isn't authorized. Enable it in Settings, or use Whisper.".into());
            }
            let alloc: *mut AnyObject = msg_send![class!(SFSpeechRecognizer), alloc];
            let recognizer: *mut AnyObject = msg_send![alloc, init];
            if recognizer.is_null() { return Err("Speech recognition unavailable for this locale.".into()); }

            let ns_path = NSString::from_str(&path.to_string_lossy());
            let url: *mut AnyObject = msg_send![class!(NSURL), fileURLWithPath: &*ns_path];
            let ralloc: *mut AnyObject = msg_send![class!(SFSpeechURLRecognitionRequest), alloc];
            let request: *mut AnyObject = msg_send![ralloc, initWithURL: url];

            let (tx, rx) = sync_channel::<Result<String, String>>(1);
            let tx2 = tx.clone();
            let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                if !error.is_null() && result.is_null() {
                    let desc: Retained<NSString> = msg_send![error, localizedDescription];
                    let _ = tx2.try_send(Err(desc.to_string()));
                    return;
                }
                if result.is_null() { return; }
                let is_final: objc2::runtime::Bool = msg_send![result, isFinal];
                if !is_final.as_bool() { return; }
                let best: *mut AnyObject = msg_send![result, bestTranscription];
                if best.is_null() { let _ = tx2.try_send(Ok(String::new())); return; }
                let s: Retained<NSString> = msg_send![best, formattedString];
                let _ = tx2.try_send(Ok(s.to_string()));
            });
            let _task: *mut AnyObject = msg_send![recognizer, recognitionTaskWithRequest: request, resultHandler: &*handler];
            match rx.recv_timeout(Duration::from_secs(120)) {
                Ok(r) => r,
                Err(_) => Err("Speech recognition timed out.".into()),
            }
        }
    }

    pub fn reset_cancel() { CANCEL.store(false, Ordering::Relaxed); }
}

/// Cancel an in-progress `stt_listen` (the loop stops and returns empty text).
#[tauri::command]
pub fn stt_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// Record one hands-free utterance and transcribe it. Returns the recognized
/// text (empty string if the user cancelled or never spoke). `engine` is
/// "whisper" (default) or "native".
#[tauri::command]
pub async fn stt_listen(
    app: tauri::AppHandle,
    engine: String,
    openai_key: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            apple::reset_cancel();
            let path = match apple::record_utterance(&app)? {
                Some(p) => p,
                None => return Ok(String::new()),
            };
            let _cleanup = RemoveOnDrop(path.clone());
            match engine.as_str() {
                "native" => apple::transcribe_file(&path),
                _ => {
                    let bytes = std::fs::read(&path).map_err(|e| format!("read recording: {e}"))?;
                    whisper(&openai_key, &bytes, "audio/m4a")
                }
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            let _ = (&app, &engine, &openai_key);
            Err("Voice input is only available on macOS and iOS.".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Transcribe already-captured audio bytes (base64). Retained for callers that
/// have their own recording; the voice loop uses `stt_listen` instead.
#[tauri::command]
pub async fn stt_transcribe(
    audio_base64: String,
    mime: String,
    engine: String,
    openai_key: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let audio = base64::engine::general_purpose::STANDARD
            .decode(audio_base64.as_bytes())
            .map_err(|e| format!("decode audio: {e}"))?;
        if audio.is_empty() { return Err("Empty recording.".into()); }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if engine == "native" {
            let dir = std::env::temp_dir();
            let path = dir.join(format!("order-stt-{}.{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0), ext_for(&mime)));
            std::fs::write(&path, &audio).map_err(|e| format!("write temp audio: {e}"))?;
            let _cleanup = RemoveOnDrop(path.clone());
            return apple::transcribe_file(&path);
        }
        whisper(&openai_key, &audio, &mime)
    })
    .await
    .map_err(|e| e.to_string())?
}
