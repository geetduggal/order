import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEditorTheme } from './useTheme'

describe('useEditorTheme', () => {
  it('keeps inline code on the muted editor surface without exporting code block overrides', () => {
    const { result } = renderHook(() => useEditorTheme())

    expect(result.current.cssVars['--inline-styles-code-background-color']).toBe(
      'var(--bg-hover-subtle)'
    )
    expect(result.current.cssVars['--code-blocks-background-color']).toBeUndefined()
  })
})
