import { describe, expect, it, vi } from 'vitest'
import {
  injectDurableEditorMarkdownBlocks,
  preProcessDurableEditorMarkdown,
} from './editorDurableMarkdown'
import { serializeRichEditorDocumentToMarkdown } from './richEditorMarkdown'

function makeEditor(document: unknown[]) {
  return {
    document,
    blocksToMarkdownLossy: vi.fn(() => ''),
  }
}

function parsePreprocessedParagraph(markdown: string) {
  return [{
    type: 'paragraph',
    content: [{ type: 'text', text: markdown.trim(), styles: {} }],
    children: [],
  }]
}

describe('file attachment Markdown roundtrip', () => {
  it('serializes file blocks as portable attachment links', () => {
    const editor = makeEditor([{
      type: 'file',
      props: {
        name: 'report.pdf',
        url: 'asset://localhost/%2Fvault%2Fattachments%2Freport.pdf',
      },
      children: [],
    }])

    expect(serializeRichEditorDocumentToMarkdown(
      editor as never,
      '---\ntitle: Note A\n---\n',
      '/vault',
      'a.md',
    )).toBe('---\ntitle: Note A\n---\n[report.pdf](attachments/report.pdf)\n')
  })

  it('rebuilds file blocks from standalone attachment links', () => {
    const preprocessed = preProcessDurableEditorMarkdown({
      markdown: '[report.pdf](attachments/report.pdf)\n',
    })

    expect(injectDurableEditorMarkdownBlocks(parsePreprocessedParagraph(preprocessed))).toEqual([
      expect.objectContaining({
        type: 'file',
        props: expect.objectContaining({
          name: 'report.pdf',
          url: 'attachments/report.pdf',
        }),
      }),
    ])
  })
})
