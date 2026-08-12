// The in-card surface for a `.chat.md` file: a hands-free voice conversation
// with the Order agent. Tap to start — it listens, you speak, it auto-sends on
// a pause, the agent's reply plays aloud, then it listens again. The scrolling
// list of turns is the queue. A keyboard fallback is always available.
//
// The Rust core owns everything real: transcription (stt_transcribe), the model
// call, the tool-use loop, and every filesystem touch. This component captures
// the mic, paints the transcript, plays replies, and surfaces the single
// batched write-approval. See lib/agent.ts, lib/voice.ts, src-tauri/src/agent/.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toVaultRel } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import {
  approve, cancelTurn, getAgentKey, onAgentStream, runTurn, recordUser,
  type AgentEvent, type ApprovalItem,
} from "../lib/agent";
import { micSupported, onLevel, onSttState, onPartial, inputName, startListenLoop, stopListenLoop, onUtterance, setForeground, voiceConvoStart, voiceConvoStop, outputIsSpeaker, voiceTrace } from "../lib/voice";
import { speak, stopSpeaking, speakableFromMarkdown, getSavedVoice, saveVoice, getSavedRate, ttsSupported, getOpenaiKey, getVoices, createStreamSpeaker, voiceKeepaliveBegin, voiceKeepaliveEnd, cloudVoiceConfig, type StreamSpeaker, type TtsVoice } from "../lib/tts";
import { getSttEngine } from "../lib/voice";
import { useTextScale } from "../lib/text-scale";
import { playEarcon } from "../lib/earcon";
import { recordChat, recordDictation, getChatUsage, addChatUsage, chatCostOf, chatUsageDetail, formatUSD, type ChatUsage } from "../lib/usage";
import { listen } from "@tauri-apps/api/event";
import { Send, Volume2, Square, Wrench, AlertTriangle, Sparkles, Mic, Keyboard, Loader2, ChevronDown } from "lucide-react";

interface Turn {
  role: "user" | "agent";
  text: string;
  tools: string[];
}

/** listening → transcribing → thinking → (approval) → speaking → listening. */
type Mode = "idle" | "listening" | "transcribing" | "thinking" | "approval" | "speaking";

/** Barge-in echo rejection: is `utterance` mostly a repeat of what the agent is
 *  currently speaking (`agentText`)? While the mic is open during TTS it picks
 *  up the agent's own voice; we treat a high word-overlap as echo and ignore it,
 *  so only NOVEL speech (your actual interruption — "stop", "wait", a new
 *  question) cuts the agent off. Short, distinct interrupts rarely overlap the
 *  reply, so they get through; a near-verbatim echo doesn't. */
function isLikelyEcho(utterance: string, agentText: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const u = norm(utterance);
  if (u.length === 0) return true;
  const a = new Set(norm(agentText));
  if (a.size === 0) return false; // agent hasn't said anything yet → not echo
  const matched = u.filter((w) => a.has(w)).length;
  return matched / u.length >= 0.6;
}

/** Parse a `.chat.md` transcript into turns. Mirrors the writer in
 *  src-tauri/src/agent/chat.rs. */
function parseTranscript(raw: string): Turn[] {
  let body = raw;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end !== -1) body = body.slice(end + 5);
  }
  const turns: Turn[] = [];
  let role: "user" | "agent" | null = null;
  let textLines: string[] = [];
  let tools: string[] = [];
  const flush = () => {
    if (!role) return;
    const text = textLines.join("\n").trim();
    if (text || tools.length) turns.push({ role, text, tools });
    textLines = [];
    tools = [];
  };
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t === "## You") { flush(); role = "user"; continue; }
    if (t === "## Agent") { flush(); role = "agent"; continue; }
    if (role === "agent" && t.startsWith("> 🔧")) { tools.push(t.replace(/^>\s*🔧\s*/, "")); continue; }
    if (role === "agent" && /^>\s*_.*_$/.test(t)) { textLines.push(t.replace(/^>\s*_/, "").replace(/_$/, "")); continue; }
    textLines.push(line);
  }
  flush();
  return turns;
}

function DiffView({ oldText, newText }: { oldText: string | null; newText: string | null }) {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = (newText ?? "").split("\n");
  return (
    <div className="order-chat-diff">
      {oldText != null && oldLines.map((l, i) => <div key={`o${i}`} className="order-chat-diff-del">- {l}</div>)}
      {newText != null && newLines.map((l, i) => <div key={`n${i}`} className="order-chat-diff-add">+ {l}</div>)}
    </div>
  );
}

function PlayButton({ text }: { text: string }) {
  const [playing, setPlaying] = useState(false);
  const toggle = useCallback(() => {
    if (playing) { stopSpeaking(); setPlaying(false); return; }
    const spoken = speakableFromMarkdown(text);
    if (!spoken) return;
    setPlaying(true);
    speak(spoken, { voiceURI: getSavedVoice() || undefined, onEnd: () => setPlaying(false), onError: () => setPlaying(false) });
  }, [playing, text]);
  if (!ttsSupported()) return null;
  return (
    <button type="button" className="order-chat-play" onClick={toggle} title={playing ? "Stop" : "Read aloud"}>
      {playing ? <Square size={13} /> : <Volume2 size={13} />}
    </button>
  );
}

interface Props {
  path: string;
  autoFocus?: boolean;
  /** Called on a quiet visit (mount, when idle) so the parent can occasionally
   *  rename a still-timestamp-named chat to something meaningful. */
  onMaybeTitle?: (rel: string) => void;
}

const THINKING_PHRASES = ["Thinking…", "One sec…", "Let me think…", "Working on it…", "Mulling it over…", "On it…", "Hmm, let me see…", "Digging in…"];

export function ChatSurface({ path, autoFocus, onMaybeTitle }: Props) {
  const rel = useMemo(() => toVaultRel(path), [path]);
  // Re-apply the global zoom as an INLINE --text-scale on the chat root. On iOS
  // WebKit a :root custom-property change doesn't always repaint the chat's
  // composited scroll layer, so the transcript ignored the rail zoom; setting it
  // inline (React re-renders when useTextScale changes) forces the repaint.
  const textScale = useTextScale();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false); // keyboard fallback visible
  const [mode, setMode] = useState<Mode>("idle");
  const [streamText, setStreamText] = useState("");
  const [streamTools, setStreamTools] = useState<string[]>([]);
  const [approval, setApproval] = useState<ApprovalItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [heard, setHeard] = useState(false);
  const [partial, setPartial] = useState("");   // live transcript while speaking
  const lastPartialLenRef = useRef(0);          // DEBUG: detect the caption jumping back
  // True from when a turn is sent until its reply finishes speaking (or is
  // interrupted). Drives the "interrupt" affordance independently of `mode`,
  // which can lag/misreport — so tapping to interrupt always works.
  const [agentActive, setAgentActive] = useState(false);
  const [micName, setMicName] = useState<string | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(() => getSavedVoice());
  const [chatUsage, setChatUsage] = useState<ChatUsage>(() => getChatUsage(rel));
  const [loadedChats, setLoadedChats] = useState<string[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  // A few 'thinking' phrasings, randomly sampled each turn so the wait doesn't
  // always read the same.
  const [thinkingPhrase, setThinkingPhrase] = useState(THINKING_PHRASES[0]);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasKey = !!getAgentKey();
  const canVoice = micSupported() && ttsSupported();

  // Refs the async voice loop reads without re-subscribing.
  const voiceOnRef = useRef(false);          // is the hands-free loop engaged?
  const modeRef = useRef<Mode>("idle");
  // Barge-in bookkeeping. The native listen loop stays open across turns, so a
  // new utterance can arrive mid-turn. `turnInFlightRef` is true while a model
  // turn is generating (can't start a second concurrently — queue it in
  // `pendingUtteranceRef`); `bargeInRef` suppresses the superseded turn's
  // streamed text + speech once we've decided to interrupt it.
  const turnInFlightRef = useRef(false);
  const pendingUtteranceRef = useRef<string | null>(null);
  const bargeInRef = useRef(false);
  // The agent's reply text as it streams — used to reject echo: while the mic is
  // open during TTS it hears the agent too, so an "utterance" that mostly repeats
  // what the agent is currently saying is echo (ignore it), whereas novel speech
  // is a genuine hands-free interruption.
  const agentSpokenRef = useRef("");
  // When a barge-in plays the "interrupt" earcon, skip the "thinking" earcon on
  // the turn it kicks off (they share one earcon player; back-to-back would cut
  // the first off, and the interrupt cue already signals "got it").
  const skipThinkEarconRef = useRef(false);
  // Rambling support: the text of the current in-flight user turn, and whether a
  // queued continuation should REPLACE that turn's bubble rather than add a new
  // one. If you keep talking before the agent replies, we combine it all into one
  // turn instead of throwing the earlier part away.
  const lastUserTextRef = useRef("");
  const pendingReplaceRef = useRef(false);
  // Built-in speaker has no echo cancellation, so we go half-duplex there: don't
  // act on the mic while (or just after) the agent speaks, or it hears itself.
  // Headsets/AirPods keep full-duplex barge-in. Refreshed when playback starts.
  const speakerRouteRef = useRef(false);
  const lastSpeakEndRef = useRef(0);
  const refreshRoute = useCallback(() => { void outputIsSpeaker().then((s) => { speakerRouteRef.current = s; }); }, []);
  // Fire the "I'm listening" cue when the mic ACTUALLY starts (stt-listening),
  // not optimistically at tap time — on Bluetooth the route can take a moment to
  // settle, which is why the cue "only worked sometimes".
  const startCuePendingRef = useRef(false);
  // Streaming TTS: a speaker fed the reply text as it arrives (native + cloud).
  const speakerRef = useRef<StreamSpeaker | null>(null);
  // "Thinking" voice cue: a brief spoken filler while a slow (tool-heavy) turn
  // runs, so silence doesn't read as a stall. Cancelled the moment the reply
  // starts arriving. A stopgap until latency is fully tuned.
  const fillerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fillerHandleRef = useRef<ReturnType<typeof speak> | null>(null);
  const clearFiller = useCallback(() => {
    if (fillerTimerRef.current) { clearTimeout(fillerTimerRef.current); fillerTimerRef.current = null; }
    fillerHandleRef.current?.stop(); fillerHandleRef.current = null;
  }, []);
  const setModeBoth = useCallback((m: Mode) => { modeRef.current = m; setMode(m); }, []);

  // Live input level for the meter + "heard you" state (native capture streams
  // `stt-level` / `stt-state`).
  useEffect(() => {
    let a: (() => void) | undefined, b: (() => void) | undefined, c: (() => void) | undefined, d: (() => void) | undefined, e: (() => void) | undefined;
    let alive = true;
    // CRITICAL: the native mic loop stays open across turns, so it streams
    // stt-level (per audio buffer, ~40/s) and stt-partial the WHOLE time —
    // including while the agent is speaking (it hears the TTS echo). Applying
    // those as React state on every event re-renders this whole component dozens
    // of times a second and STARVES the agent-text rendering, so replies didn't
    // appear on screen while audio played. Only apply them while we're actually
    // listening (when the meter/partial are even shown); ignore the flood
    // otherwise. The meter/partial aren't rendered in other modes anyway.
    void onLevel((l) => { if (modeRef.current === "listening") setLevel(l); }).then((fn) => { if (alive) a = fn; else fn(); });
    // "heard" = speech detected (fires on the first partial, ~300ms in).
    void onSttState((s) => {
      if (s !== "heard") return;
      const m = modeRef.current;
      if (m === "listening") { setHeard(true); return; }
      // INSTANT barge-in on a headset: the moment you start speaking over the
      // agent, cut the TTS immediately (don't wait for your utterance to finish)
      // and give an instant audible cue. The finalized utterance then drives the
      // next turn; the agent's reply is already persisted, so nothing is lost.
      // Only on a headset — on the built-in speaker this would trip on the
      // agent's own echo (that route stays half-duplex; tap to interrupt).
      if (m === "speaking" && !speakerRouteRef.current && speakerRef.current) {
        speakerRef.current.cancel();
        speakerRef.current = null;
        setAgentActive(false);
        skipThinkEarconRef.current = true;   // interrupt cue already covers it
        playEarcon("interrupt");
        setModeBoth("listening");
      }
    }).then((fn) => { if (alive) b = fn; else fn(); });
    // Live partial from the recognizer. The native side already prefixes it with
    // the accumulated monologue (across ~60s recognizer restarts), so the on-screen
    // transcript keeps growing and never resets — just show it.
    void onPartial((t) => {
      if (modeRef.current !== "listening") return;
      // DEBUG: the caption jumping back to a much shorter string is exactly the
      // "text disappears and starts from the beginning" symptom — log it so we can
      // line it up with the Rust loop's accum events (was a turn committed first?).
      const prev = lastPartialLenRef.current;
      if (prev >= 20 && t.length < prev - 12) {
        voiceTrace(`UI PARTIAL RESET on screen: ${prev} -> ${t.length} chars, new='${t.slice(0, 34)}'`);
      }
      lastPartialLenRef.current = t.length;
      setPartial(t);
    }).then((fn) => { if (alive) d = fn; else fn(); });
    void listen<{ engine: string; seconds: number }>("stt-usage", (e) => {
      recordDictation(e.payload.engine, e.payload.seconds);
      setChatUsage(addChatUsage(rel, e.payload.engine === "native"
        ? { nativeSeconds: e.payload.seconds }
        : { whisperSeconds: e.payload.seconds }));
    }).then((fn) => { if (alive) c = fn; else fn(); });
    // Mic is actually capturing now → fire the pending "start" cue reliably.
    void listen("stt-listening", () => {
      if (startCuePendingRef.current && voiceOnRef.current) {
        startCuePendingRef.current = false;
        refreshRoute();
        playEarcon("start");
      }
    }).then((fn) => { if (alive) e = fn; else fn(); });
    return () => { alive = false; a?.(); b?.(); c?.(); d?.(); e?.(); };
  }, [rel]);

  // Re-read the transcript from disk. Used on mount and when returning from Lock
  // Mode (where turns were written natively while JS was suspended).
  const reloadTranscript = useCallback(() => {
    return vaultFs.readText(rel).then((raw) => setTurns(parseTranscript(raw))).catch(() => {});
  }, [rel]);

  // Load the transcript from disk on mount / when the file changes.
  useEffect(() => {
    let cancelled = false;
    void vaultFs.readText(rel).then((raw) => { if (!cancelled) setTurns(parseTranscript(raw)); })
      .catch(() => { if (!cancelled) setTurns([]); });
    return () => { cancelled = true; };
  }, [rel]);

  // Load this chat's accumulated cost when it opens.
  useEffect(() => { setChatUsage(getChatUsage(rel)); }, [rel]);

  // Occasionally give a still-timestamp-named chat a meaningful filename from
  // its content — but only on a quiet visit (idle, no active voice loop or turn)
  // so an in-progress conversation is never disturbed. The parent decides
  // eligibility (a user-set title is never touched) and does the rename.
  const onMaybeTitleRef = useRef(onMaybeTitle);
  useEffect(() => { onMaybeTitleRef.current = onMaybeTitle; }, [onMaybeTitle]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (voiceOnRef.current || modeRef.current !== "idle") return;
      onMaybeTitleRef.current?.(rel);
    }, 1500);
    return () => clearTimeout(t);
  }, [rel]);

  // Auto-scroll: keep the newest content pinned to the bottom. Deferred a frame
  // so it runs AFTER layout (streaming text grows the box async), and re-run on
  // mode changes so entering listen/speak snaps to the bottom too.
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); }
    });
  }, []);
  useEffect(() => { scrollToBottom(); }, [turns, streamText, streamTools, approval, mode, partial, scrollToBottom]);
  // Track whether the user has scrolled up, to offer a jump-to-bottom control.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  useEffect(() => { if (autoFocus && typing) taRef.current?.focus(); }, [autoFocus, typing]);

  // Which mic is live — refreshed on mount so the user can tell headphones from
  // the built-in mic before they start (and again each time listening begins).
  const refreshMic = useCallback(() => { if (micSupported()) void inputName().then(setMicName); }, []);
  useEffect(() => { refreshMic(); }, [refreshMic]);

  // Report foreground state to the native side. When the app backgrounds (phone
  // locks), JS is about to suspend — visibilitychange fires first — so Rust knows
  // to drive the voice loop itself until we're visible again.
  useEffect(() => {
    const onVis = () => {
      const visible = document.visibilityState === "visible";
      setForeground(visible);
      if (visible) {
        // Returning from Lock Mode: turns handled natively while locked were saved
        // to the file but not to this view, and a stale live partial may still be
        // on screen. Reload the record so those turns appear, and clear the partial
        // so nothing reads as "written to the screen, then erased."
        void reloadTranscript();
        setPartial("");
      }
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reloadTranscript]);

  // Load the available read-aloud voices so the user can pick one right here.
  useEffect(() => {
    if (!ttsSupported()) return;
    let alive = true;
    void getVoices().then((vs) => {
      if (!alive) return;
      setVoices(vs);
      // If nothing is saved yet, reflect whatever the default resolves to.
      setVoiceURI((cur) => cur || (vs[0]?.uri ?? ""));
    }).catch(() => { /* keep empty */ });
    return () => { alive = false; };
  }, []);

  // ---- the hands-free loop ------------------------------------------------
  // Stop the whole loop and show a message. Used for real failures (a silent
  // re-arm would hide them behind "Listening…").
  const failLoud = useCallback((msg: string) => {
    voiceOnRef.current = false;
    voiceKeepaliveEnd();
    voiceConvoStop();
    void stopListenLoop();
    void cancelTurn();
    turnInFlightRef.current = false;
    pendingUtteranceRef.current = null;
    bargeInRef.current = false;
    setAgentActive(false);
    stopSpeaking();
    setLevel(0);
    setHeard(false);
    setModeBoth("idle");
    setError(msg);
  }, [setModeBoth]);

  // A turn/model error (e.g. an Anthropic 400, a transient network fail) — show it
  // but KEEP the voice loop alive and listening. A single bad turn must never tear
  // down capture: what you say next still needs to be recorded and answered. (Your
  // errored utterance is already saved to the record via capture-first.)
  const softFail = useCallback((msg: string) => {
    clearFiller();
    setError(msg);
    setStreamText("");
    setStreamTools([]);
    setApproval(null);
    speakerRef.current?.cancel();
    speakerRef.current = null;
    turnInFlightRef.current = false;
    bargeInRef.current = false;
    setAgentActive(false);
    voiceKeepaliveEnd();
    setModeBoth(voiceOnRef.current ? "listening" : "idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setModeBoth]);

  const startVoice = useCallback(() => {
    if (!hasKey) { setError("Add your Anthropic API key in Settings to use the agent."); return; }
    if (getSttEngine() === "whisper" && !getOpenaiKey()) {
      setError("Voice input transcribes with Whisper (OpenAI) by default — add an OpenAI key under Read-aloud voices in Settings, or switch Voice input to On-device (Apple) under Agent.");
      return;
    }
    setError(null);
    setTyping(false);
    setHeard(false);
    setPartial("");
    refreshMic();
    voiceOnRef.current = true;
    setModeBoth("listening");
    refreshRoute();
    startCuePendingRef.current = true;   // cue fires on stt-listening (mic ready)
    // Native continuous listen loop: the mic stays open across turns and during
    // TTS playback, streaming each finalized utterance via `stt-utterance`
    // (handled in the onUtterance effect below). This is what makes barge-in
    // possible — the old per-turn "open the mic only between turns" flow couldn't
    // hear you interrupt.
    void startListenLoop().catch((e) => failLoud(typeof e === "string" ? e : "Voice input failed."));
    // Arm the Rust-driven conversation for when the phone locks (JS suspends):
    // Rust then runs the turn and speaks the reply. Pass the SAME cloud voice you
    // use when awake so locking doesn't swap to the robotic system voice; a native
    // voice id is passed as the fallback (used if no cloud voice / synth fails).
    const sv = getSavedVoice();
    const nativeVoiceId = sv.startsWith("native:") ? sv.slice("native:".length) : null;
    voiceConvoStart(rel, getAgentKey(), nativeVoiceId, getSavedRate(), cloudVoiceConfig());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, failLoud, rel]);

  const stopVoice = useCallback(() => {
    voiceOnRef.current = false;
    voiceKeepaliveEnd();
    voiceConvoStop();
    setForeground(true);
    void stopListenLoop();
    void cancelTurn();
    turnInFlightRef.current = false;
    pendingUtteranceRef.current = null;
    bargeInRef.current = false;
    setAgentActive(false);
    clearFiller();
    speakerRef.current?.cancel();
    speakerRef.current = null;
    stopSpeaking();
    setLevel(0);
    setHeard(false);
    setModeBoth("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finish a turn: record the agent's reply and close out the streaming speaker.
  // Guarded so the stream `final` event and the runTurn promise (a safety net)
  // can't double-fire — and so a barge-in (superseding turn) is silently dropped.
  const finalizedRef = useRef(false);
  const finalizeAgent = useCallback((text: string) => {
    if (finalizedRef.current) return;
    // Barged in: this reply is superseded — don't append or speak it. The queued
    // utterance (see handleUtterance) becomes the next turn.
    if (bargeInRef.current) { finalizedRef.current = true; return; }
    finalizedRef.current = true;
    setApproval(null);
    setStreamText("");
    setStreamTools([]);
    if (text.trim()) setTurns((prev) => [...prev, { role: "agent", text, tools: [] }]);
    if (speakerRef.current) {
      // Voice mode: the reply streamed into the speaker; close it out. Its onEnd
      // returns to "listening" (the native loop never stopped capturing).
      speakerRef.current.finish();
    } else {
      // Typed turn (or a voice reply whose speech was already cut by a barge-in):
      // no auto-speak. In voice mode return to listening so the next utterance is
      // accepted; otherwise idle.
      setAgentActive(false);
      setModeBoth(voiceOnRef.current ? "listening" : "idle");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send a user turn (from voice or keyboard). `replaceLastUser` rewrites the last
  // user bubble instead of adding one. `alreadyRecorded` = the utterance was already
  // written to the record (voice capture-first), so the turn must not re-write it.
  const sendTurn = useCallback((text: string, opts?: { replaceLastUser?: boolean; alreadyRecorded?: boolean }) => {
    setError(null);
    bargeInRef.current = false;
    pendingUtteranceRef.current = null;
    turnInFlightRef.current = true;
    lastUserTextRef.current = text;
    setAgentActive(true);
    // Soft "thinking" cue when a voice turn starts (skipped right after a barge-in
    // interrupt cue, which already acknowledged you).
    if (voiceOnRef.current) {
      if (skipThinkEarconRef.current) skipThinkEarconRef.current = false;
      else playEarcon("thinking");
    }
    // Voice utterances are captured + shown as a bubble in processUtterance before
    // this runs (alreadyRecorded), so don't add a second one. Typed input adds it.
    if (!opts?.alreadyRecorded) {
      setTurns((prev) => opts?.replaceLastUser && prev.length && prev[prev.length - 1].role === "user"
        ? [...prev.slice(0, -1), { role: "user", text, tools: [] }]
        : [...prev, { role: "user", text, tools: [] }]);
    }
    setStreamText("");
    setStreamTools([]);
    setPartial("");
    finalizedRef.current = false;
    // In the voice loop, spin up a streaming speaker so the reply is spoken as it
    // generates (native = per sentence; cloud = pipelined segments). Typed turns
    // get no speaker — they stay silent.
    speakerRef.current?.cancel();
    // Voice turn: hold a background-execution assertion across the thinking gap
    // so a locked/backgrounded phone doesn't suspend before the reply speaks
    // (#27). Released in the speaker's onEnd/onError, or on stop/failure.
    if (voiceOnRef.current && ttsSupported()) voiceKeepaliveBegin();
    speakerRef.current = voiceOnRef.current && ttsSupported()
      ? createStreamSpeaker({
          voiceURI: getSavedVoice() || undefined,
          rate: getSavedRate(),
          onStart: () => { refreshRoute(); setModeBoth("speaking"); },
          onEnd: () => { voiceKeepaliveEnd(); speakerRef.current = null; setAgentActive(false); lastSpeakEndRef.current = Date.now(); if (voiceOnRef.current) setModeBoth("listening"); else setModeBoth("idle"); },
          onError: () => { voiceKeepaliveEnd(); speakerRef.current = null; setAgentActive(false); lastSpeakEndRef.current = Date.now(); if (voiceOnRef.current) setModeBoth("listening"); else setModeBoth("idle"); },
        })
      : null;
    setModeBoth("thinking");
    // No spoken "thinking" filler in the always-on-mic loop: it's TTS that the
    // open mic would hear as echo (and we now allow a genuine barge-in while
    // thinking). The visual "thinking" indicator carries the wait instead.
    clearFiller();
    void runTurn(rel, text, { alreadyRecorded: opts?.alreadyRecorded })
      .then((res) => { finalizeAgent(res.text); })   // safety net if `final` was missed
      .catch((err) => { if (!bargeInRef.current) softFail(typeof err === "string" ? err : "The agent turn failed."); })
      .finally(() => {
        turnInFlightRef.current = false;
        // A barge-in queued the next utterance while this turn was still
        // generating; now that it's wound down, reply to it. It was already written
        // to the record when spoken (capture-first), so pass alreadyRecorded.
        const pending = pendingUtteranceRef.current;
        const replace = pendingReplaceRef.current;
        pendingReplaceRef.current = false;
        if (pending && voiceOnRef.current) { pendingUtteranceRef.current = null; sendTurnRef.current?.(pending, { replaceLastUser: replace, alreadyRecorded: true }); }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, softFail, finalizeAgent]);

  // Latest sendTurn, so the runTurn .finally and the utterance handler can call
  // it without capturing a stale closure.
  const sendTurnRef = useRef(sendTurn);
  sendTurnRef.current = sendTurn;

  // A finalized user utterance from the native listen loop (voice mode).
  //
  // CAPTURE IS DECOUPLED FROM REPLYING. Every real utterance is written to the
  // chat record FIRST — no matter what we then decide about a reply — so nothing
  // you say is ever lost. Only a confirmed echo of the agent's own voice is
  // skipped (it isn't something you said). Reply paths then run the turn with
  // `alreadyRecorded` so the same utterance isn't written to the file twice.
  const processUtterance = useCallback(async (t: string) => {
    if (!voiceOnRef.current || !t) return;
    const m = modeRef.current;
    // ECHO of the agent's OWN voice → ignore (don't record; you didn't say it).
    // On the built-in speaker the whole speaking window plus a short decay tail is
    // echo we can't separate from your voice; on a headset, only an utterance that
    // repeats what the agent is currently saying counts as echo.
    voiceTrace(`UI utterance received: len=${t.length} mode=${m} speaker=${speakerRouteRef.current} inflight=${turnInFlightRef.current} '${t.slice(0, 34)}'`);
    if (m === "speaking") {
      if (speakerRouteRef.current || isLikelyEcho(t, agentSpokenRef.current)) {
        voiceTrace(`UI -> ECHO DROP (mode=speaking, not saved, not shown) len=${t.length}`);
        return;
      }
    } else if (speakerRouteRef.current && Date.now() - lastSpeakEndRef.current < 900) {
      voiceTrace(`UI -> DROP (speaker, ${Date.now() - lastSpeakEndRef.current}ms after speech end, not saved) len=${t.length}`);
      return;
    }

    // CAPTURE-FIRST GUARANTEE: record it before deciding anything else.
    try { await recordUser(rel, t); voiceTrace(`UI -> saved to .chat.md + bubble len=${t.length}`); }
    catch (e) { voiceTrace(`UI -> recordUser FAILED: ${String(e)} len=${t.length}`); }
    if (!voiceOnRef.current) return; // voice was turned off mid-record

    clearFiller();
    // Commit the utterance to the on-screen transcript IMMEDIATELY (it's already in
    // the record). This is what stops text from appearing and then vanishing: the
    // bubble is permanent the instant you finish speaking, whether or not a reply
    // follows. Reply paths below pass `alreadyRecorded`, which also skips adding a
    // second bubble in sendTurn.
    setPartial("");
    setTurns((prev) => [...prev, { role: "user", text: t, tools: [] }]);

    if (m === "speaking") {
      // Novel speech over the agent (headset) → barge-in and reply to it.
      playEarcon("interrupt");
      skipThinkEarconRef.current = true;
      speakerRef.current?.cancel();
      speakerRef.current = null;
      setAgentActive(false);
      sendTurn(t, { alreadyRecorded: true });
      return;
    }
    if (turnInFlightRef.current) {
      // You spoke while the agent was still thinking → take THIS as its own new
      // turn. NO cumulative combine (that prepended the previous turn and
      // progressively overrode the record). The prior turn is already saved, and
      // so is this one; this becomes the next reply once the in-flight turn winds
      // down (queued so we don't race its teardown).
      bargeInRef.current = true;
      skipThinkEarconRef.current = true;
      void cancelTurn();
      speakerRef.current?.cancel();
      speakerRef.current = null;
      pendingUtteranceRef.current = t;
      pendingReplaceRef.current = false;
      setStreamText("");
      setModeBoth("listening");
      return;
    }
    if (m === "listening") {
      sendTurn(t, { alreadyRecorded: true });
      return;
    }
    // Any other mode (transcribing / approval): it's recorded and already shown
    // above — don't start a competing turn.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendTurn, rel]);

  // A COMPLETE utterance from the native loop (it accumulates across the
  // recognizer's ~60s cuts and only emits on a natural pause), so just process it.
  const handleUtterance = useCallback((text: string) => {
    if (!voiceOnRef.current) { voiceTrace(`UI stt-utterance IGNORED (voice off) len=${text.length}`); return; }
    // Backgrounded/locked: the native loop drives turns itself — ignore here.
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      voiceTrace(`UI stt-utterance IGNORED (not visible: ${document.visibilityState}) len=${text.length}`);
      return;
    }
    const t = text.trim();
    if (!t) return;
    void processUtterance(t);
  }, [processUtterance]);

  // Reliable manual interrupt: tap the transcript while the agent is talking /
  // thinking to cut it off and hand the floor back to you. Works regardless of
  // whether the mic could hear you over the agent (the voice barge-in path),
  // so there's always a way to interrupt. The always-on loop then takes your
  // next utterance as a fresh turn.
  const interruptNow = useCallback(() => {
    if (!voiceOnRef.current) return;
    // Gate on the actual runtime state (a speaker is playing OR a turn is
    // generating), NOT on `mode` — mode can be wrong, which left tapping doing
    // nothing.
    if (!speakerRef.current && !turnInFlightRef.current) return;
    playEarcon("interrupt");
    skipThinkEarconRef.current = true;
    bargeInRef.current = turnInFlightRef.current;
    void cancelTurn();
    clearFiller();
    speakerRef.current?.cancel();
    speakerRef.current = null;
    setStreamText("");
    setAgentActive(false);
    setModeBoth("listening");
  }, [clearFiller, setModeBoth]);

  // Finalized utterances from the native listen loop feed the barge-in handler.
  const handleUtteranceRef = useRef(handleUtterance);
  handleUtteranceRef.current = handleUtterance;
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    void onUtterance((text) => handleUtteranceRef.current(text)).then((fn) => { if (alive) un = fn; else fn(); });
    return () => { alive = false; un?.(); };
  }, []);

  // Subscribe to the agent's stream; act only on events for THIS chat.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onAgentStream((e: AgentEvent) => {
      if (e.chatPath !== rel) return;
      // Barge-in: the user interrupted, so ignore the superseded turn's stream
      // (text/tools/approval). We still let "final"/"error" through so the turn
      // settles cleanly (finalizeAgent no-ops under bargeInRef).
      if (bargeInRef.current && e.kind !== "final" && e.kind !== "error") return;
      switch (e.kind) {
        case "context": setLoadedChats(e.loadedChats); break;
        case "text": clearFiller(); agentSpokenRef.current = (agentSpokenRef.current + e.text).slice(-2000); setStreamText((s) => s + e.text); speakerRef.current?.push(e.text); break;
        case "tool": setStreamTools((t) => [...t, e.line]); break;
        case "approval": setModeBoth("approval"); setApproval(e.items); break;
        case "note": setStreamText((s) => (s ? s + "\n\n" : "") + e.text); break;
        case "final": {
          if (e.usage) {
            const cr = e.usage.cacheReadTokens || 0, cw = e.usage.cacheWriteTokens || 0;
            recordChat(e.usage.inputTokens, e.usage.outputTokens, cr, cw);
            setChatUsage(addChatUsage(rel, { anthropicIn: e.usage.inputTokens, anthropicOut: e.usage.outputTokens, anthropicCacheRead: cr, anthropicCacheWrite: cw, anthropicTurns: 1 }));
          }
          finalizeAgent(e.text);
          break;
        }
        case "error": {
          // A turn/model error (e.g. Anthropic 400). Keep the voice loop alive so
          // capture continues — don't tear it down over one bad turn.
          softFail(e.message);
          break;
        }
      }
    }).then((fn) => { if (alive) unlisten = fn; else fn(); });
    return () => { alive = false; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel]);

  // Tear the loop down on unmount.
  useEffect(() => () => { voiceOnRef.current = false; voiceKeepaliveEnd(); voiceConvoStop(); void stopListenLoop(); void cancelTurn(); speakerRef.current?.cancel(); stopSpeaking(); }, []);

  const sendTyped = useCallback(() => {
    const text = input.trim();
    if (!text || modeRef.current === "thinking") return;
    if (!hasKey) { setError("Add your Anthropic API key in Settings to use the agent."); return; }
    setInput("");
    sendTurn(text);
  }, [input, hasKey, sendTurn]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTyped(); }
  }, [sendTyped]);

  const decide = useCallback((d: "once" | "all" | "reject") => {
    setApproval(null);
    setModeBoth("thinking");
    void approve(d);
  }, [setModeBoth]);

  const chatCost = chatCostOf(chatUsage);
  useEffect(() => {
    if (mode === "thinking") setThinkingPhrase(THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]);
  }, [mode]);
  const hasUsage = chatUsage.anthropicTurns > 0 || chatUsage.whisperSeconds > 0 || chatUsage.nativeSeconds > 0;
  const busy = mode === "thinking" || mode === "transcribing";
  const hint = agentActive ? " · tap or Interrupt to cut in" : "";
  const statusLabel =
    mode === "listening" ? (heard ? "Heard you — pause when done" : "Listening…") :
    mode === "transcribing" ? "Transcribing…" :
    mode === "thinking" ? `${thinkingPhrase}${hint}` :
    mode === "speaking" ? `Speaking…${hint}` :
    mode === "approval" ? "Waiting for you…" : "";

  return (
    <div className="order-chat" style={{ "--text-scale": textScale } as CSSProperties}>
      {/* Running cost for THIS chat (agent + dictation). Estimate. */}
      {hasUsage && (
        <div className="order-chat-cost" title={`This chat · ${chatUsageDetail(chatUsage)}${chatUsage.nativeSeconds > 0 ? " · on-device is free" : ""} · estimated`}>
          ~{formatUSD(chatCost)}
        </div>
      )}
      {/* Persistent state signal — always visible at the top, whatever is
          happening (listening / thinking / speaking / waiting). */}
      {mode !== "idle" && (
        <div className={`order-chat-status mode-${mode}`} aria-live="polite">
          <span className="order-chat-status-dot" />
          <span className="order-chat-status-label">{statusLabel}</span>
          {mode === "listening" && (
            <span className="order-chat-meter"><span className="order-chat-meter-fill" style={{ transform: `scaleX(${level})` }} /></span>
          )}
        </div>
      )}
      <div
        className="order-chat-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        // Tap the transcript to interrupt while a reply is active (no-op
        // otherwise — interruptNow self-guards on the runtime state).
        onClick={agentActive ? interruptNow : undefined}
      >
        {turns.length === 0 && mode === "idle" && (
          <div className="order-chat-empty">
            <Sparkles size={18} />
            <p>Talk to the agent — it can read, organize, and edit notes in this folder. Tap the mic and just speak.</p>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`order-chat-turn order-chat-${t.role}`}>
            {t.tools.length > 0 && (
              <div className="order-chat-tools">
                {t.tools.map((tl, j) => <div key={j} className="order-chat-tool"><Wrench size={11} /> {tl}</div>)}
              </div>
            )}
            {t.text && (
              <div className="order-chat-bubble">
                <div className="order-chat-text" style={{ fontSize: `${15 * textScale}px` }}>{t.text}</div>
                {t.role === "agent" && <PlayButton text={t.text} />}
              </div>
            )}
          </div>
        ))}

        {/* Live transcript while you speak (on-device engine). */}
        {mode === "listening" && partial && (
          <div className="order-chat-turn order-chat-user">
            <div className="order-chat-bubble order-chat-partial">
              <div className="order-chat-text" style={{ fontSize: `${15 * textScale}px` }}>{partial}</div>
            </div>
          </div>
        )}

        {(streamTools.length > 0 || streamText || busy) && !approval && (
          <div className="order-chat-turn order-chat-agent">
            {streamTools.length > 0 && (
              <div className="order-chat-tools">
                {streamTools.map((tl, j) => <div key={j} className="order-chat-tool"><Wrench size={11} /> {tl}</div>)}
              </div>
            )}
            <div className="order-chat-bubble">
              <div className="order-chat-text" style={{ fontSize: `${15 * textScale}px` }}>
                {streamText || <span className="order-chat-thinking">{statusLabel || "Thinking…"}</span>}
              </div>
            </div>
          </div>
        )}

        {error && <div className="order-chat-error"><AlertTriangle size={14} /> {error}</div>}
      </div>

      {/* Jump to the latest — always available when scrolled up. */}
      {!atBottom && (
        <button type="button" className="order-chat-jump" onClick={scrollToBottom} title="Jump to latest" aria-label="Jump to latest">
          <ChevronDown size={18} />
        </button>
      )}

      {loadedChats.length > 0 && (
        <div className="order-chat-context" onClick={() => setContextOpen((v) => !v)} style={{ cursor: "pointer" }}
          title="Recent chats in this folder that informed the reply — tap to expand/collapse">
          {contextOpen ? `context: ${loadedChats.join(", ")}` : `context (${loadedChats.length}) ▸`}
        </div>
      )}

      {approval && (
        <div className="order-chat-approval">
          <div className="order-chat-approval-head">
            The agent wants to make {approval.length} change{approval.length === 1 ? "" : "s"}:
          </div>
          <div className="order-chat-approval-list">
            {approval.map((it, i) => (
              <div key={i} className={`order-chat-approval-item${it.destructive ? " destructive" : ""}`}>
                <div className="order-chat-approval-summary">
                  {it.destructive && <AlertTriangle size={13} />} {it.summary}
                </div>
                {(it.old != null || it.new != null) && <DiffView oldText={it.old} newText={it.new} />}
              </div>
            ))}
          </div>
          <div className="order-chat-approval-actions">
            <button type="button" className="order-chat-btn primary" onClick={() => decide("once")}>Approve</button>
            <button type="button" className="order-chat-btn" onClick={() => decide("all")}>Approve all this chat</button>
            <button type="button" className="order-chat-btn ghost" onClick={() => decide("reject")}>Reject</button>
          </div>
        </div>
      )}

      {/* Mic (input) on the left, voice (output) on the right. */}
      {canVoice && (micName || voices.length > 0) && (
        <div className="order-chat-devices">
          {micName && (
            <span className="order-chat-mic-name" title="On macOS, change this in System Settings → Sound → Input">
              <Mic size={12} /> {micName}
            </span>
          )}
          {voices.length > 0 && (
            <label className="order-chat-voice-pick" title="Voice the agent reads replies in">
              <Volume2 size={12} />
              <select value={voiceURI} onChange={(e) => { setVoiceURI(e.target.value); saveVoice(e.target.value); }}>
                {voices.map((v) => <option key={v.uri} value={v.uri}>{v.name}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      {/* Voice control bar — only when NOT typing; keyboard mode gets a subtle
          inline mic toggle instead of a big hide bar. */}
      {!typing && (
        <div className="order-chat-voice">
          {canVoice && mode === "idle" && (
            // Act on pointerdown, not click: tapping an unfocused card focuses +
            // expands it, shifting this button mid-touch, which makes iOS cancel
            // the click (the old "needs a double-tap" bug). pointerdown fires
            // first, so a single tap works.
            <button type="button" className="order-chat-mic" onPointerDown={(e) => { e.preventDefault(); startVoice(); }} disabled={!hasKey}
              title={hasKey ? "Start talking" : "Add an Anthropic API key in Settings first"}>
              <Mic size={20} /> <span>Talk</span>
            </button>
          )}
          {canVoice && mode !== "idle" && (
            // While a reply is active (thinking/speaking) this button INTERRUPTS
            // that turn and hands the floor back — a guaranteed interrupt that
            // doesn't depend on the mic hearing you. When just listening it stops
            // voice mode. (The Type button always fully exits voice.)
            <button
              type="button"
              className={`order-chat-mic active mode-${mode}${agentActive ? " is-interrupt" : ""}`}
              onPointerDown={(e) => { e.preventDefault(); if (agentActive) interruptNow(); else stopVoice(); }}
              title={agentActive ? "Interrupt" : "Stop"}
            >
              {agentActive
                ? <Square size={16} />
                : mode === "listening" ? <Mic size={18} /> : <Square size={16} />}
              <span>{agentActive ? "Interrupt" : "Stop"}</span>
            </button>
          )}
          <button type="button" className="order-chat-kbd" onPointerDown={(e) => { e.preventDefault(); stopVoice(); setTyping(true); }}
            title="Type instead" aria-label="Type instead">
            <Keyboard size={18} /><span className="order-chat-kbd-label">Type</span>
          </button>
        </div>
      )}

      {(typing || !canVoice) && (
        <div className="order-chat-input">
          {canVoice && (
            <button type="button" className="order-chat-to-voice" onPointerDown={(e) => { e.preventDefault(); setTyping(false); }}
              title="Back to voice" aria-label="Back to voice">
              <Mic size={16} />
            </button>
          )}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={hasKey ? "Message the agent…  (⌘↵ to send)" : "Add an Anthropic API key in Settings first"}
            rows={2}
          />
          <button type="button" className="order-chat-send" onClick={sendTyped} disabled={busy || !input.trim()} title="Send (⌘↵)">
            <Send size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
