import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import './order.css'

const VAULT_PATH_KEY = 'order:vault-path'
const SAVE_DEBOUNCE_MS = 500

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

type View =
  | { kind: 'log' }
  | { kind: 'note'; entry: VaultEntry }

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

  const reload = useCallback(() => {
    if (!vaultPath) {
      setEntries([])
      return
    }
    setLoading(true)
    setError(null)
    invoke<VaultEntry[]>('list_vault', { path: vaultPath })
      .then((loaded) => {
        setEntries(loaded.filter((e) => !e.archived))
      })
      .catch((err) => {
        setError(typeof err === 'string' ? err : 'Failed to load vault')
        setEntries([])
      })
      .finally(() => setLoading(false))
  }, [vaultPath])

  useEffect(() => {
    let cancelled = false
    if (!vaultPath) {
      setEntries([])
      return
    }
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

  return { entries, loading, error, reload }
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

function StreamCard({ entry, onOpen }: { entry: VaultEntry; onOpen: (entry: VaultEntry) => void }) {
  const title = entry.title || entry.filename.replace(/\.md$/, '')
  return (
    <article className="stream-card" onClick={() => onOpen(entry)}>
      <h3 className="stream-card-title">{title}</h3>
      {entry.snippet && <p className="stream-card-snippet">{entry.snippet}</p>}
      <div className="stream-card-meta">
        {entry.isA && <span className="stream-card-type">{entry.isA}</span>}
      </div>
    </article>
  )
}

function Stream({
  entries,
  loading,
  error,
  onOpenEntry,
}: {
  entries: VaultEntry[]
  loading: boolean
  error: string | null
  onOpenEntry: (entry: VaultEntry) => void
}) {
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
            <StreamCard key={entry.path} entry={entry} onOpen={onOpenEntry} />
          ))}
        </section>
        {!loading && entries.length === 0 && !error && (
          <p className="view-empty">No notes yet. Drop markdown files into the vault folder.</p>
        )}
      </div>
    </main>
  )
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  if (!content.startsWith('---\n')) return { frontmatter: '', body: content }
  const end = content.indexOf('\n---\n', 4)
  if (end < 0) return { frontmatter: '', body: content }
  return {
    frontmatter: content.slice(0, end + 5),
    body: content.slice(end + 5),
  }
}

function NoteEditor({
  entry,
  onBack,
  onSaved,
}: {
  entry: VaultEntry
  onBack: () => void
  onSaved: () => void
}) {
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const frontmatterRef = useRef<string>('')
  const editor = useCreateBlockNote()
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    invoke<string>('get_note_content', { path: entry.path })
      .then(async (content) => {
        if (cancelled) return
        const { frontmatter, body } = splitFrontmatter(content)
        frontmatterRef.current = frontmatter
        const blocks = await editor.tryParseMarkdownToBlocks(body)
        if (cancelled) return
        if (blocks.length > 0) {
          editor.replaceBlocks(editor.document, blocks)
        }
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(typeof err === 'string' ? err : 'Failed to load note')
      })
    return () => {
      cancelled = true
    }
  }, [entry.path, editor])

  const triggerSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        setSaving(true)
        const body = await editor.blocksToMarkdownLossy(editor.document)
        const content = frontmatterRef.current + body
        await invoke('save_note_content', { path: entry.path, content })
        onSaved()
      } catch (err) {
        console.warn('save_note_content failed:', err)
      } finally {
        setSaving(false)
      }
    }, SAVE_DEBOUNCE_MS)
  }, [editor, entry.path, onSaved])

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [])

  const title = entry.title || entry.filename.replace(/\.md$/, '')

  return (
    <main className="pane-left">
      <div className="pane-left-inner">
        <header className="note-header">
          <button type="button" className="note-back" onClick={onBack}>← Log</button>
          <span className="note-status">{saving ? 'Saving…' : 'Saved'}</span>
        </header>
        <h1 className="note-title">{title}</h1>
        {loadError && <div className="view-error">{loadError}</div>}
        <div className="note-editor">
          <BlockNoteView editor={editor} onChange={triggerSave} theme="light" />
        </div>
      </div>
    </main>
  )
}

function Sidebar({
  vaultPath,
  onChangeVault,
  view,
  onSelectLog,
}: {
  vaultPath: string
  onChangeVault: () => void
  view: View
  onSelectLog: () => void
}) {
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
          <li
            className={`sidebar-item ${view.kind === 'log' ? 'active' : ''}`}
            onClick={onSelectLog}
          >
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
  const { entries, loading, error, reload } = useEntries(vaultPath)
  const [view, setView] = useState<View>({ kind: 'log' })

  const openEntry = useCallback((entry: VaultEntry) => {
    setView({ kind: 'note', entry })
  }, [])

  const backToLog = useCallback(() => {
    setView({ kind: 'log' })
    reload()
  }, [reload])

  if (!vaultPath) {
    return <VaultPicker onPick={pickVault} />
  }

  return (
    <div className="app">
      {view.kind === 'log' ? (
        <Stream entries={entries} loading={loading} error={error} onOpenEntry={openEntry} />
      ) : (
        <NoteEditor entry={view.entry} onBack={backToLog} onSaved={() => { /* no-op until we surface a toast */ }} />
      )}
      <div className="divider" />
      <Sidebar
        vaultPath={vaultPath}
        onChangeVault={pickVault}
        view={view}
        onSelectLog={backToLog}
      />
    </div>
  )
}
