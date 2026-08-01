// Voice input for the hands-free chat. Capture happens **natively** in Rust
// (AVAudioRecorder) — WKWebView doesn't expose getUserMedia (tauri#10898), so
// there is no browser mic path on macOS or iOS. This module is just the bridge:
// it asks Rust to listen for one utterance and returns the transcript, and it
// forwards the live input level for the meter.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getOpenaiKey, ttsSupported } from "./tts";

// STT engine selection (Whisper by default; native Apple on request).
const STT_ENGINE_KEY = "order.stt.engine";
export type SttEngine = "whisper" | "native";
export function getSttEngine(): SttEngine {
  try { return (localStorage.getItem(STT_ENGINE_KEY) as SttEngine) || "whisper"; } catch { return "whisper"; }
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
