// Local usage + estimated-cost tracking for the paid services behind the user's
// API keys — Anthropic (chat), OpenAI Whisper (dictation), and OpenAI /
// ElevenLabs (read-aloud voices). Everything is counted locally in localStorage
// and never leaves the machine; nothing here calls out anywhere.
//
// Costs are ESTIMATES computed from published rates (below). They can drift when
// a provider changes pricing, and on-device Apple STT/TTS is free (tracked for
// info only). Treat the numbers as a good-enough meter, not an invoice.

const KEY = "order.usage.v1";
export const USAGE_EVENT = "order:usage-changed";

/** USD rates. Edit here if a provider's pricing changes. */
export const RATES = {
  // Claude Sonnet-class, per 1M tokens. Cache reads are ~1/10 input; writes ~1.25×.
  anthropic: { inPerMTok: 3.0, outPerMTok: 15.0, cacheReadPerMTok: 0.30, cacheWritePerMTok: 3.75 },
  whisper: { perMinute: 0.003 },                    // OpenAI gpt-4o-mini-transcribe, per audio minute
  openaiTts: { perKChar: 0.03 },                    // OpenAI tts-1-hd, per 1K characters
  elevenlabs: { perKChar: 0.15 },                   // ElevenLabs — plan-dependent estimate
  unreal: { perKChar: 0.008 },                      // Unreal Speech — plan-dependent estimate (~$8/M)
};

export interface UsageData {
  anthropicIn: number; anthropicOut: number; anthropicTurns: number;
  anthropicCacheRead: number; anthropicCacheWrite: number;
  whisperSeconds: number; whisperCount: number;
  nativeSttSeconds: number; nativeSttCount: number;   // on-device (free)
  openaiTtsChars: number; openaiTtsCount: number;
  elevenChars: number; elevenCount: number;
  unrealChars: number; unrealCount: number;
  nativeTtsChars: number;                             // on-device (free)
  since: number;
}

function zero(): UsageData {
  return {
    anthropicIn: 0, anthropicOut: 0, anthropicTurns: 0,
    anthropicCacheRead: 0, anthropicCacheWrite: 0,
    whisperSeconds: 0, whisperCount: 0,
    nativeSttSeconds: 0, nativeSttCount: 0,
    openaiTtsChars: 0, openaiTtsCount: 0,
    elevenChars: 0, elevenCount: 0,
    unrealChars: 0, unrealCount: 0,
    nativeTtsChars: 0,
    since: Date.now(),
  };
}

export function getUsage(): UsageData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return zero();
    return { ...zero(), ...JSON.parse(raw) };
  } catch { return zero(); }
}

function save(d: UsageData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
    window.dispatchEvent(new Event(USAGE_EVENT));
  } catch { /* non-fatal */ }
}

function update(fn: (d: UsageData) => void): void {
  const d = getUsage();
  fn(d);
  save(d);
}

/** One agent turn's token usage (summed across its tool-loop iterations). */
export function recordChat(inputTokens: number, outputTokens: number, cacheRead = 0, cacheWrite = 0): void {
  if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite) return;
  update((d) => {
    d.anthropicIn += inputTokens; d.anthropicOut += outputTokens;
    d.anthropicCacheRead += cacheRead; d.anthropicCacheWrite += cacheWrite;
    d.anthropicTurns += 1;
  });
}

/** One dictation: seconds of audio and which engine transcribed it. */
export function recordDictation(engine: string, seconds: number): void {
  if (!(seconds > 0)) return;
  update((d) => {
    if (engine === "native") { d.nativeSttSeconds += seconds; d.nativeSttCount += 1; }
    else { d.whisperSeconds += seconds; d.whisperCount += 1; }
  });
}

/** Characters actually sent to a cloud TTS provider (billed on cache-miss). */
export function recordTts(engine: "openai" | "eleven" | "unreal" | "native", chars: number): void {
  if (!(chars > 0)) return;
  update((d) => {
    if (engine === "openai") { d.openaiTtsChars += chars; d.openaiTtsCount += 1; }
    else if (engine === "eleven") { d.elevenChars += chars; d.elevenCount += 1; }
    else if (engine === "unreal") { d.unrealChars += chars; d.unrealCount += 1; }
    else { d.nativeTtsChars += chars; }
  });
}

export function resetUsage(): void { save(zero()); }

export interface ServiceCost {
  key: string;
  label: string;
  detail: string;   // human units, e.g. "1,240 in / 830 out tokens · 3 turns"
  cost: number;     // estimated USD
  keyed: boolean;   // false for on-device (free) rows
}

/** Per-service breakdown with estimated costs, for the Settings meter. */
export function costBreakdown(d: UsageData = getUsage()): { rows: ServiceCost[]; total: number } {
  const nf = (n: number) => n.toLocaleString();
  const rows: ServiceCost[] = [
    {
      key: "anthropic", label: "Anthropic (chat)", keyed: true,
      detail: `${nf(d.anthropicIn)} in / ${nf(d.anthropicOut)} out${d.anthropicCacheRead ? ` · ${nf(d.anthropicCacheRead)} cached` : ""} tokens · ${nf(d.anthropicTurns)} turn${d.anthropicTurns === 1 ? "" : "s"}`,
      cost: d.anthropicIn / 1e6 * RATES.anthropic.inPerMTok
        + d.anthropicOut / 1e6 * RATES.anthropic.outPerMTok
        + d.anthropicCacheRead / 1e6 * RATES.anthropic.cacheReadPerMTok
        + d.anthropicCacheWrite / 1e6 * RATES.anthropic.cacheWritePerMTok,
    },
    {
      key: "whisper", label: "OpenAI (dictation)", keyed: true,
      detail: `${(d.whisperSeconds / 60).toFixed(1)} min · ${nf(d.whisperCount)} clip${d.whisperCount === 1 ? "" : "s"}`,
      cost: d.whisperSeconds / 60 * RATES.whisper.perMinute,
    },
    {
      key: "openaiTts", label: "OpenAI (read-aloud)", keyed: true,
      detail: `${nf(d.openaiTtsChars)} chars`,
      cost: d.openaiTtsChars / 1000 * RATES.openaiTts.perKChar,
    },
    {
      key: "elevenlabs", label: "ElevenLabs (read-aloud)", keyed: true,
      detail: `${nf(d.elevenChars)} chars`,
      cost: d.elevenChars / 1000 * RATES.elevenlabs.perKChar,
    },
    {
      key: "unreal", label: "Unreal Speech (read-aloud)", keyed: true,
      detail: `${nf(d.unrealChars)} chars`,
      cost: d.unrealChars / 1000 * RATES.unreal.perKChar,
    },
  ];
  // On-device rows only appear once they've been used — they're free, shown for info.
  if (d.nativeSttSeconds > 0 || d.nativeTtsChars > 0) {
    rows.push({
      key: "native", label: "On-device (Apple)", keyed: false,
      detail: `${(d.nativeSttSeconds / 60).toFixed(1)} min dictation · ${nf(d.nativeTtsChars)} chars read`,
      cost: 0,
    });
  }
  const total = rows.reduce((s, r) => s + r.cost, 0);
  return { rows, total };
}

export function formatUSD(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `< $0.01`;
  return `$${n.toFixed(2)}`;
}

// ---- per-chat usage (keyed by the chat's vault-relative path) --------------
// So each .chat.md can show what that specific conversation + its dictation cost.
const CHATS_KEY = "order.usage.chats.v1";

export interface ChatUsage {
  anthropicIn: number; anthropicOut: number; anthropicTurns: number;
  anthropicCacheRead: number; anthropicCacheWrite: number;
  whisperSeconds: number; nativeSeconds: number;
}
function chatZero(): ChatUsage {
  return { anthropicIn: 0, anthropicOut: 0, anthropicTurns: 0, anthropicCacheRead: 0, anthropicCacheWrite: 0, whisperSeconds: 0, nativeSeconds: 0 };
}
function readChats(): Record<string, ChatUsage> {
  try { return JSON.parse(localStorage.getItem(CHATS_KEY) || "{}"); } catch { return {}; }
}
function writeChats(m: Record<string, ChatUsage>): void {
  try { localStorage.setItem(CHATS_KEY, JSON.stringify(m)); window.dispatchEvent(new Event(USAGE_EVENT)); } catch { /* */ }
}

export function getChatUsage(key: string): ChatUsage {
  return { ...chatZero(), ...(readChats()[key] || {}) };
}
export function addChatUsage(key: string, patch: Partial<ChatUsage>): ChatUsage {
  const m = readChats();
  const cur = { ...chatZero(), ...(m[key] || {}) };
  cur.anthropicIn += patch.anthropicIn || 0;
  cur.anthropicOut += patch.anthropicOut || 0;
  cur.anthropicTurns += patch.anthropicTurns || 0;
  cur.anthropicCacheRead += patch.anthropicCacheRead || 0;
  cur.anthropicCacheWrite += patch.anthropicCacheWrite || 0;
  cur.whisperSeconds += patch.whisperSeconds || 0;
  cur.nativeSeconds += patch.nativeSeconds || 0;
  m[key] = cur; writeChats(m);
  return cur;
}

/** Estimated USD for one chat (agent tokens + dictation; Apple is free). */
export function chatCostOf(u: ChatUsage): number {
  return u.anthropicIn / 1e6 * RATES.anthropic.inPerMTok
    + u.anthropicOut / 1e6 * RATES.anthropic.outPerMTok
    + u.anthropicCacheRead / 1e6 * RATES.anthropic.cacheReadPerMTok
    + u.anthropicCacheWrite / 1e6 * RATES.anthropic.cacheWritePerMTok
    + u.whisperSeconds / 60 * RATES.whisper.perMinute;
}

/** A one-line human breakdown for a chat's cost tooltip. */
export function chatUsageDetail(u: ChatUsage): string {
  const bits = [`${(u.anthropicIn + u.anthropicOut).toLocaleString()} tokens`];
  if (u.whisperSeconds > 0) bits.push(`${(u.whisperSeconds / 60).toFixed(1)} min Whisper`);
  if (u.nativeSeconds > 0) bits.push(`${(u.nativeSeconds / 60).toFixed(1)} min on-device`);
  return bits.join(" · ");
}
