import {
  hasDurableMarkdownBlocks,
  injectDurableMarkdownBlocks,
  preProcessDurableMarkdownBlocks,
  serializeDurableMarkdownBlocks,
  type MarkdownSerializer,
} from './durableMarkdownBlocks'
import {
  hasFileAttachmentBlocks,
  injectFileAttachmentBlocks,
  preProcessFileAttachmentMarkdown,
  serializeFileAttachmentBlocks,
} from './fileAttachmentMarkdown'
import { serializeMathAwareBlocks } from './mathMarkdown'
import { mermaidMarkdownCodec } from './mermaidMarkdown'
import { tldrawMarkdownCodec } from './tldrawMarkdown'

const EDITOR_DURABLE_MARKDOWN_CODECS = [
  mermaidMarkdownCodec,
  tldrawMarkdownCodec,
] as const

export function preProcessDurableEditorMarkdown({ markdown }: { markdown: string }): string {
  const withDurableBlocks = preProcessDurableMarkdownBlocks({
    markdown,
    codecs: EDITOR_DURABLE_MARKDOWN_CODECS,
  })
  return preProcessFileAttachmentMarkdown({ markdown: withDurableBlocks })
}

export function injectDurableEditorMarkdownBlocks(blocks: unknown[]): unknown[] {
  const withDurableBlocks = injectDurableMarkdownBlocks({
    blocks,
    codecs: EDITOR_DURABLE_MARKDOWN_CODECS,
  })
  return injectFileAttachmentBlocks(withDurableBlocks)
}

export function serializeDurableEditorBlocks(editor: MarkdownSerializer, blocks: unknown[]): string {
  return serializeFileAttachmentBlocks({
    blocks,
    serializeOrdinaryBlocks: ordinaryBlocks => serializeDurableMarkdownBlocks({
      blocks: ordinaryBlocks,
      codecs: EDITOR_DURABLE_MARKDOWN_CODECS,
      serializeOrdinaryBlocks: durableOrdinaryBlocks => serializeMathAwareBlocks(editor, durableOrdinaryBlocks),
    }),
  })
}

export function hasDurableEditorBlocks(blocks: unknown[]): boolean {
  return hasFileAttachmentBlocks(blocks) || hasDurableMarkdownBlocks({
    blocks,
    codecs: EDITOR_DURABLE_MARKDOWN_CODECS,
  })
}
