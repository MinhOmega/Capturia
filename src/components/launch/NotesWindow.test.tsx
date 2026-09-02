// @vitest-environment jsdom
//
// Ported from upstream main `NotesWindow.test.tsx` (stylesheet + legacy migration
// cases; the teleprompter cases are not ported).
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, render, screen } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getInitialNotesContent, NOTES_STORAGE_KEY, NotesWindow } from './NotesWindow'

const tiptapState = vi.hoisted(() => ({
  options: null as null | {
    content: string
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
    t: (key: string) => key.replace(/^launch\.tooltips\.notesToolbar\./, ''),
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

function createEditor(): Editor {
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

  it('renders the formatting toolbar', () => {
    render(<NotesWindow />)

    expect(screen.getByRole('button', { name: 'bold' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'codeBlock' })).toBeEnabled()
    expect(screen.getByTestId('notes-editor')).toBeInTheDocument()
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
})
