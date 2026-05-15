import { afterEach, describe, it, expect, vi } from 'vitest'
import { evaluateView } from './viewFilters'
import type { VaultEntry, ViewDefinition } from '../types'

const NOW = Math.floor(Date.now() / 1000)

function makeEntry(overrides: Partial<VaultEntry>): VaultEntry {
  return {
    path: '/vault/test.md', filename: 'test.md', title: 'Test', isA: null,
    aliases: [], belongsTo: [], relatedTo: [], status: null,
    archived: false,
    modifiedAt: NOW, createdAt: NOW, fileSize: 100, snippet: '',
    wordCount: 0, relationships: {}, icon: null, color: null,
    order: null, sidebarLabel: null, template: null, sort: null, view: null,
    visible: null, favorite: false, favoriteIndex: null,
    outgoingLinks: [], properties: {}, listPropertiesDisplay: [],
    ...overrides,
  }
}

describe('evaluateView', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('filters by type equals', () => {
    const view: ViewDefinition = {
      name: 'Projects', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'type', op: 'equals', value: 'Project' }] },
    }
    const entries = [
      makeEntry({ isA: 'Project', title: 'P1' }),
      makeEntry({ isA: 'Note', title: 'N1' }),
      makeEntry({ isA: 'Project', title: 'P2' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['P1', 'P2'])
  })

  it('filters by status not_equals', () => {
    const view: ViewDefinition = {
      name: 'Active', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'status', op: 'not_equals', value: 'done' }] },
    }
    const entries = [
      makeEntry({ status: 'active', title: 'A' }),
      makeEntry({ status: 'done', title: 'D' }),
      makeEntry({ status: null, title: 'N' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['A', 'N'])
  })

  it('filters by relationship contains wikilink', () => {
    const view: ViewDefinition = {
      name: 'Related', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Related to', op: 'contains', value: '[[laputa-app]]' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', relationships: { 'Related to': ['[[laputa-app|Laputa App]]', '[[other]]'] } }),
      makeEntry({ title: 'No match', relationships: { 'Related to': ['[[something]]'] } }),
      makeEntry({ title: 'No rels', relationships: {} }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('evaluates nested AND/OR groups', () => {
    const view: ViewDefinition = {
      name: 'Complex', icon: null, color: null, sort: null,
      filters: {
        any: [
          { all: [{ field: 'type', op: 'equals', value: 'Project' }, { field: 'status', op: 'equals', value: 'active' }] },
          { all: [{ field: 'type', op: 'equals', value: 'Event' }] },
        ],
      },
    }
    const entries = [
      makeEntry({ isA: 'Project', status: 'active', title: 'Active Proj' }),
      makeEntry({ isA: 'Project', status: 'done', title: 'Done Proj' }),
      makeEntry({ isA: 'Event', title: 'My Event' }),
      makeEntry({ isA: 'Note', title: 'Random' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Active Proj', 'My Event'])
  })

  it('filters by is_empty and is_not_empty', () => {
    const view: ViewDefinition = {
      name: 'Has Status', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'status', op: 'is_not_empty' }] },
    }
    const entries = [
      makeEntry({ status: 'active', title: 'Has' }),
      makeEntry({ status: null, title: 'Null' }),
      makeEntry({ status: '', title: 'Empty' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Has'])
  })

  it('excludes archived entries', () => {
    const view: ViewDefinition = {
      name: 'All', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'type', op: 'equals', value: 'Note' }] },
    }
    const entries = [
      makeEntry({ isA: 'Note', title: 'Active' }),
      makeEntry({ isA: 'Note', title: 'Archived', archived: true }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Active'])
  })

  it('filters by property field', () => {
    const view: ViewDefinition = {
      name: 'By Owner', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Owner', op: 'equals', value: 'Luca' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', properties: { Owner: 'Luca' } }),
      makeEntry({ title: 'Other', properties: { Owner: 'Brian' } }),
      makeEntry({ title: 'None', properties: {} }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('filters with any_of operator', () => {
    const view: ViewDefinition = {
      name: 'Multi', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'status', op: 'any_of', value: ['active', 'in progress'] }] },
    }
    const entries = [
      makeEntry({ status: 'active', title: 'A' }),
      makeEntry({ status: 'In Progress', title: 'B' }),
      makeEntry({ status: 'done', title: 'C' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['A', 'B'])
  })

  it('contains on relationship uses substring match for plain text', () => {
    const view: ViewDefinition = {
      name: 'Monday', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: 'Monday' }] },
    }
    const entries = [
      makeEntry({ title: 'A', relationships: { 'belongs to': ['[[Monday Ideas]]'] } }),
      makeEntry({ title: 'B', relationships: { 'belongs to': ['[[Monday Recap]]'] } }),
      makeEntry({ title: 'C', relationships: { 'belongs to': ['[[Tuesday Ideas]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['A', 'B'])
  })

  it('not_contains on relationship uses substring match for plain text', () => {
    const view: ViewDefinition = {
      name: 'Not Monday', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'not_contains', value: 'Monday' }] },
    }
    const entries = [
      makeEntry({ title: 'A', relationships: { 'belongs to': ['[[Monday Ideas]]'] } }),
      makeEntry({ title: 'B', relationships: { 'belongs to': ['[[Tuesday Ideas]]'] } }),
      makeEntry({ title: 'C', relationships: { 'belongs to': [] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['B', 'C'])
  })

  it('contains on relationship uses exact match for wikilink syntax', () => {
    const view: ViewDefinition = {
      name: 'Exact', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: '[[Monday Ideas]]' }] },
    }
    const entries = [
      makeEntry({ title: 'A', relationships: { 'belongs to': ['[[Monday Ideas]]'] } }),
      makeEntry({ title: 'B', relationships: { 'belongs to': ['[[Monday Recap]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['A'])
  })

  it('equals on relationship matches a single-item array by stem', () => {
    const view: ViewDefinition = {
      name: 'session-trail', icon: null, color: null, sort: null,
      filters: {
        any: [
          { field: 'belongs_to', op: 'equals', value: 'svc-session-trail' },
          { field: 'related_to', op: 'equals', value: 'svc-session-trail' },
        ],
      },
    }
    const entries = [
      makeEntry({ title: 'Matches', relationships: { related_to: ['[[svc-session-trail]]'] } }),
      makeEntry({ title: 'Bracketed value also matches', relationships: { related_to: ['[[svc-session-trail|Trail]]'] } }),
      makeEntry({ title: 'Other relation', relationships: { related_to: ['[[unrelated]]'] } }),
      makeEntry({ title: 'No rels', relationships: {} }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Matches', 'Bracketed value also matches'])
  })

  it('equals on relationship requires a single-item array (mirrors Rust semantics)', () => {
    const view: ViewDefinition = {
      name: 'single', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'related_to', op: 'equals', value: 'svc-session-trail' }] },
    }
    const entries = [
      makeEntry({ title: 'Single', relationships: { related_to: ['[[svc-session-trail]]'] } }),
      makeEntry({ title: 'Multiple', relationships: { related_to: ['[[svc-session-trail]]', '[[other]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Single'])
  })

  it('not_equals on relationship is the inverse of equals', () => {
    const view: ViewDefinition = {
      name: 'not-equals', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'related_to', op: 'not_equals', value: 'svc-session-trail' }] },
    }
    const entries = [
      makeEntry({ title: 'Single match', relationships: { related_to: ['[[svc-session-trail]]'] } }),
      makeEntry({ title: 'Multiple', relationships: { related_to: ['[[svc-session-trail]]', '[[other]]'] } }),
      makeEntry({ title: 'Other', relationships: { related_to: ['[[unrelated]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Multiple', 'Other'])
  })

  it('any_of / none_of on relationship always use exact stem match', () => {
    const view: ViewDefinition = {
      name: 'Exact list', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'any_of', value: ['[[Monday]]'] }] },
    }
    const entries = [
      makeEntry({ title: 'Exact', relationships: { 'belongs to': ['[[Monday]]'] } }),
      makeEntry({ title: 'Partial', relationships: { 'belongs to': ['[[Monday Ideas]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Exact'])
  })

  it('before operator works with ISO date strings in properties', () => {
    const view: ViewDefinition = {
      name: 'Before', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Date', op: 'before', value: '2024-06-01' }] },
    }
    const entries = [
      makeEntry({ title: 'Early', properties: { Date: '2024-03-15' } }),
      makeEntry({ title: 'Late', properties: { Date: '2024-09-01' } }),
      makeEntry({ title: 'NoDate', properties: {} }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Early'])
  })

  it('after operator works with ISO date strings in properties', () => {
    const view: ViewDefinition = {
      name: 'After', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Date', op: 'after', value: '2024-06-01' }] },
    }
    const entries = [
      makeEntry({ title: 'Early', properties: { Date: '2024-03-15' } }),
      makeEntry({ title: 'Late', properties: { Date: '2024-09-01' } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Late'])
  })

  it('before/after works with ISO datetime strings', () => {
    const view: ViewDefinition = {
      name: 'Before datetime', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Date', op: 'before', value: '2024-03-15T12:00:00' }] },
    }
    const entries = [
      makeEntry({ title: 'Morning', properties: { Date: '2024-03-15T08:00:00' } }),
      makeEntry({ title: 'Evening', properties: { Date: '2024-03-15T18:00:00' } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Morning'])
  })

  it('before/after works with numeric Unix timestamps', () => {
    const view: ViewDefinition = {
      name: 'After ts', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Date', op: 'after', value: '2024-01-01' }] },
    }
    // Unix timestamp for 2024-06-15 in seconds
    const ts = Math.floor(new Date('2024-06-15').getTime() / 1000)
    const entries = [
      makeEntry({ title: 'Match', properties: { Date: ts } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('before/after accept natural-language relative date phrases', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-07T12:00:00Z'))

    const view: ViewDefinition = {
      name: 'Recent', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'Date', op: 'after', value: '10 days ago' }] },
    }
    const entries = [
      makeEntry({ title: 'Older', properties: { Date: '2026-03-20' } }),
      makeEntry({ title: 'Recent', properties: { Date: '2026-03-30' } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Recent'])
  })

  it('body contains filters on snippet text (case-insensitive)', () => {
    const view: ViewDefinition = {
      name: 'Body search', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'body', op: 'contains', value: 'quarterly' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', snippet: 'This is the quarterly review summary' }),
      makeEntry({ title: 'No match', snippet: 'Daily standup notes' }),
      makeEntry({ title: 'Case match', snippet: 'QUARTERLY PLANNING session' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match', 'Case match'])
  })

  it('body not_contains excludes matching notes', () => {
    const view: ViewDefinition = {
      name: 'Body exclude', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'body', op: 'not_contains', value: 'draft' }] },
    }
    const entries = [
      makeEntry({ title: 'Final', snippet: 'Final version of the document' }),
      makeEntry({ title: 'Draft', snippet: 'This is a draft version' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Final'])
  })

  it('body filter combines with property filters (AND)', () => {
    const view: ViewDefinition = {
      name: 'Combined', icon: null, color: null, sort: null,
      filters: { all: [
        { field: 'type', op: 'equals', value: 'Note' },
        { field: 'body', op: 'contains', value: 'important' },
      ] },
    }
    const entries = [
      makeEntry({ title: 'Yes', isA: 'Note', snippet: 'This is important content' }),
      makeEntry({ title: 'Wrong type', isA: 'Project', snippet: 'This is important content' }),
      makeEntry({ title: 'No match', isA: 'Note', snippet: 'Regular content' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Yes'])
  })

  it('wikilink filter matches frontmatter with alias via path', () => {
    const view: ViewDefinition = {
      name: 'By path', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: '[[monday-112]]' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', relationships: { 'belongs to': ['[[monday-112|Monday #112]]'] } }),
      makeEntry({ title: 'No match', relationships: { 'belongs to': ['[[tuesday-200|Tuesday]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('wikilink filter matches frontmatter with alias via alias', () => {
    const view: ViewDefinition = {
      name: 'By alias', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: '[[Monday #112]]' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', relationships: { 'belongs to': ['[[monday-112|Monday #112]]'] } }),
      makeEntry({ title: 'No match', relationships: { 'belongs to': ['[[tuesday-200|Tuesday]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('wikilink filter with stem|title format matches frontmatter path', () => {
    const view: ViewDefinition = {
      name: 'Stem format', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: '[[monday-112|Monday 112]]' }] },
    }
    const entries = [
      makeEntry({ title: 'Match', relationships: { 'belongs to': ['[[monday-112|Monday #112]]'] } }),
      makeEntry({ title: 'No match', relationships: { 'belongs to': ['[[other]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('any_of on relationship uses alias matching', () => {
    const view: ViewDefinition = {
      name: 'Any of', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'any_of', value: ['[[monday-112|Monday 112]]'] }] },
    }
    const entries = [
      makeEntry({ title: 'Match', relationships: { 'belongs to': ['[[monday-112|Monday #112]]'] } }),
      makeEntry({ title: 'No', relationships: { 'belongs to': ['[[other]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Match'])
  })

  it('body is_empty matches notes with empty snippet', () => {
    const view: ViewDefinition = {
      name: 'Empty body', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'body', op: 'is_empty' }] },
    }
    const entries = [
      makeEntry({ title: 'Empty', snippet: '' }),
      makeEntry({ title: 'Has content', snippet: 'Some text here' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Empty'])
  })

  it('supports regex matching on scalar fields', () => {
    const view: ViewDefinition = {
      name: 'Regex title', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'title', op: 'contains', value: '^alpha\\s+project$', regex: true }] },
    }
    const entries = [
      makeEntry({ title: 'Alpha Project' }),
      makeEntry({ title: 'Alpha Notes' }),
      makeEntry({ title: 'alpha project' }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Alpha Project', 'alpha project'])
  })

  it('supports regex matching on relationship aliases and stems', () => {
    const view: ViewDefinition = {
      name: 'Regex relationship', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'belongs to', op: 'contains', value: 'monday-(112|113)|Monday #112', regex: true }] },
    }
    const entries = [
      makeEntry({ title: 'Alias match', relationships: { 'belongs to': ['[[monday-112|Monday #112]]'] } }),
      makeEntry({ title: 'Stem match', relationships: { 'belongs to': ['[[monday-113]]'] } }),
      makeEntry({ title: 'No match', relationships: { 'belongs to': ['[[tuesday-200|Tuesday]]'] } }),
    ]
    const result = evaluateView(view, entries)
    expect(result.map((e) => e.title)).toEqual(['Alias match', 'Stem match'])
  })

  it('treats invalid regex filters as matching nothing', () => {
    const view: ViewDefinition = {
      name: 'Broken regex', icon: null, color: null, sort: null,
      filters: { all: [{ field: 'title', op: 'contains', value: '(', regex: true }] },
    }
    const entries = [
      makeEntry({ title: 'Alpha Project' }),
      makeEntry({ title: 'Beta Project' }),
    ]
    const result = evaluateView(view, entries)
    expect(result).toEqual([])
  })
})
