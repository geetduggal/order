import { useEffect, useState } from 'react'
import type { GitCommit } from '../types'

const GIT_HISTORY_LOAD_DELAY_MS = 200

export function useGitHistory(
  activeTabPath: string | null,
  loadGitHistory: (path: string) => Promise<GitCommit[]>,
  enabled = true,
) {
  const [loadedHistory, setLoadedHistory] = useState<{
    path: string | null
    commits: GitCommit[]
  }>({
    path: null,
    commits: [],
  })

  useEffect(() => {
    if (!enabled || !activeTabPath) return

    let cancelled = false

    const timeoutId = window.setTimeout(() => {
      void loadGitHistory(activeTabPath).then((history) => {
        if (cancelled) return
        setLoadedHistory({
          path: activeTabPath,
          commits: history,
        })
      })
    }, GIT_HISTORY_LOAD_DELAY_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [activeTabPath, enabled, loadGitHistory])

  return enabled && activeTabPath && loadedHistory.path === activeTabPath
    ? loadedHistory.commits
    : []
}
