import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isTauri, mockInvoke } from '../mock-tauri'

export type GitRepoState = 'checking' | 'missing' | 'ready'

interface GitSetupStateConfig {
  onToast: (message: string | null) => void
  resolvedPath: string
  windowMode: boolean
}

export function useGitSetupState({
  onToast,
  resolvedPath,
  windowMode,
}: GitSetupStateConfig) {
  const [gitRepoStatus, setGitRepoStatus] = useState<{ path: string; state: GitRepoState }>({
    path: '',
    state: 'checking',
  })
  const [dismissedGitSetupPath, setDismissedGitSetupPath] = useState<string | null>(null)
  const gitRepoState = gitRepoStatus.path === resolvedPath ? gitRepoStatus.state : 'checking'

  useEffect(() => {
    if (!resolvedPath) return
    let cancelled = false
    const check = isTauri()
      ? invoke<boolean>('is_git_repo', { vaultPath: resolvedPath })
      : mockInvoke<boolean>('is_git_repo', { vaultPath: resolvedPath })
    check
      .then(isGit => {
        if (!cancelled) setGitRepoStatus({ path: resolvedPath, state: isGit ? 'ready' : 'missing' })
      })
      .catch(() => {
        if (!cancelled) setGitRepoStatus({ path: resolvedPath, state: 'ready' })
      })
    return () => {
      cancelled = true
    }
  }, [resolvedPath])

  const openGitSetupDialog = useCallback(() => {
    if (gitRepoState !== 'missing') return
    setDismissedGitSetupPath(null)
  }, [gitRepoState])

  const dismissGitSetupDialog = useCallback(() => {
    setDismissedGitSetupPath(resolvedPath)
  }, [resolvedPath])

  const handleInitGitRepo = useCallback(async () => {
    if (isTauri()) {
      await invoke('init_git_repo', { vaultPath: resolvedPath })
    } else {
      await mockInvoke('init_git_repo', { vaultPath: resolvedPath })
    }
    setGitRepoStatus({ path: resolvedPath, state: 'ready' })
    setDismissedGitSetupPath(null)
    onToast('Git initialized for this vault')
  }, [onToast, resolvedPath])

  const showGitSetupDialog = !windowMode
    && gitRepoState === 'missing'
    && dismissedGitSetupPath !== resolvedPath

  return {
    dismissGitSetupDialog,
    gitRepoState,
    handleInitGitRepo,
    openGitSetupDialog,
    showGitSetupDialog,
    shouldShowGitSetupDialog: showGitSetupDialog,
  }
}
