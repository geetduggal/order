import type { ReactElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react'
import { DynamicPropertiesPanel } from './DynamicPropertiesPanel'
import { FOCUS_NOTE_ICON_PROPERTY_EVENT } from './noteIconPropertyEvents'
import type { VaultEntry } from '../types'
import { TooltipProvider } from '@/components/ui/tooltip'

beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  if (!window.getComputedStyle) window.getComputedStyle = vi.fn().mockReturnValue({}) as never
})

const makeEntry = (overrides: Partial<VaultEntry> = {}): VaultEntry => ({
  path: '/vault/note.md',
  filename: 'note.md',
  title: 'Note',
  isA: 'Note',
  aliases: [],
  belongsTo: [],
  relatedTo: [],
  status: null,
  archived: false,
  modifiedAt: 0,
  createdAt: 0,
  fileSize: 0,
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
  hasH1: true,
  fileKind: 'markdown',
  ...overrides,
})

function hasSuggestedSlot(label: string): boolean {
  return screen
    .queryAllByTestId('suggested-property')
    .some((node) => node.textContent?.includes(label))
}

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: TooltipProvider })
}

describe('DynamicPropertiesPanel system metadata', () => {
  const onAddProperty = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the icon visible while hiding the other system metadata', () => {
    render(
      <DynamicPropertiesPanel
        entry={makeEntry()}
        content=""
        frontmatter={{
          _list_properties_display: ['Owner'],
          _icon: 'rocket',
          icon: 'legacy',
          order: 4,
          sort: 'title:asc',
          '_sidebar_label': 'Projects',
          Owner: 'Luca',
        }}
      />,
    )

    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Luca')).toBeInTheDocument()
    expect(screen.getByText('Icon')).toBeInTheDocument()
    expect(screen.getByTestId('icon-editable-display')).toHaveTextContent('rocket')
    expect(screen.queryByDisplayValue('legacy')).not.toBeInTheDocument()
    expect(screen.queryByText('Order')).not.toBeInTheDocument()
    expect(screen.queryByText('Sort')).not.toBeInTheDocument()
    expect(screen.queryByText('Sidebar label')).not.toBeInTheDocument()
  })

  it('treats _icon as satisfying the suggested icon slot', () => {
    render(
      <DynamicPropertiesPanel
        entry={makeEntry()}
        content=""
        frontmatter={{ _icon: 'rocket' }}
        onAddProperty={onAddProperty}
      />,
    )

    expect(hasSuggestedSlot('Icon')).toBe(false)
  })

  it('opens the icon editor without writing metadata until the user saves', async () => {
    render(
      <DynamicPropertiesPanel
        entry={makeEntry()}
        content=""
        frontmatter={{}}
        onAddProperty={onAddProperty}
      />,
    )

    act(() => {
      window.dispatchEvent(new CustomEvent(FOCUS_NOTE_ICON_PROPERTY_EVENT))
    })

    await waitFor(() => {
      expect(screen.getByTestId('icon-editable-input')).toBeInTheDocument()
    })
    expect(onAddProperty).not.toHaveBeenCalled()

    const input = screen.getByTestId('icon-editable-input')
    fireEvent.change(input, { target: { value: 'rocket' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAddProperty).toHaveBeenCalledWith('_icon', 'rocket')
  })

  it('renders an existing underscored icon property with the icon picker UI', () => {
    render(
      <DynamicPropertiesPanel
        entry={makeEntry()}
        content=""
        frontmatter={{ _icon: 'megaphone' }}
        onAddProperty={onAddProperty}
      />,
    )

    expect(screen.getByText('Icon')).toBeInTheDocument()
    expect(screen.getByTestId('icon-editable-display')).toHaveTextContent('megaphone')
  })
})
