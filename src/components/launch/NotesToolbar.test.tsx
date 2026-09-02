// @vitest-environment jsdom
//
// Teleprompter controls of the Notes toolbar through the real i18n provider,
// so the readouts and labels are checked as the reader sees them.
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { type ReactNode, useLayoutEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, LOCALE_STORAGE_KEY, useI18n } from '@/i18n'
import { NotesToolbar, type NotesToolbarProps } from './NotesToolbar'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}))

beforeEach(() => {
  // `setLocale` persists its choice and the provider reads it back on mount;
  // without this the locale-switching test would leak into the ones after it.
  localStorage.removeItem(LOCALE_STORAGE_KEY)
})

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

function createProps(overrides: Partial<NotesToolbarProps> = {}): NotesToolbarProps {
  return {
    editor: createEditor(),
    teleprompterEnabled: true,
    isPlaying: false,
    speed: 40,
    fontSize: 16,
    mirrored: false,
    onToggleTeleprompter: vi.fn(),
    onTogglePlaying: vi.fn(),
    onRestart: vi.fn(),
    onSpeedChange: vi.fn(),
    onDecreaseFontSize: vi.fn(),
    onIncreaseFontSize: vi.fn(),
    onToggleMirror: vi.fn(),
    ...overrides,
  }
}

function ActiveLocale({ children, locale }: { children: ReactNode; locale: string }) {
  const { setLocale } = useI18n()

  useLayoutEffect(() => {
    setLocale(locale)
  }, [locale, setLocale])

  return children
}

function renderToolbar(props: NotesToolbarProps, locale = 'en') {
  return render(
    <I18nProvider>
      <ActiveLocale locale={locale}>
        <NotesToolbar {...props} />
      </ActiveLocale>
    </I18nProvider>,
  )
}

describe('NotesToolbar teleprompter controls', () => {
  it('hides the playback row and keeps formatting live while the mode is off', () => {
    const props = createProps({ teleprompterEnabled: false })
    renderToolbar(props)

    expect(screen.queryByTestId('notes-teleprompter-controls')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bold' })).toBeEnabled()
    const toggle = screen.getByRole('button', { name: 'Teleprompter mode' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(props.onToggleTeleprompter).toHaveBeenCalledOnce()
  })

  it('exposes readouts and dispatches every control while the mode is on', () => {
    const props = createProps()
    renderToolbar(props)

    expect(screen.getByRole('button', { name: 'Teleprompter mode' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled()

    const speedGroup = screen.getByRole('group', { name: 'Scroll speed' })
    const slider = within(speedGroup).getByRole('slider', { name: 'Scroll speed' })
    expect(slider).toHaveValue('40')
    expect(within(speedGroup).getByRole('status')).toHaveTextContent('40 px/s')
    expect(slider).toHaveAccessibleDescription('40 px/s')

    const fontGroup = screen.getByRole('group', { name: 'Font size' })
    expect(within(fontGroup).getByRole('status')).toHaveTextContent('16 px')

    const play = screen.getByRole('button', { name: 'Start auto-scroll' })
    expect(play).not.toHaveAttribute('aria-pressed')
    expect(play).toHaveAccessibleDescription('Space plays or pauses while the note is not focused')
    expect(screen.getByRole('button', { name: 'Mirror horizontally' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )

    fireEvent.click(play)
    fireEvent.click(screen.getByRole('button', { name: 'Restart from top' }))
    fireEvent.change(slider, { target: { value: '95' } })
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mirror horizontally' }))

    expect(props.onTogglePlaying).toHaveBeenCalledOnce()
    expect(props.onRestart).toHaveBeenCalledOnce()
    expect(props.onSpeedChange).toHaveBeenCalledWith(95)
    expect(props.onDecreaseFontSize).toHaveBeenCalledOnce()
    expect(props.onIncreaseFontSize).toHaveBeenCalledOnce()
    expect(props.onToggleMirror).toHaveBeenCalledOnce()
  })

  it('disables the font-size steps at their bounds and bounds the slider', () => {
    const { rerender } = renderToolbar(createProps({ fontSize: 14 }))
    expect(screen.getByRole('button', { name: 'Decrease font size' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Increase font size' })).toBeEnabled()
    const slider = screen.getByRole('slider', { name: 'Scroll speed' })
    expect(slider).toHaveAttribute('min', '10')
    expect(slider).toHaveAttribute('max', '150')
    expect(slider).toHaveAttribute('step', '5')

    rerender(
      <I18nProvider>
        <NotesToolbar {...createProps({ fontSize: 48 })} />
      </I18nProvider>,
    )
    expect(screen.getByRole('button', { name: 'Increase font size' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Decrease font size' })).toBeEnabled()
  })

  it('announces playback through the label and keeps it disabled until the editor is ready', () => {
    const { rerender } = renderToolbar(createProps({ editor: null }))
    expect(screen.getByRole('button', { name: 'Start auto-scroll' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Restart from top' })).toBeDisabled()

    rerender(
      <I18nProvider>
        <NotesToolbar {...createProps({ isPlaying: true })} />
      </I18nProvider>,
    )
    const pause = screen.getByRole('button', { name: 'Pause auto-scroll' })
    expect(pause).toBeEnabled()
    expect(pause).not.toHaveAttribute('aria-pressed')
    expect(screen.queryByRole('button', { name: 'Start auto-scroll' })).not.toBeInTheDocument()
  })

  it('localises the readouts', () => {
    renderToolbar(createProps({ speed: 120, fontSize: 24 }), 'vi')

    expect(
      within(screen.getByRole('group', { name: 'Tốc độ cuộn' })).getByRole('status'),
    ).toHaveTextContent('120 px/giây')
    expect(
      within(screen.getByRole('group', { name: 'Cỡ chữ' })).getByRole('status'),
    ).toHaveTextContent('24 px')
    expect(screen.getByRole('button', { name: 'Bắt đầu tự cuộn' })).toBeInTheDocument()
  })
})
