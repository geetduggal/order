import type { NoteReference } from './ai-context'

export const OPEN_AI_CHAT_EVENT = 'tolaria:open-ai-chat'
export const AI_PROMPT_QUEUED_EVENT = 'tolaria:ai-prompt-queued'
export const NEW_AI_CHAT_EVENT = 'tolaria:new-ai-chat'

export interface QueuedAiPrompt {
  id: number
  text: string
  references: NoteReference[]
}

let nextQueuedPromptId = 1
let pendingPrompt: QueuedAiPrompt | null = null

export function queueAiPrompt(text: string, references: NoteReference[]): QueuedAiPrompt {
  const queuedPrompt = {
    id: nextQueuedPromptId++,
    text,
    references,
  }
  pendingPrompt = queuedPrompt
  window.dispatchEvent(new Event(AI_PROMPT_QUEUED_EVENT))
  return queuedPrompt
}

export function takeQueuedAiPrompt(): QueuedAiPrompt | null {
  const queuedPrompt = pendingPrompt
  pendingPrompt = null
  return queuedPrompt
}

export function requestOpenAiChat() {
  window.dispatchEvent(new Event(OPEN_AI_CHAT_EVENT))
}

export function requestNewAiChat() {
  window.dispatchEvent(new Event(NEW_AI_CHAT_EVENT))
  requestOpenAiChat()
}
