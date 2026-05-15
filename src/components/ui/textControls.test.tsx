import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Input } from './input'
import { Textarea } from './textarea'

describe('text controls', () => {
  it('disables native text assistance on inputs by default', () => {
    render(<Input aria-label="Search" />)

    const input = screen.getByLabelText('Search')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input).toHaveAttribute('autocorrect', 'off')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('autocapitalize', 'off')
  })

  it('disables native text assistance on textareas by default', () => {
    render(<Textarea aria-label="Message" />)

    const textarea = screen.getByLabelText('Message')
    expect(textarea).toHaveAttribute('spellcheck', 'false')
    expect(textarea).toHaveAttribute('autocorrect', 'off')
    expect(textarea).toHaveAttribute('autocomplete', 'off')
    expect(textarea).toHaveAttribute('autocapitalize', 'off')
  })
})
