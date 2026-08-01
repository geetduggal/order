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
import { listenOnce, cancelListen, micSupported, onLevel, onSttState } from "../lib/voice";
import { speak, stopSpeaking, speakableFromMarkdown, getSavedVoice, ttsSupported, getOpenaiKey } from "../lib/tts";
import { getSttEngine } from "../lib/voice";
import { Send, Volume2, Square, Wrench, AlertTriangle, Sparkles, Mic, Keyboard, Loader2 } from "lucide-react";

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
  const [loadedChats, setLoadedChats] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const hasKey = !!getAgentKey();
  const canVoice = micSupported() && ttsSupported();

  // Refs the async voice loop reads without re-subscribing.
  const voiceOnRef = useRef(false);          // is the hands-free loop engaged?
  const modeRef = useRef<Mode>("idle");
  const setModeBoth = useCallback((m: Mode) => { modeRef.current = m; setMode(m); }, []);

  // Live input level for the meter + "heard you" state (native capture streams
  // `stt-level` / `stt-state`).
  useEffect(() => {
    let a: (() => void) | undefined, b: (() => void) | undefined;
    let alive = true;
    void onLevel((l) => setLevel(l)).then((fn) => { if (alive) a = fn; else fn(); });
    void onSttState((s) => { if (s === "heard") setHeard(true); }).then((fn) => { if (alive) b = fn; else fn(); });
    return () => { alive = false; a?.(); b?.(); };
  }, []);

  // Load the transcript from disk on mount / when the file changes.
  useEffect(() => {
    let cancelled = false;
    void vaultFs.readText(rel).then((raw) => { if (!cancelled) setTurns(parseTranscript(raw)); })
      .catch(() => { if (!cancelled) setTurns([]); });
    return () => { cancelled = true; };
  }, [rel]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, streamText, streamTools, approval]);

  useEffect(() => { if (autoFocus && typing) taRef.current?.focus(); }, [autoFocus, typing]);

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
    stopSpeaking();
    setLevel(0);
    setHeard(false);
    setModeBoth("idle");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finish a turn: record the agent's reply, speak it, then resume listening
  // (or go idle). Guarded so the stream `final` event and the runTurn promise
  // (a safety net if the event is missed) can't double-fire.
  const finalizedRef = useRef(false);
  const finalizeAgent = useCallback((text: string) => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    setApproval(null);
    setStreamText("");
    setStreamTools([]);
    if (text.trim()) setTurns((prev) => [...prev, { role: "agent", text, tools: [] }]);
    const spoken = speakableFromMarkdown(text);
    if (spoken && ttsSupported()) {
      setModeBoth("speaking");
      speak(spoken, {
        voiceURI: getSavedVoice() || undefined,
        onEnd: () => { if (voiceOnRef.current) beginListening(); else setModeBoth("idle"); },
        onError: () => { if (voiceOnRef.current) beginListening(); else setModeBoth("idle"); },
      });
    } else if (voiceOnRef.current) { beginListening(); } else { setModeBoth("idle"); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Send a user turn (from voice or keyboard).
  const sendTurn = useCallback((text: string) => {
    setError(null);
    setTurns((prev) => [...prev, { role: "user", text, tools: [] }]);
    setStreamText("");
    setStreamTools([]);
    finalizedRef.current = false;
    setModeBoth("thinking");
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
        case "text": setStreamText((s) => s + e.text); break;
        case "tool": setStreamTools((t) => [...t, e.line]); break;
        case "approval": setModeBoth("approval"); setApproval(e.items); break;
        case "note": setStreamText((s) => (s ? s + "\n\n" : "") + e.text); break;
        case "final": {
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
  useEffect(() => () => { voiceOnRef.current = false; void cancelListen(); stopSpeaking(); }, []);

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

  const busy = mode === "thinking" || mode === "transcribing";
  const statusLabel =
    mode === "listening" ? (heard ? "Heard you — pause when done" : "Listening…") :
    mode === "transcribing" ? "Transcribing…" :
    mode === "thinking" ? "Thinking…" :
    mode === "speaking" ? "Speaking…" :
    mode === "approval" ? "Waiting for you…" : "";

  return (
    <div className="order-chat">
      <div className="order-chat-scroll" ref={scrollRef}>
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

      {/* Voice control bar */}
      <div className="order-chat-voice">
        {canVoice && mode === "idle" && !typing && (
          <button type="button" className="order-chat-mic" onClick={startVoice} disabled={!hasKey}
            title={hasKey ? "Start talking" : "Add an Anthropic API key in Settings first"}>
            <Mic size={20} /> <span>Talk</span>
          </button>
        )}
        {canVoice && mode !== "idle" && (
          <button type="button" className={`order-chat-mic active mode-${mode}`} onClick={stopVoice} title="Stop">
            {mode === "transcribing" || mode === "thinking"
              ? <Loader2 size={20} className="order-spin" />
              : mode === "speaking" ? <Volume2 size={20} /> : <Square size={18} />}
            <span className="order-chat-voice-status">
              {statusLabel}
              {mode === "listening" && (
                <span className="order-chat-meter"><span className="order-chat-meter-fill" style={{ transform: `scaleX(${level})` }} /></span>
              )}
            </span>
          </button>
        )}
        <button type="button" className="order-chat-kbd" onClick={() => { if (!typing) stopVoice(); setTyping((v) => !v); }}
          title={typing ? "Hide keyboard" : "Type instead"}>
          <Keyboard size={18} />
        </button>
      </div>

      {(typing || !canVoice) && (
        <div className="order-chat-input">
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
