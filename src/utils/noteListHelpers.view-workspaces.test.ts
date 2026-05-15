import { describe, expect, it } from 'vitest'
import type { ViewFile, WorkspaceIdentity } from '../types'
import { makeEntry } from '../test-utils/noteListTestUtils'
import { filterEntries } from './noteListHelpers'

function workspace(path: string, label: string): WorkspaceIdentity {
  return {
    id: label.toLowerCase(),
    label,
    alias: label.toLowerCase(),
    path,
    shortLabel: label.slice(0, 2).toUpperCase(),
    color: null,
    icon: null,
    mounted: true,
    available: true,
    defaultForNewNotes: false,
  }
}

function focusView(rootPath: string, label: string): ViewFile {
  return {
    filename: 'focus.yml',
    rootPath,
    workspace: workspace(rootPath, label),
    definition: {
      name: `${label} Focus`,
      icon: null,
      color: null,
      sort: null,
      filters: { all: [{ field: 'type', op: 'equals', value: 'Note' }] },
    },
  }
}

describe('view filtering across workspaces', () => {
  it('matches duplicate view filenames by root path and scopes results to that workspace', () => {
    const personal = workspace('/personal', 'Personal')
    const team = workspace('/team', 'Team')
    const entries = [
      makeEntry({ title: 'Personal Alpha', path: '/personal/alpha.md', isA: 'Note', workspace: personal }),
      makeEntry({ title: 'Team Alpha', path: '/team/alpha.md', isA: 'Note', workspace: team }),
    ]

    const result = filterEntries(
      entries,
      { kind: 'view', filename: 'focus.yml', rootPath: '/team' },
      { views: [focusView('/personal', 'Personal'), focusView('/team', 'Team')] },
    )

    expect(result.map((entry) => entry.title)).toEqual(['Team Alpha'])
  })
})
