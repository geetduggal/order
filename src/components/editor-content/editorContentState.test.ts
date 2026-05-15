import { describe, expect, it } from 'vitest'
import type { VaultEntry } from '../../types'
import { deriveEditorContentState, type EditorContentTab } from './editorContentState'

const baseEntry: VaultEntry = {
  path: '/vault/project/legacy-project.md',
  filename: 'legacy-project.md',
  title: 'Legacy Project',
  isA: 'Project',
  aliases: [],
  belongsTo: [],
  relatedTo: [],
  status: 'Active',
  archived: false,
  modifiedAt: 1700000000,
  createdAt: null,
  fileSize: 1024,
  snippet: '',
  wordCount: 0,
  relationships: {},
  icon: null,
  color: null,
  order: null,
  sidebarLabel: null,
  template: null,
  sort: null,
  view: null,
  visible: null,
  organized: false,
  favorite: false,
  favoriteIndex: null,
  listPropertiesDisplay: [],
  outgoingLinks: [],
  properties: {},
  hasH1: false,
}

function deriveState(tab: EditorContentTab | null, overrides?: Partial<VaultEntry>) {
  const entry = tab ? { ...baseEntry, ...overrides, ...tab.entry } : null
  return deriveEditorContentState({
    activeTab: entry ? { ...tab, entry } : null,
    entries: entry ? [entry] : [],
    rawMode: false,
    activeStatus: 'clean',
  })
}

describe('deriveEditorContentState', () => {
  it('marks loaded content with a top-level H1 as titled', () => {
    const state = deriveState({
      entry: baseEntry,
      content: '---\ntitle: Legacy Project\n---\n# Legacy Project\n\nBody',
    })

    expect(state.hasH1).toBe(true)
    expect(state.showEditor).toBe(true)
  })

  it('keeps editor content visible for notes without an H1', () => {
    const state = deriveState({
      entry: baseEntry,
      content: '---\ntitle: Legacy Project\n---\nBody without a heading',
    })

    expect(state.hasH1).toBe(false)
    expect(state.showEditor).toBe(true)
  })

  it('keeps editor content visible when a legacy frontmatter title exists', () => {
    const state = deriveState({
      entry: baseEntry,
      content: '---\ntitle: Spring 2026\nstatus: Active\n---\n## Goals',
    })

    expect(state.hasH1).toBe(false)
    expect(state.showEditor).toBe(true)
  })

  it('does not fall back to a separate title section when the filename drives the display title', () => {
    const state = deriveState({
      entry: baseEntry,
      content: '---\nstatus: Active\n---\nBody without a heading',
    })

    expect(state.hasH1).toBe(false)
    expect(state.showEditor).toBe(true)
  })

  it('keeps untitled drafts in the editor even before they get an H1', () => {
    const draftEntry = {
      ...baseEntry,
      path: '/vault/untitled-note-1700000000.md',
      filename: 'untitled-note-1700000000.md',
      title: 'Untitled Note 1700000000',
    }

    const state = deriveEditorContentState({
      activeTab: {
        entry: draftEntry,
        content: '---\ntype: Note\n---\n',
      },
      entries: [draftEntry],
      rawMode: false,
      activeStatus: 'unsaved',
    })

    expect(state.hasH1).toBe(false)
    expect(state.showEditor).toBe(true)
  })
})
