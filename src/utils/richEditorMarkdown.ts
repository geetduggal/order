import type { useCreateBlockNote } from '@blocknote/react'
import { compactMarkdown } from './compact-markdown'
import { serializeDurableEditorBlocks } from './editorDurableMarkdown'
import { portableFileAttachmentUrls } from './fileAttachmentMarkdown'
import { portableImageUrls } from './vaultImages'
import { restoreWikilinksInBlocks, splitFrontmatter } from './wikilinks'

export function serializeRichEditorBodyToMarkdown(
  editor: ReturnType<typeof useCreateBlockNote>,
): string {
  const restored = restoreWikilinksInBlocks(editor.document)
  return compactMarkdown(serializeDurableEditorBlocks(editor, restored))
}

export function serializeRichEditorDocumentToMarkdown(
  editor: ReturnType<typeof useCreateBlockNote>,
  tabContent: string,
  vaultPath?: string,
  notePath?: string,
): string {
  const rawBodyMarkdown = serializeRichEditorBodyToMarkdown(editor)
  const bodyMarkdown = vaultPath
    ? portableFileAttachmentUrls(
      portableImageUrls(rawBodyMarkdown, vaultPath, notePath),
      vaultPath,
    )
    : rawBodyMarkdown
  const [frontmatter] = splitFrontmatter(tabContent)
  return `${frontmatter}${bodyMarkdown}`
}
