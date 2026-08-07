//! Native text-to-speech (AVSpeechSynthesizer) — macOS + iOS.
//!
//! The Web Speech API in WKWebView only surfaces a filtered subset of voices
//! (the downloaded Enhanced / Premium voices don't appear) and has a flaky
//! cancel/speak timing. Driving the native synthesizer instead exposes every
//! installed voice with its quality, and plays reliably. Speak / stop run on
//! the main thread (audio API); the frontend polls `tts_is_speaking` to reset
//! its button when playback finishes.

use serde::Serialize;

#[derive(Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub name: String,
    pub lang: String,
    /// AVSpeechSynthesisVoiceQuality: 1 = default (compact), 2 = enhanced,
    /// 3 = premium. Used by the UI to keep only the good voices.
    pub quality: u8,
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::VoiceInfo;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    use std::sync::Mutex;

    // Force-link the framework that defines AVSpeechSynthesizer so its classes
    // are registered with the Obj-C runtime (same pattern as badge.rs).
    #[link(name = "AVFAudio", kind = "framework")]
    extern "C" {}

    // One shared synthesizer, created + driven on the main thread. Stored as a
    // retained raw pointer (Send) behind a Mutex.
    static SYNTH: Mutex<usize> = Mutex::new(0);

    /// Every installed voice with its quality.
    pub fn voices() -> Vec<VoiceInfo> {
        let arr: *mut AnyObject = unsafe { msg_send![class!(AVSpeechSynthesisVoice), speechVoices] };
        if arr.is_null() {
            return Vec::new();
        }
        let count: usize = unsafe { msg_send![arr, count] };
        let mut out = Vec::with_capacity(count);
        for idx in 0..count {
            let v: *mut AnyObject = unsafe { msg_send![arr, objectAtIndex: idx] };
            if v.is_null() {
                continue;
            }
            let id: Retained<NSString> = unsafe { msg_send![v, identifier] };
            let name: Retained<NSString> = unsafe { msg_send![v, name] };
            let lang: Retained<NSString> = unsafe { msg_send![v, language] };
            let quality: isize = unsafe { msg_send![v, quality] };
            out.push(VoiceInfo {
                id: id.to_string(),
                name: name.to_string(),
                lang: lang.to_string(),
                quality: quality.clamp(1, 3) as u8,
            });
        }
        out
    }

    fn synth_ptr() -> *mut AnyObject {
        let mut g = SYNTH.lock().unwrap();
        if *g == 0 {
            let s: *mut AnyObject = unsafe {
                let alloc: *mut AnyObject = msg_send![class!(AVSpeechSynthesizer), alloc];
                msg_send![alloc, init]
            };
            // Keep it alive past the autorelease pool.
            let s: *mut AnyObject = unsafe { msg_send![s, retain] };
            *g = s as usize;
        }
        *g as *mut AnyObject
    }

    // Keep audio alive when the app is backgrounded / the phone is locked.
    // iOS only — macOS has no AVAudioSession (calling it would crash). Paired
    // with UIBackgroundModes=audio in Info.plist.
    #[cfg(target_os = "ios")]
    extern "C" {
        static AVAudioSessionCategoryPlayAndRecord: *const AnyObject;
        static AVAudioSessionModeVoiceChat: *const AnyObject;
    }
    #[cfg(target_os = "ios")]
    fn activate_audio_session() {
        unsafe {
            let session: *mut AnyObject = msg_send![class!(AVAudioSession), sharedInstance];
            if session.is_null() {
                return;
            }
            // PlayAndRecord (NOT Playback): a playback-only category disables the
            // input, which killed the continuously-open STT mic the instant the
            // agent spoke — so the user could never be heard to interrupt. Keeping
            // the record-capable category (matching stt.rs prepare_session) lets
            // the mic stay live during TTS, which is what barge-in needs.
            // AllowBluetooth (0x4) keeps AirPods as the route; DefaultToSpeaker
            // (0x8) keeps playback loud with no headset; VoiceChat mode enables the
            // system echo cancellation so the mic doesn't transcribe the TTS.
            let options: usize = 0x4 | 0x8;
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let _: objc2::runtime::Bool = msg_send![session, setCategory: AVAudioSessionCategoryPlayAndRecord, withOptions: options, error: &mut err];
            let mut merr: *mut AnyObject = std::ptr::null_mut();
            let _: objc2::runtime::Bool = msg_send![session, setMode: AVAudioSessionModeVoiceChat, error: &mut merr];
            let mut err2: *mut AnyObject = std::ptr::null_mut();
            let _: objc2::runtime::Bool = msg_send![session, setActive: true, error: &mut err2];
        }
    }
    #[cfg(not(target_os = "ios"))]
    fn activate_audio_session() {}

    // ---- background-execution assertion (#27) ---------------------------------
    // UIBackgroundModes=audio only keeps the app alive while audio is actually
    // flowing. During a voice turn's "thinking" gap — mic stopped, nothing
    // playing yet, waiting on the model/tools — a locked phone would suspend the
    // app and the reply would never arrive or speak. A UIApplication background
    // task assertion buys ~30s of guaranteed execution to bridge that gap. The
    // JS voice loop takes it when a turn starts and releases it once the reply
    // finishes playing (or on cancel/error). Idempotent: only one is ever held.
    #[cfg(target_os = "ios")]
    mod bg {
        use objc2::{class, msg_send, runtime::AnyObject};
        use std::sync::Mutex;

        #[link(name = "UIKit", kind = "framework")]
        extern "C" {}

        // UIBackgroundTaskInvalid == NSUIntegerMax.
        const INVALID: usize = usize::MAX;
        static TASK: Mutex<usize> = Mutex::new(INVALID);

        pub fn begin() {
            unsafe {
                let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
                if app.is_null() {
                    return;
                }
                let mut g = TASK.lock().unwrap();
                if *g != INVALID {
                    return; // already holding one — don't stack
                }
                // nil expiration handler: we end the task ourselves when the turn
                // completes. If it ever expires first the system just reclaims it
                // (same outcome as today — the turn is lost), so this is safe.
                let id: usize = msg_send![
                    app,
                    beginBackgroundTaskWithExpirationHandler: std::ptr::null::<AnyObject>()
                ];
                *g = id;
            }
        }

        pub fn end() {
            unsafe {
                let app: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
                if app.is_null() {
                    return;
                }
                let mut g = TASK.lock().unwrap();
                if *g == INVALID {
                    return;
                }
                let _: () = msg_send![app, endBackgroundTask: *g];
                *g = INVALID;
            }
        }
    }

    #[cfg(target_os = "ios")]
    pub fn keepalive_begin() {
        bg::begin();
    }
    #[cfg(target_os = "ios")]
    pub fn keepalive_end() {
        bg::end();
    }
    #[cfg(not(target_os = "ios"))]
    pub fn keepalive_begin() {}
    #[cfg(not(target_os = "ios"))]
    pub fn keepalive_end() {}

    /// Speak `text`, stopping anything already playing (one at a time). Runs on
    /// the main thread (call via run_on_main_thread).
    pub fn speak(text: &str, voice_id: Option<&str>, rate_ux: f32) {
        activate_audio_session();
        let synth = synth_ptr();
        unsafe {
            // 0 = AVSpeechBoundaryImmediate.
            let _: () = msg_send![synth, stopSpeakingAtBoundary: 0isize];
            let ns = NSString::from_str(text);
            let utter: *mut AnyObject =
                msg_send![class!(AVSpeechUtterance), speechUtteranceWithString: &*ns];
            if utter.is_null() {
                return;
            }
            if let Some(vid) = voice_id {
                if !vid.is_empty() {
                    let vns = NSString::from_str(vid);
                    let voice: *mut AnyObject =
                        msg_send![class!(AVSpeechSynthesisVoice), voiceWithIdentifier: &*vns];
                    if !voice.is_null() {
                        let _: () = msg_send![utter, setVoice: voice];
                    }
                }
            }
            // AVSpeechUtterance.rate is 0.0–1.0 (default ~0.5). Map our 0.5–2.0×.
            let av_rate: f32 = (0.5 * rate_ux).clamp(0.0, 1.0);
            let _: () = msg_send![utter, setRate: av_rate];
            let _: () = msg_send![synth, speakUtterance: utter];
        }
    }

    pub fn stop() {
        let g = SYNTH.lock().unwrap();
        if *g != 0 {
            let synth = *g as *mut AnyObject;
            unsafe {
                let _: () = msg_send![synth, stopSpeakingAtBoundary: 0isize];
            }
        }
    }

    pub fn is_speaking() -> bool {
        let g = SYNTH.lock().unwrap();
        if *g == 0 {
            return false;
        }
        let synth = *g as *mut AnyObject;
        let speaking: objc2::runtime::Bool = unsafe { msg_send![synth, isSpeaking] };
        speaking.as_bool()
    }
}

#[tauri::command]
pub fn tts_voices() -> Vec<VoiceInfo> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::voices()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub fn tts_speak(
    #[allow(unused_variables)] app: tauri::AppHandle,
    text: String,
    voice_id: Option<String>,
    rate: f32,
) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        app.run_on_main_thread(move || imp::speak(&text, voice_id.as_deref(), rate))
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (text, voice_id, rate);
        Ok(())
    }
}

#[tauri::command]
pub fn tts_stop(#[allow(unused_variables)] app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        app.run_on_main_thread(|| imp::stop()).map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(())
    }
}

#[tauri::command]
pub fn tts_is_speaking() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::is_speaking()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}

/// Take a background-execution assertion so a voice turn keeps running while the
/// phone is locked / the app is backgrounded (#27). No-op off iOS. Paired with
/// `voice_keepalive_end` — always release it when the turn finishes.
#[tauri::command]
pub fn voice_keepalive_begin(#[allow(unused_variables)] app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        app.run_on_main_thread(|| imp::keepalive_begin())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(())
    }
}

/// Release the background-execution assertion taken by `voice_keepalive_begin`.
#[tauri::command]
pub fn voice_keepalive_end(#[allow(unused_variables)] app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        app.run_on_main_thread(|| imp::keepalive_end())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(())
    }
}

// ---- Cloud engines (OpenAI + ElevenLabs) ----------------------------------
//
// The HTTP calls run in Rust (ureq) so the API key never rides in the webview
// and there's no browser CORS. Audio (mp3) comes back base64 for the frontend
// to play via an <audio> element.

use base64::Engine as _;
use std::io::Read;

fn http_agent() -> ureq::Agent {
    let connector = native_tls::TlsConnector::new().expect("tls");
    ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(connector))
        .build()
}

fn read_audio_b64(resp: ureq::Response) -> Result<String, String> {
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("read audio: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(buf))
}

/// OpenAI text-to-speech → base64 mp3.
#[tauri::command]
pub async fn tts_openai(
    api_key: String,
    voice: String,
    model: String,
    speed: f32,
    text: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let body = serde_json::json!({
            "model": model, "voice": voice, "input": text,
            "response_format": "mp3", "speed": speed.clamp(0.25, 4.0),
        });
        match http_agent()
            .post("https://api.openai.com/v1/audio/speech")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(body)
        {
            Ok(r) => read_audio_b64(r),
            Err(ureq::Error::Status(code, r)) => {
                Err(format!("OpenAI TTS {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => Err(format!("OpenAI TTS: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ElevenLabs text-to-speech → base64 mp3.
#[tauri::command]
pub async fn tts_eleven(
    api_key: String,
    voice_id: String,
    model_id: String,
    text: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("https://api.elevenlabs.io/v1/text-to-speech/{voice_id}");
        let body = serde_json::json!({ "text": text, "model_id": model_id });
        match http_agent()
            .post(&url)
            .set("xi-api-key", &api_key)
            .set("Accept", "audio/mpeg")
            .send_json(body)
        {
            Ok(r) => read_audio_b64(r),
            Err(ureq::Error::Status(code, r)) => {
                Err(format!("ElevenLabs TTS {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => Err(format!("ElevenLabs TTS: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unreal Speech text-to-speech → base64 mp3. The `/stream` endpoint accepts up
/// to 1000 characters; the frontend chunks below that.
#[tauri::command]
pub async fn tts_unreal(
    api_key: String,
    voice_id: String,
    text: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Synthesize at natural speed/pitch; playback rate handles speed so one
        // cached recording works at any speed (mirrors the OpenAI/Eleven path).
        let body = serde_json::json!({
            "Text": text,
            "VoiceId": voice_id,
            "Bitrate": "192k",
            "Speed": 0,
            "Pitch": 1.0,
            "Codec": "libmp3lame",
        });
        match http_agent()
            .post("https://api.v8.unrealspeech.com/stream")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(body)
        {
            Ok(r) => read_audio_b64(r),
            Err(ureq::Error::Status(code, r)) => {
                Err(format!("Unreal Speech TTS {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => Err(format!("Unreal Speech TTS: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct CloudVoice {
    pub id: String,
    pub name: String,
}

/// The user's ElevenLabs voices (for the picker).
#[tauri::command]
pub async fn tts_eleven_voices(api_key: String) -> Result<Vec<CloudVoice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = http_agent()
            .get("https://api.elevenlabs.io/v1/voices")
            .set("xi-api-key", &api_key)
            .call();
        let v: serde_json::Value = match resp {
            Ok(r) => r.into_json().map_err(|e| format!("eleven voices body: {e}"))?,
            Err(ureq::Error::Status(code, r)) => {
                return Err(format!("ElevenLabs voices {code}: {}", r.into_string().unwrap_or_default()))
            }
            Err(e) => return Err(format!("ElevenLabs voices: {e}")),
        };
        let out = v
            .get("voices")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|it| {
                        let id = it.get("voice_id").and_then(|x| x.as_str())?.to_string();
                        let name = it.get("name").and_then(|x| x.as_str()).unwrap_or("Voice").to_string();
                        Some(CloudVoice { id, name })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
