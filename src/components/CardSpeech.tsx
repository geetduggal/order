// Audio playback for a card. The card shows a small play button; pressing it
// speaks the card's text and opens a real playback panel DOCKED above the bottom
// dock (via a portal) with traditional transport controls — play/pause, speed,
// and voice always, plus a scrubber + -10s/+10s + time readout when the audio is
// a complete stored recording on disk (a cache hit, which is seekable). A
// chunk-by-chunk fresh synth ("streaming") is not seekable, so it shows just
// play/pause + speed. See lib/tts.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Play, Pause, Square, Loader2, X as XIcon, RotateCcw, RotateCw } from "lucide-react";
import {
  ttsSupported, getVoices, hasEnhancedVoice, pickDefaultVoice, speakableFromMarkdown, speak, stopSpeaking,
  getSavedVoice, saveVoice, getSavedRate, saveRate, hintDismissed, dismissHint,
  TTS_KEYS_EVENT, type TtsVoice, type SpeakHandle,
} from "../lib/tts";

interface Props {
  /** Live markdown source for the card (read at press time). */
  getText: () => string;
  /** Vault-relative note path — enables caching the cloud recording beside it. */
  notePath?: string;
}

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function CardSpeech({ getText, notePath }: Props) {
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(getSavedVoice());
  const [rate, setRate] = useState<number>(getSavedRate());
  const [showHint, setShowHint] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Scrub/time state — only meaningful for a seekable (stored-file) playback.
  const [canSeek, setCanSeek] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);

  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const handleRef = useRef<SpeakHandle | null>(null);
  const audioCleanupRef = useRef<(() => void) | null>(null);
  const voiceRef = useRef(voiceURI); voiceRef.current = voiceURI;
  const rateRef = useRef(rate); rateRef.current = rate;

  useEffect(() => {
    if (!ttsSupported()) return;
    let cancelled = false;
    const load = () => {
      void getVoices().then((vs) => {
        if (cancelled) return;
        setVoices(vs);
        setVoiceURI((c) => (c && vs.some((v) => v.uri === c) ? c : pickDefaultVoice(vs)));
        if (!hasEnhancedVoice(vs) && vs.length > 0 && !hintDismissed()) setShowHint(true);
      });
    };
    load();
    window.addEventListener(TTS_KEYS_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(TTS_KEYS_EVENT, load); };
  }, []);

  const detachAudio = useCallback(() => { audioCleanupRef.current?.(); audioCleanupRef.current = null; }, []);

  // Wire the <audio> element (cloud playback) so the panel reflects real time /
  // duration / play-pause state and can scrub a stored file.
  const wireAudio = useCallback(() => {
    detachAudio();
    const h = handleRef.current;
    const a = h?.audio;
    if (!a) { setCanSeek(false); setDur(0); setCur(0); return; }
    const sync = () => {
      setPaused(a.paused);
      setCur(a.currentTime || 0);
      setDur(Number.isFinite(a.duration) ? a.duration : 0);
      setCanSeek(!!h?.seekable?.());
    };
    const onTime = () => { setCur(a.currentTime || 0); setCanSeek(!!h?.seekable?.()); };
    const onMeta = () => { setDur(Number.isFinite(a.duration) ? a.duration : 0); setCanSeek(!!h?.seekable?.()); };
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    sync();
    audioCleanupRef.current = () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, [detachAudio]);

  useEffect(() => () => { if (handleRef.current) stopSpeaking(); detachAudio(); if (errorTimer.current) clearTimeout(errorTimer.current); }, [detachAudio]);

  const showError = (raw: string) => {
    let msg = "";
    const j = raw.match(/\{[\s\S]*\}/);
    if (j) { try { const o = JSON.parse(j[0]); msg = o?.detail?.message || o?.detail?.status || o?.error?.message || o?.message || ""; if (typeof msg !== "string") msg = ""; } catch { /* */ } }
    if (!msg) msg = /concurrent/i.test(raw) ? "Too many requests at once — wait, then retry." : /invalid_api_key/i.test(raw) ? "Invalid API key." : "Couldn't play this voice.";
    setError(msg.length > 180 ? msg.slice(0, 178) + "…" : msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 8000);
  };

  const start = useCallback(() => {
    const text = speakableFromMarkdown(getText());
    if (!text) return;
    const id = ++reqIdRef.current;
    const live = () => id === reqIdRef.current;
    setError(null); setPending(true); setPaused(false); setCanSeek(false); setCur(0); setDur(0);
    if (voiceRef.current) saveVoice(voiceRef.current);
    const vName = voices.find((v) => v.uri === voiceRef.current)?.name;
    handleRef.current = speak(text, {
      voiceURI: voiceRef.current || undefined,
      voiceName: vName,
      notePath,
      rate: rateRef.current,
      onStart: () => { if (live()) { setPending(false); setSpeaking(true); wireAudio(); } },
      onEnd: () => { if (live()) { setPending(false); setSpeaking(false); setPaused(false); detachAudio(); handleRef.current = null; } },
      onError: (m) => { if (live()) showError(m); },
    });
  }, [getText, voices, notePath, wireAudio, detachAudio]);

  const busy = speaking || pending;

  // Card button: start when idle, STOP when active (the panel handles pause).
  const toggleFromCard = useCallback(() => {
    if (busy) { stopSpeaking(); setPending(false); return; }
    start();
  }, [busy, start]);

  // Panel play/pause: cloud can pause/resume in place; native (no pause) stops.
  const playPause = useCallback(() => {
    const h = handleRef.current;
    if (!h) return;
    if (h.pause && h.resume) {
      if (paused) { h.resume(); setPaused(false); } else { h.pause(); setPaused(true); }
    } else {
      stopSpeaking(); // native: no in-place pause
    }
  }, [paused]);

  const seekTo = useCallback((t: number) => {
    const a = handleRef.current?.audio;
    if (!a) return;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, t));
    setCur(a.currentTime);
  }, []);
  const skip = useCallback((d: number) => { const a = handleRef.current?.audio; if (a) seekTo((a.currentTime || 0) + d); }, [seekTo]);

  const changeVoice = (uri: string) => { setVoiceURI(uri); saveVoice(uri); voiceRef.current = uri; start(); };
  const changeRate = (r: number) => {
    setRate(r); saveRate(r); rateRef.current = r;
    const h = handleRef.current;
    if (h?.setRate) h.setRate(r);          // cloud: live, no restart
    else if (busy) start();                // native: restart at the new rate
  };

  if (!ttsSupported()) return null;

  const voiceName = (voices.find((v) => v.uri === voiceURI)?.name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  const showPanel = busy || !!error;

  return (
    <>
      <button
        type="button"
        className={"order-card-btn card-speech-btn" + (busy ? " is-on" : "") + (pending ? " is-loading" : "")}
        onClick={toggleFromCard}
        title={busy ? "Stop" : "Play audio"}
        aria-label={busy ? "Stop audio" : "Play audio"}
        aria-pressed={busy}
      >
        {pending ? <Loader2 size={14} strokeWidth={2.4} className="card-speech-spin" />
          : speaking ? <Square size={13} strokeWidth={2.4} fill="currentColor" />
            : <Play size={14} strokeWidth={2} />}
      </button>

      {showPanel && createPortal(
        <div className="tts-dock-panel" role="group" aria-label="Audio playback"
             onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {error ? (
            <div className="tts-dock-err" role="alert">
              <span>{error}</span>
              <button type="button" className="tts-dock-x" onClick={() => setError(null)} aria-label="Dismiss"><XIcon size={12} strokeWidth={2.4} /></button>
            </div>
          ) : (
            <>
            <div className="tts-dock-row">
              {/* transport */}
              <button type="button" className="tts-dock-btn tts-dock-play" onClick={playPause} disabled={pending}
                      title={pending ? "Loading" : paused ? "Play" : "Pause"} aria-label={paused ? "Play" : "Pause"}>
                {pending ? <Loader2 size={17} strokeWidth={2.2} className="card-speech-spin" />
                  : paused ? <Play size={17} strokeWidth={2.2} />
                    : (handleRef.current?.pause ? <Pause size={17} strokeWidth={2.2} /> : <Square size={15} strokeWidth={2.2} fill="currentColor" />)}
              </button>

              {canSeek && (
                <button type="button" className="tts-dock-btn tts-dock-skip" onClick={() => skip(-10)} title="Back 10s" aria-label="Back 10 seconds">
                  <RotateCcw size={15} strokeWidth={2.2} />
                </button>
              )}

              {/* Forward-skip stays with the transport controls; the scrubber gets
                  its OWN full-width row below (tts-dock-scrubrow) so it isn't cramped. */}
              {canSeek && (
                <button type="button" className="tts-dock-btn tts-dock-skip" onClick={() => skip(10)} title="Forward 10s" aria-label="Forward 10 seconds">
                  <RotateCw size={15} strokeWidth={2.2} />
                </button>
              )}
              {!canSeek && (
                <span className="tts-dock-time tts-dock-elapsed">{pending ? "Loading…" : fmt(cur)}</span>
              )}

              {/* speed */}
              <select className="tts-dock-select tts-dock-speed" value={rate} onChange={(e) => changeRate(parseFloat(e.target.value))} title="Speed" aria-label="Speed">
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>

              {/* voice */}
              <select className="tts-dock-select tts-dock-voice" value={voiceURI} onChange={(e) => changeVoice(e.target.value)} title="Voice" aria-label="Voice">
                {voices.map((v) => <option key={v.uri} value={v.uri}>{v.name}{v.enhanced ? " ✦" : ""}</option>)}
              </select>

              <button type="button" className="tts-dock-btn tts-dock-close" onClick={() => { stopSpeaking(); setPending(false); }} title="Stop & close" aria-label="Stop">
                <XIcon size={15} strokeWidth={2.2} />
              </button>
            </div>
            {canSeek && (
              <div className="tts-dock-scrubrow">
                <span className="tts-dock-time">{fmt(cur)}</span>
                <input type="range" className="tts-dock-range" min={0} max={dur || 0} step={0.1} value={Math.min(cur, dur || 0)}
                       onChange={(e) => seekTo(parseFloat(e.target.value))} aria-label="Seek" />
                <span className="tts-dock-time">{fmt(dur)}</span>
              </div>
            )}
            </>
          )}
          {showHint && !error && (
            <div className="tts-dock-hint">
              <span>Better voices install in System Settings → Spoken Content.</span>
              <button type="button" className="tts-dock-x" onClick={() => { setShowHint(false); dismissHint(); }} aria-label="Dismiss"><XIcon size={11} strokeWidth={2.4} /></button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
