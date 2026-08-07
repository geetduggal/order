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
  approve, cancelTurn, getAgentKey, onAgentStream, runTurn,
  type AgentEvent, type ApprovalItem,
} from "../lib/agent";
import { micSupported, onLevel, onSttState, onPartial, inputName, startListenLoop, stopListenLoop, onUtterance } from "../lib/voice";
import { speak, stopSpeaking, speakableFromMarkdown, getSavedVoice, saveVoice, getSavedRate, ttsSupported, getOpenaiKey, getVoices, createStreamSpeaker, voiceKeepaliveBegin, voiceKeepaliveEnd, type StreamSpeaker, type TtsVoice } from "../lib/tts";
import { getSttEngine } from "../lib/voice";
import { useTextScale } from "../lib/text-scale";
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
    let a: (() => void) | undefined, b: (() => void) | undefined, c: (() => void) | undefined, d: (() => void) | undefined;
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
    // "heard" fires on every partial — including the recognizer picking up the
    // agent's OWN TTS (echo). We deliberately do NOT auto-interrupt on it: without
    // rock-solid echo cancellation that made the agent cut itself off. Interrupt
    // is the reliable button/tap, or a full utterance once we're back to listening.
    void onSttState((s) => { if (s === "heard" && modeRef.current === "listening") setHeard(true); }).then((fn) => { if (alive) b = fn; else fn(); });
    void onPartial((t) => { if (modeRef.current === "listening") setPartial(t); }).then((fn) => { if (alive) d = fn; else fn(); });
    void listen<{ engine: string; seconds: number }>("stt-usage", (e) => {
      recordDictation(e.payload.engine, e.payload.seconds);
      setChatUsage(addChatUsage(rel, e.payload.engine === "native"
        ? { nativeSeconds: e.payload.seconds }
        : { whisperSeconds: e.payload.seconds }));
    }).then((fn) => { if (alive) c = fn; else fn(); });
    return () => { alive = false; a?.(); b?.(); c?.(); d?.(); };
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
    // Native continuous listen loop: the mic stays open across turns and during
    // TTS playback, streaming each finalized utterance via `stt-utterance`
    // (handled in the onUtterance effect below). This is what makes barge-in
    // possible — the old per-turn "open the mic only between turns" flow couldn't
    // hear you interrupt.
    void startListenLoop().catch((e) => failLoud(typeof e === "string" ? e : "Voice input failed."));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKey, failLoud]);

  const stopVoice = useCallback(() => {
    voiceOnRef.current = false;
    voiceKeepaliveEnd();
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
      // Typed turn (or voice reply with nothing to speak): no auto-speak.
      setAgentActive(false);
      setModeBoth("idle");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send a user turn (from voice or keyboard).
  const sendTurn = useCallback((text: string) => {
    setError(null);
    bargeInRef.current = false;
    pendingUtteranceRef.current = null;
    turnInFlightRef.current = true;
    setAgentActive(true);
    // Close the mic for the duration of the reply. Recording WHILE the TTS plays
    // put the audio subsystem under enough contention to freeze the UI thread
    // (no streaming text, unresponsive Interrupt). The loop reopens on the
    // speaker's onEnd, so it's still hands-free; interrupt is the button/tap.
    if (voiceOnRef.current) void stopListenLoop();
    setTurns((prev) => [...prev, { role: "user", text, tools: [] }]);
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
          onStart: () => setModeBoth("speaking"),
          onEnd: () => { voiceKeepaliveEnd(); speakerRef.current = null; setAgentActive(false); if (voiceOnRef.current) { void startListenLoop(); setModeBoth("listening"); } else setModeBoth("idle"); },
          onError: () => { voiceKeepaliveEnd(); speakerRef.current = null; setAgentActive(false); if (voiceOnRef.current) { void startListenLoop(); setModeBoth("listening"); } else setModeBoth("idle"); },
        })
      : null;
    setModeBoth("thinking");
    // No spoken "thinking" filler in the always-on-mic loop: it's TTS that the
    // open mic would hear as echo (and we now allow a genuine barge-in while
    // thinking). The visual "thinking" indicator carries the wait instead.
    clearFiller();
    void runTurn(rel, text)
      .then((res) => { finalizeAgent(res.text); })   // safety net if `final` was missed
      .catch((err) => { if (!bargeInRef.current) failLoud(typeof err === "string" ? err : "The agent turn failed."); })
      .finally(() => {
        turnInFlightRef.current = false;
        // A barge-in queued the next utterance while this turn was still
        // generating; now that it's wound down, send it.
        const pending = pendingUtteranceRef.current;
        if (pending && voiceOnRef.current) { pendingUtteranceRef.current = null; sendTurnRef.current?.(pending); }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, failLoud, finalizeAgent]);

  // Latest sendTurn, so the runTurn .finally and the utterance handler can call
  // it without capturing a stale closure.
  const sendTurnRef = useRef(sendTurn);
  sendTurnRef.current = sendTurn;

  // A finalized user utterance from the native listen loop (voice mode). Drives
  // barge-in: interrupt whatever the agent is doing and take the new input.
  const handleUtterance = useCallback((text: string) => {
    if (!voiceOnRef.current) return;
    const t = text.trim();
    if (!t) return;
    // While the agent is SPEAKING, the always-on mic mostly hears the agent
    // itself (echo), so a "finalized utterance" here is unreliable — ignore it
    // and let the user interrupt with a tap instead. A turn is only started from
    // the clean states: listening (normal hands-free next turn) or thinking
    // (a genuine barge-in before any audio is playing).
    const m = modeRef.current;
    if (m !== "listening" && m !== "thinking") return;
    clearFiller();
    if (turnInFlightRef.current) {
      // Still generating (thinking) → abandon it and queue this as the next turn
      // (two model turns can't run at once); the runTurn .finally sends it once
      // wound down.
      bargeInRef.current = true;
      void cancelTurn();
      speakerRef.current?.cancel();
      speakerRef.current = null;
      pendingUtteranceRef.current = t;
      setStreamText("");
      setModeBoth("listening");
      return;
    }
    sendTurn(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendTurn]);

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
    bargeInRef.current = turnInFlightRef.current;
    void cancelTurn();
    clearFiller();
    speakerRef.current?.cancel();
    speakerRef.current = null;
    setStreamText("");
    setAgentActive(false);
    // Reopen the mic to hear your next input (it was closed for the reply).
    if (voiceOnRef.current) void startListenLoop();
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
        case "text": clearFiller(); setStreamText((s) => s + e.text); speakerRef.current?.push(e.text); break;
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
          setApproval(null);
          setStreamText("");
          setStreamTools([]);
          failLoud(e.message);
          break;
        }
      }
    }).then((fn) => { if (alive) unlisten = fn; else fn(); });
    return () => { alive = false; unlisten?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel]);

  // Tear the loop down on unmount.
  useEffect(() => () => { voiceOnRef.current = false; voiceKeepaliveEnd(); void stopListenLoop(); void cancelTurn(); speakerRef.current?.cancel(); stopSpeaking(); }, []);

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
