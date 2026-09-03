// @vitest-environment jsdom
//
// The field applies each keystroke live but settles once. `onChange` drives the
// preview, `onCommit` marks the end of the edit -- that is what turns a typed
// speed into a single undo entry instead of one per digit.
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEGMENT_SPEED_PRESETS, SegmentSpeedInput } from './SegmentSpeedInput'

afterEach(() => {
  cleanup()
})

function renderInput(value = 1) {
  const onChange = vi.fn()
  const onCommit = vi.fn()
  const onError = vi.fn()
  render(
    <SegmentSpeedInput
      value={value}
      onChange={onChange}
      onCommit={onCommit}
      onError={onError}
      ariaLabel="Custom speed"
    />,
  )
  const input = screen.getByLabelText('Custom speed') as HTMLInputElement
  return { input, onChange, onCommit, onError }
}

/** Type a string one character at a time, as the user would. */
function typeInto(input: HTMLInputElement, text: string) {
  act(() => {
    input.focus()
  })
  let sofar = ''
  for (const char of text) {
    sofar += char
    fireEvent.change(input, { target: { value: sofar } })
  }
}

describe('SegmentSpeedInput', () => {
  it('applies every keystroke but commits only once, on blur', () => {
    const { input, onChange, onCommit } = renderInput()

    typeInto(input, '2.5')
    // One call per keystroke: '2' and '2.' both read as the speed 2.
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([2, 2, 2.5])
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(3)
  })

  it('commits on Enter', () => {
    const { input, onChange, onCommit } = renderInput()

    typeInto(input, '12')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls.at(-1)?.[0]).toBe(12)
  })

  it('commits once per typing session, not once per session per keystroke', () => {
    const { input, onCommit } = renderInput()

    typeInto(input, '3')
    fireEvent.blur(input)
    typeInto(input, '4')
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenCalledTimes(2)
  })

  it('refuses a speed above the cap without changing or committing', () => {
    const { input, onChange, onCommit, onError } = renderInput()

    typeInto(input, '99')
    expect(onError).toHaveBeenCalled()
    // 9 is a valid speed; 99 is not, so the draft never reaches it.
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([9])
    expect(input.value).toBe('9')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('normalizes the draft on blur and still commits when the draft is unusable', () => {
    const { input, onChange, onCommit } = renderInput(1)

    typeInto(input, '.')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.blur(input)
    // Falls back to the current speed, which is a preset, so the field clears.
    expect(input.value).toBe('')
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('shows a non-preset speed and clears for a preset one', () => {
    const { input } = renderInput(3.7)
    expect(input.value).toBe('3.7')

    cleanup()
    expect(renderInput(2).input.value).toBe('')
  })

  it('offers the documented presets', () => {
    expect(SEGMENT_SPEED_PRESETS).toContain(1)
    expect(SEGMENT_SPEED_PRESETS.at(0)).toBe(0.25)
    expect(SEGMENT_SPEED_PRESETS.at(-1)).toBe(40)
  })
})
