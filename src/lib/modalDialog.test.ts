// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { isModalDialogOpen } from './modalDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

function mount(html: string) {
  document.body.innerHTML = html
}

describe('isModalDialogOpen', () => {
  it('is false on a document with no dialog', () => {
    mount('<div id="editor"><button type="button">Play</button></div>')
    expect(isModalDialogOpen()).toBe(false)
  })

  it('is true while any element is marked aria-modal', () => {
    mount('<div role="dialog" aria-modal="true"><p>Crop video</p></div>')
    expect(isModalDialogOpen()).toBe(true)
  })

  it('finds a dialog rendered into a portal outside the app root', () => {
    mount('<div id="root"></div>')
    const portal = document.createElement('div')
    portal.innerHTML = '<div role="dialog" aria-modal="true">Export</div>'
    document.body.appendChild(portal)
    expect(isModalDialogOpen()).toBe(true)
  })

  it('ignores a non-modal dialog and a stale aria-modal="false"', () => {
    mount(
      '<div role="dialog" aria-modal="false">Inline panel</div><div role="dialog">Popover</div>',
    )
    expect(isModalDialogOpen()).toBe(false)
  })

  it('goes back to false once the dialog unmounts', () => {
    mount('<div role="dialog" aria-modal="true">Shortcuts</div>')
    expect(isModalDialogOpen()).toBe(true)
    document.body.innerHTML = ''
    expect(isModalDialogOpen()).toBe(false)
  })

  it('accepts an explicit document and treats a missing one as no dialog', () => {
    const other = document.implementation.createHTMLDocument('other')
    other.body.innerHTML = '<div aria-modal="true"></div>'
    expect(isModalDialogOpen(other)).toBe(true)
    expect(isModalDialogOpen(null)).toBe(false)
  })
})
