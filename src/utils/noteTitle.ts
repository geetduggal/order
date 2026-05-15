import { parseFrontmatter } from './frontmatter'
import { splitFrontmatter } from './wikilinks'

interface ResolvedContentTitle {
  source: 'h1' | 'frontmatter'
  title: string
}

interface DisplayTitleInput {
  content: string
  filename: string
  frontmatterTitle?: string | null
}

interface DisplayTitleState {
  title: string
  hasH1: boolean
}

function replaceWikilinkAliases(text: string): string {
  return text.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, '$1')
}

function replacePlainWikilinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, '$1')
}

function replaceMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

function removeInlineMarkdownMarkers(text: string): string {
  return text.replace(/[*_`~]/g, '')
}

function stripMarkdownFormatting(text: string): string {
  return removeInlineMarkdownMarkers(
    replaceMarkdownLinks(
      replacePlainWikilinks(
        replaceWikilinkAliases(text),
      ),
    ),
  )
}

export function filenameStemToTitle(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '')
  return stem
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function extractH1TitleFromContent(content: string): string | null {
  const [, body] = splitFrontmatter(content)

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!trimmed.startsWith('# ')) return null
    const title = stripMarkdownFormatting(trimmed.slice(2)).trim()
    return title || null
  }

  return null
}

export function extractFrontmatterTitleFromContent(content: string): string | null {
  const title = parseFrontmatter(content).title
  if (typeof title !== 'string') return null
  const trimmed = title.trim()
  return trimmed || null
}

function resolveContentTitle(content: string, frontmatterTitle?: string | null): ResolvedContentTitle | null {
  const h1Title = extractH1TitleFromContent(content)
  if (h1Title) {
    return { title: h1Title, source: 'h1' }
  }

  const resolvedFrontmatterTitle = frontmatterTitle?.trim() || extractFrontmatterTitleFromContent(content)
  if (resolvedFrontmatterTitle) {
    return { title: resolvedFrontmatterTitle, source: 'frontmatter' }
  }

  return null
}

export function contentDefinesDisplayTitle(content: string): boolean {
  return resolveContentTitle(content) !== null
}

export function deriveDisplayTitleState({
  content,
  filename,
  frontmatterTitle,
}: DisplayTitleInput): DisplayTitleState {
  const resolvedTitle = resolveContentTitle(content, frontmatterTitle)
  if (resolvedTitle) {
    return {
      title: resolvedTitle.title,
      hasH1: resolvedTitle.source === 'h1',
    }
  }

  return {
    title: filenameStemToTitle(filename),
    hasH1: false,
  }
}
