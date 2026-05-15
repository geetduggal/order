import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useEditorTabSwap } from './useEditorTabSwap'
import type { VaultEntry } from '../types'

const initialBlocks = [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }]

function makeTab(path: string, title: string) {
  return {
    entry: { path, title, filename: `${title}.md`, type: 'Note', status: 'Active', aliases: [], isA: '' } as VaultEntry,
    content: `---\ntitle: ${title}\n---\n\n# ${title}\n\nBody of ${title}.`,
  }
}

function makeMockEditor(docRef: { current: unknown[] }) {
  const editor = {
    get document() { return docRef.current },
    get prosemirrorView() { return {} },
    onMount: (cb: () => void) => { cb(); return () => {} },
    replaceBlocks: vi.fn((_old, newBlocks) => { docRef.current = newBlocks }),
    blocksToMarkdownLossy: vi.fn(() => ''),
    tryParseMarkdownToBlocks: vi.fn(() => initialBlocks),
  }
  return editor
}

function installEditorDomSpies() {
  vi.spyOn(document, 'querySelector').mockReturnValue({ scrollTop: 0 } as unknown as Element)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0)
    return 0
  })
}

async function flushEditorTick() {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

describe('useEditorTabSwap rich-editor serialization performance', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not reserialize when local rich-editor content catches up to tab state', async () => {
    installEditorDomSpies()
    const tab = makeTab('a.md', 'Note A')
    const onContentChange = vi.fn()
    const docRef = { current: initialBlocks as unknown[] }
    const editor = makeMockEditor(docRef)
    let currentTabs = [tab]

    const { result, rerender } = renderHook(
      ({ tabs }) => useEditorTabSwap({
        tabs,
        activeTabPath: 'a.md',
        rawMode: false,
        editor: editor as never,
        onContentChange,
      }),
      { initialProps: { tabs: currentTabs } },
    )
    await flushEditorTick()

    docRef.current = [{
      type: 'paragraph',
      content: [{ type: 'text', text: 'Changed body', styles: {} }],
      children: [],
    }]
    editor.blocksToMarkdownLossy.mockReturnValue('Changed body\n')
    editor.blocksToMarkdownLossy.mockClear()

    act(() => {
      result.current.handleEditorChange()
      result.current.flushPendingEditorChange()
    })

    expect(editor.blocksToMarkdownLossy).toHaveBeenCalledTimes(1)
    const nextContent = onContentChange.mock.calls[0][1] as string
    currentTabs = [{ ...tab, content: nextContent }]
    rerender({ tabs: currentTabs })
    await flushEditorTick()

    expect(editor.blocksToMarkdownLossy).toHaveBeenCalledTimes(1)
  })
})
