import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  bindingsEqual,
  findConflict,
  matchesShortcut,
  formatBinding,
  mergeWithDefaults,
  isReservedBinding,
  isTextEditingTarget,
  isArrowKeyOwningTarget,
  DEFAULT_SHORTCUTS,
  FIXED_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABEL_KEYS,
  TRANSPORT_SHORTCUT_KEYS,
  ZOOM_DEPTH_SHORTCUT_KEYS,
  type ShortcutBinding,
  type ShortcutsConfig,
} from './shortcuts'

// ---------------------------------------------------------------------------
// bindingsEqual
// ---------------------------------------------------------------------------
describe('bindingsEqual', () => {
  it('matches identical simple bindings', () => {
    expect(bindingsEqual({ key: 'z' }, { key: 'z' })).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(bindingsEqual({ key: 'Z' }, { key: 'z' })).toBe(true)
    expect(bindingsEqual({ key: 'a' }, { key: 'A' })).toBe(true)
  })

  it('matches identical modifier bindings', () => {
    expect(bindingsEqual({ key: 'd', ctrl: true }, { key: 'd', ctrl: true })).toBe(true)
  })

  it('treats undefined modifiers as false', () => {
    expect(bindingsEqual({ key: 'z' }, { key: 'z', ctrl: false, shift: false, alt: false })).toBe(
      true,
    )
  })

  it('rejects different keys', () => {
    expect(bindingsEqual({ key: 'z' }, { key: 'x' })).toBe(false)
  })

  it('rejects different modifiers', () => {
    expect(bindingsEqual({ key: 'z', ctrl: true }, { key: 'z' })).toBe(false)
    expect(bindingsEqual({ key: 'z', shift: true }, { key: 'z' })).toBe(false)
    expect(bindingsEqual({ key: 'z', alt: true }, { key: 'z' })).toBe(false)
  })

  it('rejects when only one has shift', () => {
    expect(bindingsEqual({ key: 'z', ctrl: true, shift: true }, { key: 'z', ctrl: true })).toBe(
      false,
    )
  })
})

// ---------------------------------------------------------------------------
// findConflict
// ---------------------------------------------------------------------------
describe('findConflict', () => {
  const config: ShortcutsConfig = { ...DEFAULT_SHORTCUTS }

  it('returns null when no conflict exists', () => {
    expect(findConflict({ key: 'q' }, 'addZoom', config)).toBeNull()
  })

  it('detects configurable conflict', () => {
    // 'a' is assigned to addAnnotation
    const result = findConflict({ key: 'a' }, 'addZoom', config)
    expect(result).toEqual({ type: 'configurable', action: 'addAnnotation' })
  })

  it('excludes self from conflict check', () => {
    // 'z' is addZoom — assigning 'z' to addZoom should not conflict
    expect(findConflict({ key: 'z' }, 'addZoom', config)).toBeNull()
  })

  it('detects fixed shortcut conflict', () => {
    // Ctrl+Z is undo (fixed)
    const result = findConflict({ key: 'z', ctrl: true }, 'addZoom', config)
    expect(result).not.toBeNull()
    expect(result?.type).toBe('fixed')
  })

  it('detects fixed arrow key conflict', () => {
    const result = findConflict({ key: 'arrowright' }, 'playPause', config)
    expect(result).toEqual({ type: 'fixed', labelKey: 'shortcuts.seekForward' })
  })

  it('detects fixed frame-step key conflict', () => {
    expect(findConflict({ key: ',' }, 'playPause', config)).toEqual({
      type: 'fixed',
      labelKey: 'shortcuts.frameBack',
    })
    expect(findConflict({ key: '.' }, 'playPause', config)).toEqual({
      type: 'fixed',
      labelKey: 'shortcuts.frameForward',
    })
  })

  it('keeps every default binding clear of the fixed shortcuts', () => {
    for (const action of SHORTCUT_ACTIONS) {
      const conflict = findConflict(DEFAULT_SHORTCUTS[action], action, DEFAULT_SHORTCUTS)
      expect(conflict, `${action} default collides`).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// matchesShortcut
// ---------------------------------------------------------------------------
describe('matchesShortcut', () => {
  const makeEvent = (overrides: Partial<KeyboardEvent>): KeyboardEvent =>
    ({
      key: '',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...overrides,
    }) as unknown as KeyboardEvent

  it('matches simple key', () => {
    expect(matchesShortcut(makeEvent({ key: 'z' }), { key: 'z' }, false)).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(matchesShortcut(makeEvent({ key: 'Z' }), { key: 'z' }, false)).toBe(true)
  })

  it('matches Ctrl key on Linux', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', ctrlKey: true }), { key: 'd', ctrl: true }, false),
    ).toBe(true)
  })

  it('matches Meta (Cmd) key on Mac', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', metaKey: true }), { key: 'd', ctrl: true }, true),
    ).toBe(true)
  })

  it('rejects Ctrl on Mac when binding has ctrl (expects Meta)', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'd', ctrlKey: true }), { key: 'd', ctrl: true }, true),
    ).toBe(false)
  })

  it('rejects when extra modifier is held', () => {
    // Binding is just 'z', but Ctrl is held
    expect(matchesShortcut(makeEvent({ key: 'z', ctrlKey: true }), { key: 'z' }, false)).toBe(false)
  })

  it('rejects when required modifier is missing', () => {
    expect(matchesShortcut(makeEvent({ key: 'd' }), { key: 'd', ctrl: true }, false)).toBe(false)
  })

  it('matches shift+key', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'a', shiftKey: true }), { key: 'a', shift: true }, false),
    ).toBe(true)
  })

  it('matches alt+key', () => {
    expect(
      matchesShortcut(makeEvent({ key: 'x', altKey: true }), { key: 'x', alt: true }, false),
    ).toBe(true)
  })

  it('matches space key', () => {
    expect(matchesShortcut(makeEvent({ key: ' ' }), { key: ' ' }, false)).toBe(true)
  })

  it('rejects wrong key', () => {
    expect(matchesShortcut(makeEvent({ key: 'x' }), { key: 'z' }, false)).toBe(false)
  })

  it('rejects Ctrl+Z on Mac when binding has no modifiers', () => {
    // Physical Ctrl on Mac should not match a bare key binding
    expect(matchesShortcut(makeEvent({ key: 'z', ctrlKey: true }), { key: 'z' }, true)).toBe(false)
  })

  it('rejects Meta+Z on Linux when binding has no modifiers', () => {
    expect(matchesShortcut(makeEvent({ key: 'z', metaKey: true }), { key: 'z' }, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// formatBinding
// ---------------------------------------------------------------------------
describe('formatBinding', () => {
  it('formats a single key in uppercase', () => {
    expect(formatBinding({ key: 'z' }, false)).toBe('Z')
  })

  it('formats Ctrl+key for Linux', () => {
    expect(formatBinding({ key: 'd', ctrl: true }, false)).toBe('Ctrl + D')
  })

  it('formats Cmd+key for Mac', () => {
    expect(formatBinding({ key: 'd', ctrl: true }, true)).toBe('⌘ + D')
  })

  it('formats Shift+key for Linux', () => {
    expect(formatBinding({ key: 'a', shift: true }, false)).toBe('Shift + A')
  })

  it('formats Shift+key for Mac with symbol', () => {
    expect(formatBinding({ key: 'a', shift: true }, true)).toBe('⇧ + A')
  })

  it('formats Alt+key for Linux', () => {
    expect(formatBinding({ key: 'x', alt: true }, false)).toBe('Alt + X')
  })

  it('formats Alt+key for Mac with symbol', () => {
    expect(formatBinding({ key: 'x', alt: true }, true)).toBe('⌥ + X')
  })

  it('formats multi-modifier binding', () => {
    expect(formatBinding({ key: 'z', ctrl: true, shift: true }, false)).toBe('Ctrl + Shift + Z')
    expect(formatBinding({ key: 'z', ctrl: true, shift: true }, true)).toBe('⌘ + ⇧ + Z')
  })

  it('formats special keys', () => {
    expect(formatBinding({ key: ' ' }, false)).toBe('Space')
    expect(formatBinding({ key: 'arrowleft' }, false)).toBe('←')
    expect(formatBinding({ key: 'arrowright' }, false)).toBe('→')
    expect(formatBinding({ key: 'delete' }, false)).toBe('Del')
    expect(formatBinding({ key: 'backspace' }, false)).toBe('⌫')
    expect(formatBinding({ key: 'escape' }, false)).toBe('Esc')
  })

  it('formats bracket keys', () => {
    expect(formatBinding({ key: ']' }, false)).toBe(']')
    expect(formatBinding({ key: '[' }, false)).toBe('[')
  })
})

// ---------------------------------------------------------------------------
// mergeWithDefaults
// ---------------------------------------------------------------------------
describe('mergeWithDefaults', () => {
  it('returns defaults when given empty object', () => {
    const result = mergeWithDefaults({})
    expect(result).toEqual(DEFAULT_SHORTCUTS)
  })

  it('preserves overridden keys', () => {
    const result = mergeWithDefaults({ addZoom: { key: 'q' } })
    expect(result.addZoom).toEqual({ key: 'q' })
    // Other keys should be defaults
    expect(result.addAnnotation).toEqual(DEFAULT_SHORTCUTS.addAnnotation)
  })

  it('fills missing keys from defaults', () => {
    const partial: Partial<ShortcutsConfig> = {
      playPause: { key: 'p' },
    }
    const result = mergeWithDefaults(partial)
    expect(result.playPause).toEqual({ key: 'p' })
    for (const action of SHORTCUT_ACTIONS) {
      if (action !== 'playPause') {
        expect(result[action]).toEqual(DEFAULT_SHORTCUTS[action])
      }
    }
  })

  it('ignores invalid entries without key property', () => {
    const result = mergeWithDefaults({ addZoom: { bad: true } as unknown as ShortcutBinding })
    expect(result.addZoom).toEqual(DEFAULT_SHORTCUTS.addZoom)
  })

  it('preserves full config as-is', () => {
    // Plain 1-6 are the fixed zoom-depth keys, so a saved config may not hold
    // them; every binding here is one a user could still assign today.
    const full: ShortcutsConfig = {
      addZoom: { key: 'q' },
      addAnnotation: { key: 'w' },
      addBlur: { key: 'b', shift: true },
      addKeyframe: { key: 'e' },
      toggleScissors: { key: 'r' },
      deleteSelected: { key: '5', ctrl: true },
      playPause: { key: '7' },
      speedUp: { key: '8' },
      speedDown: { key: '9' },
      copySelected: { key: '0', ctrl: true },
      paste: { key: 'v', ctrl: true, alt: true },
      openApp: { key: 'o', ctrl: true, alt: true },
      stopRecording: { key: 'r', ctrl: true, alt: true },
      markMoment: { key: 'm', ctrl: true, alt: true },
    }
    expect(mergeWithDefaults(full)).toEqual(full)
  })
})

// ---------------------------------------------------------------------------
// Reserved bindings — configs saved before a binding became fixed
// ---------------------------------------------------------------------------
describe('reserved bindings in a saved config', () => {
  it('drops a saved deleteSelected of Ctrl+D, which now duplicates a region', () => {
    // Ctrl/Cmd+D was the shipped default before the duplicate shortcut took
    // it. Keeping it would delete AND duplicate the selection on one press,
    // because the two run from separate keydown listeners.
    const merged = mergeWithDefaults({ deleteSelected: { key: 'd', ctrl: true } })
    expect(merged.deleteSelected).toEqual({ key: 'delete' })
    expect(merged.deleteSelected).toEqual(DEFAULT_SHORTCUTS.deleteSelected)
  })

  it('keeps a custom binding that collides with nothing fixed', () => {
    const merged = mergeWithDefaults({
      deleteSelected: { key: 'd', ctrl: true, shift: true },
      addZoom: { key: 'q' },
    })
    expect(merged.deleteSelected).toEqual({ key: 'd', ctrl: true, shift: true })
    expect(merged.addZoom).toEqual({ key: 'q' })
  })

  it('drops the transport and zoom-depth keys, whatever action saved them', () => {
    const merged = mergeWithDefaults({
      playPause: { key: 'k' },
      addZoom: { key: '3' },
      speedUp: { key: 'l' },
      speedDown: { key: 'j' },
    })
    expect(merged.playPause).toEqual(DEFAULT_SHORTCUTS.playPause)
    expect(merged.addZoom).toEqual(DEFAULT_SHORTCUTS.addZoom)
    expect(merged.speedUp).toEqual(DEFAULT_SHORTCUTS.speedUp)
    expect(merged.speedDown).toEqual(DEFAULT_SHORTCUTS.speedDown)
  })

  it('isReservedBinding matches only on the exact modifier combination', () => {
    expect(isReservedBinding({ key: 'd', ctrl: true })).toBe(true)
    expect(isReservedBinding({ key: 'D', ctrl: true })).toBe(true)
    expect(isReservedBinding({ key: '4' })).toBe(true)
    expect(isReservedBinding({ key: 'j' })).toBe(true)
    // The same keys with another modifier stay assignable.
    expect(isReservedBinding({ key: 'd' })).toBe(false)
    expect(isReservedBinding({ key: 'd', ctrl: true, shift: true })).toBe(false)
    expect(isReservedBinding({ key: '4', ctrl: true })).toBe(false)
    expect(isReservedBinding({ key: 'j', alt: true })).toBe(false)
  })

  it('leaves every default assignable, so no default is silently reset', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(isReservedBinding(DEFAULT_SHORTCUTS[action])).toBe(false)
    }
    expect(mergeWithDefaults(DEFAULT_SHORTCUTS)).toEqual(DEFAULT_SHORTCUTS)
  })

  it('refuses a reserved binding in the config dialog, via findConflict', () => {
    // The dialog shows shortcuts.conflictFixed and declines the capture.
    const conflict = findConflict({ key: 'd', ctrl: true }, 'deleteSelected', DEFAULT_SHORTCUTS)
    expect(conflict).toEqual({ type: 'fixed', labelKey: 'shortcuts.duplicateRegion' })
    expect(findConflict({ key: 'k' }, 'playPause', DEFAULT_SHORTCUTS)).toEqual({
      type: 'fixed',
      labelKey: 'shortcuts.transportPause',
    })
    expect(
      findConflict({ key: 'd', ctrl: true, shift: true }, 'deleteSelected', DEFAULT_SHORTCUTS),
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Default bindings — copy/paste actions and conflict-freeness
// ---------------------------------------------------------------------------
describe('DEFAULT_SHORTCUTS', () => {
  it('binds copy and paste to the platform primary modifier', () => {
    expect(DEFAULT_SHORTCUTS.copySelected).toEqual({ key: 'c', ctrl: true })
    expect(DEFAULT_SHORTCUTS.paste).toEqual({ key: 'v', ctrl: true })
  })

  it('has a label key for every action', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(SHORTCUT_LABEL_KEYS[action]).toMatch(/^shortcuts\./)
    }
  })

  it('has no conflicts between any default bindings', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(findConflict(DEFAULT_SHORTCUTS[action], action, DEFAULT_SHORTCUTS)).toBeNull()
    }
  })

  it('keeps old shortcuts.json files valid by filling in the new actions', () => {
    const legacy = { addZoom: { key: 'q' } } as Partial<ShortcutsConfig>
    const merged = mergeWithDefaults(legacy)
    expect(merged.copySelected).toEqual(DEFAULT_SHORTCUTS.copySelected)
    expect(merged.paste).toEqual(DEFAULT_SHORTCUTS.paste)
  })

  it('leaves Ctrl/Cmd+D to the fixed duplicate shortcut and deletes with Delete', () => {
    expect(DEFAULT_SHORTCUTS.deleteSelected).toEqual({ key: 'delete' })
    expect(findConflict({ key: 'd', ctrl: true }, 'addZoom', DEFAULT_SHORTCUTS)).toEqual({
      type: 'fixed',
      labelKey: 'shortcuts.duplicateRegion',
    })
  })
})

// ---------------------------------------------------------------------------
// Fixed table — the shortcuts P2-B added
// ---------------------------------------------------------------------------
describe('FIXED_SHORTCUTS', () => {
  const byLabel = (labelKey: string) => FIXED_SHORTCUTS.find((f) => f.labelKey === labelKey)

  it('has a label key and a display string for every entry', () => {
    for (const fixed of FIXED_SHORTCUTS) {
      expect(fixed.labelKey).toMatch(/^shortcuts\./)
      expect(fixed.display.length).toBeGreaterThan(0)
    }
  })

  it('lists the zoom level keys 1-6', () => {
    expect(ZOOM_DEPTH_SHORTCUT_KEYS).toEqual(['1', '2', '3', '4', '5', '6'])
    const entry = byLabel('shortcuts.zoomLevel')
    expect(entry?.bindings).toEqual([
      { key: '1' },
      { key: '2' },
      { key: '3' },
      { key: '4' },
      { key: '5' },
      { key: '6' },
    ])
    // A plain digit is reserved; the stop-recording accelerator carries
    // modifiers, so it is not caught by the reservation.
    expect(findConflict({ key: '3' }, 'addZoom', DEFAULT_SHORTCUTS)).toEqual({
      type: 'fixed',
      labelKey: 'shortcuts.zoomLevel',
    })
    expect(
      findConflict({ key: '2', ctrl: true, shift: true }, 'stopRecording', DEFAULT_SHORTCUTS),
    ).toBeNull()
  })

  it('lists J / K / L transport and the duplicate combo', () => {
    expect(TRANSPORT_SHORTCUT_KEYS).toEqual({ slower: 'j', pause: 'k', faster: 'l' })
    expect(byLabel('shortcuts.transportSlower')?.bindings).toEqual([{ key: 'j' }])
    expect(byLabel('shortcuts.transportPause')?.bindings).toEqual([{ key: 'k' }])
    expect(byLabel('shortcuts.transportFaster')?.bindings).toEqual([{ key: 'l' }])
    expect(byLabel('shortcuts.duplicateRegion')?.bindings).toEqual([{ key: 'd', ctrl: true }])
  })

  it('matches the transport keys only without modifiers', () => {
    const press = (init: Partial<KeyboardEvent> & { key: string }) =>
      ({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...init,
      }) as unknown as KeyboardEvent
    const j = byLabel('shortcuts.transportSlower')?.bindings[0]
    if (!j) throw new Error('missing transport binding')
    expect(matchesShortcut(press({ key: 'j' }), j, false)).toBe(true)
    expect(matchesShortcut(press({ key: 'J' }), j, false)).toBe(true)
    expect(matchesShortcut(press({ key: 'j', ctrlKey: true }), j, false)).toBe(false)
    expect(matchesShortcut(press({ key: 'j', shiftKey: true }), j, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isTextEditingTarget — node env has no DOM, so stub the element classes
// ---------------------------------------------------------------------------
describe('isTextEditingTarget', () => {
  class FakeHTMLElement {
    isContentEditable = false
  }
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}

  const g = globalThis as Record<string, unknown>
  const saved = {
    HTMLElement: g.HTMLElement,
    HTMLInputElement: g.HTMLInputElement,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
  }

  beforeEach(() => {
    g.HTMLElement = FakeHTMLElement
    g.HTMLInputElement = FakeHTMLInputElement
    g.HTMLTextAreaElement = FakeHTMLTextAreaElement
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete g[name]
      else g[name] = value
    }
  })

  it('returns true for inputs and textareas', () => {
    expect(isTextEditingTarget(new FakeHTMLInputElement() as unknown as EventTarget)).toBe(true)
    expect(isTextEditingTarget(new FakeHTMLTextAreaElement() as unknown as EventTarget)).toBe(true)
  })

  it('returns true for contentEditable elements only', () => {
    const editable = new FakeHTMLElement()
    editable.isContentEditable = true
    expect(isTextEditingTarget(editable as unknown as EventTarget)).toBe(true)
    expect(isTextEditingTarget(new FakeHTMLElement() as unknown as EventTarget)).toBe(false)
  })

  it('returns false for null and non-element targets', () => {
    expect(isTextEditingTarget(null)).toBe(false)
    expect(isTextEditingTarget({} as EventTarget)).toBe(false)
  })

  it('returns false when no DOM is available at all', () => {
    delete g.HTMLElement
    delete g.HTMLInputElement
    delete g.HTMLTextAreaElement
    expect(isTextEditingTarget({} as EventTarget)).toBe(false)
  })
})

describe('isArrowKeyOwningTarget', () => {
  /** Minimal element: `closest` answers by matching the role/tag it was built with. */
  class FakeHTMLElement {
    isContentEditable = false
    constructor(private readonly selectors: string[] = []) {}
    closest(selector: string): FakeHTMLElement | null {
      const wanted = selector.split(',').map((s) => s.trim())
      return this.selectors.some((own) => wanted.includes(own)) ? this : null
    }
  }
  class FakeHTMLInputElement extends FakeHTMLElement {}
  class FakeHTMLTextAreaElement extends FakeHTMLElement {}

  const g = globalThis as Record<string, unknown>
  const saved = {
    HTMLElement: g.HTMLElement,
    HTMLInputElement: g.HTMLInputElement,
    HTMLTextAreaElement: g.HTMLTextAreaElement,
  }

  beforeEach(() => {
    g.HTMLElement = FakeHTMLElement
    g.HTMLInputElement = FakeHTMLInputElement
    g.HTMLTextAreaElement = FakeHTMLTextAreaElement
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete g[name]
      else g[name] = value
    }
  })

  it('treats text-editing surfaces as owning the arrow keys', () => {
    expect(isArrowKeyOwningTarget(new FakeHTMLInputElement() as unknown as EventTarget)).toBe(true)
    const editable = new FakeHTMLElement()
    editable.isContentEditable = true
    expect(isArrowKeyOwningTarget(editable as unknown as EventTarget)).toBe(true)
  })

  it('treats sliders, selects and other arrow-driven ARIA widgets as owners', () => {
    for (const own of [
      '[role="slider"]',
      'select',
      '[role="listbox"]',
      '[role="tab"]',
      '[role="menuitem"]',
    ]) {
      expect(
        isArrowKeyOwningTarget(new FakeHTMLElement([own]) as unknown as EventTarget),
        own,
      ).toBe(true)
    }
  })

  it('lets plain elements, buttons and the document body through', () => {
    expect(isArrowKeyOwningTarget(new FakeHTMLElement() as unknown as EventTarget)).toBe(false)
    expect(isArrowKeyOwningTarget(new FakeHTMLElement(['button']) as unknown as EventTarget)).toBe(
      false,
    )
    expect(isArrowKeyOwningTarget(null)).toBe(false)
    expect(isArrowKeyOwningTarget({} as EventTarget)).toBe(false)
  })
})
