// Subtle audio feedback (earcons) for the voice agent: a soft cue when it starts
// thinking, and a quick blip when your interruption is detected. Tones are
// synthesized once as tiny WAVs and played through a DEDICATED native player
// (tts_play_earcon) so they layer over the reply/mic without disturbing either.

import { invoke } from "@tauri-apps/api/core";

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

const SR = 44100;

/** 16-bit mono WAV (base64) from float samples in [-1, 1]. */
function encodeWav(samples: Float32Array): string {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Concatenate tone segments, each with a raised-cosine bell envelope (soft
 *  attack + release, no clicks). `vol` keeps it subtle. */
function tones(segs: { freq: number; ms: number }[], vol: number): Float32Array {
  const total = segs.reduce((a, s) => a + Math.round((SR * s.ms) / 1000), 0);
  const out = new Float32Array(total);
  let idx = 0;
  for (const seg of segs) {
    const len = Math.round((SR * seg.ms) / 1000);
    for (let i = 0; i < len; i++) {
      const env = Math.sin(Math.PI * (i / len)); // 0 → 1 → 0
      out[idx++] = Math.sin(2 * Math.PI * seg.freq * (i / SR)) * env * vol;
    }
  }
  return out;
}

// Precomputed once, each clearly distinct:
//  - start:     a warm rising three-note arpeggio — "I'm listening" (tap Talk).
//  - thinking:  a single soft low tone — "got it, working" (after you speak).
//  - interrupt: a quick rising two-note tick — "cutting in".
const START = encodeWav(tones([{ freq: 523, ms: 70 }, { freq: 659, ms: 70 }, { freq: 784, ms: 95 }], 0.13));
const THINKING = encodeWav(tones([{ freq: 396, ms: 130 }], 0.12));
const INTERRUPT = encodeWav(tones([{ freq: 784, ms: 45 }, { freq: 1046, ms: 65 }], 0.15));

export function playEarcon(kind: "start" | "thinking" | "interrupt"): void {
  if (!isTauri()) return;
  const b64 = kind === "start" ? START : kind === "thinking" ? THINKING : INTERRUPT;
  void invoke("tts_play_earcon", { audioBase64: b64 }).catch(() => {});
}
