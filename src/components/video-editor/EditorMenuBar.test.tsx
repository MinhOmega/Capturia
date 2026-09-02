// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildEditorMenuModel,
  EditorMenuBar,
  type EditorMenuBarProps,
  formatShiftShortcut,
  formatShortcut,
} from './EditorMenuBar'

const LABELS: Record<string, string> = {
  'common.actions.file': 'File',
  'common.actions.edit': 'Edit',
  'common.actions.view': 'View',
  'common.actions.help': 'Help',
  'common.actions.quit': 'Quit',
  'common.actions.undo': 'Undo',
  'common.actions.redo': 'Redo',
  'common.actions.reload': 'Reload',
  'common.actions.importVideo': 'Import Video…',
  'common.actions.export': 'Export…',
  'common.actions.returnToRecorder': 'Return to Recorder',
  'common.actions.keyboardShortcuts': 'Keyboard Shortcuts…',
  'common.actions.toggleTimeline': 'Toggle Timeline',
  'common.actions.toggleSettings': 'Toggle Settings Panel',
  'common.actions.saveDiagnostics': 'Save Diagnostics…',
  'common.actions.reportIssue': 'Report an Issue…',
  'common.actions.about': 'About Capturia',
}

function makeProps(overrides: Partial<EditorMenuBarProps> = {}): EditorMenuBarProps {
  return {
    isMac: false,
    t: (key: string) => LABELS[key] ?? key,
    onImportVideo: vi.fn(),
    onExport: vi.fn(),
    onReturnToRecorder: vi.fn(),
    onQuit: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onKeyboardShortcuts: vi.fn(),
    onToggleTimeline: vi.fn(),
    onToggleSettings: vi.fn(),
    onReload: vi.fn(),
    onSaveDiagnostics: vi.fn(),
    onReportIssue: vi.fn(),
    onAbout: vi.fn(),
    canUndo: true,
    canRedo: true,
    timelineVisible: true,
    settingsVisible: false,
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('formatShortcut', () => {
  it('uses Ctrl on non-mac and the ⌘ symbol on mac', () => {
    expect(formatShortcut(false, 'O')).toBe('Ctrl+O')
    expect(formatShortcut(true, 'O')).toBe('⌘O')
  })

  it('formats shift combos per platform', () => {
    expect(formatShiftShortcut(false, 'T')).toBe('Ctrl+Shift+T')
    expect(formatShiftShortcut(true, 'T')).toBe('⌘⇧T')
  })
})

describe('buildEditorMenuModel', () => {
  it('returns the File, Edit, View and Help menus with translated labels', () => {
    const model = buildEditorMenuModel(makeProps())
    expect(model.map((m) => m.id)).toEqual(['file', 'edit', 'view', 'help'])
    expect(model.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Help'])
  })

  it('wires each item to its handler', () => {
    const props = makeProps()
    const byId = Object.fromEntries(
      buildEditorMenuModel(props)
        .flatMap((m) => m.items)
        .map((i) => [i.id, i]),
    )

    byId['import-video'].onSelect()
    byId.export.onSelect()
    byId['return-to-recorder'].onSelect()
    byId.quit.onSelect()
    byId.undo.onSelect()
    byId.redo.onSelect()
    byId['keyboard-shortcuts'].onSelect()
    byId['toggle-timeline'].onSelect()
    byId['toggle-settings'].onSelect()
    byId.reload.onSelect()
    byId['report-issue'].onSelect()
    byId['save-diagnostics'].onSelect()
    byId.about.onSelect()

    expect(props.onImportVideo).toHaveBeenCalledOnce()
    expect(props.onExport).toHaveBeenCalledOnce()
    expect(props.onReturnToRecorder).toHaveBeenCalledOnce()
    expect(props.onQuit).toHaveBeenCalledOnce()
    expect(props.onUndo).toHaveBeenCalledOnce()
    expect(props.onRedo).toHaveBeenCalledOnce()
    expect(props.onKeyboardShortcuts).toHaveBeenCalledOnce()
    expect(props.onToggleTimeline).toHaveBeenCalledOnce()
    expect(props.onToggleSettings).toHaveBeenCalledOnce()
    expect(props.onReload).toHaveBeenCalledOnce()
    expect(props.onReportIssue).toHaveBeenCalledOnce()
    expect(props.onSaveDiagnostics).toHaveBeenCalledOnce()
    expect(props.onAbout).toHaveBeenCalledOnce()
  })

  it('marks Quit as a destructive item after a separator', () => {
    const [file] = buildEditorMenuModel(makeProps())
    const quit = file.items.find((i) => i.id === 'quit')
    expect(quit).toMatchObject({ danger: true, separatorBefore: true })
  })

  it('shows Ctrl-based shortcut hints on non-mac', () => {
    const model = buildEditorMenuModel(makeProps({ isMac: false }))
    const shortcuts = Object.fromEntries(
      model.flatMap((m) => m.items).map((i) => [i.id, i.shortcut]),
    )
    expect(shortcuts).toMatchObject({
      'import-video': 'Ctrl+O',
      export: 'Ctrl+E',
      quit: 'Ctrl+Q',
      undo: 'Ctrl+Z',
      redo: 'Ctrl+Y',
      'toggle-timeline': 'Ctrl+Shift+T',
      'toggle-settings': 'Ctrl+Shift+P',
      reload: 'Ctrl+R',
    })
    expect(shortcuts['return-to-recorder']).toBeUndefined()
  })

  it('shows ⌘-based shortcut hints on mac (redo uses ⌘⇧Z)', () => {
    const model = buildEditorMenuModel(makeProps({ isMac: true }))
    const shortcuts = Object.fromEntries(
      model.flatMap((m) => m.items).map((i) => [i.id, i.shortcut]),
    )
    expect(shortcuts).toMatchObject({
      'import-video': '⌘O',
      export: '⌘E',
      undo: '⌘Z',
      redo: '⌘⇧Z',
      'toggle-timeline': '⌘⇧T',
      reload: '⌘R',
    })
  })

  it('disables Undo/Redo according to canUndo/canRedo', () => {
    const model = buildEditorMenuModel(makeProps({ canUndo: false, canRedo: false }))
    const edit = model.find((m) => m.id === 'edit')
    expect(edit?.items.find((i) => i.id === 'undo')?.disabled).toBe(true)
    expect(edit?.items.find((i) => i.id === 'redo')?.disabled).toBe(true)

    const enabled = buildEditorMenuModel(makeProps({ canUndo: true, canRedo: true }))
    const editEnabled = enabled.find((m) => m.id === 'edit')
    expect(editEnabled?.items.find((i) => i.id === 'undo')?.disabled).toBe(false)
    expect(editEnabled?.items.find((i) => i.id === 'redo')?.disabled).toBe(false)
  })

  it('reflects the panel visibility as checked state on the View toggles', () => {
    const view = buildEditorMenuModel(
      makeProps({ timelineVisible: true, settingsVisible: false }),
    ).find((m) => m.id === 'view')
    expect(view?.items.find((i) => i.id === 'toggle-timeline')?.checked).toBe(true)
    expect(view?.items.find((i) => i.id === 'toggle-settings')?.checked).toBe(false)
    expect(view?.items.find((i) => i.id === 'reload')?.checked).toBeUndefined()
  })
})

describe('<EditorMenuBar />', () => {
  // Radix relies on pointer-capture / scroll APIs jsdom does not implement.
  beforeAll(() => {
    Element.prototype.hasPointerCapture = vi.fn(() => false)
    Element.prototype.releasePointerCapture = vi.fn()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders the four top-level menu triggers', () => {
    render(<EditorMenuBar {...makeProps()} />)
    expect(screen.getByRole('button', { name: 'File' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument()
  })

  it('opens the File menu and invokes the handler for a selected item', async () => {
    const user = userEvent.setup()
    const props = makeProps()
    render(<EditorMenuBar {...props} />)

    await user.click(screen.getByRole('button', { name: 'File' }))

    expect(await screen.findByText('Import Video…')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+O')).toBeInTheDocument()

    await user.click(screen.getByText('Export…'))
    expect(props.onExport).toHaveBeenCalledOnce()
  })

  it('renders a disabled Undo item when canUndo is false', async () => {
    const user = userEvent.setup()
    const props = makeProps({ canUndo: false })
    render(<EditorMenuBar {...props} />)

    await user.click(screen.getByRole('button', { name: 'Edit' }))

    const undoItem = await screen.findByRole('menuitem', { name: /Undo/ })
    expect(undoItem).toHaveAttribute('aria-disabled', 'true')
  })
})
