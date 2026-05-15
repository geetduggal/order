import { useEffect, type RefObject } from 'react'
import { openEditorAttachmentOrUrl } from './editorAttachmentActions'

const CODE_CONTEXT_SELECTOR = '[data-content-type="codeBlock"], pre, code'

function hasFollowModifier(event: KeyboardEvent | MouseEvent) {
  return event.metaKey || event.ctrlKey
}

function isInsideCodeContext(target: HTMLElement) {
  return !!target.closest(CODE_CONTEXT_SELECTOR)
}

function elementFromEventTarget(target: EventTarget | null) {
  if (target instanceof HTMLElement) return target
  if (target instanceof Text) return target.parentElement
  return null
}

function resolveWikilinkTarget(target: HTMLElement) {
  return target.closest<HTMLElement>('.wikilink[data-target]')?.dataset.target ?? null
}

function resolveAnchorHref(target: HTMLElement) {
  return target.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href')?.trim() ?? null
}

function blurActiveEditable(container: HTMLElement) {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !container.contains(active)) return
  const editable = active.isContentEditable ? active : active.closest<HTMLElement>('[contenteditable="true"]')
  editable?.blur()
}

function setFollowLinksActive(container: HTMLElement, active: boolean) {
  if (active) container.setAttribute('data-follow-links', '')
  else container.removeAttribute('data-follow-links')
}

function consumeEditorLinkEvent(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
}

function scheduleAfterNativeClick(callback: () => void) {
  if (typeof queueMicrotask === 'function') queueMicrotask(callback)
  else window.setTimeout(callback, 0)
}

function activateWikilink(
  event: MouseEvent,
  container: HTMLElement,
  target: string,
  onNavigateWikilink: (target: string) => void,
) {
  consumeEditorLinkEvent(event)

  if (!hasFollowModifier(event)) return

  blurActiveEditable(container)
  scheduleAfterNativeClick(() => onNavigateWikilink(target))
}

function activateUrl(event: MouseEvent, href: string, vaultPath?: string) {
  consumeEditorLinkEvent(event)

  if (!hasFollowModifier(event)) return

  openEditorAttachmentOrUrl({ url: href, vaultPath, source: 'link' })
}

function handleEditorLinkClick(
  event: MouseEvent,
  container: HTMLElement,
  onNavigateWikilink: (target: string) => void,
  vaultPath?: string,
) {
  const target = elementFromEventTarget(event.target)
  if (!target || isInsideCodeContext(target)) return

  const wikilinkTarget = resolveWikilinkTarget(target)
  if (wikilinkTarget) {
    activateWikilink(event, container, wikilinkTarget, onNavigateWikilink)
    return
  }

  const href = resolveAnchorHref(target)
  if (href) activateUrl(event, href, vaultPath)
}

function handleEditorLinkMouseDown(event: MouseEvent, vaultPath?: string): string | null {
  const target = elementFromEventTarget(event.target)
  if (!target || isInsideCodeContext(target)) return null

  if (resolveWikilinkTarget(target)) {
    consumeEditorLinkEvent(event)
    return null
  }

  const href = resolveAnchorHref(target)
  if (hasFollowModifier(event) && href) {
    activateUrl(event, href, vaultPath)
    return href
  }

  return null
}

function followedAnchorHrefFromEvent(event: MouseEvent, fallback: HTMLElement) {
  if (!hasFollowModifier(event)) return null

  return resolveAnchorHref(elementFromEventTarget(event.target) ?? fallback)
}

export function useEditorLinkActivation(
  containerRef: RefObject<HTMLDivElement | null>,
  onNavigateWikilink: (target: string) => void,
  vaultPath?: string,
) {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resetModifierState = () => setFollowLinksActive(container, false)
    const handleModifierChange = (event: KeyboardEvent) => {
      setFollowLinksActive(container, hasFollowModifier(event))
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') resetModifierState()
    }
    let handledMouseDownUrl: string | null = null
    const rememberHandledMouseDownUrl = (href: string) => {
      handledMouseDownUrl = href
      window.setTimeout(() => {
        if (handledMouseDownUrl === href) handledMouseDownUrl = null
      }, 0)
    }
    const handleMouseDown = (event: MouseEvent) => {
      const href = handleEditorLinkMouseDown(event, vaultPath)
      if (href) rememberHandledMouseDownUrl(href)
    }
    const handleClick = (event: MouseEvent) => {
      const followedHref = followedAnchorHrefFromEvent(event, container)
      if (handledMouseDownUrl && followedHref === handledMouseDownUrl) {
        handledMouseDownUrl = null
        consumeEditorLinkEvent(event)
        return
      }

      handledMouseDownUrl = null
      handleEditorLinkClick(event, container, onNavigateWikilink, vaultPath)
    }

    container.addEventListener('mousedown', handleMouseDown, true)
    container.addEventListener('click', handleClick, true)
    window.addEventListener('keydown', handleModifierChange)
    window.addEventListener('keyup', handleModifierChange)
    window.addEventListener('blur', resetModifierState)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      container.removeEventListener('mousedown', handleMouseDown, true)
      container.removeEventListener('click', handleClick, true)
      window.removeEventListener('keydown', handleModifierChange)
      window.removeEventListener('keyup', handleModifierChange)
      window.removeEventListener('blur', resetModifierState)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      resetModifierState()
    }
  }, [containerRef, onNavigateWikilink, vaultPath])
}
