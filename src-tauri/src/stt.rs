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

/// Whether the last `listen_live` utterance ended NATURALLY (you paused) vs was
/// CUT by the on-device recognizer's ~60s segment limit (you were still talking).
/// A cut segment is a continuation, not a finished turn — the frontend holds it
/// and keeps accumulating until a natural end, so long speech isn't split (and
/// isn't lost). Default true.
static END_NATURAL: AtomicBool = AtomicBool::new(true);

/// Whether the app (WebView) is in the foreground. JS flips this on
/// visibilitychange. When the app is backgrounded (the phone is locked or the app
/// is switched away) the WebView's JS is suspended and can't drive the voice loop
/// — we call this **Lock Mode**. In Lock Mode the STT loop runs the turn and
/// speaks the reply itself (see `run_background_turn`), captures everything said,
/// and plays its own audible cues. Foreground (active) mode is unchanged: the loop
/// emits `stt-utterance` and JS orchestrates as before. (`is_foreground()` names
/// the underlying OS state; "Lock Mode" is the product name for `!is_foreground`.)
static FOREGROUND: AtomicBool = AtomicBool::new(true);

/// True when the app is in the foreground (JS is alive to drive the loop).
pub fn is_foreground() -> bool {
    FOREGROUND.load(Ordering::Relaxed)
}

/// DEBUG: append one line to `<vault>/voice-trace.log`. It sits at the vault ROOT
/// (a dotdir like `.order-legacy` is NOT synced by Dropbox, but root files such as
/// spacetime.yml are), and `.log` isn't in Order's card walk, so it syncs for
/// retrieval without cluttering the UI. Cheap + safe: it only fires on segment
/// boundaries / commits, never per partial.
/// Master switch for the voice trace. Flip to `true` (and rebuild) to capture a
/// walk to `<vault>/voice-trace.log` when debugging dictation; off in normal use.
const VTRACE_ENABLED: bool = false;

pub fn vtrace(app: &tauri::AppHandle, line: &str) {
    if !VTRACE_ENABLED { return; }
    use tauri::Manager;
    let root = app
        .try_state::<crate::vault_fs::VaultState>()
        .and_then(|st| st.root.lock().ok().and_then(|g| g.clone()));
    let Some(root) = root else { return };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true).append(true).open(root.join("voice-trace.log"))
    {
        let _ = writeln!(f, "{ms} {line}");
    }
}

/// Frontend bridge to the same trace file, so Rust loop events and UI decisions
/// (utterance received → saved vs echo-dropped) interleave in one timeline.
#[tauri::command]
pub fn voice_trace(app: tauri::AppHandle, line: String) {
    vtrace(&app, &line);
}

/// Did the on-device recognizer RESET its running transcript to a NEW sentence
/// (an endpoint on a pause) rather than grow or lightly revise the current one?
/// True only when the new text is shorter than the current segment AND shares
/// little of its leading text — a growth or minor revision keeps a long common
/// prefix (so this stays false). A trivially short current segment isn't worth
/// banking, which also avoids false positives on early word-by-word growth.
pub fn is_segment_reset(cur: &str, new: &str) -> bool {
    let cur = cur.trim();
    let new = new.trim();
    let cur_n = cur.chars().count();
    let new_n = new.chars().count();
    if cur_n < 8 || new_n >= cur_n { return false; } // too short to matter, or still growing
    let common = cur.chars().zip(new.chars()).take_while(|(a, b)| a == b).count();
    common < cur_n / 2
}

/// Head+tail of a string for the trace (enough to recognise the buffer content
/// without dumping the whole utterance).
pub fn snippet(s: &str) -> String {
    let s = s.trim();
    let n = s.chars().count();
    if n <= 44 { return s.to_string(); }
    let head: String = s.chars().take(30).collect();
    let tail: String = s.chars().skip(n - 10).collect();
    format!("{head}…{tail}")
}

/// Config for the Rust-driven voice conversation used while backgrounded/locked.
/// Provided by JS when hands-free voice starts (`voice_convo_start`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
struct VoiceConvo {
    chat_rel: String,
    api_key: String,
    voice_id: Option<String>,
    rate: f32,
    // Cloud voice for the locked path so it sounds the same as when awake. When
    // `cloud_engine` is None (or synthesis fails), fall back to the native voice.
    cloud_engine: Option<String>, // "openai" | "eleven" | "unreal"
    cloud_voice: String,
    cloud_model: String,
    cloud_key: String,
    // Agent model provider selection (mirrors agent_turn).
    agent_provider: Option<String>,
    agent_base_url: Option<String>,
    agent_model: Option<String>,
}
#[cfg(any(target_os = "macos", target_os = "ios"))]
static VOICE_CONVO: std::sync::Mutex<Option<VoiceConvo>> = std::sync::Mutex::new(None);

/// Tell the native side whether the app is foregrounded (JS visibilitychange).
#[tauri::command]
pub fn set_foreground(#[allow(unused_variables)] app: tauri::AppHandle, foreground: bool) {
    FOREGROUND.store(foreground, Ordering::Relaxed);
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // Keep-alive under lock: while a hands-free voice loop is running and we go
        // to the background, loop inaudible audio so iOS keeps doing audio I/O in
        // the gaps between utterances and doesn't suspend/cold-start us. Stop it
        // the instant we return to the foreground (the awake path drives itself).
        if !foreground && LOOP_RUNNING.load(Ordering::Relaxed) {
            let _ = app.run_on_main_thread(|| crate::tts::silence_keepalive_begin());
        } else if foreground {
            let _ = app.run_on_main_thread(|| crate::tts::silence_keepalive_end());
        }
    }
}

/// Arm the Rust-driven voice conversation (used only while backgrounded). JS
/// calls this when hands-free voice starts; `voice_convo_stop` disarms it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn voice_convo_start(
    #[allow(unused_variables)] chat_path: String,
    #[allow(unused_variables)] api_key: String,
    #[allow(unused_variables)] voice_id: Option<String>,
    #[allow(unused_variables)] rate: Option<f32>,
    #[allow(unused_variables)] cloud_engine: Option<String>,
    #[allow(unused_variables)] cloud_voice: Option<String>,
    #[allow(unused_variables)] cloud_model: Option<String>,
    #[allow(unused_variables)] cloud_key: Option<String>,
    #[allow(unused_variables)] agent_provider: Option<String>,
    #[allow(unused_variables)] agent_base_url: Option<String>,
    #[allow(unused_variables)] agent_model: Option<String>,
) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        // Only treat it as a cloud voice if there's actually a key to use.
        let cloud_engine = match cloud_key.as_deref() {
            Some(k) if !k.trim().is_empty() => cloud_engine,
            _ => None,
        };
        *VOICE_CONVO.lock().unwrap() = Some(VoiceConvo {
            chat_rel: chat_path,
            api_key,
            voice_id,
            rate: rate.unwrap_or(1.0),
            cloud_engine,
            cloud_voice: cloud_voice.unwrap_or_default(),
            cloud_model: cloud_model.unwrap_or_default(),
            cloud_key: cloud_key.unwrap_or_default(),
            agent_provider,
            agent_base_url,
            agent_model,
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

/// Lock Mode turn: JS is suspended, so run the agent turn and speak the reply
/// entirely in Rust. Captures the user's utterance to the record first (a running
/// turn records it; the no-turn bail paths record it explicitly), then thinks and
/// speaks with audible cues. A background-execution assertion bridges the whole
/// turn so the app isn't suspended mid-think.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn run_background_turn(app: &tauri::AppHandle, utterance: &str) {
    let (chat_rel, api_key, voice_id, rate, cloud_engine, cloud_voice, cloud_model, cloud_key, agent_provider, agent_base_url, agent_model) = {
        let g = VOICE_CONVO.lock().unwrap();
        match g.as_ref() {
            Some(c) => (
                c.chat_rel.clone(), c.api_key.clone(), c.voice_id.clone(), c.rate,
                c.cloud_engine.clone(), c.cloud_voice.clone(), c.cloud_model.clone(), c.cloud_key.clone(),
                c.agent_provider.clone(), c.agent_base_url.clone(), c.agent_model.clone(),
            ),
            None => return, // no conversation armed → nowhere to record it
        }
    };
    // CAPTURE-FIRST GUARANTEE: whatever the user said is saved to the record even
    // when a full turn can't run here. A running turn records the user itself, so
    // we only record explicitly on the no-turn paths below (never a duplicate).
    if is_foreground() {
        // Returned to the foreground since this utterance was routed here: don't
        // also speak a reply (JS owns live turns), but still capture what was said.
        let _ = crate::agent::run::record_user_utterance(app, &chat_rel, utterance);
        return;
    }
    if api_key.trim().is_empty() {
        let _ = crate::agent::run::record_user_utterance(app, &chat_rel, utterance);
        return;
    }
    // Audible "processing" cue — the same feedback the web layer gives when the
    // app is open, but played natively because JS is suspended in Lock Mode.
    crate::tts::play_earcon_kind("thinking");
    // Hold the background-execution assertion across the WHOLE turn — model call,
    // cloud-TTS synth, AND playback — not just the model call. The gap between the
    // model finishing and audio starting (network synth, no audio flowing) was
    // otherwise unprotected, so iOS could suspend us mid-turn; that's a big part of
    // why only the FIRST locked turn worked (it fit inside the initial grace).
    crate::tts::keepalive_begin();
    let reply = crate::agent::run::run_turn_for(app, &api_key, &chat_rel, utterance, agent_provider.as_deref(), agent_base_url, agent_model.as_deref());
    let reply = match reply {
        Ok(r) => r,
        Err(_) => { crate::tts::keepalive_end(); return; }
    };
    if reply.trim().is_empty() {
        crate::tts::keepalive_end();
        return;
    }
    // Speak the reply. Prefer the SAME cloud voice used when awake (so locking the
    // phone doesn't swap to the robotic system voice) by synthesizing mp3 in Rust
    // and playing it on the shared session. Fall back to the native synthesizer if
    // no cloud voice is configured or synthesis/playback fails (e.g. offline).
    // RETRY before dropping to the system voice. Locked + walking = flaky cellular,
    // so a single synth/playback failure shouldn't switch you to the robotic Apple
    // voice — that's the "it often defaults back" complaint. Try the SELECTED cloud
    // voice a few times (short backoff) and only fall back to native as a last resort.
    let spoke_cloud = if let Some(engine) = cloud_engine.as_deref() {
        let mut ok = false;
        for attempt in 0..3u32 {
            match crate::tts::synth_cloud_bytes(engine, &cloud_voice, &cloud_model, &cloud_key, &reply) {
                Ok(bytes) => match crate::tts::play_audio_bytes(&bytes, rate) {
                    Ok(dur) => {
                        // Wait out playback before re-arming the mic (clean walkie-talkie).
                        let ms = ((dur * 1000.0) as u64).saturating_add(150).min(180_000);
                        std::thread::sleep(std::time::Duration::from_millis(ms));
                        ok = true;
                        break;
                    }
                    Err(_) => {} // playback failed — retry the whole synth+play
                },
                Err(_) => {} // synth failed (usually a transient network blip) — retry
            }
            if attempt < 2 { std::thread::sleep(std::time::Duration::from_millis(700)); }
        }
        ok
    } else {
        false
    };
    if !spoke_cloud {
        // Native (system voice): reliable offline / while locked. Wait for it to
        // finish before the loop re-arms the mic so the next turn is clean.
        crate::tts::speak_native(&reply, voice_id.as_deref(), rate);
        let start = std::time::Instant::now();
        std::thread::sleep(std::time::Duration::from_millis(200));
        while crate::tts::is_native_speaking() && start.elapsed() < std::time::Duration::from_secs(180) {
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
    }
    crate::tts::keepalive_end();
    // Reply delivered — cue that the mic is listening again for your next turn.
    crate::tts::play_earcon_kind("listening");
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

    /// True when audio is playing out the phone's BUILT-IN SPEAKER (portType
    /// "Speaker"), as opposed to headphones / AirPods / other Bluetooth. On the
    /// built-in speaker there's no echo cancellation, so the mic hears the agent
    /// loudly — the caller uses this to go half-duplex there. macOS: false.
    pub fn output_is_speaker() -> bool {
        #[cfg(target_os = "ios")]
        unsafe {
            let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
            if session.is_null() { return false; }
            let route: *mut AnyObject = msg_send![session, currentRoute];
            if route.is_null() { return false; }
            let outputs: *mut AnyObject = msg_send![route, outputs];
            if outputs.is_null() { return false; }
            let count: usize = msg_send![outputs, count];
            for i in 0..count {
                let port: *mut AnyObject = msg_send![outputs, objectAtIndex: i];
                if port.is_null() { continue; }
                let pt: Retained<NSString> = msg_send![port, portType];
                // AVAudioSessionPortBuiltInSpeaker == "Speaker".
                if pt.to_string() == "Speaker" { return true; }
            }
            false
        }
        #[cfg(target_os = "macos")]
        { false }
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
        // VoiceChat mode pins playback to the quiet earpiece (Receiver) even with
        // DefaultToSpeaker — force the loud speaker per AUDIO_OUTPUT_PREF (auto leaves
        // an external route alone). Mirrors tts::imp::route_output.
        {
            use std::sync::atomic::Ordering;
            let (apply, ov): (bool, usize) = match crate::tts::AUDIO_OUTPUT_PREF.load(Ordering::Relaxed) {
                1 => (true, 1),
                2 => (true, 0),
                _ => {
                    // auto: built-in speaker whenever there's no external route
                    // (mirrors tts::route_output — !ext, so a null/unsettled route
                    // still forces the loud speaker instead of the earpiece).
                    let route: *mut AnyObject = msg_send![session, currentRoute];
                    let mut ext = false;
                    if !route.is_null() {
                        let outs: *mut AnyObject = msg_send![route, outputs];
                        let cnt: usize = if outs.is_null() { 0 } else { msg_send![outs, count] };
                        for i in 0..cnt {
                            let p: *mut AnyObject = msg_send![outs, objectAtIndex: i];
                            if p.is_null() { continue; }
                            let pt: Retained<NSString> = msg_send![p, portType];
                            let s = pt.to_string();
                            if s != "Receiver" && s != "Speaker" { ext = true; }
                        }
                    }
                    (!ext, 1)
                }
            };
            if apply {
                let mut oerr: *mut AnyObject = std::ptr::null_mut();
                let _: objc2::runtime::Bool = msg_send![session, overrideOutputAudioPort: ov, error: &mut oerr];
            }
        }
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

    // The capture engine is built ONCE and kept RUNNING across utterances (see
    // `ensure_engine`) rather than torn down and rebuilt per turn. Rebuilding it
    // per-utterance meant that while the phone was LOCKED only the FIRST turn
    // worked — iOS resists starting a fresh mic capture under lock — and it also
    // dropped barge-in during TTS. A continuously-running engine fixes both, and is
    // itself the reliable "keep the app alive" signal (active mic I/O). Each
    // utterance's recognition request is swapped in via REQ_CUR, which the single
    // persistent tap feeds.
    static ENGINE: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
    static REQ_CUR: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    static REQ_KEEP: std::sync::Mutex<usize> = std::sync::Mutex::new(0);

    /// Build (once) and keep the capture engine running. Idempotent: a cheap check
    /// when it's already up; if it fell over, restart or rebuild it.
    unsafe fn ensure_engine(app: &AppHandle) -> Result<(), String> {
        use block2::RcBlock;
        {
            let g = ENGINE.lock().unwrap();
            if *g != 0 {
                let engine = *g as *mut AnyObject;
                let running: objc2::runtime::Bool = msg_send![engine, isRunning];
                if running.as_bool() { return Ok(()); }
                let mut err: *mut AnyObject = std::ptr::null_mut();
                let _: () = msg_send![engine, prepare];
                let ok: objc2::runtime::Bool = msg_send![engine, startAndReturnError: &mut err];
                if ok.as_bool() { return Ok(()); }
                // Couldn't restart the existing engine — tear it down and rebuild.
                let input: *mut AnyObject = msg_send![engine, inputNode];
                let _: () = msg_send![input, removeTapOnBus: 0usize];
                let _: () = msg_send![engine, stop];
                let _: () = msg_send![engine, release];
            }
        }
        prepare_session();
        let ealloc: *mut AnyObject = msg_send![class!(AVAudioEngine), alloc];
        let engine: *mut AnyObject = msg_send![ealloc, init];
        let input: *mut AnyObject = msg_send![engine, inputNode];
        // AEC via the input node's voice-processing unit is gated behind STT_AEC:
        // enabling it crashed on-device (format churn), so it's OFF by default.
        if super::aec_enabled() {
            let mut vp_err: *mut AnyObject = std::ptr::null_mut();
            let _: objc2::runtime::Bool = msg_send![input, setVoiceProcessingEnabled: true, error: &mut vp_err];
        }
        let fmt: *mut AnyObject = msg_send![input, outputFormatForBus: 0usize];
        // Persistent tap: feed the CURRENT recognition request (when an utterance is
        // active) and emit a rough input level. Between utterances REQ_CUR is 0, so
        // the mic just stays warm and the engine never stops.
        let app_tap = app.clone();
        let tap = RcBlock::new(move |buffer: *mut AnyObject, _when: *mut AnyObject| {
            let req = REQ_CUR.load(Ordering::Relaxed) as *mut AnyObject;
            if !req.is_null() {
                let _: () = msg_send![req, appendAudioPCMBuffer: buffer];
            }
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
            let _: () = msg_send![engine, release];
            return Err("Couldn't start the audio engine for live transcription.".into());
        }
        *ENGINE.lock().unwrap() = engine as usize;
        Ok(())
    }

    /// Stop and release the persistent capture engine (loop teardown).
    pub fn stop_engine() {
        unsafe {
            REQ_CUR.store(0, Ordering::Relaxed);
            {
                let mut g = REQ_KEEP.lock().unwrap();
                if *g != 0 { let r = *g as *mut AnyObject; let _: () = msg_send![r, release]; *g = 0; }
            }
            let mut g = ENGINE.lock().unwrap();
            if *g != 0 {
                let engine = *g as *mut AnyObject;
                let input: *mut AnyObject = msg_send![engine, inputNode];
                let _: () = msg_send![input, removeTapOnBus: 0usize];
                let _: () = msg_send![engine, stop];
                let _: () = msg_send![engine, release];
                *g = 0;
            }
        }
    }

    /// Live on-device recognition for ONE utterance against the persistent capture
    /// engine: streams partial transcripts (`stt-partial`, prefixed with `prefix` —
    /// the already-accumulated monologue, so the on-screen text never resets when
    /// the recognizer restarts at its ~60s cap) and finalizes after a pause. Returns
    /// the final transcript, or None if nothing was said / cancelled.
    pub fn listen_live(app: &AppHandle, prefix: &str, no_speech_ms: u64) -> Result<Option<String>, String> {
        use block2::RcBlock;
        use std::sync::{Arc, Mutex};

        // `text` = the FULL utterance so far = `finalized` (sentences the on-device
        // recognizer has already completed and RESET past) + `cur` (the sentence it's
        // currently building). The recognizer resets its running transcript to a fresh
        // short string every time you pause (it endpoints the sentence); without banking
        // `cur` into `finalized` at that moment, everything before the pause is
        // overwritten and lost — the confirmed "text vanishes on a pause" bug.
        struct Shared { text: String, finalized: String, cur: String, last: Instant, got: bool, done: bool, err: Option<String> }
        let shared = Arc::new(Mutex::new(Shared { text: String::new(), finalized: String::new(), cur: String::new(), last: Instant::now(), got: false, done: false, err: None }));

        unsafe {
            ensure_engine(app)?;
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

            // Point the persistent tap at THIS request, and keep it owned in REQ_KEEP
            // (the alloc/init +1) so the audio thread can't use-after-free after we
            // stop feeding it at teardown. The PREVIOUS request is released here — by
            // now its REQ_CUR was long since cleared, so the tap isn't touching it.
            {
                let mut keep = REQ_KEEP.lock().unwrap();
                if *keep != 0 { let old = *keep as *mut AnyObject; let _: () = msg_send![old, release]; }
                *keep = request as usize;
            }
            REQ_CUR.store(request as usize, Ordering::Relaxed);

            // Mic is already live (persistent engine) — cue "listening" for this turn.
            let _ = app.emit("stt-listening", ());

            // Recognition task: stream partials, PREFIXED with the held monologue so
            // the on-screen transcript keeps growing instead of resetting at each
            // ~60s recognizer restart.
            let prefix_s = prefix.to_string();
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
                let mut full = String::new();
                let mut banked: Option<(String, usize)> = None; // (finished sentence, total finalized len)
                if let Ok(mut st) = shared_h.lock() {
                    let seg = text.trim();
                    if !seg.is_empty() {
                        // The recognizer resets its running transcript to a fresh, much
                        // shorter, divergent string when it endpoints a sentence (a pause).
                        // Detect that and BANK the sentence it just finished so it can't be
                        // overwritten. A normal growth or minor revision keeps a big shared
                        // prefix, so it is NOT treated as a reset.
                        if super::is_segment_reset(&st.cur, seg) {
                            let done_sentence = st.cur.trim().to_string();
                            if !done_sentence.is_empty() {
                                if !st.finalized.is_empty() { st.finalized.push(' '); }
                                st.finalized.push_str(&done_sentence);
                                banked = Some((done_sentence, st.finalized.chars().count()));
                            }
                        }
                        st.cur = seg.to_string();
                        st.text = if st.finalized.is_empty() {
                            st.cur.clone()
                        } else {
                            format!("{} {}", st.finalized.trim(), st.cur.trim())
                        };
                        st.got = true;
                        st.last = Instant::now();
                    }
                    full = st.text.clone();
                    if is_final.as_bool() { st.done = true; }
                }
                if let Some((sentence, fin_len)) = banked {
                    super::vtrace(&app_h, &format!("  BANK sentence on pause-reset: kept '{}' (finalized now {} chars)",
                        super::snippet(&sentence), fin_len));
                }
                let shown = if prefix_s.is_empty() { full.clone() }
                    else if full.is_empty() { prefix_s.clone() }
                    else { format!("{} {}", prefix_s, full) };
                let _ = app_h.emit("stt-partial", &shown);
                let _ = app_h.emit("stt-state", "heard");
            });
            let task: *mut AnyObject = msg_send![recognizer, recognitionTaskWithRequest: request, resultHandler: &*handler];

            // Wait for a pause after speech (or a cap / no-speech timeout / cancel).
            // End-of-turn = silence, but a SEMANTIC check tolerates rambling: if
            // the transcript trails off mid-thought (a conjunction/filler/dangling
            // function word, no terminal punctuation), grant a longer window so a
            // natural pause isn't mistaken for "done".
            let start = Instant::now();
            // Pause tolerance BEFORE we treat silence as "you're done". Kept long
            // enough that Apple's own on-device isFinal (its segment boundary, which
            // fires ~2s into a pause) reliably wins the race — so a brief pause-then-
            // resume is HELD and stitched into one utterance by the caller (accum),
            // instead of our timer committing it early and the resumed words starting
            // a fresh turn. That early-commit was the pause-boundary data-loss seam.
            let silence = Duration::from_millis(2600);
            let silence_incomplete = Duration::from_millis(4200);
            // No-speech timeout: patient on a fresh utterance (wait for you to start),
            // but a short grace when we're already holding a continuation (`accum`) —
            // if you don't resume within it, commit what's held rather than hanging.
            let no_speech = Duration::from_millis(no_speech_ms);
            let max_utter = Duration::from_secs(90);
            let mut cancelled = false;
            // Whether this segment ended because you actually paused (natural) or
            // was cut by the recognizer's own finalization / our hard cap (you
            // were likely still talking). Continuations are held by the caller.
            let mut natural = true;
            let mut reason = "?";
            loop {
                std::thread::sleep(Duration::from_millis(60));
                if CANCEL.load(Ordering::Relaxed) { cancelled = true; reason = "cancel"; break; }
                let (got, done, since_last, since_start, txt) = {
                    let s = shared.lock().unwrap();
                    (s.got, s.done, s.last.elapsed(), start.elapsed(), s.text.clone())
                };
                // Recognizer finalized on its own (its ~60s on-device limit) while
                // you were mid-speech: a cut, not a real end.
                if done { natural = false; reason = "isFinal"; break; }
                let eff_silence = if looks_incomplete(&txt) { silence_incomplete } else { silence };
                if got && since_last > eff_silence { natural = true; reason = "pause-timer"; break; } // you paused
                if !got && since_start > no_speech { natural = true; reason = "no-speech"; break; }  // no speech
                if since_start > max_utter { natural = false; reason = "hard-cap-90s"; break; }         // our cap; likely still talking
            }

            // Teardown for THIS utterance only — the engine keeps running. Stop
            // feeding the request (so the persistent tap can't touch it), then
            // finalize it and the task. REQ_KEEP holds the request alive until the
            // next utterance swaps it in, avoiding a use-after-free on the audio
            // thread.
            REQ_CUR.store(0, Ordering::Relaxed);
            let _: () = msg_send![request, endAudio];
            let _: () = msg_send![task, cancel];
            let _ = app.emit("stt-level", 0.0f32);

            if cancelled { super::vtrace(app, &format!("  listen_live END reason=cancel natural={} prefix_len={} -> None", natural, prefix.len())); return Ok(None); }
            let final_text = { let s = shared.lock().unwrap(); s.text.trim().to_string() };
            if final_text.is_empty() {
                super::vtrace(app, &format!("  listen_live END reason={} EMPTY prefix_len={} -> None", reason, prefix.len()));
                return Ok(None);
            }
            super::END_NATURAL.store(natural, Ordering::Relaxed);
            super::vtrace(app, &format!("  listen_live END reason={} natural={} prefix_len={} text_len={} text='{}'",
                reason, natural, prefix.len(), final_text.len(), super::snippet(&final_text)));
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

/// True when TTS is playing out the built-in speaker (no echo cancellation there,
/// so the frontend goes half-duplex to stop the agent hearing itself).
#[tauri::command]
pub fn stt_output_is_speaker() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    { apple::output_is_speaker() }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    { false }
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
                let text = match apple::listen_live(&app, "", 20_000)? {
                    Some(t) => t,
                    None => return Ok(String::new()),
                };
                apple::stop_engine(); // single-shot: don't leave the mic running
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
            // Continuation buffer (foreground AND background): segments the recognizer
            // cut mid-speech (its ~60s cap) are held here and joined until a NATURAL
            // pause, so a long monologue is ONE utterance — nothing lost, nothing sent
            // early. The display keeps up because listen_live prefixes its partials
            // with this. Sending is driven purely by the on-device VAD (no JS timer).
            let mut accum = String::new();
            vtrace(&app, &format!("=== LOOP START engine={} (accum reset to empty) ===", engine));
            while LOOP_RUNNING.load(Ordering::Relaxed) {
                apple::reset_cancel();
                // While backgrounded/locked, make sure the inaudible keep-alive is
                // still playing before each listen — an audio-session interruption
                // (e.g. after a reply) can pause it, and if it stays paused iOS
                // suspends us during the next think (why locked chat died after the
                // first turn). Idempotent: no-op when already playing.
                if !is_foreground() {
                    let _ = app.run_on_main_thread(|| crate::tts::silence_keepalive_begin());
                }
                END_NATURAL.store(true, Ordering::Relaxed); // default; native path overrides
                let started = std::time::Instant::now();
                vtrace(&app, &format!("iter start: fg={} accum_len={} accum='{}'", is_foreground(), accum.len(), snippet(&accum)));
                let result = if engine == "native" {
                    // Fresh utterance: wait patiently (20s) for you to start. Holding
                    // a continuation (accum non-empty): only a short grace (2.5s) for
                    // you to RESUME before we commit what's held — this is what stitches
                    // a pause-then-resume into one turn instead of losing the tail.
                    apple::listen_live(&app, &accum, if accum.is_empty() { 20_000 } else { 2_500 })
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
                        let continues = !END_NATURAL.load(Ordering::Relaxed);
                        let _ = app.emit("stt-usage", serde_json::json!({ "engine": engine, "seconds": started.elapsed().as_secs_f64() }));
                        let seg = text.trim();
                        if continues {
                            // Recognizer cut you mid-thought (its ~60s cap): HOLD the
                            // segment and keep listening. No turn is sent, nothing is
                            // shown as final — the display already grows via prefixed
                            // partials. This is what stops long speech being lost/chopped.
                            if !accum.is_empty() { accum.push(' '); }
                            accum.push_str(seg);
                            vtrace(&app, &format!("HELD (continues) seg_len={} -> accum_len={} '{}'", seg.len(), accum.len(), snippet(&accum)));
                        } else {
                            // Natural pause = the WHOLE utterance is done.
                            let full = if accum.is_empty() { seg.to_string() } else { format!("{} {}", accum.trim(), seg) };
                            accum.clear();
                            vtrace(&app, &format!("COMMIT-send fg={} full_len={} '{}'", is_foreground(), full.len(), snippet(&full)));
                            if is_foreground() {
                                let _ = app.emit("stt-utterance", serde_json::json!({ "text": full }));
                            } else {
                                run_background_turn(&app, full.trim());
                            }
                        }
                    }
                    Ok(_) => {
                        consecutive_errs = 0; // silence / cancelled — re-arm
                        // You stopped after a mid-thought cut with nothing more: flush
                        // the held text now as the complete utterance.
                        if !accum.trim().is_empty() {
                            let full = accum.trim().to_string();
                            accum.clear();
                            vtrace(&app, &format!("COMMIT-flush fg={} full_len={} '{}'", is_foreground(), full.len(), snippet(&full)));
                            if is_foreground() {
                                let _ = app.emit("stt-utterance", serde_json::json!({ "text": full }));
                            } else {
                                run_background_turn(&app, &full);
                            }
                        } else {
                            vtrace(&app, "None/empty: accum also empty (nothing to commit)");
                        }
                    }
                    Err(e) => {
                        // A transient failure — e.g. the audio engine couldn't
                        // (re)start because TTS is currently using the session.
                        // Don't kill the loop: back off briefly and retry so the
                        // mic comes back (during playback for barge-in, and after
                        // it for the next turn). Only give up after many in a row.
                        consecutive_errs += 1;
                        vtrace(&app, &format!("ERR '{}' consec={} accum_len={} (accum KEPT)", e, consecutive_errs, accum.len()));
                        if consecutive_errs >= 15 {
                            let _ = app.emit("stt-error", &e);
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(350));
                    }
                }
            }
            vtrace(&app, &format!("=== LOOP END (running={}) accum_len={} '{}' <-- if accum_len>0 here, HELD TEXT WAS LOST ===",
                LOOP_RUNNING.load(Ordering::Relaxed), accum.len(), snippet(&accum)));
            LOOP_RUNNING.store(false, Ordering::SeqCst);
            apple::stop_engine();
            let _ = app.run_on_main_thread(|| crate::tts::silence_keepalive_end());
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
