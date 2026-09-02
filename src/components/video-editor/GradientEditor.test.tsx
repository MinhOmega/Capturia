// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseCssGradient } from '@/lib/exporter/gradientParser'
import { MAX_GRADIENT_STOPS, parseGradientSpec } from '@/lib/gradientBuilder'
import { BACKGROUND_GRADIENT_PRESETS } from './backgroundPresets'
import { GradientEditor } from './GradientEditor'

vi.mock('@/i18n', async () => {
  const loader = await vi.importActual<typeof import('@/i18n/loader')>('@/i18n/loader')
  const t = (qualifiedKey: string, vars?: Record<string, string | number>) => {
    const [namespace, ...rest] = qualifiedKey.split('.')
    return loader.translate('en', namespace as never, rest.join('.'), vars)
  }
  return { useI18n: () => ({ locale: 'en', setLocale: vi.fn(), t }) }
})

beforeAll(() => {
  // Radix Slider measures its track.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    class ResizeObserverStub {
      observe() {
        // jsdom has no layout; the slider never needs a measurement.
      }
      unobserve() {
        // see observe
      }
      disconnect() {
        // see observe
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  }
})

afterEach(() => {
  cleanup()
})

const TWO_STOPS = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'

describe('GradientEditor', () => {
  it('loads the current gradient and shows a live preview', () => {
    render(<GradientEditor value={TWO_STOPS} onChange={vi.fn()} presets={[]} />)
    expect(screen.getByTestId('gradient-preview')).toHaveStyle({ background: TWO_STOPS })
    expect(screen.getByLabelText('Angle in degrees')).toHaveValue(90)
    expect(screen.getAllByLabelText(/^Stop position/)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Linear' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('emits a parser-compatible gradient when the angle changes', () => {
    const onChange = vi.fn()
    render(<GradientEditor value={TWO_STOPS} onChange={onChange} presets={[]} />)

    fireEvent.change(screen.getByLabelText('Angle in degrees'), { target: { value: '45' } })

    expect(onChange).toHaveBeenLastCalledWith('linear-gradient(45deg, #ff0000 0%, #0000ff 100%)')
    const parsed = parseCssGradient(onChange.mock.calls[0][0])
    expect(parsed?.descriptor).toBe('45deg')
    expect(parsed?.stops.map((s) => s.offset)).toEqual([0, 1])
  })

  it('adds stops up to the maximum and removes them down to two', () => {
    const onChange = vi.fn()
    render(<GradientEditor value={TWO_STOPS} onChange={onChange} presets={[]} />)

    const addButton = screen.getByRole('button', { name: 'Add stop' })
    fireEvent.click(addButton)
    expect(screen.getAllByLabelText(/^Stop position/)).toHaveLength(3)
    expect(onChange).toHaveBeenLastCalledWith(
      'linear-gradient(90deg, #ff0000 0%, #800080 50%, #0000ff 100%)',
    )

    for (let i = 0; i < MAX_GRADIENT_STOPS; i++) fireEvent.click(addButton)
    expect(screen.getAllByLabelText(/^Stop position/)).toHaveLength(MAX_GRADIENT_STOPS)
    expect(addButton).toBeDisabled()

    const removeButtons = () => screen.getAllByLabelText(/^Remove stop/)
    // Added stops are appended, so removing the last row each time restores the original pair.
    while (removeButtons().length > 2) fireEvent.click(removeButtons().at(-1) as HTMLElement)
    expect(removeButtons()[0]).toBeDisabled()
    expect(onChange).toHaveBeenLastCalledWith(TWO_STOPS)
  })

  it('switches to a radial gradient', () => {
    const onChange = vi.fn()
    render(<GradientEditor value={TWO_STOPS} onChange={onChange} presets={[]} />)

    fireEvent.click(screen.getByRole('button', { name: 'Radial' }))

    expect(onChange).toHaveBeenLastCalledWith(
      'radial-gradient(circle at 50% 50%, #ff0000 0%, #0000ff 100%)',
    )
    expect(screen.queryByLabelText('Angle in degrees')).not.toBeInTheDocument()
  })

  it('keeps the row order while a position is typed and sorts on output', () => {
    const onChange = vi.fn()
    render(<GradientEditor value={TWO_STOPS} onChange={onChange} presets={[]} />)

    fireEvent.change(screen.getAllByLabelText(/^Stop position/)[0], { target: { value: '100' } })
    fireEvent.change(screen.getAllByLabelText(/^Stop position/)[1], { target: { value: '0' } })

    expect(screen.getAllByLabelText(/^Stop position/)[0]).toHaveValue(100)
    expect(onChange).toHaveBeenLastCalledWith('linear-gradient(90deg, #0000ff 0%, #ff0000 100%)')
  })

  it('loads a preset into the editor with the same stops the exporter reads', () => {
    const onChange = vi.fn()
    render(<GradientEditor value={TWO_STOPS} onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preset 3' }))

    const preset = BACKGROUND_GRADIENT_PRESETS[2]
    const emitted = onChange.mock.calls.at(-1)?.[0] as string
    expect(parseGradientSpec(emitted)).toEqual(parseGradientSpec(preset))
    expect(parseCssGradient(emitted)?.type).toBe('radial')
    expect(screen.getByRole('button', { name: 'Radial' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reloads when the wallpaper changes from outside but ignores its own emissions', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <GradientEditor value={TWO_STOPS} onChange={onChange} presets={[]} />,
    )

    rerender(<GradientEditor value="#123456" onChange={onChange} presets={[]} />)
    expect(screen.getByLabelText('Angle in degrees')).toHaveValue(90)

    rerender(
      <GradientEditor
        value="linear-gradient(to top, #000000 0%, #ffffff 100%)"
        onChange={onChange}
        presets={[]}
      />,
    )
    expect(screen.getByLabelText('Angle in degrees')).toHaveValue(0)
    expect(onChange).not.toHaveBeenCalled()
  })
})
