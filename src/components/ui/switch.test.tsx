// @vitest-environment jsdom
//
// The editor's panels are near-black, so an unchecked switch that borrows the
// panel background reads as empty space rather than as a control. These pin the
// two colours that keep it visible.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Switch } from './switch'

afterEach(() => {
  cleanup()
})

describe('Switch', () => {
  it('gives the unchecked track a colour that stands off a dark panel', () => {
    render(<Switch checked={false} onCheckedChange={vi.fn()} aria-label="Clip to canvas" />)
    const track = screen.getByRole('switch')

    expect(track).toHaveAttribute('data-state', 'unchecked')
    expect(track.className).toContain('data-[state=unchecked]:bg-[#52525b]')
    expect(track.className).toContain('data-[state=checked]:bg-[#34B27B]')
  })

  it('keeps the thumb white in both states', () => {
    render(<Switch checked onCheckedChange={vi.fn()} aria-label="Clip to canvas" />)
    const thumb = screen.getByRole('switch').firstElementChild

    expect(thumb?.className).toContain('bg-white')
    expect(thumb?.className).not.toContain('dark:bg-[#23232a]')
  })

  it('still reports changes', () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Clip to canvas" />)

    fireEvent.click(screen.getByRole('switch'))
    expect(onCheckedChange).toHaveBeenCalledWith(true)
  })
})
