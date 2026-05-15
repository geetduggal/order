import { renderHook, act } from '@testing-library/react'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useNoteListKeyboard } from './useNoteListKeyboard'
import type { VaultEntry } from '../types'

function makeEntry(path: string, title: string): VaultEntry {
  return {
    path,
    title,
    filename: `${title}.md`,
    isA: 'Note',
    aliases: [],
    tags: [],
    snippet: '',
    status: null,
    favorite: false,
    archived: false,
    createdAt: null,
    modifiedAt: null,
    fileSize: 100,
    color: null,
    icon: null,
    template: null, sort: null,
    outgoingLinks: [],
    relationships: {},
  }
}

function keyEvent(key: string, opts: Partial<React.KeyboardEvent> = {}): React.KeyboardEvent {
  return { key, preventDefault: vi.fn(), metaKey: false, ctrlKey: false, altKey: false, ...opts } as unknown as React.KeyboardEvent
}

function installAnimationFrameStub() {
  let nextId = 1
  const callbacks = new Map<number, FrameRequestCallback>()

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextId++
    callbacks.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    callbacks.delete(id)
  })

  return {
    flushAnimationFrame: () => {
      const pending = [...callbacks.entries()]
      callbacks.clear()
      for (const [, callback] of pending) callback(0)
    },
  }
}

describe('useNoteListKeyboard', () => {
  const items = [makeEntry('/a.md', 'A'), makeEntry('/b.md', 'B'), makeEntry('/c.md', 'C')]
  const onOpen = vi.fn()
  let flushAnimationFrame: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    ;({ flushAnimationFrame } = installAnimationFrameStub())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('initializes with no highlight', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen, enabled: true }),
    )
    expect(result.current.highlightedPath).toBeNull()
  })

  it('ArrowDown highlights first item from no selection', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBe('/a.md')
    expect(open).not.toHaveBeenCalled()
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledWith(items[0])
  })

  it('ArrowDown advances highlight and opens the latest highlighted note on the next frame', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBe('/b.md')
    expect(open).not.toHaveBeenCalled()
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(items[1])
  })

  it('ArrowDown clamps at end of list', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBe('/c.md')
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(items[2])
  })

  it('ArrowUp highlights last item from no selection', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowUp')))
    expect(result.current.highlightedPath).toBe('/c.md')
    expect(open).not.toHaveBeenCalled()
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledWith(items[2])
  })

  it('scrolls the highlighted item into view with nearest-style behavior', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    const scrollIntoView = vi.fn()
    result.current.virtuosoRef.current = { scrollIntoView } as never

    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))

    expect(scrollIntoView).toHaveBeenCalledWith({ index: 0, behavior: 'auto' })
  })

  it('ArrowUp clamps at start of list', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowUp')))
    expect(result.current.highlightedPath).toBe('/a.md')
  })

  it('Enter opens highlighted note', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('Enter')))
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(items[0])
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('Enter does nothing when no item highlighted', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('Enter')))
    expect(open).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen, enabled: false }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBeNull()
  })

  it('does nothing with modifier keys', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown', { metaKey: true } as Partial<React.KeyboardEvent>)))
    expect(result.current.highlightedPath).toBeNull()
  })

  it('resets highlight when items change', () => {
    const { result, rerender } = renderHook(
      ({ items: hookItems }) => useNoteListKeyboard({ items: hookItems, selectedNotePath: null, onOpen, enabled: true }),
      { initialProps: { items } },
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBe('/a.md')

    rerender({ items: [makeEntry('/d.md', 'D')] })
    expect(result.current.highlightedPath).toBeNull()
  })

  it('handleFocus sets highlight to selected note', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: '/b.md', onOpen, enabled: true }),
    )
    act(() => result.current.handleFocus())
    expect(result.current.highlightedPath).toBe('/b.md')
  })

  it('handleFocus defaults to first item when no selected note', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen, enabled: true }),
    )
    act(() => result.current.handleFocus())
    expect(result.current.highlightedPath).toBe('/a.md')
  })

  it('does nothing on empty item list', () => {
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items: [], selectedNotePath: null, onOpen, enabled: true }),
    )
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    expect(result.current.highlightedPath).toBeNull()
  })

  it('responds to global arrow keys when no editable element is focused', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })

    expect(result.current.highlightedPath).toBe('/a.md')
    act(() => flushAnimationFrame())
    expect(open).toHaveBeenCalledWith(items[0])
  })

  it('ignores global arrow keys while an editable element is focused', () => {
    const open = vi.fn()
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    document.body.appendChild(editor)
    editor.focus()

    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    })

    expect(result.current.highlightedPath).toBeNull()
    expect(open).not.toHaveBeenCalled()

    editor.remove()
  })

  it('coalesces rapid arrow navigation into a single open for the latest highlighted note', () => {
    const open = vi.fn()
    const { result } = renderHook(() =>
      useNoteListKeyboard({ items, selectedNotePath: null, onOpen: open, enabled: true }),
    )

    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))
    act(() => result.current.handleKeyDown(keyEvent('ArrowDown')))

    expect(result.current.highlightedPath).toBe('/c.md')
    expect(open).not.toHaveBeenCalled()

    act(() => flushAnimationFrame())

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(items[2])
  })
})
