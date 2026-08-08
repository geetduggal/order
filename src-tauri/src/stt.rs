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
/// True while the continuous hands-free listen loop (`stt_start_loop`) is active.
/// The loop re-arms the native recognizer after each utterance so the mic stays
/// open across turns AND during TTS playback — the basis for barge-in.
static LOOP_RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether the app (WebView) is in the foreground. JS flips this on
/// visibilitychange. When the app is BACKGROUNDED (phone locked), JS is
/// suspended and can't drive the voice loop — so the STT loop runs the turn +
/// speaks the reply itself (see `run_background_turn`). Foreground is unchanged:
/// the loop just emits `stt-utterance` and JS orchestrates as before.
static FOREGROUND: AtomicBool = AtomicBool::new(true);

/// True when the app is in the foreground (JS is alive to drive the loop).
pub fn is_foreground() -> bool {
    FOREGROUND.load(Ordering::Relaxed)
}

/// Config for the Rust-driven voice conversation used while backgrounded/locked.
/// Provided by JS when hands-free voice starts (`voice_convo_start`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
struct VoiceConvo {
    chat_rel: String,
    api_key: String,
    voice_id: Option<String>,
    rate: f32,
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
static VOICE_CONVO: std::sync::Mutex<Option<VoiceConvo>> = std::sync::Mutex::new(None);

/// Tell the native side whether the app is foregrounded (JS visibilitychange).
#[tauri::command]
pub fn set_foreground(foreground: bool) {
    FOREGROUND.store(foreground, Ordering::Relaxed);
}

/// Arm the Rust-driven voice conversation (used only while backgrounded). JS
/// calls this when hands-free voice starts; `voice_convo_stop` disarms it.
#[tauri::command]
pub fn voice_convo_start(
    #[allow(unused_variables)] chat_path: String,
    #[allow(unused_variables)] api_key: String,
    #[allow(unused_variables)] voice_id: Option<String>,
    #[allow(unused_variables)] rate: Option<f32>,
) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        *VOICE_CONVO.lock().unwrap() = Some(VoiceConvo {
            chat_rel: chat_path,
            api_key,
            voice_id,
            rate: rate.unwrap_or(1.0),
        });
    }
}

#[tauri::command]
pub fn voice_convo_stop() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        *VOICE_CONVO.lock().unwrap() = None;
    }
}

/// Locked-phone path: JS is suspended, so run the agent turn and speak the reply
/// entirely in Rust. The mic engine is already torn down between utterances, so
/// nothing records during the (native) TTS — no echo, no barge-in here, just a
/// clean walkie-talkie loop. A background-task assertion bridges the model call
/// (no audio flowing) so the app isn't suspended mid-think.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn run_background_turn(app: &tauri::AppHandle, utterance: &str) {
    let (chat_rel, api_key, voice_id, rate) = {
        let g = VOICE_CONVO.lock().unwrap();
        match g.as_ref() {
            Some(c) => (c.chat_rel.clone(), c.api_key.clone(), c.voice_id.clone(), c.rate),
            None => return, // no conversation armed
        }
    };
    if api_key.trim().is_empty() {
        return;
    }
    crate::tts::keepalive_begin();
    let reply = crate::agent::run::run_turn_for(app, &api_key, &chat_rel, utterance);
    crate::tts::keepalive_end();
    let reply = match reply {
        Ok(r) => r,
        Err(_) => return,
    };
    if reply.trim().is_empty() {
        return;
    }
    // Speak natively (system voice) — reliable offline and while locked. Wait for
    // it to finish before the loop re-arms the mic so the next turn is clean.
    crate::tts::speak_native(&reply, voice_id.as_deref(), rate);
    let start = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(200));
    while crate::tts::is_native_speaking() && start.elapsed() < std::time::Duration::from_secs(180) {
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
}
/// Last time (ms since UNIX epoch) an `stt-level` event was emitted. The audio
/// tap fires ~40×/s; throttling the emit keeps the JS bridge from being flooded
/// (which, during TTS, was starving the agent-text rendering).
static LEVEL_LAST_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Whether to enable input echo-cancellation (voice processing). Off by default
/// (it crashed on-device); flip via the OS env var STT_AEC=1 once it's safe.
fn aec_enabled() -> bool {
    std::env::var("STT_AEC").map(|v| v == "1").unwrap_or(false)
}

/// True iff at least ~55ms have passed since the last `stt-level` emit (≈18Hz).
fn level_should_emit() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let last = LEVEL_LAST_MS.load(Ordering::Relaxed);
    if now.saturating_sub(last) >= 55 {
        LEVEL_LAST_MS.store(now, Ordering::Relaxed);
        true
    } else {
        false
    }
}

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
    // gpt-4o-mini-transcribe is faster and cheaper than whisper-1 on the same
    // endpoint, and hallucinates less. (It doesn't accept `temperature`.)
    field("model", "gpt-4o-mini-transcribe");
    field("response_format", "text");
    field("language", "en");
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

/// Whisper (and, less often, Apple) emit boilerplate phrases when handed near-
/// silent or noisy audio — the "thank you for watching" family. Treat a short
/// transcript that is entirely one of these as nothing said.
fn looks_like_hallucination(text: &str) -> bool {
    let norm: String = text
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if norm.is_empty() { return true; }
    if norm.len() > 60 { return false; } // long enough to be real speech
    const PHANTOMS: &[&str] = &[
        "you", "so", "bye", "thank you", "thanks", "thank you very much",
        "thank you for watching", "thanks for watching", "thank you for watching the video",
        "thank you so much for watching", "thank you for watching this video",
        "please subscribe", "please like and subscribe", "subscribe",
        "see you next time", "ill see you next time", "see you in the next video",
        "subtitles by the amaraorg community", "the end",
    ];
    PHANTOMS.contains(&norm.as_str())
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
    // AVCaptureDevice (default audio input name) lives in AVFoundation on macOS.
    #[cfg(target_os = "macos")]
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: *const AnyObject;
    }

    // kAudioFormatMPEG4AAC ('aac ')
    const AAC: i32 = 1_633_772_320;

    /// Name of the microphone that will actually be used, e.g. "AirPods Pro" or
    /// "MacBook Pro Microphone". macOS reads the default AVCaptureDevice; iOS the
    /// active audio-session route. None if it can't be determined.
    pub fn current_input_name() -> Option<String> {
        unsafe {
            #[cfg(target_os = "ios")]
            {
                let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
                if session.is_null() { return None; }
                let route: *mut AnyObject = msg_send![session, currentRoute];
                if route.is_null() { return None; }
                let inputs: *mut AnyObject = msg_send![route, inputs];
                if inputs.is_null() { return None; }
                let count: usize = msg_send![inputs, count];
                if count == 0 { return None; }
                let port: *mut AnyObject = msg_send![inputs, objectAtIndex: 0usize];
                if port.is_null() { return None; }
                let name: Retained<NSString> = msg_send![port, portName];
                Some(name.to_string())
            }
            #[cfg(target_os = "macos")]
            {
                let dev: *mut AnyObject = msg_send![class!(AVCaptureDevice), defaultDeviceWithMediaType: AVMediaTypeAudio];
                if dev.is_null() { return None; }
                let name: Retained<NSString> = msg_send![dev, localizedName];
                Some(name.to_string())
            }
        }
    }

    #[cfg(target_os = "ios")]
    extern "C" {
        static AVAudioSessionCategoryPlayAndRecord: *const AnyObject;
        static AVAudioSessionModeVoiceChat: *const AnyObject;
    }
    #[cfg(target_os = "ios")]
    unsafe fn prepare_session() {
        let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
        if session.is_null() { return; }
        let mut err: *mut AnyObject = std::ptr::null_mut();
        // Options: AllowBluetooth (0x4) routes the mic to a Bluetooth headset
        // (AirPods) instead of forcing the built-in mic; DefaultToSpeaker (0x8)
        // keeps playback loud when no headset is present.
        let options: usize = 0x4 | 0x8;
        let _: objc2::runtime::Bool = msg_send![session, setCategory: AVAudioSessionCategoryPlayAndRecord, withOptions: options, error: &mut err];
        // VoiceChat mode enables the system's acoustic echo cancellation, so the
        // continuously-open mic doesn't transcribe the agent's own TTS during
        // barge-in. Best-effort — ignore any error (keeps the plain category).
        let mut merr: *mut AnyObject = std::ptr::null_mut();
        let _: objc2::runtime::Bool = msg_send![session, setMode: AVAudioSessionModeVoiceChat, error: &mut merr];
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
    /// Returns (file path, audio seconds) or None if cancelled / nothing spoken.
    pub fn record_utterance(app: &AppHandle) -> Result<Option<(PathBuf, f64)>, String> {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("order-stt-{}.m4a", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
        let path_str = path.to_string_lossy().to_string();
        let mut duration_secs = 0.0f64;

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
            let mut first_voice = Instant::now();
            let mut last_voice = Instant::now();
            let mut peak_seen = -160.0f32;
            // A longer end-of-speech pause so a mid-thought breath doesn't cut you
            // off (the #1 complaint). Voiced speech must last at least min_voiced,
            // which drops door-clicks / wind blips before they reach the model.
            // A generous end-of-speech pause so long, thoughtful rambles with
            // mid-thought gaps aren't cut off (a repeated user complaint).
            let silence = Duration::from_millis(1900);
            let min_voiced = Duration::from_millis(350);
            let max_wait = Duration::from_secs(20);   // nobody spoke
            let max_utter = Duration::from_secs(90);  // hard cap — allow long rambles

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
                // A wider start margin makes onset more deliberate, so ambient
                // noise on a walk is less likely to trip it.
                let speak_thresh = (floor_db + 14.0).max(-38.0);
                let keep_thresh = (floor_db + 6.0).max(-48.0);

                if !speech_started {
                    // Fast fail: no signal at all after 3s ⇒ the mic isn't capturing.
                    if now - start > Duration::from_secs(3) && peak_seen < -140.0 {
                        let _: () = msg_send![recorder, stop];
                        let _ = app.emit("stt-level", 0.0f32);
                        return Err("No sound is reaching the microphone. Check Order's mic permission in System Settings → Privacy → Microphone.".into());
                    }
                    if db > speak_thresh {
                        speech_started = true; spoke = true; first_voice = now; last_voice = now;
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
            // Reject too-brief blips (a single tick of noise that crossed the
            // threshold) — they're the main source of phantom transcriptions.
            if !spoke || last_voice.saturating_duration_since(first_voice) < min_voiced {
                return Ok(None);
            }
            duration_secs = start.elapsed().as_secs_f64();
        }
        Ok(Some((path, duration_secs)))
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

    /// Cheap semantic end-of-turn heuristic: does the transcript trail off
    /// mid-thought? If it ends on a conjunction/filler/dangling function word (and
    /// has no terminal punctuation — Apple adds `.`/`?`/`!` when it thinks a
    /// sentence completed), the speaker is probably pausing, not finished, so the
    /// caller grants a longer silence window before finalizing.
    fn looks_incomplete(text: &str) -> bool {
        let t = text.trim();
        if t.is_empty() { return true; }
        if t.ends_with('.') || t.ends_with('?') || t.ends_with('!') { return false; }
        let last = t
            .rsplit(|c: char| c.is_whitespace())
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        const TRAILING: &[&str] = &[
            "and", "but", "so", "or", "because", "if", "when", "while", "then", "that",
            "which", "who", "um", "uh", "er", "like", "well", "the", "a", "an", "to", "of",
            "for", "with", "in", "on", "at", "my", "your", "our", "is", "are", "was", "were",
            "as", "also", "plus", "actually", "basically", "maybe", "just", "gonna", "wanna",
            "i'm", "we're", "it's", "there's",
        ];
        TRAILING.contains(&last.as_str())
    }

    /// Live on-device recognition: streams partial transcripts (`stt-partial`)
    /// word-by-word as the user speaks (AVAudioEngine feeding
    /// SFSpeechAudioBufferRecognitionRequest), and finalizes after a pause.
    /// Returns the final transcript, or None if nothing was said / cancelled.
    pub fn listen_live(app: &AppHandle) -> Result<Option<String>, String> {
        use block2::RcBlock;
        use std::sync::{Arc, Mutex};

        struct Shared { text: String, last: Instant, got: bool, done: bool, err: Option<String> }
        let shared = Arc::new(Mutex::new(Shared { text: String::new(), last: Instant::now(), got: false, done: false, err: None }));

        unsafe {
            prepare_session();
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

            let ralloc: *mut AnyObject = msg_send![class!(SFSpeechAudioBufferRecognitionRequest), alloc];
            let request: *mut AnyObject = msg_send![ralloc, init];
            let _: () = msg_send![request, setShouldReportPartialResults: true];
            let on_device: objc2::runtime::Bool = msg_send![recognizer, supportsOnDeviceRecognition];
            if on_device.as_bool() { let _: () = msg_send![request, setRequiresOnDeviceRecognition: true]; }

            let ealloc: *mut AnyObject = msg_send![class!(AVAudioEngine), alloc];
            let engine: *mut AnyObject = msg_send![ealloc, init];
            let input: *mut AnyObject = msg_send![engine, inputNode];
            // Acoustic echo cancellation via the input node's voice-processing unit
            // is gated behind STT_AEC: enabling it crashed on-device (format churn
            // after enabling VP), so it's OFF by default until done safely.
            if super::aec_enabled() {
                let mut vp_err: *mut AnyObject = std::ptr::null_mut();
                let _: objc2::runtime::Bool = msg_send![input, setVoiceProcessingEnabled: true, error: &mut vp_err];
            }
            let fmt: *mut AnyObject = msg_send![input, outputFormatForBus: 0usize];

            // Tap: append each buffer to the request + emit a rough input level.
            let req_addr = request as usize;
            let app_tap = app.clone();
            let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
                let req = req_addr as *mut AnyObject;
                let _: () = msg_send![req, appendAudioPCMBuffer: buffer];
                let data: *const *const f32 = msg_send![buffer, floatChannelData];
                let frames: u32 = msg_send![buffer, frameLength];
                if !data.is_null() && frames > 0 {
                    let ch0 = *data;
                    if !ch0.is_null() {
                        let n = frames as usize;
                        let mut sum = 0.0f32;
                        for i in 0..n { let v = *ch0.add(i); sum += v * v; }
                        let rms = (sum / n as f32).sqrt();
                        if super::level_should_emit() {
                            let _ = app_tap.emit("stt-level", (rms * 6.0).min(1.0));
                        }
                    }
                }
            });
            let _: () = msg_send![input, installTapOnBus: 0usize, bufferSize: 1024u32, format: fmt, block: &*tap];

            let mut err: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![engine, prepare];
            let started: objc2::runtime::Bool = msg_send![engine, startAndReturnError: &mut err];
            if !started.as_bool() {
                let _: () = msg_send![input, removeTapOnBus: 0usize];
                return Err("Couldn't start the audio engine for live transcription.".into());
            }

            // Recognition task: stream partials.
            let shared_h = shared.clone();
            let app_h = app.clone();
            let handler = RcBlock::new(move |result: *mut AnyObject, error: *mut AnyObject| {
                if !error.is_null() && result.is_null() {
                    if let Ok(mut s) = shared_h.lock() { if !s.got { s.err = Some("recognition error".into()); } s.done = true; }
                    return;
                }
                if result.is_null() { return; }
                let best: *mut AnyObject = msg_send![result, bestTranscription];
                let text = if best.is_null() { String::new() } else {
                    let s: Retained<NSString> = msg_send![best, formattedString];
                    s.to_string()
                };
                let is_final: objc2::runtime::Bool = msg_send![result, isFinal];
                if let Ok(mut st) = shared_h.lock() {
                    if !text.trim().is_empty() { st.text = text.clone(); st.got = true; st.last = Instant::now(); }
                    if is_final.as_bool() { st.done = true; }
                }
                let _ = app_h.emit("stt-partial", &text);
                let _ = app_h.emit("stt-state", "heard");
            });
            let task: *mut AnyObject = msg_send![recognizer, recognitionTaskWithRequest: request, resultHandler: &*handler];

            // Wait for a pause after speech (or a cap / no-speech timeout / cancel).
            // End-of-turn = silence, but a SEMANTIC check tolerates rambling: if
            // the transcript trails off mid-thought (a conjunction/filler/dangling
            // function word, no terminal punctuation), grant a longer window so a
            // natural pause isn't mistaken for "done".
            let start = Instant::now();
            let silence = Duration::from_millis(1600);
            let silence_incomplete = Duration::from_millis(3400);
            let max_wait = Duration::from_secs(20);
            let max_utter = Duration::from_secs(90);
            let mut cancelled = false;
            loop {
                std::thread::sleep(Duration::from_millis(60));
                if CANCEL.load(Ordering::Relaxed) { cancelled = true; break; }
                let (got, done, since_last, since_start, txt) = {
                    let s = shared.lock().unwrap();
                    (s.got, s.done, s.last.elapsed(), start.elapsed(), s.text.clone())
                };
                if done { break; }
                let eff_silence = if looks_incomplete(&txt) { silence_incomplete } else { silence };
                if got && since_last > eff_silence { break; }
                if !got && since_start > max_wait { break; }
                if since_start > max_utter { break; }
            }

            // Teardown.
            let _: () = msg_send![input, removeTapOnBus: 0usize];
            let _: () = msg_send![engine, stop];
            let _: () = msg_send![request, endAudio];
            let _: () = msg_send![task, cancel];
            let _ = app.emit("stt-level", 0.0f32);

            if cancelled { return Ok(None); }
            let final_text = { let s = shared.lock().unwrap(); s.text.trim().to_string() };
            if final_text.is_empty() { return Ok(None); }
            Ok(Some(final_text))
        }
    }

    pub fn reset_cancel() { CANCEL.store(false, Ordering::Relaxed); }
}

/// Cancel an in-progress `stt_listen` (the loop stops and returns empty text).
#[tauri::command]
pub fn stt_cancel() {
    CANCEL.store(true, Ordering::Relaxed);
}

/// The microphone that voice input will use (e.g. "AirPods Pro"), so the UI can
/// show it and the user can tell whether headphones or the built-in mic is live.
#[tauri::command]
pub fn stt_input_name() -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    { apple::current_input_name() }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    { None }
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
            use tauri::Emitter;
            apple::reset_cancel();
            // Native = live on-device recognition: words stream in as you speak
            // (via `stt-partial`) and it finalizes after a pause. No upload, so
            // it's the lowest-latency path.
            if engine == "native" {
                let started = std::time::Instant::now();
                let text = match apple::listen_live(&app)? {
                    Some(t) => t,
                    None => return Ok(String::new()),
                };
                if looks_like_hallucination(&text) { return Ok(String::new()); }
                let _ = app.emit("stt-usage", serde_json::json!({ "engine": "native", "seconds": started.elapsed().as_secs_f64() }));
                return Ok(text);
            }
            // Whisper (default): record one utterance, then upload for transcription.
            let (path, secs) = match apple::record_utterance(&app)? {
                Some(p) => p,
                None => return Ok(String::new()),
            };
            let _cleanup = RemoveOnDrop(path.clone());
            let bytes = std::fs::read(&path).map_err(|e| format!("read recording: {e}"))?;
            let text = whisper(&openai_key, &bytes, "audio/m4a")?;
            if looks_like_hallucination(&text) { return Ok(String::new()); }
            let _ = app.emit("stt-usage", serde_json::json!({ "engine": engine, "seconds": secs }));
            Ok(text)
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

/// Start the continuous hands-free listen loop. Re-arms the recognizer after
/// every utterance so the mic stays open across turns and during TTS playback,
/// emitting `stt-utterance` (final text) for each. This is what enables barge-in
/// (the frontend cancels the agent's speech the moment a new utterance lands).
/// Idempotent: a second call while running is a no-op. `stt_stop_loop` ends it.
#[tauri::command]
pub async fn stt_start_loop(
    app: tauri::AppHandle,
    engine: String,
    #[allow(unused_variables)] openai_key: String,
) -> Result<(), String> {
    if LOOP_RUNNING.swap(true, Ordering::SeqCst) {
        return Ok(()); // already running
    }
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        {
            use tauri::Emitter;
            let mut consecutive_errs = 0u32;
            while LOOP_RUNNING.load(Ordering::Relaxed) {
                apple::reset_cancel();
                let started = std::time::Instant::now();
                let result = if engine == "native" {
                    apple::listen_live(&app)
                } else {
                    match apple::record_utterance(&app) {
                        Ok(Some((path, _secs))) => {
                            let _cleanup = RemoveOnDrop(path.clone());
                            std::fs::read(&path)
                                .map_err(|e| format!("read recording: {e}"))
                                .and_then(|bytes| whisper(&openai_key, &bytes, "audio/m4a"))
                                .map(Some)
                        }
                        Ok(None) => Ok(None),
                        Err(e) => Err(e),
                    }
                };
                match result {
                    Ok(Some(text)) if !text.trim().is_empty() && !looks_like_hallucination(&text) => {
                        consecutive_errs = 0;
                        let _ = app.emit("stt-usage", serde_json::json!({ "engine": engine, "seconds": started.elapsed().as_secs_f64() }));
                        if is_foreground() {
                            // Awake: JS orchestrates the turn (barge-in, earcons, TTS).
                            let _ = app.emit("stt-utterance", &text);
                        } else {
                            // Locked/backgrounded: JS is suspended — run it here.
                            // (Deliberately no stt-utterance emit: a buffered event
                            // delivered when JS wakes would double-run the turn.)
                            run_background_turn(&app, &text);
                        }
                    }
                    Ok(_) => { consecutive_errs = 0; /* silence / cancelled — just re-arm */ }
                    Err(e) => {
                        // A transient failure — e.g. the audio engine couldn't
                        // (re)start because TTS is currently using the session.
                        // Don't kill the loop: back off briefly and retry so the
                        // mic comes back (during playback for barge-in, and after
                        // it for the next turn). Only give up after many in a row.
                        consecutive_errs += 1;
                        if consecutive_errs >= 15 {
                            let _ = app.emit("stt-error", &e);
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(350));
                    }
                }
            }
            LOOP_RUNNING.store(false, Ordering::SeqCst);
            let _ = app.emit("stt-loop-ended", ());
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        {
            let _ = (&app, &engine, &openai_key);
            LOOP_RUNNING.store(false, Ordering::SeqCst);
        }
    });
    Ok(())
}

/// Stop the continuous listen loop and break any in-flight utterance capture.
#[tauri::command]
pub fn stt_stop_loop() {
    LOOP_RUNNING.store(false, Ordering::SeqCst);
    CANCEL.store(true, Ordering::Relaxed);
}
