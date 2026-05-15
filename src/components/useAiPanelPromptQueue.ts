import { startTransition, useCallback, useEffect, useState } from 'react'
import type { NoteReference } from '../utils/ai-context'
import type { QueuedAiPrompt } from '../utils/aiPromptBridge'
import { useQueuedAiPrompt } from './useQueuedAiPrompt'

interface AiAgentBridge {
  clearConversation: () => void
  sendMessage: (text: string, references: NoteReference[]) => void
}

interface UseAiPanelPromptQueueArgs {
  agent: AiAgentBridge
  input: string
  isActive: boolean
  setInput: (value: string) => void
}

export function useAiPanelPromptQueue({
  agent,
  input,
  isActive,
  setInput,
}: UseAiPanelPromptQueueArgs) {
  const [queuedPrompt, setQueuedPrompt] = useState<QueuedAiPrompt | null>(null)

  const handleQueuedPrompt = useCallback((prompt: QueuedAiPrompt) => {
    setInput(prompt.text)
    setQueuedPrompt(prompt)
    agent.clearConversation()
  }, [agent, setInput])

  useQueuedAiPrompt(handleQueuedPrompt)

  useEffect(() => {
    if (!queuedPrompt || isActive) return
    if (input !== queuedPrompt.text) return

    agent.sendMessage(queuedPrompt.text, queuedPrompt.references)
    startTransition(() => {
      setInput('')
      setQueuedPrompt(null)
    })
  }, [agent, input, isActive, queuedPrompt, setInput])
}
