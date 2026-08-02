// The in-card surface for a `.chat.md` file: a hands-free voice conversation
// with the Order agent. Tap to start — it listens, you speak, it auto-sends on
// a pause, the agent's reply plays aloud, then it listens again. The scrolling
// list of turns is the queue. A keyboard fallback is always available.
//
// The Rust core owns everything real: transcription (stt_transcribe), the model
// call, the tool-use loop, and every filesystem touch. This component captures
// the mic, paints the transcript, plays replies, and surfaces the single
// batched write-approval. See lib/agent.ts, lib/voice.ts, src-tauri/src/agent/.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toVaultRel } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import {
  approve, getAgentKey, onAgentStream, runTurn,
  type AgentEvent, type ApprovalItem,
} from "../lib/agent";
import { listenOnce, cancelListen, micSupported, onLevel, onSttState, onPartial, inputName } from "../lib/voice";
import { speak, stopSpeaking, speakableFromMarkdown, getSavedVoice, saveVoice, getSavedRate, ttsSupported, getOpenaiKey, getVoices, createStreamSpeaker, type StreamSpeaker, type TtsVoice } from "../lib/tts";
import { getSttEngine } from "../lib/voice";
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
}

export function ChatSurface({ path, autoFocus }: Props) {
  const rel = useMemo(() => toVaultRel(path), [path]);
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
  const [micName, setMicName] = useState<string | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(() => getSavedVoice());
  const [chatUsage, setChatUsage] = useState<ChatUsage>(() => getChatUsage(rel));
  const [loadedChats, setLoadedChats] = useState<string[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasKey = !!getAgentKey();
  const canVoice = micSupported() && ttsSupported();

  // Refs the async voice loop reads without re-subscribing.
  const voiceOnRef = useRef(false);          // is the hands-free loop engaged?
  const modeRef = useRef<Mode>("idle");
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
    void onLevel((l) => setLevel(l)).then((fn) => { if (alive) a = fn; else fn(); });
    void onSttState((s) => { if (s === "heard") setHeard(true); }).then((fn) => { if (alive) b = fn; else fn(); });
    void onPartial((t) => setPartial(t)).then((fn) => { if (alive) d = fn; else fn(); });
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
    void cancelListen();
    stopSpeaking();
    setLevel(0);
    setHeard(false);
    setModeBoth("idle");
    setError(msg);
  }, [setModeBoth]);

  const beginListening = useCallback(() => {
    if (!voiceOnRef.current) return;
    setError(null);
    setHeard(false);
    setPartial("");
    refreshMic();
    setModeBoth("listening");
    setLevel(0);
    // Rust records one utterance natively and resolves with the transcript
    // (""=cancelled or nothing said). The mic is only open for this call.
    void listenOnce().then((text) => {
      const t = text.trim();
      if (!voiceOnRef.current) return;
      if (!t) { beginListening(); return; }   // cancelled / silence → re-arm
      sendTurn(t);
    }).catch((e) => {
      // A real recording/transcription error — surface it and stop, don't loop
      // over it silently.
      failLoud(typeof e === "string" ? e : "Voice input failed.");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failLoud]);

  const startVoice = useCallback(() => {
    if (!hasKey) { setError("Add your Anthropic API key in Settings to use the agent."); return; }
    if (getSttEngine() === "whisper" && !getOpenaiKey()) {
      setError("Voice input transcribes with Whisper (OpenAI) by default — add an OpenAI key under Read-aloud voices in Settings, or switch Voice input to On-device (Apple) under Agent.");
      return;
    }
    setError(null);
    setTyping(false);
    voiceOnRef.current = true;
    beginListening();
  }, [hasKey, beginListening]);

  const stopVoice = useCallback(() => {
    voiceOnRef.current = false;
    void cancelListen();
    clearFiller();
    speakerRef.current?.cancel();
    speakerRef.current = null;
    stopSpeaking();
    setLevel(0);
    setHeard(false);
    setModeBoth("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finish a turn: record the agent's reply, tell the streaming speaker no more
  // text is coming (it drains and then resumes listening via onEnd), and clear
  // the live bubble. Guarded so the stream `final` event and the runTurn promise
  // (a safety net if the event is missed) can't double-fire.
  const finalizedRef = useRef(false);
  const finalizeAgent = useCallback((text: string) => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    setApproval(null);
    setStreamText("");
    setStreamTools([]);
    if (text.trim()) setTurns((prev) => [...prev, { role: "agent", text, tools: [] }]);
    if (speakerRef.current) {
      // Voice mode: the reply has been streaming into the speaker. Close it out;
      // its onEnd (fired when playback drains) resumes listening. Keep the ref so
      // Stop can still cancel playback — a new turn or stopVoice replaces it.
      speakerRef.current.finish();
    } else {
      // Typed turn: no auto-speak (the per-message play button is there instead).
      setModeBoth("idle");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send a user turn (from voice or keyboard).
  const sendTurn = useCallback((text: string) => {
    setError(null);
    setTurns((prev) => [...prev, { role: "user", text, tools: [] }]);
    setStreamText("");
    setStreamTools([]);
    finalizedRef.current = false;
    // In the voice loop, spin up a streaming speaker so the reply is spoken as it
    // generates (native = per sentence; cloud = pipelined segments). Typed turns
    // get no speaker — they stay silent.
    speakerRef.current?.cancel();
    speakerRef.current = voiceOnRef.current && ttsSupported()
      ? createStreamSpeaker({
          voiceURI: getSavedVoice() || undefined,
          rate: getSavedRate(),
          onStart: () => setModeBoth("speaking"),
          onEnd: () => { speakerRef.current = null; if (voiceOnRef.current) beginListening(); else setModeBoth("idle"); },
          onError: () => { speakerRef.current = null; if (voiceOnRef.current) beginListening(); else setModeBoth("idle"); },
        })
      : null;
    setModeBoth("thinking");
    // If the reply is slow to start (tool-heavy turn), speak a brief filler so
    // the silence doesn't feel like a stall. Cancelled as soon as text arrives.
    clearFiller();
    if (voiceOnRef.current && ttsSupported()) {
      fillerTimerRef.current = setTimeout(() => {
        if (!voiceOnRef.current || modeRef.current !== "thinking") return;
        fillerHandleRef.current = speak("Let me look into that.", { voiceURI: getSavedVoice() || undefined, rate: getSavedRate() });
      }, 900);
    }
    void runTurn(rel, text)
      .then((res) => { finalizeAgent(res.text); })   // safety net if `final` was missed
      .catch((err) => { failLoud(typeof err === "string" ? err : "The agent turn failed."); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, failLoud, finalizeAgent]);

  // Subscribe to the agent's stream; act only on events for THIS chat.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    void onAgentStream((e: AgentEvent) => {
      if (e.chatPath !== rel) return;
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
  useEffect(() => () => { voiceOnRef.current = false; void cancelListen(); speakerRef.current?.cancel(); stopSpeaking(); }, []);

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
  const hasUsage = chatUsage.anthropicTurns > 0 || chatUsage.whisperSeconds > 0 || chatUsage.nativeSeconds > 0;
  const busy = mode === "thinking" || mode === "transcribing";
  const statusLabel =
    mode === "listening" ? (heard ? "Heard you — pause when done" : "Listening…") :
    mode === "transcribing" ? "Transcribing…" :
    mode === "thinking" ? "Thinking…" :
    mode === "speaking" ? "Speaking…" :
    mode === "approval" ? "Waiting for you…" : "";

  return (
    <div className="order-chat">
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
      <div className="order-chat-scroll" ref={scrollRef} onScroll={onScroll}>
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
                <div className="order-chat-text">{t.text}</div>
                {t.role === "agent" && <PlayButton text={t.text} />}
              </div>
            )}
          </div>
        ))}

        {/* Live transcript while you speak (on-device engine). */}
        {mode === "listening" && partial && (
          <div className="order-chat-turn order-chat-user">
            <div className="order-chat-bubble order-chat-partial">
              <div className="order-chat-text">{partial}</div>
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
              <div className="order-chat-text">
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
        <div className="order-chat-context" title="Recent chats in this folder that informed the reply">
          context: {loadedChats.join(", ")}
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
            <button type="button" className="order-chat-mic" onClick={startVoice} disabled={!hasKey}
              title={hasKey ? "Start talking" : "Add an Anthropic API key in Settings first"}>
              <Mic size={20} /> <span>Talk</span>
            </button>
          )}
          {canVoice && mode !== "idle" && (
            <button type="button" className={`order-chat-mic active mode-${mode}`} onClick={stopVoice} title="Stop">
              {mode === "thinking"
                ? <Loader2 size={18} className="order-spin" />
                : mode === "speaking" ? <Volume2 size={18} />
                : mode === "listening" ? <Mic size={18} /> : <Square size={16} />}
              <span>Stop</span>
            </button>
          )}
          <button type="button" className="order-chat-kbd" onClick={() => { stopVoice(); setTyping(true); }}
            title="Type instead" aria-label="Type instead">
            <Keyboard size={18} /><span className="order-chat-kbd-label">Type</span>
          </button>
        </div>
      )}

      {(typing || !canVoice) && (
        <div className="order-chat-input">
          {canVoice && (
            <button type="button" className="order-chat-to-voice" onClick={() => setTyping(false)}
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
