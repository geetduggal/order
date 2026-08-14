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

/// Audio OUTPUT routing preference for the voice loop:
///   0 = auto  — the loud built-in speaker when on the built-in route, but keep an
///               external route (AirPods / wired) if one is connected;
///   1 = speaker — always the built-in speaker;
///   2 = receiver — the earpiece (quiet, phone-to-ear).
/// iOS `VoiceChat` mode otherwise pins playback to the quiet earpiece even with the
/// DefaultToSpeaker option — this is why the spoken reply wasn't coming out loud.
pub static AUDIO_OUTPUT_PREF: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// Set the voice output routing (from Settings). Applied on the next session setup.
#[tauri::command]
pub fn set_audio_output(pref: u8) {
    AUDIO_OUTPUT_PREF.store(pref, std::sync::atomic::Ordering::Relaxed);
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

    // Native playback of cloud-TTS audio (AVAudioPlayer). Cloud voices used to
    // play through the WebView's <audio>, whose playback INTERRUPTS the native
    // mic engine on iOS — so the hands-free loop went deaf during speech and you
    // couldn't be heard to interrupt. Playing on the same AVAudioSession as the
    // recorder lets record + playback coexist, which is what barge-in needs.
    static AUDIO_PLAYER: Mutex<usize> = Mutex::new(0);

    /// Play mp3/audio bytes on the shared audio session. Returns the wall-clock
    /// duration (seconds, adjusted for `rate`) so the caller can advance its
    /// queue. Stops any previous clip first (one at a time).
    pub fn play_audio(bytes: &[u8], rate: f32) -> Result<f64, String> {
        unsafe {
            stop_audio();
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
                length: bytes.len()
            ];
            if data.is_null() {
                return Err("audio: NSData failed".into());
            }
            let alloc: *mut AnyObject = msg_send![class!(AVAudioPlayer), alloc];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let player: *mut AnyObject = msg_send![alloc, initWithData: data, error: &mut err];
            if player.is_null() {
                return Err("audio: player init failed".into());
            }
            let _: () = msg_send![player, setEnableRate: true];
            let r = if rate > 0.1 { rate } else { 1.0 };
            let _: () = msg_send![player, setRate: r];
            let _: objc2::runtime::Bool = msg_send![player, prepareToPlay];
            let dur: f64 = msg_send![player, duration];
            let ok: objc2::runtime::Bool = msg_send![player, play];
            if !ok.as_bool() {
                return Err("audio: play failed".into());
            }
            let _: *mut AnyObject = msg_send![player, retain];
            *AUDIO_PLAYER.lock().unwrap() = player as usize;
            Ok((dur / r as f64).max(0.0))
        }
    }

    pub fn stop_audio() {
        unsafe {
            let mut g = AUDIO_PLAYER.lock().unwrap();
            if *g != 0 {
                let p = *g as *mut AnyObject;
                let _: () = msg_send![p, stop];
                let _: () = msg_send![p, release];
                *g = 0;
            }
        }
    }

    // A SEPARATE player for short UI earcons (thinking / interrupt cues) so they
    // don't stop the reply's audio or fight the main player. Overlap is fine.
    static EARCON_PLAYER: Mutex<usize> = Mutex::new(0);

    pub fn play_earcon(bytes: &[u8]) -> Result<(), String> {
        unsafe {
            {
                let mut g = EARCON_PLAYER.lock().unwrap();
                if *g != 0 {
                    let p = *g as *mut AnyObject;
                    let _: () = msg_send![p, stop];
                    let _: () = msg_send![p, release];
                    *g = 0;
                }
            }
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
                length: bytes.len()
            ];
            if data.is_null() {
                return Err("earcon: NSData failed".into());
            }
            let alloc: *mut AnyObject = msg_send![class!(AVAudioPlayer), alloc];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let player: *mut AnyObject = msg_send![alloc, initWithData: data, error: &mut err];
            if player.is_null() {
                return Err("earcon: player init failed".into());
            }
            let _: objc2::runtime::Bool = msg_send![player, prepareToPlay];
            let ok: objc2::runtime::Bool = msg_send![player, play];
            if !ok.as_bool() {
                return Err("earcon: play failed".into());
            }
            let _: *mut AnyObject = msg_send![player, retain];
            *EARCON_PLAYER.lock().unwrap() = player as usize;
            Ok(())
        }
    }

    // Continuous inaudible audio that keeps the app alive while backgrounded /
    // locked. iOS only keeps an `audio`-background app running while it is
    // actively doing audio I/O. Between utterances the mic engine is stopped
    // (stt.rs teardown), leaving a gap in which a LOCKED phone suspends the
    // process — which is exactly why the app cold-started on relaunch. Looping an
    // inaudible buffer through the shared session fills those gaps so the process
    // stays alive. Background-only: started on `setForeground(false)` during an
    // active voice loop, stopped the moment we return to the foreground.
    static KEEPALIVE_PLAYER: Mutex<usize> = Mutex::new(0);

    /// A 1s 16-bit mono WAV holding a barely-there 50 Hz tone (amplitude ~24 of
    /// 32767) — non-silent so the audio pipeline treats it as real playback, but
    /// inaudible (the player volume is also near zero).
    fn silence_wav() -> Vec<u8> {
        const SR: u32 = 44100;
        let n = SR as usize; // 1 second
        let data_len = n * 2;
        let mut buf = Vec::with_capacity(44 + data_len);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
        buf.extend_from_slice(&1u16.to_le_bytes()); // mono
        buf.extend_from_slice(&SR.to_le_bytes());
        buf.extend_from_slice(&(SR * 2).to_le_bytes()); // byte rate
        buf.extend_from_slice(&2u16.to_le_bytes()); // block align
        buf.extend_from_slice(&16u16.to_le_bytes()); // bits
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data_len as u32).to_le_bytes());
        for i in 0..n {
            let s = ((i as f32 * 50.0 * std::f32::consts::TAU / SR as f32).sin() * 24.0) as i16;
            buf.extend_from_slice(&s.to_le_bytes());
        }
        buf
    }

    pub fn silence_keepalive_begin() {
        unsafe {
            // Ensure it's actively playing. If a player exists but stopped (an audio
            // session interruption after a reply can pause it), kick it again; only
            // rebuild if that fails. This self-heal is what keeps the app alive past
            // the FIRST locked turn (it was dying on turn 2 when the loop stopped).
            {
                let mut g = KEEPALIVE_PLAYER.lock().unwrap();
                if *g != 0 {
                    let p = *g as *mut AnyObject;
                    let playing: objc2::runtime::Bool = msg_send![p, isPlaying];
                    if playing.as_bool() {
                        return; // already looping
                    }
                    let ok: objc2::runtime::Bool = msg_send![p, play];
                    if ok.as_bool() {
                        return; // resumed
                    }
                    // Couldn't resume — drop the stale player and rebuild below.
                    let _: () = msg_send![p, stop];
                    let _: () = msg_send![p, release];
                    *g = 0;
                }
            }
            let bytes = silence_wav();
            let data: *mut AnyObject = msg_send![
                class!(NSData),
                dataWithBytes: bytes.as_ptr() as *const std::ffi::c_void,
                length: bytes.len()
            ];
            if data.is_null() {
                return;
            }
            let alloc: *mut AnyObject = msg_send![class!(AVAudioPlayer), alloc];
            let mut err: *mut AnyObject = std::ptr::null_mut();
            let player: *mut AnyObject = msg_send![alloc, initWithData: data, error: &mut err];
            if player.is_null() {
                return;
            }
            let _: () = msg_send![player, setNumberOfLoops: -1isize]; // loop forever
            let _: () = msg_send![player, setVolume: 0.01f32];
            let _: objc2::runtime::Bool = msg_send![player, prepareToPlay];
            let ok: objc2::runtime::Bool = msg_send![player, play];
            if !ok.as_bool() {
                return;
            }
            let _: *mut AnyObject = msg_send![player, retain];
            *KEEPALIVE_PLAYER.lock().unwrap() = player as usize;
        }
    }

    pub fn silence_keepalive_end() {
        unsafe {
            let mut g = KEEPALIVE_PLAYER.lock().unwrap();
            if *g != 0 {
                let p = *g as *mut AnyObject;
                let _: () = msg_send![p, stop];
                let _: () = msg_send![p, release];
                *g = 0;
            }
        }
    }

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
        // The streaming speaker calls speak() once per sentence, so this ran
        // per-sentence on the MAIN thread — setCategory/setActive can be slow and
        // janks the UI. Throttle: reconfigure at most every ~2s (the config is
        // sticky, so a mid-reply skip is harmless).
        use std::sync::atomic::{AtomicU64, Ordering};
        static LAST_MS: AtomicU64 = AtomicU64::new(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if now.saturating_sub(LAST_MS.load(Ordering::Relaxed)) < 2000 {
            return;
        }
        LAST_MS.store(now, Ordering::Relaxed);
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
            route_output(session);
        }
    }
    #[cfg(not(target_os = "ios"))]
    fn activate_audio_session() {}

    /// Force the loud speaker when VoiceChat mode would otherwise pin playback to the
    /// quiet earpiece (Receiver). Honors `AUDIO_OUTPUT_PREF`; in auto it leaves an
    /// external route (AirPods / wired) alone. THE fix for "the reply didn't come out
    /// of the iPhone speaker."
    #[cfg(target_os = "ios")]
    unsafe fn route_output(session: *mut AnyObject) {
        use std::sync::atomic::Ordering;
        let (apply, ov): (bool, usize) = match super::AUDIO_OUTPUT_PREF.load(Ordering::Relaxed) {
            1 => (true, 1), // speaker: force built-in speaker
            2 => (true, 0), // receiver: OverrideNone → VoiceChat's earpiece default
            _ => {          // auto: speaker only if on the built-in Receiver, no headset
                let route: *mut AnyObject = msg_send![session, currentRoute];
                if route.is_null() { return; }
                let outs: *mut AnyObject = msg_send![route, outputs];
                let cnt: usize = if outs.is_null() { 0 } else { msg_send![outs, count] };
                let (mut recv, mut ext) = (false, false);
                for i in 0..cnt {
                    let p: *mut AnyObject = msg_send![outs, objectAtIndex: i];
                    if p.is_null() { continue; }
                    let pt: Retained<NSString> = msg_send![p, portType];
                    let s = pt.to_string();
                    if s == "Receiver" { recv = true; } else if s != "Speaker" { ext = true; }
                }
                (recv && !ext, 1)
            }
        };
        if apply {
            let mut oerr: *mut AnyObject = std::ptr::null_mut();
            let _: objc2::runtime::Bool = msg_send![session, overrideOutputAudioPort: ov, error: &mut oerr];
        }
    }

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

// ---- helpers for the Rust-driven (locked) voice loop ----------------------
// The background voice loop in stt.rs speaks replies with the native synthesizer
// (reliable offline / while locked) and bridges the model call with a background
// task assertion. These thin wrappers give it access without going through the
// Tauri command layer.

/// Speak `text` with the native synthesizer (AVSpeech). No-op off macOS/iOS.
pub fn speak_native(#[allow(unused_variables)] text: &str, #[allow(unused_variables)] voice_id: Option<&str>, #[allow(unused_variables)] rate: f32) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::speak(text, voice_id, rate);
    }
}

/// Whether the native synthesizer is currently speaking.
pub fn is_native_speaking() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::is_speaking()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}

/// Take / release a background-execution assertion (bridges the no-audio think
/// gap so a locked phone doesn't suspend mid-turn).
pub fn keepalive_begin() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::keepalive_begin();
    }
}
pub fn keepalive_end() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::keepalive_end();
    }
}

/// Start / stop a continuous inaudible audio loop that keeps the app alive while
/// backgrounded / locked (fills the mic-engine gaps between utterances so iOS
/// doesn't suspend and cold-start the process). Call on the main thread. No-op
/// off macOS/iOS.
pub fn silence_keepalive_begin() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::silence_keepalive_begin();
    }
}
pub fn silence_keepalive_end() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::silence_keepalive_end();
    }
}

/// A tiny 16-bit mono WAV of one or more tones, each with a raised-cosine bell
/// envelope (soft attack + release, no clicks). Mirrors the JS `tones()` in
/// src/lib/earcon.ts so the native (Lock Mode) cues sound identical to the ones
/// the web layer plays when the app is open. `segs` is (freq_hz, ms).
fn earcon_wav(segs: &[(f32, u32)], vol: f32) -> Vec<u8> {
    const SR: u32 = 44100;
    let total: usize = segs.iter().map(|(_, ms)| (SR * ms / 1000) as usize).sum();
    let data_len = total * 2;
    let mut buf = Vec::with_capacity(44 + data_len);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes());
    buf.extend_from_slice(&1u16.to_le_bytes()); // PCM
    buf.extend_from_slice(&1u16.to_le_bytes()); // mono
    buf.extend_from_slice(&SR.to_le_bytes());
    buf.extend_from_slice(&(SR * 2).to_le_bytes());
    buf.extend_from_slice(&2u16.to_le_bytes());
    buf.extend_from_slice(&16u16.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&(data_len as u32).to_le_bytes());
    for (freq, ms) in segs {
        let len = (SR * ms / 1000) as usize;
        for i in 0..len {
            let env = (std::f32::consts::PI * (i as f32 / len as f32)).sin(); // 0 → 1 → 0
            let s = ((2.0 * std::f32::consts::PI * freq * (i as f32 / SR as f32)).sin()
                * env * vol * 32767.0) as i16;
            buf.extend_from_slice(&s.to_le_bytes());
        }
    }
    buf
}

/// Play a feedback earcon natively (used by the Lock Mode voice loop, where the
/// web layer's earcons can't fire because JS is suspended). `kind` matches the JS
/// earcons: "start"/"listening" (ready for you), "thinking" (processing), and
/// "interrupt". No-op off macOS/iOS.
pub fn play_earcon_kind(#[allow(unused_variables)] kind: &str) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let (segs, vol): (&[(f32, u32)], f32) = match kind {
            "start" | "listening" => (&[(523.0, 70), (659.0, 70), (784.0, 95)], 0.13),
            "interrupt" => (&[(784.0, 45), (1046.0, 65)], 0.15),
            _ => (&[(396.0, 130)], 0.12), // thinking
        };
        let bytes = earcon_wav(segs, vol);
        let _ = imp::play_earcon(&bytes);
    }
}

/// Play a base64 audio clip (cloud TTS mp3) through the NATIVE audio session so
/// it coexists with the recording mic (WebView `<audio>` interrupts recording).
/// Returns the clip's playback duration in seconds. No-op off macOS/iOS.
#[tauri::command]
pub async fn tts_play_audio(
    #[allow(unused_variables)] app: tauri::AppHandle,
    audio_base64: String,
    rate: f32,
) -> Result<f64, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(audio_base64.as_bytes())
                .map_err(|e| format!("decode audio: {e}"))?;
            imp::play_audio(&bytes, rate)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = (audio_base64, rate);
        Err("native audio playback is macOS/iOS only".into())
    }
}

/// Stop the native audio clip started by `tts_play_audio`.
#[tauri::command]
pub fn tts_stop_audio() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::stop_audio();
    }
}

/// Play a short UI earcon (base64 WAV) on a dedicated player, so it layers over
/// the reply/mic without stopping them. Used for the thinking / interrupt cues.
#[tauri::command]
pub async fn tts_play_earcon(audio_base64: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(audio_base64.as_bytes())
                .map_err(|e| format!("decode earcon: {e}"))?;
            imp::play_earcon(&bytes)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = audio_base64;
        Ok(())
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

/// Synthesize cloud TTS to raw mp3 bytes, synchronously. Used by the locked /
/// backgrounded voice loop (which plays via `play_audio_bytes`) so a locked phone
/// keeps the SAME cloud voice as when awake. Mirrors the `tts_openai` /
/// `tts_eleven` / `tts_unreal` commands but returns bytes instead of base64.
pub fn synth_cloud_bytes(
    engine: &str,
    voice: &str,
    model: &str,
    api_key: &str,
    text: &str,
) -> Result<Vec<u8>, String> {
    let req = match engine {
        "openai" => http_agent()
            .post("https://api.openai.com/v1/audio/speech")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(serde_json::json!({
                "model": model, "voice": voice, "input": text,
                "response_format": "mp3", "speed": 1.0,
            })),
        "eleven" => http_agent()
            .post(&format!("https://api.elevenlabs.io/v1/text-to-speech/{voice}"))
            .set("xi-api-key", api_key)
            .set("Accept", "audio/mpeg")
            .send_json(serde_json::json!({ "text": text, "model_id": model })),
        "unreal" => http_agent()
            .post("https://api.v8.unrealspeech.com/stream")
            .set("Authorization", &format!("Bearer {api_key}"))
            .send_json(serde_json::json!({
                "Text": text, "VoiceId": voice, "Bitrate": "192k",
                "Speed": 0, "Pitch": 1.0, "Codec": "libmp3lame",
            })),
        other => return Err(format!("unknown TTS engine: {other}")),
    };
    match req {
        Ok(r) => {
            let mut buf = Vec::new();
            r.into_reader()
                .read_to_end(&mut buf)
                .map_err(|e| format!("read audio: {e}"))?;
            Ok(buf)
        }
        Err(ureq::Error::Status(code, r)) => {
            Err(format!("cloud TTS {code}: {}", r.into_string().unwrap_or_default()))
        }
        Err(e) => Err(format!("cloud TTS: {e}")),
    }
}

/// Play mp3 bytes on the shared native session; returns playback seconds (0 off
/// macOS/iOS). Module-level twin of the `tts_play_audio` command for Rust callers
/// (the locked voice loop).
pub fn play_audio_bytes(#[allow(unused_variables)] bytes: &[u8], #[allow(unused_variables)] rate: f32) -> Result<f64, String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        imp::play_audio(bytes, rate)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Ok(0.0)
    }
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
