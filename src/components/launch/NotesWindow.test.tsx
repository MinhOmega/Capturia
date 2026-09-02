// @vitest-environment jsdom
//
// Stylesheet + legacy migration cases, plus the teleprompter mode: playback
// timing against a stubbed animation frame, the manual-scroll hold, restart,
// read-only locking, reading-position retention and preference persistence.
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TELEPROMPTER_MANUAL_SCROLL_HOLD_MS } from '@/lib/notesTeleprompter'
import { USER_PREFERENCES_STORAGE_KEY } from '@/lib/userPreferences'
import { getInitialNotesContent, NOTES_STORAGE_KEY, NotesWindow } from './NotesWindow'

const tiptapState = vi.hoisted(() => ({
  options: null as null | {
    content: string
    editable?: boolean
    onUpdate: (payload: { editor: { getHTML: () => string } }) => void
  },
  editor: null as Editor | null,
}))

vi.mock('@tiptap/react', () => ({
  useEditor: (options: typeof tiptapState.options) => {
    tiptapState.options = options
    return tiptapState.editor
  },
  EditorContent: ({
    editor: _editor,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { editor: Editor | null }) => <div {...props} />,
}))

vi.mock('@tiptap/starter-kit', () => ({ default: {} }))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: vi.fn(),
    t: (key: string, vars?: Record<string, string | number>) => {
      const short = key.replace(/^launch\.tooltips\.notesToolbar\./, '')
      return vars ? `${short}:${Object.values(vars).join(',')}` : short
    },
  }),
}))

function createStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size
    },
  }
}

const setEditable = vi.fn()

function createScrollElement(scrollHeight = 200, clientHeight = 100): HTMLElement {
  const element = document.createElement('div')
  Object.defineProperties(element, {
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
  })
  element.scrollTop = 0
  return element
}

function createEditor(scrollElement: HTMLElement = createScrollElement()): Editor {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const command of [
    'focus',
    'toggleBold',
    'toggleItalic',
    'toggleStrike',
    'toggleBulletList',
    'toggleOrderedList',
    'toggleBlockquote',
    'toggleCodeBlock',
  ]) {
    chain[command] = vi.fn(() => chain)
  }
  chain.run = vi.fn(() => true)

  return {
    can: () => ({ chain: () => chain }),
    chain: () => chain,
    isActive: () => false,
    on: vi.fn(),
    off: vi.fn(),
    setEditable,
    view: { dom: scrollElement },
  } as unknown as Editor
}

describe('NotesWindow content', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    })
    tiptapState.editor = createEditor()
    tiptapState.options = null
  })

  it('loads legacy plain-text notes as paragraphs and saves editor updates', () => {
    localStorage.setItem(NOTES_STORAGE_KEY, 'First\nSecond')
    render(<NotesWindow />)

    expect(tiptapState.options?.content).toBe('<p>First</p><p>Second</p>')
    act(() => {
      tiptapState.options?.onUpdate({
        editor: { getHTML: () => '<p>Updated</p>' },
      })
    })
    expect(localStorage.getItem(NOTES_STORAGE_KEY)).toBe('<p>Updated</p>')
  })

  it('passes stored HTML through untouched and starts empty otherwise', () => {
    expect(getInitialNotesContent({ getItem: () => null })).toBe('')
    expect(getInitialNotesContent({ getItem: () => '<p>Kept</p>' })).toBe('<p>Kept</p>')
    // Legacy text is escaped so angle brackets cannot turn into markup.
    expect(getInitialNotesContent({ getItem: () => 'a < b & c' })).toBe('<p>a &lt; b &amp; c</p>')
  })

  it('renders the formatting toolbar with the teleprompter off and editable', () => {
    render(<NotesWindow />)

    expect(screen.getByRole('button', { name: 'bold' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'codeBlock' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'teleprompter' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(screen.queryByTestId('notes-teleprompter-controls')).not.toBeInTheDocument()
    expect(screen.getByTestId('notes-editor')).toBeInTheDocument()
    expect(tiptapState.options?.editable).toBe(true)
  })
})

describe('NotesWindow teleprompter mode', () => {
  let scrollElement: HTMLElement
  let frameCallbacks: Map<number, FrameRequestCallback>
  let nextFrameId: number

  function flushNextFrame(timestamp: number): void {
    const entry = frameCallbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined
    if (!entry) {
      throw new Error('No animation frame was scheduled')
    }
    frameCallbacks.delete(entry[0])
    act(() => entry[1](timestamp))
  }

  function enableTeleprompter(): void {
    fireEvent.click(screen.getByRole('button', { name: 'teleprompter' }))
  }

  function play(): void {
    fireEvent.click(screen.getByRole('button', { name: 'play' }))
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    })
    setEditable.mockClear()

    scrollElement = createScrollElement()
    tiptapState.editor = createEditor(scrollElement)
    tiptapState.options = null

    frameCallbacks = new Map()
    nextFrameId = 1
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frameCallbacks.set(id, callback)
        return id
      }),
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => {
        frameCallbacks.delete(id)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('locks the note while on, shows the controls and unlocks when switched off', () => {
    render(<NotesWindow />)
    expect(setEditable).toHaveBeenLastCalledWith(true, false)

    enableTeleprompter()
    expect(setEditable).toHaveBeenLastCalledWith(false, false)
    expect(screen.getByTestId('notes-teleprompter-controls')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'bold' })).toBeDisabled()
    expect(screen.getByTestId('notes-editor')).toHaveAttribute('data-teleprompter', 'true')
    expect(screen.getByTestId('notes-editor')).toHaveStyle({ fontSize: '16px' })

    enableTeleprompter()
    expect(setEditable).toHaveBeenLastCalledWith(true, false)
    expect(screen.queryByTestId('notes-teleprompter-controls')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'bold' })).toBeEnabled()
    expect(screen.getByTestId('notes-editor').style.fontSize).toBe('')
  })

  it('starts paused, scrolls by elapsed time, follows the speed slider and pauses', () => {
    render(<NotesWindow />)
    enableTeleprompter()

    play()
    expect(screen.getByRole('button', { name: 'pause' })).toBeInTheDocument()

    flushNextFrame(0)
    expect(scrollElement.scrollTop).toBe(0)
    flushNextFrame(100)
    expect(scrollElement.scrollTop).toBe(4)

    // The slider changes the pace without restarting the loop.
    fireEvent.change(screen.getByRole('slider', { name: 'speed' }), { target: { value: '80' } })
    expect(screen.getByText('launch.notesTeleprompter.speedReadout:80')).toBeInTheDocument()
    expect(frameCallbacks.size).toBe(1)
    flushNextFrame(200)
    expect(scrollElement.scrollTop).toBe(12)

    fireEvent.click(screen.getByRole('button', { name: 'pause' }))
    expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument()
    expect(frameCallbacks.size).toBe(0)
  })

  it('stops at the bottom and replays from the top on the next play', () => {
    scrollElement.scrollTop = 96
    render(<NotesWindow />)
    enableTeleprompter()

    play()
    flushNextFrame(0)
    flushNextFrame(100)
    expect(scrollElement.scrollTop).toBe(100)
    expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument()
    expect(frameCallbacks.size).toBe(0)

    play()
    expect(scrollElement.scrollTop).toBe(0)
    flushNextFrame(1_000)
    flushNextFrame(1_100)
    expect(scrollElement.scrollTop).toBe(4)
  })

  it('waits after a wheel scroll and resumes from where the reader left it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(500)
    render(<NotesWindow />)
    enableTeleprompter()

    play()
    flushNextFrame(0)
    flushNextFrame(100)
    expect(scrollElement.scrollTop).toBe(4)

    scrollElement.scrollTop = 40
    fireEvent.wheel(scrollElement, { deltaY: 36 })

    flushNextFrame(600)
    expect(scrollElement.scrollTop).toBe(40)
    flushNextFrame(500 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    expect(scrollElement.scrollTop).toBe(40)
    flushNextFrame(600 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    expect(scrollElement.scrollTop).toBe(44)
    expect(screen.getByRole('button', { name: 'pause' })).toBeInTheDocument()
  })

  it('treats a scrollbar drag as a manual scroll through the drift check', () => {
    render(<NotesWindow />)
    enableTeleprompter()

    play()
    flushNextFrame(0)
    flushNextFrame(100)

    scrollElement.scrollTop = 60
    flushNextFrame(200)
    expect(scrollElement.scrollTop).toBe(60)
    flushNextFrame(200 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    flushNextFrame(300 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    expect(scrollElement.scrollTop).toBe(64)
  })

  it('restarts from the top while playing and while paused', () => {
    render(<NotesWindow />)
    enableTeleprompter()

    scrollElement.scrollTop = 50
    fireEvent.click(screen.getByRole('button', { name: 'restart' }))
    expect(scrollElement.scrollTop).toBe(0)

    play()
    flushNextFrame(0)
    flushNextFrame(1_000)
    expect(scrollElement.scrollTop).toBe(4)

    fireEvent.click(screen.getByRole('button', { name: 'restart' }))
    expect(scrollElement.scrollTop).toBe(0)
    flushNextFrame(1_100)
    expect(scrollElement.scrollTop).toBe(0)
    flushNextFrame(1_200)
    expect(scrollElement.scrollTop).toBe(4)
  })

  it('toggles playback with Space unless the note or a control has focus', () => {
    render(<NotesWindow />)

    // Off: Space is an ordinary key.
    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' })
    expect(screen.queryByRole('button', { name: 'pause' })).not.toBeInTheDocument()

    enableTeleprompter()
    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' })
    expect(screen.getByRole('button', { name: 'pause' })).toBeInTheDocument()

    // Inside the note body the key is left to the editor.
    document.body.appendChild(scrollElement)
    fireEvent.keyDown(scrollElement, { code: 'Space', key: ' ' })
    expect(screen.getByRole('button', { name: 'pause' })).toBeInTheDocument()

    // A focused button already handles Space itself.
    fireEvent.keyDown(screen.getByRole('button', { name: 'restart' }), { code: 'Space', key: ' ' })
    expect(screen.getByRole('button', { name: 'pause' })).toBeInTheDocument()

    fireEvent.keyDown(document.body, { code: 'Space', key: ' ' })
    expect(screen.getByRole('button', { name: 'play' })).toBeInTheDocument()
    scrollElement.remove()
  })

  it('keeps the relative reading position when the font size or the mode changes', () => {
    // Model the layout: the note grows 50 px per font step above the default 16 px,
    // so the height the component sees follows the style it just applied.
    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      get: () => {
        const fontSize = screen.getByTestId('notes-editor').style.fontSize
        return 200 + (fontSize ? (Number.parseInt(fontSize, 10) - 16) * 50 : 0)
      },
    })
    render(<NotesWindow />)
    scrollElement.scrollTop = 50
    enableTeleprompter()
    expect(scrollElement.scrollTop).toBe(50)

    // A larger font makes the note taller; the reader stays halfway down.
    fireEvent.click(screen.getByRole('button', { name: 'increaseFontSize' }))
    expect(screen.getByText('launch.notesTeleprompter.fontSizeReadout:18')).toBeInTheDocument()
    expect(scrollElement.scrollTop).toBe(100)

    // Switching off returns to the default size at the same relative spot.
    enableTeleprompter()
    expect(scrollElement.scrollTop).toBe(50)
  })

  it('mirrors the note only while the teleprompter is on', () => {
    render(<NotesWindow />)
    enableTeleprompter()

    fireEvent.click(screen.getByRole('button', { name: 'mirror' }))
    expect(screen.getByTestId('notes-editor')).toHaveAttribute('data-mirrored', 'true')
    enableTeleprompter()
    expect(screen.getByTestId('notes-editor')).toHaveAttribute('data-mirrored', 'false')
  })

  it('persists speed and font size, never playback, and writes nothing on mount', () => {
    render(<NotesWindow />)
    expect(localStorage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull()

    enableTeleprompter()
    play()
    expect(localStorage.getItem(USER_PREFERENCES_STORAGE_KEY)).toBeNull()

    fireEvent.change(screen.getByRole('slider', { name: 'speed' }), { target: { value: '65' } })
    fireEvent.click(screen.getByRole('button', { name: 'decreaseFontSize' }))
    const stored = JSON.parse(localStorage.getItem(USER_PREFERENCES_STORAGE_KEY) ?? '{}')
    expect(stored.notesTeleprompter).toEqual({ speed: 65, fontSize: 14 })
    expect(stored.isPlaying).toBeUndefined()
  })

  it('restores persisted speed and font size', () => {
    localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ notesTeleprompter: { speed: 90, fontSize: 30 } }),
    )
    render(<NotesWindow />)
    enableTeleprompter()

    expect(screen.getByRole('slider', { name: 'speed' })).toHaveValue('90')
    expect(screen.getByTestId('notes-editor')).toHaveStyle({ fontSize: '30px' })
  })
})

describe('NotesWindow stylesheet', () => {
  // The note body only scrolls because `.tiptap` carries `height: 100%` + `overflow-y: auto`.
  // Those rules reach the app through a side-effect import, and a side-effect import of a
  // *CSS module* is tree-shaken out of the production bundle: dev looked fine while the
  // packaged app let a long note grow past its slot, scroll the whole shell out of view and
  // take the toolbar with it. A plain `.css` import is always emitted.
  const read = (file: string) =>
    readFileSync(resolve(process.cwd(), 'src/components/launch', file), 'utf8')

  it('is imported as plain CSS, never as a CSS module', () => {
    const source = read('NotesWindow.tsx')

    expect(source).toMatch(/^import ['"]\.\/NotesWindow\.css['"]$/m)
    expect(source).not.toContain('.module.css')
  })

  it('keeps the note body a scroll container', () => {
    const css = read('NotesWindow.css')
    const body = css.match(/\.tiptap\s*\{[^}]*\}/)?.[0] ?? ''

    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })

  it('mirrors and locks the note through data attributes', () => {
    const css = read('NotesWindow.css')

    expect(css).toMatch(/\.notes-content\[data-mirrored='true'\]\s*\{[^}]*scaleX\(-1\)/)
    expect(css).toMatch(/\.notes-content\[data-teleprompter='true'\] \.tiptap\s*\{[^}]*caret-color/)
  })
})
