// @vitest-environment jsdom
//
// The editor decides whether to run a global shortcut by asking the document
// whether a modal dialog is open, so `aria-modal` on the dialog surface is a
// behavioural contract, not decoration. These tests pin both halves: the
// attribute is present while a dialog is open, and a shortcut listener written
// the way the editor writes one stays quiet underneath it.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isModalDialogOpen } from '@/lib/modalDialog'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog'

afterEach(() => {
  cleanup()
})

describe('DialogContent', () => {
  it('marks the open dialog aria-modal so the editor can see it', () => {
    expect(isModalDialogOpen()).toBe(false)

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Crop video</DialogTitle>
        </DialogContent>
      </Dialog>,
    )

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
    expect(isModalDialogOpen()).toBe(true)
  })

  it('reports no modal once the dialog closes', () => {
    const { rerender } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Shortcuts</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(isModalDialogOpen()).toBe(true)

    rerender(
      <Dialog open={false}>
        <DialogContent>
          <DialogTitle>Shortcuts</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(isModalDialogOpen()).toBe(false)
  })
})

/** A stand-in for the editor: one capture-phase shortcut, guarded like the real one. */
function ShortcutHarness({ onShortcut }: { onShortcut: () => void }) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isModalDialogOpen()) return
      if (e.key === ' ') onShortcut()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [onShortcut])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger>Open crop</DialogTrigger>
      <DialogContent>
        <DialogTitle>Crop video</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}

describe('editor shortcuts under a modal', () => {
  it('run normally, stop while the dialog is open, and resume after it closes', () => {
    const onShortcut = vi.fn()
    render(<ShortcutHarness onShortcut={onShortcut} />)

    fireEvent.keyDown(document.body, { key: ' ' })
    expect(onShortcut).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Open crop'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(onShortcut).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.keyDown(document.body, { key: ' ' })
    expect(onShortcut).toHaveBeenCalledTimes(2)
  })
})
