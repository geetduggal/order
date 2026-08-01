// Text-to-speech for cards. Three engines behind one interface:
//  - native: AVSpeechSynthesizer via Rust (system voices; see src-tauri/tts.rs)
//  - openai / eleven: cloud voices — Rust makes the HTTP call (no browser CORS,
//    key stays out of the webview) and returns mp3 we play via <audio>.
// One card speaks at a time. A voice's engine is encoded in its uri prefix.

import { invoke } from "@tauri-apps/api/core";

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export function ttsSupported(): boolean { return isTauri(); }

export type TtsEngine = "native" | "openai" | "eleven";

export interface TtsVoice {
  uri: string;   // "native:<id>" | "openai:<voice>" | "eleven:<voiceId>"
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
  return "native";
}
const voiceOf = (uri: string) => uri.slice(uri.indexOf(":") + 1);

// ---- keys -----------------------------------------------------------------

const OPENAI_KEY = "order.tts.openai_key";
const ELEVEN_KEY = "order.tts.eleven_key";
const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* non-fatal */ } };
export const TTS_KEYS_EVENT = "order:tts-keys-changed";
function keysChanged() { voicesCache = null; try { window.dispatchEvent(new Event(TTS_KEYS_EVENT)); } catch { /* */ } }
export function getOpenaiKey(): string { return lsGet(OPENAI_KEY); }
export function setOpenaiKey(v: string): void { lsSet(OPENAI_KEY, v.trim()); keysChanged(); }
export function getElevenKey(): string { return lsGet(ELEVEN_KEY); }
export function setElevenKey(v: string): void { lsSet(ELEVEN_KEY, v.trim()); keysChanged(); }

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

export interface SpeakHandle { stop: () => void }

export function speak(
  text: string,
  opts: { voiceURI?: string; rate?: number; onStart?: () => void; onEnd?: () => void; onError?: (msg: string) => void },
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

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function speakCloud(text: string, opts: Parameters<typeof speak>[1]): SpeakHandle {
  const engine = engineOf(opts.voiceURI);
  const voice = opts.voiceURI ? voiceOf(opts.voiceURI) : "";
  const rate = opts.rate ?? 1;
  // OpenAI honors a native `speed`; ElevenLabs has none, so we time-stretch the
  // audio element instead.
  const apiSpeed = engine === "openai" ? rate : 1;
  const playbackRate = engine === "openai" ? 1 : rate;
  const chunks = chunkText(text, 1800);
  const audio = new Audio();
  audio.playbackRate = playbackRate;

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
  const cleanup = () => { try { audio.pause(); } catch { /* */ } clearMedia(); if (audio.src) { URL.revokeObjectURL(audio.src); audio.removeAttribute("src"); } };
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

  const synth = (chunk: string): Promise<string> =>
    engine === "openai"
      ? invoke<string>("tts_openai", { apiKey: getOpenaiKey(), voice, model: OPENAI_MODEL, speed: apiSpeed, text: chunk })
      : invoke<string>("tts_eleven", { apiKey: getElevenKey(), voiceId: voice, modelId: ELEVEN_MODEL, text: chunk });

  const playNext = async () => {
    if (done) return;
    if (i >= chunks.length) { end(); return; }
    let b64: string;
    try {
      b64 = await synth(chunks[i]);
    } catch (e) { console.error("[tts] cloud synth failed:", e); opts.onError?.(String(e)); end(); return; }
    if (done) return;
    try {
      if (audio.src) URL.revokeObjectURL(audio.src);
      audio.src = URL.createObjectURL(b64ToBlob(b64, "audio/mpeg"));
      audio.playbackRate = playbackRate;
      audio.onended = () => { i++; void playNext(); };
      audio.onerror = () => { console.error("[tts] audio element error", audio.error); i++; void playNext(); };
      await audio.play();
      if (i === 0) { opts.onStart?.(); wireMedia(); }
    } catch (e) { console.error("[tts] audio.play() blocked/failed:", e); opts.onError?.(String(e)); end(); }
  };
  void playNext();
  return { stop: end };
}

// ---- persisted defaults ---------------------------------------------------

const VOICE_KEY = "order.tts.voice";
const RATE_KEY = "order.tts.rate";
const HINT_KEY = "order.tts.enhanced_hint_dismissed";

export function getSavedVoice(): string { return lsGet(VOICE_KEY); }
export function saveVoice(uri: string): void { lsSet(VOICE_KEY, uri); }
export function getSavedRate(): number { const r = parseFloat(lsGet(RATE_KEY)); return Number.isFinite(r) ? r : 1; }
export function saveRate(r: number): void { lsSet(RATE_KEY, String(r)); }
export function hintDismissed(): boolean { return lsGet(HINT_KEY) === "1"; }
export function dismissHint(): void { lsSet(HINT_KEY, "1"); }
