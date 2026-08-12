// Text-to-speech for cards. Three engines behind one interface:
//  - native: AVSpeechSynthesizer via Rust (system voices; see src-tauri/tts.rs)
//  - openai / eleven: cloud voices — Rust makes the HTTP call (no browser CORS,
//    key stays out of the webview) and returns mp3 we play via <audio>.
// One card speaks at a time. A voice's engine is encoded in its uri prefix.

import { invoke } from "@tauri-apps/api/core";
import { vaultFs } from "./vault-fs";
import { assetUrl } from "./attachments";
import { recordTts } from "./usage";

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export function ttsSupported(): boolean { return isTauri(); }

// Background-execution assertion for a voice turn (#27). Keeps the app running
// through the "thinking" gap (mic off, nothing playing) so a locked/backgrounded
// phone doesn't suspend mid-turn and drop the reply. begin/end are idempotent in
// Rust (only one assertion is ever held); always pair them. No-op off iOS.
export function voiceKeepaliveBegin(): void {
  if (!isTauri()) return;
  void invoke("voice_keepalive_begin").catch(() => {});
}
export function voiceKeepaliveEnd(): void {
  if (!isTauri()) return;
  void invoke("voice_keepalive_end").catch(() => {});
}

export type TtsEngine = "native" | "openai" | "eleven" | "unreal";

export interface TtsVoice {
  uri: string;   // "native:<id>" | "openai:<voice>" | "eleven:<id>" | "unreal:<id>"
  name: string;
  lang: string;
  engine: TtsEngine;
  enhanced: boolean;
  quality: number;
}

interface NativeVoice { id: string; name: string; lang: string; quality: number }
interface CloudVoice { id: string; name: string }

function engineOf(uri: string | undefined): TtsEngine {
  if (uri?.startsWith("openai:")) return "openai";
  if (uri?.startsWith("eleven:")) return "eleven";
  if (uri?.startsWith("unreal:")) return "unreal";
  return "native";
}

/** Which engine a voice URI uses. Exposed so callers (e.g. the voice chat's
 *  streaming playback) can tell whether a voice is local/native — native TTS is
 *  free + instant, so it's safe to stream sentence-by-sentence. */
export function voiceEngine(uri: string | undefined): TtsEngine { return engineOf(uri); }
const voiceOf = (uri: string) => uri.slice(uri.indexOf(":") + 1);

// ---- keys -----------------------------------------------------------------

const OPENAI_KEY = "order.tts.openai_key";
const ELEVEN_KEY = "order.tts.eleven_key";
const UNREAL_KEY = "order.tts.unreal_key";
const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* non-fatal */ } };
export const TTS_KEYS_EVENT = "order:tts-keys-changed";
function keysChanged() { voicesCache = null; try { window.dispatchEvent(new Event(TTS_KEYS_EVENT)); } catch { /* */ } }
export function getOpenaiKey(): string { return lsGet(OPENAI_KEY); }
export function setOpenaiKey(v: string): void { lsSet(OPENAI_KEY, v.trim()); keysChanged(); }
export function getElevenKey(): string { return lsGet(ELEVEN_KEY); }
export function setElevenKey(v: string): void { lsSet(ELEVEN_KEY, v.trim()); keysChanged(); }
export function getUnrealKey(): string { return lsGet(UNREAL_KEY); }
export function setUnrealKey(v: string): void { lsSet(UNREAL_KEY, v.trim()); keysChanged(); }

// Which ElevenLabs voices appear in the card picker. Empty = show all.
const ELEVEN_SEL = "order.tts.eleven_selected";
export function getElevenSelected(): string[] { try { return JSON.parse(lsGet(ELEVEN_SEL) || "[]"); } catch { return []; } }
export function setElevenSelected(ids: string[]): void { lsSet(ELEVEN_SEL, JSON.stringify(ids)); keysChanged(); }

/** All of the user's ElevenLabs voices (for the Settings picker). */
export async function listElevenVoices(): Promise<CloudVoice[]> {
  if (!isTauri() || !getElevenKey()) return [];
  try { return await invoke<CloudVoice[]>("tts_eleven_voices", { apiKey: getElevenKey() }); } catch { return []; }
}

// OpenAI's fixed voice set (tts-1-hd). Names are the API ids.
export const OPENAI_VOICES = ["alloy", "echo", "fable", "nova", "onyx", "shimmer"];
const OPENAI_SEL = "order.tts.openai_selected";
export function getOpenaiSelected(): string[] { try { return JSON.parse(lsGet(OPENAI_SEL) || "[]"); } catch { return []; } }
export function setOpenaiSelected(ids: string[]): void { lsSet(OPENAI_SEL, JSON.stringify(ids)); keysChanged(); }
const OPENAI_MODEL = "tts-1-hd";
const ELEVEN_MODEL = "eleven_multilingual_v2";

// Unreal Speech's English voice set (VoiceId values). Sierra is their default.
export const UNREAL_VOICES = [
  "Sierra", "Melody", "Autumn", "Emily", "Luna", "Lauren", "Willow", "Hannah", "Ivy",
  "Daniel", "Noah", "Jasper", "Ethan", "Caleb", "Ronan",
  "Eleanor", "Amelia", "Charlotte", "Chloe", "Arthur", "Oliver", "Edward", "Benjamin",
];
const UNREAL_SEL = "order.tts.unreal_selected";
export function getUnrealSelected(): string[] { try { return JSON.parse(lsGet(UNREAL_SEL) || "[]"); } catch { return []; } }
export function setUnrealSelected(ids: string[]): void { lsSet(UNREAL_SEL, JSON.stringify(ids)); keysChanged(); }

// ---- voices ---------------------------------------------------------------

let voicesCache: TtsVoice[] | null = null;

export async function getVoices(): Promise<TtsVoice[]> {
  if (voicesCache) return voicesCache;
  if (!isTauri()) return [];

  // Native system voices — a clean handful of real English voices.
  let nativeOut: TtsVoice[] = [];
  try {
    const raw = await invoke<NativeVoice[]>("tts_voices");
    const english = raw.filter((v) => /^en(-|_|$)/i.test(v.lang));
    const real = english.filter((v) => /^com\.apple\.voice\./i.test(v.id));
    const pool = real.length ? real : english;
    const seen = new Set<string>();
    nativeOut = pool
      .sort((a, b) => (b.quality - a.quality) || a.name.localeCompare(b.name))
      .filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)))
      .map((v): TtsVoice => ({ uri: `native:${v.id}`, name: v.name, lang: v.lang, engine: "native", enhanced: v.quality >= 2, quality: v.quality }));
  } catch { nativeOut = []; }

  // Cloud voices (opt-in via API key) — listed first since they're premium.
  const cloud: TtsVoice[] = [];
  if (getOpenaiKey()) {
    const sel = getOpenaiSelected();
    const chosen = sel.length ? OPENAI_VOICES.filter((v) => sel.includes(v)) : OPENAI_VOICES;
    for (const v of chosen) {
      cloud.push({ uri: `openai:${v}`, name: `${v[0].toUpperCase()}${v.slice(1)} (OpenAI)`, lang: "en-US", engine: "openai", enhanced: true, quality: 4 });
    }
  }
  if (getElevenKey()) {
    try {
      const evs = await invoke<CloudVoice[]>("tts_eleven_voices", { apiKey: getElevenKey() });
      const sel = getElevenSelected();
      const chosen = sel.length ? evs.filter((v) => sel.includes(v.id)) : evs;
      for (const v of chosen) cloud.push({ uri: `eleven:${v.id}`, name: `${v.name} (ElevenLabs)`, lang: "en-US", engine: "eleven", enhanced: true, quality: 4 });
    } catch (e) { console.warn("[tts] ElevenLabs voices fetch failed:", e); }
  }
  if (getUnrealKey()) {
    const sel = getUnrealSelected();
    const chosen = sel.length ? UNREAL_VOICES.filter((v) => sel.includes(v)) : UNREAL_VOICES;
    for (const v of chosen) {
      cloud.push({ uri: `unreal:${v}`, name: `${v} (Unreal)`, lang: "en-US", engine: "unreal", enhanced: true, quality: 4 });
    }
  }

  voicesCache = [...cloud, ...nativeOut];
  return voicesCache;
}

export function hasEnhancedVoice(voices: TtsVoice[]): boolean {
  return voices.some((v) => v.engine === "native" && v.enhanced);
}

/** Default: highest-quality NATIVE voice (never auto-pick a paid cloud voice),
 *  tie-broken toward the UI locale. */
export function pickDefaultVoice(voices: TtsVoice[]): string {
  const nat = voices.filter((v) => v.engine === "native");
  const list = nat.length ? nat : voices;
  if (!list.length) return "";
  const locale = ((typeof navigator !== "undefined" && navigator.language) || "en-US").toLowerCase();
  const base = locale.split("-")[0];
  const maxQ = Math.max(...list.map((v) => v.quality));
  const top = list.filter((v) => v.quality === maxQ);
  const pick = top.find((v) => v.lang.toLowerCase() === locale) || top.find((v) => v.lang.toLowerCase().startsWith(base));
  return (pick ?? top[0]).uri;
}

// ---- markdown → speakable text -------------------------------------------

export function speakableFromMarkdown(md: string): string {
  let s = md;
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/~~~[\s\S]*?~~~/g, " ");
  s = s.replace(/!\[\[[^\]]*\]\]/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a: string, b?: string) => (b || a));
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/^#{1,6}\s+(.*)$/gm, "$1.");
  s = s.replace(/^\s{0,3}>\s?/gm, "");
  s = s.replace(/^\s*([-*+]|\d+[.)])\s+/gm, "");
  s = s.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, " ");
  s = s.replace(/\|/g, " ");
  s = s.replace(/(\*\*|__|~~|\*|_)/g, "");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/\n{2,}/g, ".\n").replace(/[ \t]+/g, " ").trim();
  return s;
}

/** Split into chunks no longer than `max` chars on sentence / newline bounds. */
function chunkText(text: string, max: number): string[] {
  const pieces = text.split(/(?<=[.!?])\s+|\n+/);
  const out: string[] = [];
  let buf = "";
  for (const p of pieces) {
    const seg = p.trim();
    if (!seg) continue;
    if (buf && buf.length + seg.length > max) { out.push(buf); buf = seg; }
    else buf = buf ? `${buf} ${seg}` : seg;
  }
  if (buf) out.push(buf);
  return out;
}

// ---- playback (one at a time) --------------------------------------------

let current: { cancel: () => void } | null = null;

export function stopSpeaking(): void {
  const c = current;
  current = null;
  c?.cancel();
}

export interface SpeakHandle {
  stop: () => void;
  /** Pause without ending (cloud playback only). Absent → not pausable (native). */
  pause?: () => void;
  /** Resume after pause (cloud playback only). */
  resume?: () => void;
  /** Change playback speed live, no restart (cloud playback only). */
  setRate?: (r: number) => void;
  /** The underlying <audio> element for a scrub/time UI; null for native. */
  audio?: HTMLAudioElement | null;
  /** True only while a COMPLETE stored recording is playing (cache hit) — i.e. the
   *  whole file is loaded and seekable. False for chunk-by-chunk fresh synth. */
  seekable?: () => boolean;
}

export function speak(
  text: string,
  opts: { voiceURI?: string; voiceName?: string; notePath?: string; rate?: number; onStart?: () => void; onEnd?: () => void; onError?: (msg: string) => void },
): SpeakHandle {
  if (!isTauri() || !text) { opts.onEnd?.(); return { stop: () => {} }; }
  stopSpeaking();
  return engineOf(opts.voiceURI) === "native" ? speakNative(text, opts) : speakCloud(text, opts);
}

function speakNative(text: string, opts: Parameters<typeof speak>[1]): SpeakHandle {
  let done = false;
  let poll: ReturnType<typeof setInterval> | null = null;
  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  const end = () => { if (done) return; done = true; stopPoll(); if (current === ctrl) current = null; opts.onEnd?.(); };
  const ctrl = { cancel: () => { if (done) return; done = true; stopPoll(); void invoke("tts_stop").catch(() => {}); opts.onEnd?.(); } };
  current = ctrl;
  const voiceId = opts.voiceURI ? voiceOf(opts.voiceURI) : "";
  void invoke("tts_speak", { text, voiceId: voiceId || null, rate: opts.rate ?? 1 })
    .then(() => {
      if (done) return;
      opts.onStart?.();
      let started = false, grace = 0;
      poll = setInterval(() => {
        void invoke<boolean>("tts_is_speaking").then((sp) => {
          if (done) return;
          if (sp) { started = true; return; }
          if (started || grace++ > 6) end();
        }).catch(() => end());
      }, 250);
    })
    .catch(() => end());
  return { stop: ctrl.cancel };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Fast 53-bit content hash (cyrb53) — enough to tell if a note's speech text
// changed. No crypto/secure-context dependency.
function contentHash(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Vault paths for a note+voice's cached recording: a visible `<base> [Voice].mp3`
 *  sidecar next to the note + a hidden `.…​.hash` companion for change detection. */
function cachePaths(noteRel: string, voiceName: string): { mp3: string; hash: string } {
  const slash = noteRel.lastIndexOf("/");
  const dir = slash >= 0 ? noteRel.slice(0, slash) : "";
  const file = slash >= 0 ? noteRel.slice(slash + 1) : noteRel;
  const base = file.replace(/\.[^.]+$/, "");
  const label = (voiceName.replace(/\s*\([^)]*\)\s*$/, "").split(/[,–—-]/)[0] || voiceName)
    .replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "voice";
  const p = dir ? `${dir}/` : "";
  return { mp3: `${p}${base} [${label}].mp3`, hash: `${p}.${base} [${label}].mp3.hash` };
}

/** One cloud-TTS call → base64 mp3, dispatched to the right provider. */
function synthCloud(engine: TtsEngine, voice: string, speed: number, text: string): Promise<string> {
  if (engine === "openai") return invoke<string>("tts_openai", { apiKey: getOpenaiKey(), voice, model: OPENAI_MODEL, speed, text });
  if (engine === "unreal") return invoke<string>("tts_unreal", { apiKey: getUnrealKey(), voiceId: voice, text });
  return invoke<string>("tts_eleven", { apiKey: getElevenKey(), voiceId: voice, modelId: ELEVEN_MODEL, text });
}

function speakCloud(text: string, opts: Parameters<typeof speak>[1]): SpeakHandle {
  const engine = engineOf(opts.voiceURI);
  const voice = opts.voiceURI ? voiceOf(opts.voiceURI) : "";
  const rate = opts.rate ?? 1;
  // Always synth at natural speed and time-stretch on playback, so ONE cached
  // recording works at any speed (speed isn't baked into the file).
  const apiSpeed = 1;
  let playbackRate = rate;
  // True only once a COMPLETE cached recording is playing (one seekable file);
  // stays false for chunk-by-chunk fresh synth, which can't be scrubbed.
  let singleFile = false;
  // Unreal Speech's /stream endpoint caps at 1000 chars per call; others are fine larger.
  const chunks = chunkText(text, engine === "unreal" ? 900 : 1800);
  const audio = new Audio();
  audio.playbackRate = playbackRate;

  // Vault cache: one `<note> [Voice].mp3` per voice next to the note, keyed by a
  // content hash so an edited note regenerates + overwrites. Reuse = no API cost.
  const cache = opts.notePath && opts.voiceName
    ? { ...cachePaths(opts.notePath, opts.voiceName), key: contentHash(`${engine}|${voice}|${text}`) }
    : null;
  const parts: Uint8Array[] = []; // accumulated mp3 bytes to save after a fresh synth

  let done = false;
  let i = 0;
  const clearMedia = () => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    ms.playbackState = "none";
    for (const a of ["play", "pause", "stop", "seekto", "seekbackward", "seekforward"] as const) {
      try { ms.setActionHandler(a, null); } catch { /* unsupported action */ }
    }
    try { ms.metadata = null; } catch { /* */ }
  };
  const cleanup = () => { try { audio.pause(); } catch { /* */ } clearMedia(); if (audio.src) { if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src); audio.removeAttribute("src"); } };
  const end = () => { if (done) return; done = true; cleanup(); if (current === ctrl) current = null; opts.onEnd?.(); };
  const ctrl = { cancel: end };
  current = ctrl;

  // System media controls (lock screen / Control Center / macOS Now-Playing +
  // media keys) for the <audio> element, incl. scrubbing. Web MediaSession is
  // honored by WKWebView on macOS + iOS.
  const wireMedia = () => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    try {
      const title = (text.split(/[.\n]/)[0] || "Note").slice(0, 80).trim();
      ms.metadata = new MediaMetadata({ title, artist: "Order" });
    } catch { /* MediaMetadata unsupported */ }
    const set = (a: MediaSessionAction, h: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, h); } catch { /* */ } };
    set("play", () => { void audio.play(); ms.playbackState = "playing"; });
    set("pause", () => { audio.pause(); ms.playbackState = "paused"; });
    set("stop", () => end());
    set("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10)); });
    set("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10)); });
    set("seekto", (d) => { if (typeof d.seekTime === "number") audio.currentTime = d.seekTime; });
    ms.playbackState = "playing";
  };
  audio.addEventListener("timeupdate", () => {
    const ms = navigator.mediaSession;
    if (ms && audio.duration && Number.isFinite(audio.duration)) {
      try { ms.setPositionState({ duration: audio.duration, position: audio.currentTime, playbackRate: audio.playbackRate }); } catch { /* */ }
    }
  });

  const synth = (chunk: string): Promise<string> => {
    // Bill characters here, at the real API call — cache hits never reach this.
    recordTts(engine, chunk.length);
    return synthCloud(engine, voice, apiSpeed, chunk);
  };

  const playSrc = async (src: string, revoke: boolean) => {
    if (audio.src && audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
    audio.src = src;
    audio.playbackRate = playbackRate;
    await audio.play();
  };

  // Save the freshly-synthesized recording (concatenated mp3) + its hash.
  const persist = () => {
    if (!cache || parts.length === 0) return;
    const total = parts.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0; for (const p of parts) { merged.set(p, off); off += p.length; }
    void vaultFs.writeBinary(cache.mp3, Array.from(merged))
      .then(() => vaultFs.writeText(cache.hash, cache.key))
      .catch((e) => console.warn("[tts] cache save failed:", e));
  };

  const playFromApi = async () => {
    if (done) return;
    if (i >= chunks.length) { persist(); end(); return; }
    let b64: string;
    try { b64 = await synth(chunks[i]); }
    catch (e) { console.error("[tts] cloud synth failed:", e); opts.onError?.(String(e)); end(); return; }
    if (done) return;
    try {
      const bytes = b64ToBytes(b64);
      if (cache) parts.push(bytes);
      audio.onended = () => { i++; void playFromApi(); };
      audio.onerror = () => { console.error("[tts] audio element error", audio.error); i++; void playFromApi(); };
      await playSrc(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/mpeg" })), true);
      if (i === 0) { opts.onStart?.(); wireMedia(); }
    } catch (e) { console.error("[tts] audio.play() blocked/failed:", e); opts.onError?.(String(e)); end(); }
  };

  void (async () => {
    // Cache hit: the note is unchanged for this voice → play the saved file free.
    if (cache) {
      try {
        const saved = await vaultFs.readText(cache.hash).catch(() => "");
        if (saved === cache.key && await vaultFs.exists(cache.mp3)) {
          audio.onended = () => end();
          audio.onerror = () => { console.error("[tts] cached audio error", audio.error); end(); };
          singleFile = true; // the whole recording is one seekable file
          await playSrc(assetUrl(cache.mp3), false);
          opts.onStart?.(); wireMedia();
          return;
        }
      } catch { /* fall through to fresh synth */ }
    }
    void playFromApi();
  })();

  return {
    stop: end,
    pause: () => { try { audio.pause(); } catch { /* */ } },
    resume: () => { void audio.play().catch(() => {}); },
    setRate: (r) => { playbackRate = r; audio.playbackRate = r; },
    audio,
    seekable: () => singleFile && Number.isFinite(audio.duration) && audio.duration > 0,
  };
}

// ---- streaming speaker: speak a reply as it is generated ------------------
// Fed text incrementally with push() and told when the reply is complete with
// finish(). It speaks in order with a short time-to-first-audio:
//   - native voices: sentence by sentence, locally (free, instant).
//   - cloud voices (OpenAI AND ElevenLabs, handled identically): small segments,
//     synthesizing the NEXT segment while the current one plays. Only ONE synth
//     request is ever in flight, so there's no concurrency limit to trip
//     (ElevenLabs) and no wasted parallelism (OpenAI), and the first audio
//     arrives after just one short segment instead of the whole reply.
export interface StreamSpeaker {
  push(text: string): void;
  finish(): void;
  cancel(): void;
}

/** Group complete sentences into segments of ~`target` chars. Returns ready
 *  segments plus the leftover to carry forward (an incomplete sentence, or —
 *  unless flushing — a sub-target remainder). */
function segmentText(buf: string, target: number, flushAll: boolean): { segments: string[]; rest: string } {
  const re = /[^.!?…\n]*[.!?…\n]+["'”’)\]]*\s*/g;
  const segments: string[] = [];
  let cur = "";
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    cur += m[0];
    consumed = re.lastIndex;
    if (cur.trim().length >= target) { segments.push(cur.trim()); cur = ""; }
  }
  let rest = cur + buf.slice(consumed);
  if (flushAll) { const tail = rest.trim(); if (tail) segments.push(tail); rest = ""; }
  return { segments: segments.map((s) => s.trim()).filter(Boolean), rest };
}

/** Time-to-first-audio helper (#26). For the VERY FIRST spoken segment we don't
 *  want to wait for a whole sentence — that's the biggest chunk of perceived
 *  latency on cloud voices. Break at the earliest natural boundary once there's
 *  at least `minChars` of text: a sentence terminator anywhere, else a clause
 *  boundary (comma / semicolon / colon / dash) past the floor, else a hard word
 *  break once we've buffered ~2× the floor. Returns null when there isn't yet
 *  enough to speak, so the caller keeps buffering. Exported for tests. */
export function firstAudioSegment(buf: string, minChars: number): { seg: string; rest: string } | null {
  // A sentence terminator anywhere ends the first segment immediately.
  const sent = /[.!?…\n]["'”’)\]]*\s?/.exec(buf);
  if (sent) {
    const end = sent.index + sent[0].length;
    const seg = buf.slice(0, end).trim();
    if (seg) return { seg, rest: buf.slice(end) };
  }
  if (buf.trim().length < minChars) return null;
  // Earliest clause boundary at/after the floor.
  const clause = /[,;:—–-]\s/g;
  let m: RegExpExecArray | null;
  while ((m = clause.exec(buf)) !== null) {
    if (m.index + 1 >= minChars) {
      const end = m.index + m[0].length;
      const seg = buf.slice(0, end).trim();
      if (seg) return { seg, rest: buf.slice(end) };
    }
  }
  // No punctuation but a lot of text already — hard-break on a word boundary so
  // a long clause-free opener still starts promptly.
  if (buf.trim().length >= minChars * 2) {
    const ws = buf.lastIndexOf(" ");
    if (ws > minChars) return { seg: buf.slice(0, ws).trim(), rest: buf.slice(ws) };
  }
  return null;
}

export function createStreamSpeaker(opts: {
  voiceURI?: string; voiceName?: string; rate?: number;
  onStart?: () => void; onEnd?: () => void; onError?: (m: string) => void;
}): StreamSpeaker {
  if (!isTauri()) { opts.onEnd?.(); return { push() {}, finish() {}, cancel() {} }; }
  return engineOf(opts.voiceURI) === "native" ? nativeStream(opts) : cloudStream(opts, engineOf(opts.voiceURI));
}

function nativeStream(opts: Parameters<typeof createStreamSpeaker>[0]): StreamSpeaker {
  let buffer = ""; let finished = false; let cancelled = false; let playing = false; let started = false;
  const queue: string[] = [];
  const done = () => { if (cancelled) return; cancelled = true; opts.onEnd?.(); };
  const playNext = () => {
    if (playing || cancelled) return;
    const s = queue.shift();
    if (s === undefined) { if (finished) done(); return; }
    playing = true;
    if (!started) { started = true; opts.onStart?.(); }
    speak(speakableFromMarkdown(s) || s, {
      voiceURI: opts.voiceURI, rate: opts.rate,
      onEnd: () => { playing = false; playNext(); },
      onError: () => { playing = false; playNext(); },
    });
  };
  const drain = (flushAll: boolean) => {
    const { segments, rest } = segmentText(buffer, 1, flushAll);
    buffer = rest;
    if (segments.length) { queue.push(...segments); playNext(); }
    else if (flushAll) playNext();
  };
  return {
    push(t) { if (cancelled) return; buffer += t; drain(false); },
    finish() { if (cancelled) return; finished = true; drain(true); },
    cancel() { cancelled = true; stopSpeaking(); },
  };
}

function cloudStream(opts: Parameters<typeof createStreamSpeaker>[0], engine: TtsEngine): StreamSpeaker {
  const voice = opts.voiceURI ? voiceOf(opts.voiceURI) : "";
  const playbackRate = opts.rate ?? 1;
  let buffer = ""; let finished = false; let cancelled = false;
  let synthing = false; let playing = false; let started = false;
  let playTimer: ReturnType<typeof setTimeout> | null = null;
  const segQueue: string[] = [];
  const readyQueue: string[] = [];   // base64 mp3 clips, ready to play

  const cleanup = () => {
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    void invoke("tts_stop_audio").catch(() => {});
    readyQueue.splice(0);
  };
  const done = () => { if (cancelled) return; cancelled = true; cleanup(); if (current === ctrl) current = null; opts.onEnd?.(); };
  const ctrl = { cancel: () => { if (cancelled) return; cancelled = true; cleanup(); if (current === ctrl) current = null; } };
  // NOTE: don't claim the shared `current` (or call stopSpeaking) at creation —
  // a "thinking" filler that fires before the first audio would otherwise cancel
  // us via stopSpeaking and the reply would never play. Claim it lazily once we
  // actually start playing (see playNext). The caller cancels any prior speaker.

  const synth1 = (text: string): Promise<string> => synthCloud(engine, voice, 1, text);

  const maybeDone = () => {
    if (finished && !synthing && !playing && segQueue.length === 0 && readyQueue.length === 0) done();
  };
  const pumpSynth = () => {
    if (synthing || cancelled) return;
    const seg = segQueue.shift();
    if (seg === undefined) { maybeDone(); return; }
    synthing = true;
    recordTts(engine, seg.length);
    void synth1(seg)
      .then((b64) => {
        if (cancelled) return;
        readyQueue.push(b64);   // keep the base64; native player takes it directly
        playNext();
      })
      .catch((e) => {
        // Surface the failure and stop — don't half-play the rest. The caller's
        // onError resumes the listening loop.
        if (!cancelled) { cancelled = true; cleanup(); if (current === ctrl) current = null; opts.onError?.(String(e)); }
      })
      .finally(() => { synthing = false; if (!cancelled) pumpSynth(); });
  };
  const advance = () => { playTimer = null; playing = false; playNext(); };
  const playNext = () => {
    if (playing || cancelled) return;
    const b64 = readyQueue.shift();
    if (b64 === undefined) { maybeDone(); return; }
    playing = true;
    if (!started) { started = true; stopSpeaking(); current = ctrl; opts.onStart?.(); }
    // Play NATIVELY (AVAudioPlayer, Rust) so playback shares the audio session
    // with the recording mic instead of interrupting it via the WebView's
    // <audio> — the whole reason hands-free barge-in couldn't hear you. The
    // command returns the clip's duration; advance the queue when it ends.
    void invoke<number>("tts_play_audio", { audioBase64: b64, rate: playbackRate })
      .then((durSec) => {
        if (cancelled) return;
        playTimer = setTimeout(advance, Math.max(0, durSec * 1000) + 60);
      })
      .catch((e) => { if (!cancelled) { opts.onError?.(String(e)); playing = false; } });
  };
  let firstSeg = true;
  const drain = (flushAll: boolean) => {
    // First audio: break at the earliest clause boundary (not a full sentence)
    // so the voice starts talking sooner (#26). Only while still buffering — on
    // flush the normal path below emits whatever's left.
    if (firstSeg && !flushAll) {
      const first = firstAudioSegment(buffer, 20);
      if (!first) return; // not enough yet — wait for the next push
      buffer = first.rest;
      firstSeg = false;
      const seg = engine === "unreal" && first.seg.length > 900
        ? (first.seg.match(/[\s\S]{1,900}/g) ?? [first.seg])
        : [first.seg];
      segQueue.push(...seg);
      pumpSynth();
      return;
    }
    // Small first segment (one short sentence) so audio starts almost
    // immediately; larger segments after keep it smooth with fewer requests.
    const target = firstSeg ? 45 : 200;
    const { segments, rest } = segmentText(buffer, target, flushAll);
    buffer = rest;
    if (segments.length) firstSeg = false;
    // Unreal's /stream caps at 1000 chars — hard-split any over-long segment.
    const capped = engine === "unreal"
      ? segments.flatMap((s) => (s.length <= 900 ? [s] : (s.match(/[\s\S]{1,900}/g) ?? [s])))
      : segments;
    if (capped.length) { segQueue.push(...capped); pumpSynth(); }
    else if (flushAll) maybeDone();
  };
  return {
    push(t) { if (cancelled) return; buffer += t; drain(false); },
    finish() { if (cancelled) return; finished = true; drain(true); },
    cancel() { ctrl.cancel(); },
  };
}

// ---- persisted defaults ---------------------------------------------------

const VOICE_KEY = "order.tts.voice";
const RATE_KEY = "order.tts.rate";
const HINT_KEY = "order.tts.enhanced_hint_dismissed";

export function getSavedVoice(): string { return lsGet(VOICE_KEY); }
export function saveVoice(uri: string): void { lsSet(VOICE_KEY, uri); }
export function getSavedRate(): number { const r = parseFloat(lsGet(RATE_KEY)); return Number.isFinite(r) ? r : 1; }
export function saveRate(r: number): void { lsSet(RATE_KEY, String(r)); }

/** The saved voice as a CLOUD-synthesis config, or null if it's a native voice.
 *  Handed to the locked/background voice loop (`voiceConvoStart`) so a phone that
 *  locks keeps speaking in the SAME cloud voice instead of the system default. */
export function cloudVoiceConfig(): { engine: string; voice: string; model: string; key: string } | null {
  const sv = getSavedVoice();
  const engine = engineOf(sv);
  if (engine === "native") return null;
  const voice = voiceOf(sv);
  if (engine === "openai") return { engine, voice, model: OPENAI_MODEL, key: getOpenaiKey() };
  if (engine === "eleven") return { engine, voice, model: ELEVEN_MODEL, key: getElevenKey() };
  if (engine === "unreal") return { engine, voice, model: "", key: getUnrealKey() };
  return null;
}
export function hintDismissed(): boolean { return lsGet(HINT_KEY) === "1"; }
export function dismissHint(): void { lsSet(HINT_KEY, "1"); }
