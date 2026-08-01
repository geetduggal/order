// Compact audio-playback control for a card. Resting state is a single small
// play button that matches the card's chrome; pressing it speaks the card's
// text immediately with saved defaults. Voice + speed controls (and, if only
// compact voices are installed, a one-line hint) appear in a light popover
// only while speaking — progressive disclosure. See lib/tts.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, Loader2, X as XIcon } from "lucide-react";
import {
  ttsSupported, getVoices, hasEnhancedVoice, pickDefaultVoice, speakableFromMarkdown, speak, stopSpeaking,
  getSavedVoice, saveVoice, getSavedRate, saveRate, hintDismissed, dismissHint,
  TTS_KEYS_EVENT, type TtsVoice, type SpeakHandle,
} from "../lib/tts";

interface Props {
  /** Live markdown source for the card (read at press time). */
  getText: () => string;
}

export function CardSpeech({ getText }: Props) {
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState<string>(getSavedVoice());
  const [rate, setRate] = useState<number>(getSavedRate());
  const [showHint, setShowHint] = useState(false);
  // Optimistic "busy" from the moment play is pressed until audio starts (cloud
  // voices fetch first) — so a second press STOPS instead of firing another
  // request (which, e.g., trips ElevenLabs' concurrency limit).
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);
  const handleRef = useRef<SpeakHandle | null>(null);
  // Latest voice/rate for a restart triggered by a control change mid-playback.
  const voiceRef = useRef(voiceURI); voiceRef.current = voiceURI;
  const rateRef = useRef(rate); rateRef.current = rate;

  // Load voices on mount, and re-load whenever the API keys change (adding an
  // OpenAI / ElevenLabs key should surface its voices without a reload).
  useEffect(() => {
    if (!ttsSupported()) return;
    let cancelled = false;
    const load = () => {
      void getVoices().then((vs) => {
        if (cancelled) return;
        setVoices(vs);
        // Keep a still-valid saved choice, else default to the best voice.
        setVoiceURI((cur) => (cur && vs.some((v) => v.uri === cur) ? cur : pickDefaultVoice(vs)));
        if (!hasEnhancedVoice(vs) && vs.length > 0 && !hintDismissed()) setShowHint(true);
      });
    };
    load();
    window.addEventListener(TTS_KEYS_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(TTS_KEYS_EVENT, load); };
  }, []);

  // Stop speech if the card unmounts.
  useEffect(() => () => { if (handleRef.current) stopSpeaking(); if (errorTimer.current) clearTimeout(errorTimer.current); }, []);

  const showError = (raw: string) => {
    // The Rust error carries the provider's JSON, e.g.
    // `ElevenLabs TTS 401: {"detail":{"message":"…","status":"…"}}`. Show the
    // provider's own message — far more useful than a generic label.
    let msg = "";
    const j = raw.match(/\{[\s\S]*\}/);
    if (j) {
      try {
        const o = JSON.parse(j[0]);
        msg = o?.detail?.message || o?.detail?.status || o?.error?.message || o?.message || "";
        if (typeof msg !== "string") msg = "";
      } catch { /* not JSON */ }
    }
    if (!msg) {
      msg = /concurrent/i.test(raw) ? "Too many requests at once — wait, then retry."
        : /invalid_api_key/i.test(raw) ? "Invalid API key."
        : "Couldn't play this voice.";
    }
    setError(msg.length > 180 ? msg.slice(0, 178) + "…" : msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 8000);
  };

  const start = useCallback(() => {
    const text = speakableFromMarkdown(getText());
    if (!text) return;
    // Bump a request id BEFORE calling speak(): speak() stops any current
    // playback, which fires the OLD handle's onEnd — its stale id no longer
    // matches, so it can't clear the new "pending" (that was wiping the loading
    // indicator on a voice switch).
    const id = ++reqIdRef.current;
    const live = () => id === reqIdRef.current;
    setError(null);
    setPending(true);
    // Remember the voice actually used (not just ones picked from the dropdown),
    // so the last-used voice is restored on the next launch.
    if (voiceRef.current) saveVoice(voiceRef.current);
    handleRef.current = speak(text, {
      voiceURI: voiceRef.current || undefined,
      rate: rateRef.current,
      onStart: () => { if (live()) { setPending(false); setSpeaking(true); } },
      onEnd: () => { if (live()) { setPending(false); setSpeaking(false); handleRef.current = null; } },
      onError: (m) => { if (live()) showError(m); },
    });
  }, [getText]);

  const busy = speaking || pending;
  const toggle = useCallback(() => {
    if (speaking || pending) { stopSpeaking(); setPending(false); return; }
    start();
  }, [speaking, pending, start]);

  // The popover is only visible while busy or after an error, so picking a
  // voice always (re)starts playback with it — immediate audio + button
  // feedback, and it doubles as "retry with a different voice" after a failure.
  const changeVoice = (uri: string) => { setVoiceURI(uri); saveVoice(uri); voiceRef.current = uri; start(); };
  // Speed: update live (label + saved) on drag; only RESTART on release, so a
  // continuous drag doesn't thrash playback (which was unmounting the popover).
  const previewRate = (r: number) => { setRate(r); saveRate(r); rateRef.current = r; };
  const commitRate = () => { if (busy) start(); };

  if (!ttsSupported()) return null;

  // Keep the popover (voice + speed) open while busy OR after an error — so a
  // rate-limit / bad-voice failure lets you pick a different voice and retry.
  const showPop = busy || !!error;
  const voiceName = (voices.find((v) => v.uri === voiceURI)?.name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return (
    <div className={"card-speech" + (showPop ? " is-speaking" : "")}>
      <button
        type="button"
        className={"order-card-btn card-speech-btn" + (busy ? " is-on" : "") + (pending ? " is-loading" : "")}
        onClick={toggle}
        title={busy ? "Stop" : "Play audio"}
        aria-label={busy ? "Stop audio" : "Play audio"}
        aria-pressed={busy}
      >
        {pending
          ? <Loader2 size={14} strokeWidth={2.4} className="card-speech-spin" />
          : speaking
            ? <Square size={13} strokeWidth={2.4} fill="currentColor" />
            : <Play size={14} strokeWidth={2} />}
      </button>
      {showPop && (
        <div className="card-speech-pop" role="group" aria-label="Audio controls" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          {error ? (
            <div className="card-speech-err-line" role="alert">
              {error}
              <button type="button" className="card-speech-hint-x" onClick={() => setError(null)} aria-label="Dismiss"><XIcon size={11} strokeWidth={2.4} /></button>
            </div>
          ) : pending ? (
            <div className="card-speech-loading">
              <Loader2 size={12} strokeWidth={2.4} className="card-speech-spin" />
              <span>Loading{voiceName ? ` ${voiceName}` : ""}…</span>
            </div>
          ) : null}
          <select
            className="card-speech-voice"
            value={voiceURI}
            onChange={(e) => changeVoice(e.target.value)}
            aria-label="Voice"
            title="Voice"
          >
            {voices.map((v) => (
              <option key={v.uri} value={v.uri}>{v.name}{v.enhanced ? " ✦" : ""} · {v.lang}</option>
            ))}
          </select>
          <div className="card-speech-rate" title="Speed">
            <span className="card-speech-rate-label">{rate.toFixed(1)}×</span>
            <input
              type="range" min={0.5} max={2} step={0.1} value={rate}
              onChange={(e) => previewRate(parseFloat(e.target.value))}
              onPointerUp={commitRate}
              onKeyUp={commitRate}
              aria-label="Speed"
            />
          </div>
          {showHint && (
            <div className="card-speech-hint">
              <span>Better voices install in System Settings → Spoken Content.</span>
              <button type="button" className="card-speech-hint-x" onClick={() => { setShowHint(false); dismissHint(); }} aria-label="Dismiss">
                <XIcon size={11} strokeWidth={2.4} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
