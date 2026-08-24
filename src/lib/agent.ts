// Thin bridge to the Rust-owned agent. React never touches the filesystem or
// the model API: it hands the Rust core a user message plus an opaque chat
// handle (a vault-relative path that Rust minted), and renders the `agent-stream`
// events the core emits. The whole tool-use loop — reads, writes, model calls —
// runs in Rust. See src-tauri/src/agent/.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---- API keys + provider selection (same localStorage pattern as TTS keys) --
// Multiple providers share the OpenAI Chat Completions API (OpenAI, xAI Grok,
// local Ollama/LM Studio); Anthropic is its own. Keys are stored per provider;
// getAgentKey() returns the CURRENTLY SELECTED provider's key so every existing
// caller (hasKey checks, voice) works unchanged.
const AGENT_KEY = "order.agent.anthropic_key"; // legacy Anthropic key location
const PROVIDER_KEY = "order.agent.provider";
const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } };
const lsSet = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* non-fatal */ } };
export const AGENT_KEY_EVENT = "order:agent-key-changed";

export type AgentProvider = "anthropic" | "openai" | "grok" | "local";
export const AGENT_PROVIDERS: AgentProvider[] = ["anthropic", "openai", "grok", "local"];
/** Model used when a provider's model field is left blank ("" → Rust's default). */
export const AGENT_DEFAULT_MODEL: Record<AgentProvider, string> = {
  anthropic: "", openai: "gpt-4o", grok: "grok-2-latest", local: "",
};

export function getAgentProvider(): AgentProvider {
  const p = lsGet(PROVIDER_KEY);
  return (AGENT_PROVIDERS as string[]).includes(p) ? (p as AgentProvider) : "anthropic";
}
export function setAgentProvider(v: AgentProvider): void {
  lsSet(PROVIDER_KEY, v);
  try { window.dispatchEvent(new Event(AGENT_KEY_EVENT)); } catch { /* noop */ }
}

const keyStore = (p: AgentProvider) => (p === "anthropic" ? AGENT_KEY : `order.agent.key.${p}`);
export function getAgentKeyFor(p: AgentProvider): string { return lsGet(keyStore(p)); }
export function setAgentKeyFor(p: AgentProvider, v: string): void {
  lsSet(keyStore(p), v.trim());
  try { window.dispatchEvent(new Event(AGENT_KEY_EVENT)); } catch { /* noop */ }
}
export function getAgentModelFor(p: AgentProvider): string { return lsGet(`order.agent.model.${p}`); }
export function setAgentModelFor(p: AgentProvider, v: string): void { lsSet(`order.agent.model.${p}`, v.trim()); }
export function getAgentBaseUrlFor(p: AgentProvider): string { return lsGet(`order.agent.baseurl.${p}`); }
export function setAgentBaseUrlFor(p: AgentProvider, v: string): void { lsSet(`order.agent.baseurl.${p}`, v.trim()); }

/** The selected provider's key (back-compatible with the old single-key API). */
export function getAgentKey(): string { return getAgentKeyFor(getAgentProvider()); }
export function setAgentKey(v: string): void { setAgentKeyFor(getAgentProvider(), v); }

/** The effective model for the selected provider (stored, else per-provider default). */
export function getAgentModel(): string {
  const p = getAgentProvider();
  return getAgentModelFor(p) || AGENT_DEFAULT_MODEL[p] || "";
}
export function getAgentBaseUrl(): string { return getAgentBaseUrlFor(getAgentProvider()); }

/** Provider/base-url/model args passed to every agent command. */
export function agentModelArgs(): { provider: string; baseUrl: string | null; model: string | null } {
  return { provider: getAgentProvider(), baseUrl: getAgentBaseUrl() || null, model: getAgentModel() || null };
}

// ---- One preview row in a write-approval batch (mirrors Rust ApprovalItem) --
export interface ApprovalItem {
  tool: string;
  summary: string;
  path: string;
  destructive: boolean;
  old: string | null;
  new: string | null;
}

// ---- Streaming events the Rust core emits over `agent-stream` --------------
export type AgentEvent =
  | { kind: "created"; chatPath: string }
  | { kind: "context"; chatPath: string; loadedChats: string[] }
  | { kind: "text"; chatPath: string; text: string }
  | { kind: "tool"; chatPath: string; line: string }
  | { kind: "approval"; chatPath: string; items: ApprovalItem[] }
  | { kind: "note"; chatPath: string; text: string }
  | { kind: "final"; chatPath: string; text: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; model: string } }
  | { kind: "error"; chatPath: string; message: string };

/** Subscribe to the agent's event stream. Filter by chatPath in the handler. */
export async function onAgentStream(handler: (e: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent-stream", (evt) => handler(evt.payload));
}

export interface TurnResult { chat_path: string; text: string }

/** Create an empty chat file (Rust owns the filename) and return its
 *  vault-relative path. `dirRel` is the notable folder's vault-relative dir. */
export function newChat(dirRel: string, title?: string): Promise<string> {
  return invoke<string>("agent_new_chat", { dirRel, title: title ?? null });
}

/** Run one agent turn against an existing chat. Progress arrives via
 *  `onAgentStream`; the resolved value is the final assistant text.
 *  `alreadyRecorded` = the user's message was already written to the record
 *  (voice capture-first), so this turn must NOT write it again. */
export function runTurn(chatPath: string, userText: string, opts?: { alreadyRecorded?: boolean }): Promise<TurnResult> {
  return invoke<TurnResult>("agent_turn", {
    apiKey: getAgentKey(),
    chatPath,
    createDir: null,
    title: null,
    userText,
    recordUser: !opts?.alreadyRecorded,
    ...agentModelArgs(),
  });
}

/** Write a spoken utterance to the chat record WITHOUT running a turn. The voice
 *  loop calls this for every finalized utterance so nothing said is ever lost,
 *  even when we don't reply to it. When a reply does follow, the turn is run with
 *  `alreadyRecorded: true` so it isn't written twice. */
export function recordUser(chatPath: string, userText: string): Promise<void> {
  return invoke<void>("agent_record_user", { chatPath, userText });
}

/** Ask the model for a short, filesystem-friendly title summarising a chat's
 *  content. Returns null when there isn't enough conversation to name (or the
 *  model declines). Purely advisory — the caller decides whether to rename. */
export function suggestChatTitle(chatPath: string): Promise<string | null> {
  return invoke<string | null>("agent_chat_title", {
    apiKey: getAgentKey(),
    chatPath,
    ...agentModelArgs(),
  });
}

/** Answer a pending write-approval batch. */
export function approve(decision: "once" | "all" | "reject"): Promise<void> {
  return invoke("agent_approve", { decision });
}

/** Ask the in-flight turn to stop (voice barge-in). The turn winds down between
 *  round-trips; its promise still resolves, so the caller must also guard
 *  against acting on a superseded result. */
export function cancelTurn(): Promise<void> {
  return invoke<void>("agent_cancel").catch(() => undefined);
}
