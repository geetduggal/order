import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import './order.css'

const VAULT_PATH_KEY = 'order:vault-path'

interface VaultEntry {
  path: string
  filename: string
  title: string
  snippet: string
  isA: string | null
  modifiedAt: number | null
  createdAt: number | null
  archived: boolean
  wordCount: number
  icon: string | null
  color: string | null
}

function readStoredVaultPath(): string | null {
  try {
    return localStorage.getItem(VAULT_PATH_KEY)
  } catch {
    return null
  }
}

function writeStoredVaultPath(path: string | null): void {
  try {
    if (path) localStorage.setItem(VAULT_PATH_KEY, path)
    else localStorage.removeItem(VAULT_PATH_KEY)
  } catch {
    // localStorage may be unavailable; non-fatal.
  }
}

function useVaultPath() {
  const [vaultPath, setVaultPath] = useState<string | null>(readStoredVaultPath)

  const pickVault = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false })
    if (typeof selected === 'string') {
      writeStoredVaultPath(selected)
      setVaultPath(selected)
    }
  }, [])

  return { vaultPath, pickVault }
}

function useEntries(vaultPath: string | null) {
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!vaultPath) {
      setEntries([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    invoke<VaultEntry[]>('list_vault', { path: vaultPath })
      .then((loaded) => {
        if (cancelled) return
        setEntries(loaded.filter((e) => !e.archived))
      })
      .catch((err) => {
        if (cancelled) return
        setError(typeof err === 'string' ? err : 'Failed to load vault')
        setEntries([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [vaultPath])

  return { entries, loading, error }
}

function VaultPicker({ onPick }: { onPick: () => void }) {
  return (
    <div className="vault-picker">
      <div className="vault-picker-inner">
        <h1 className="vault-picker-title">Order</h1>
        <p className="vault-picker-subtitle">Weather-resistant productivity for your markdown notes.</p>
        <button type="button" className="vault-picker-button" onClick={onPick}>
          Open a vault folder
        </button>
      </div>
    </div>
  )
}

function StreamCard({ entry }: { entry: VaultEntry }) {
  const title = entry.title || entry.filename.replace(/\.md$/, '')
  return (
    <article className="stream-card">
      <h3 className="stream-card-title">{title}</h3>
      {entry.snippet && <p className="stream-card-snippet">{entry.snippet}</p>}
      <div className="stream-card-meta">
        {entry.isA && <span className="stream-card-type">{entry.isA}</span>}
      </div>
    </article>
  )
}

function Stream({ entries, loading, error }: { entries: VaultEntry[]; loading: boolean; error: string | null }) {
  const sorted = [...entries].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
  return (
    <main className="pane-left">
      <div className="pane-left-inner">
        <header className="view-header">
          <h1 className="view-title">Log</h1>
          <p className="view-meta">{loading ? 'Loading…' : `${entries.length} note${entries.length === 1 ? '' : 's'}`}</p>
        </header>
        {error && <div className="view-error">{error}</div>}
        <section className="stream-grid">
          {sorted.slice(0, 60).map((entry) => (
            <StreamCard key={entry.path} entry={entry} />
          ))}
        </section>
        {!loading && entries.length === 0 && !error && (
          <p className="view-empty">No notes yet. Drop markdown files into the vault folder.</p>
        )}
      </div>
    </main>
  )
}

function Sidebar({ vaultPath, onChangeVault }: { vaultPath: string; onChangeVault: () => void }) {
  const vaultName = vaultPath.split('/').filter(Boolean).pop() ?? vaultPath
  return (
    <aside className="pane-right">
      <button type="button" className="vault-switcher" onClick={onChangeVault} title={vaultPath}>
        <span className="vault-switcher-label">{vaultName}</span>
        <span className="vault-switcher-action">change</span>
      </button>
      <nav className="sidebar-section">
        <h2 className="sidebar-heading">Pinned</h2>
        <ul className="sidebar-list">
          <li className="sidebar-item active">
            <span className="sidebar-dot dot-coral" /> Log
          </li>
          <li className="sidebar-item">
            <span className="sidebar-dot dot-royal" /> Public
          </li>
        </ul>
      </nav>
      <nav className="sidebar-section">
        <h2 className="sidebar-heading">Notable</h2>
        <p className="sidebar-empty">Pin folders here to surface them in the Stream.</p>
      </nav>
    </aside>
  )
}

export default function App() {
  const { vaultPath, pickVault } = useVaultPath()
  const { entries, loading, error } = useEntries(vaultPath)

  if (!vaultPath) {
    return <VaultPicker onPick={pickVault} />
  }

  return (
    <div className="app">
      <Stream entries={entries} loading={loading} error={error} />
      <div className="divider" />
      <Sidebar vaultPath={vaultPath} onChangeVault={pickVault} />
    </div>
  )
}
