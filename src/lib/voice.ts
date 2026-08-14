// Voice input for the hands-free chat. Capture happens **natively** in Rust
// (AVAudioRecorder) — WKWebView doesn't expose getUserMedia (tauri#10898), so
// there is no browser mic path on macOS or iOS. This module is just the bridge:
// it asks Rust to listen for one utterance and returns the transcript, and it
// forwards the live input level for the meter.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getOpenaiKey, ttsSupported, applyAudioOutput } from "./tts";

/** DEBUG: append a line to the shared voice-trace log (same file the Rust loop
 *  writes) so UI decisions interleave with the loop's events in one timeline. */
export const voiceTrace = (line: string): void => {
  void invoke("voice_trace", { line }).catch(() => {});
};

// STT engine selection (Whisper by default; native Apple on request).
const STT_ENGINE_KEY = "order.stt.engine";
export type SttEngine = "whisper" | "native";
// Default to on-device Apple: it streams words live as you speak (Whisper only
// returns text after you pause) and stays local. Whisper stays selectable.
export function getSttEngine(): SttEngine {
  try { return (localStorage.getItem(STT_ENGINE_KEY) as SttEngine) || "native"; } catch { return "native"; }
}
export function setSttEngine(e: SttEngine): void {
  try { localStorage.setItem(STT_ENGINE_KEY, e); } catch { /* noop */ }
}

/** Native voice capture is available wherever native audio is (i.e. in the
 *  Tauri app on macOS/iOS). There's no webview fallback. */
export function micSupported(): boolean {
  return ttsSupported();
}

/** Subscribe to the live input level (0..1) while listening, for a meter. */
export async function onLevel(handler: (level: number) => void): Promise<UnlistenFn> {
  return listen<number>("stt-level", (e) => handler(e.payload));
}

/** Subscribe to capture state changes ("heard" = speech detected). */
export async function onSttState(handler: (state: string) => void): Promise<UnlistenFn> {
  return listen<string>("stt-state", (e) => handler(e.payload));
}

/** Subscribe to live partial transcripts (on-device engine) as you speak. */
export async function onPartial(handler: (text: string) => void): Promise<UnlistenFn> {
  return listen<string>("stt-partial", (e) => handler(e.payload));
}

/**
 * Record one hands-free utterance natively and return its transcript. Resolves
 * with "" if the user cancelled (see `cancelListen`) or never spoke — the caller
 * re-invokes for the next turn. The mic is only open during this call, so the
 * agent's own TTS can never bleed into a recording.
 */
export function listenOnce(): Promise<string> {
  return invoke<string>("stt_listen", {
    engine: getSttEngine(),
    openaiKey: getOpenaiKey(),
  });
}

/** Stop an in-progress `listenOnce` early; it resolves with "". */
export function cancelListen(): Promise<void> {
  return invoke("stt_cancel");
}

/**
 * Start the continuous hands-free listen loop (native). The mic stays open
 * across turns and during TTS playback; each finalized utterance arrives via the
 * `stt-utterance` event (subscribe with `onUtterance`). This is what enables
 * barge-in — the frontend cancels the agent's speech the moment you start
 * talking. Idempotent; pair with `stopListenLoop`.
 */
export function startListenLoop(): Promise<void> {
  applyAudioOutput(); // push the saved output routing before the session activates
  return invoke("stt_start_loop", {
    engine: getSttEngine(),
    openaiKey: getOpenaiKey(),
  });
}

/** Stop the continuous listen loop. */
export function stopListenLoop(): Promise<void> {
  return invoke("stt_stop_loop");
}

/** Subscribe to finalized utterances from the continuous listen loop. The native
 *  side now accumulates across the recognizer's ~60s segment cuts and emits only
 *  COMPLETE utterances (on a natural pause), so the caller just sends them — no
 *  client-side holding/timers. Partial text streams separately via `onPartial`. */
export async function onUtterance(handler: (text: string) => void): Promise<UnlistenFn> {
  return listen<{ text: string }>("stt-utterance", (e) => handler(e.payload.text));
}

// ---- locked-phone (backgrounded) voice ------------------------------------
// When the app is backgrounded (phone locked) the WebView's JS is suspended, so
// it can't drive the voice loop. These let Rust take over: JS reports the
// foreground state, and arms a conversation (which chat, which key) that Rust
// runs + speaks natively while backgrounded. The foreground path is unchanged.

/** Tell the native side whether the app/WebView is foregrounded. */
export function setForeground(foreground: boolean): void {
  if (!micSupported()) return;
  void invoke("set_foreground", { foreground }).catch(() => {});
}

/** Arm the Rust-driven conversation used while backgrounded. `chatPath` is the
 *  vault-relative chat file; `voiceId` is an optional NATIVE voice id (fallback);
 *  `cloud` is the cloud-TTS config so a LOCKED phone speaks in the same cloud
 *  voice as when awake (falls back to the native voice if it's null or fails). */
export function voiceConvoStart(
  chatPath: string,
  apiKey: string,
  voiceId: string | null,
  rate: number,
  cloud?: { engine: string; voice: string; model: string; key: string } | null,
): void {
  if (!micSupported()) return;
  void invoke("voice_convo_start", {
    chatPath,
    apiKey,
    voiceId,
    rate,
    cloudEngine: cloud?.engine ?? null,
    cloudVoice: cloud?.voice ?? null,
    cloudModel: cloud?.model ?? null,
    cloudKey: cloud?.key ?? null,
  }).catch(() => {});
}

export function voiceConvoStop(): void {
  if (!micSupported()) return;
  void invoke("voice_convo_stop").catch(() => {});
}

/** The microphone that will be used (e.g. "AirPods Pro"), or null if unknown. */
export function inputName(): Promise<string | null> {
  return invoke<string | null>("stt_input_name").catch(() => null);
}

/** True when TTS is coming out the phone's built-in speaker (no hardware echo
 *  cancellation → the mic hears the agent). The chat goes half-duplex there. */
export function outputIsSpeaker(): Promise<boolean> {
  return invoke<boolean>("stt_output_is_speaker").catch(() => false);
}
