import { describe, expect, it } from 'vitest'
import {
  clampNotesFontSize,
  clampTeleprompterSpeed,
  createTeleprompterRunState,
  DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
  getMaxScrollTop,
  getNextTeleprompterScrollTop,
  getTeleprompterFrame,
  hasManualScrollDrift,
  holdTeleprompter,
  isAtTeleprompterEnd,
  MAX_NOTES_FONT_SIZE,
  MAX_TELEPROMPTER_FRAME_MS,
  MAX_TELEPROMPTER_SPEED,
  MIN_NOTES_FONT_SIZE,
  MIN_TELEPROMPTER_SPEED,
  normalizeNotesTeleprompterSettings,
  resolveTeleprompterPosition,
  scaleScrollTop,
  shouldSpaceTogglePlayback,
  stepTeleprompter,
  TELEPROMPTER_MANUAL_SCROLL_HOLD_MS,
  TELEPROMPTER_SCROLL_TOLERANCE_PX,
} from './notesTeleprompter'

describe('notes teleprompter settings', () => {
  it('falls back to defaults for missing or malformed input', () => {
    expect(normalizeNotesTeleprompterSettings(undefined)).toEqual(
      DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
    )
    expect(normalizeNotesTeleprompterSettings('nope')).toEqual(DEFAULT_NOTES_TELEPROMPTER_SETTINGS)
    expect(normalizeNotesTeleprompterSettings({})).toEqual(DEFAULT_NOTES_TELEPROMPTER_SETTINGS)
    expect(normalizeNotesTeleprompterSettings({ speed: 'fast', fontSize: null })).toEqual(
      DEFAULT_NOTES_TELEPROMPTER_SETTINGS,
    )
  })

  it('clamps persisted values and drops unknown fields', () => {
    expect(
      normalizeNotesTeleprompterSettings({ speed: 1_000, fontSize: 1, isPlaying: true }),
    ).toEqual({
      speed: MAX_TELEPROMPTER_SPEED,
      fontSize: MIN_NOTES_FONT_SIZE,
    })
    expect(normalizeNotesTeleprompterSettings({ speed: 55, fontSize: 24 })).toEqual({
      speed: 55,
      fontSize: 24,
    })
  })

  it('enforces speed and font-size bounds', () => {
    expect(clampTeleprompterSpeed(0)).toBe(MIN_TELEPROMPTER_SPEED)
    expect(clampTeleprompterSpeed(1_000)).toBe(MAX_TELEPROMPTER_SPEED)
    expect(clampTeleprompterSpeed(Number.NaN)).toBe(DEFAULT_NOTES_TELEPROMPTER_SETTINGS.speed)
    expect(clampNotesFontSize(0)).toBe(MIN_NOTES_FONT_SIZE)
    expect(clampNotesFontSize(1_000)).toBe(MAX_NOTES_FONT_SIZE)
    expect(clampNotesFontSize(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_NOTES_TELEPROMPTER_SETTINGS.fontSize,
    )
  })
})

describe('notes teleprompter frame math', () => {
  it('primes the clock without moving for the first, invalid or backward timestamps', () => {
    expect(getTeleprompterFrame(null, 100)).toEqual({ elapsedMs: 0, nextTimestamp: 100 })
    expect(getTeleprompterFrame(100, Number.NaN)).toEqual({ elapsedMs: 0, nextTimestamp: null })
    expect(getTeleprompterFrame(100, 90)).toEqual({ elapsedMs: 0, nextTimestamp: 90 })
    expect(getTeleprompterFrame(Number.NaN, 90)).toEqual({ elapsedMs: 0, nextTimestamp: 90 })
  })

  it('caps long frame gaps', () => {
    expect(getTeleprompterFrame(100, 1_000)).toEqual({
      elapsedMs: MAX_TELEPROMPTER_FRAME_MS,
      nextTimestamp: 1_000,
    })
    expect(getTeleprompterFrame(100, 116)).toEqual({ elapsedMs: 16, nextTimestamp: 116 })
  })

  it('advances in pixels per second without crossing the bottom', () => {
    expect(getNextTeleprompterScrollTop(10, 40, 100, 100)).toBe(14)
    expect(getNextTeleprompterScrollTop(98, 40, 100, 100)).toBe(100)
    expect(getNextTeleprompterScrollTop(Number.NaN, 40, -1, 100)).toBe(0)
    expect(getNextTeleprompterScrollTop(0, 40, 100, Number.NaN)).toBe(0)
  })

  it('clamps an out-of-range speed before using it', () => {
    expect(getNextTeleprompterScrollTop(0, 10_000, 1_000, 10_000)).toBe(MAX_TELEPROMPTER_SPEED)
  })
})

describe('notes teleprompter position tracking', () => {
  it('keeps the tracked sub-pixel position when the DOM only rounds it', () => {
    const tracked = 12.4
    expect(hasManualScrollDrift(tracked, Math.floor(tracked))).toBe(false)
    expect(resolveTeleprompterPosition(tracked, Math.floor(tracked))).toBe(tracked)
    expect(resolveTeleprompterPosition(tracked, tracked + TELEPROMPTER_SCROLL_TOLERANCE_PX)).toBe(
      tracked,
    )
  })

  it('hands control to the DOM once the reader scrolls by hand', () => {
    expect(hasManualScrollDrift(12.4, 300)).toBe(true)
    expect(resolveTeleprompterPosition(12.4, 300)).toBe(300)
    expect(resolveTeleprompterPosition(300, 12.4)).toBe(12.4)
  })

  it('falls back safely for unusable inputs', () => {
    expect(hasManualScrollDrift(Number.NaN, 12)).toBe(false)
    expect(resolveTeleprompterPosition(12.4, Number.NaN)).toBe(12.4)
    expect(resolveTeleprompterPosition(Number.NaN, 12.4)).toBe(12.4)
    expect(resolveTeleprompterPosition(Number.NaN, Number.NaN)).toBe(0)
    expect(resolveTeleprompterPosition(-5, -5)).toBe(0)
  })

  it('reports the end only when there is something to scroll', () => {
    expect(isAtTeleprompterEnd(100, 100)).toBe(true)
    expect(isAtTeleprompterEnd(100 - TELEPROMPTER_SCROLL_TOLERANCE_PX, 100)).toBe(true)
    expect(isAtTeleprompterEnd(50, 100)).toBe(false)
    // A note that fits the window has nowhere to go: playback stays armed.
    expect(isAtTeleprompterEnd(0, 0)).toBe(false)
    expect(isAtTeleprompterEnd(0, Number.NaN)).toBe(false)
  })

  it('derives the scrollable distance without going negative', () => {
    expect(getMaxScrollTop({ scrollHeight: 200, clientHeight: 100 })).toBe(100)
    expect(getMaxScrollTop({ scrollHeight: 100, clientHeight: 100 })).toBe(0)
    expect(getMaxScrollTop({ scrollHeight: 50, clientHeight: 100 })).toBe(0)
  })

  it('keeps the relative reading position across a layout change', () => {
    expect(scaleScrollTop(50, 100, 300)).toBe(150)
    expect(scaleScrollTop(100, 100, 40)).toBe(40)
    expect(scaleScrollTop(500, 100, 300)).toBe(300)
    expect(scaleScrollTop(50, 100, 0)).toBe(0)
    expect(scaleScrollTop(50, 0, 300)).toBe(0)
    expect(scaleScrollTop(Number.NaN, 100, 300)).toBe(0)
  })
})

describe('notes teleprompter playback steps', () => {
  const run = (
    state: ReturnType<typeof createTeleprompterRunState>,
    timestamp: number,
    actualScrollTop: number,
    overrides: Partial<{ maxScrollTop: number; speed: number; holdMs: number }> = {},
  ) =>
    stepTeleprompter(state, {
      timestamp,
      actualScrollTop,
      maxScrollTop: 100,
      speed: 40,
      ...overrides,
    })

  it('primes on the first frame and then scrolls by elapsed time', () => {
    let state = createTeleprompterRunState(0)

    let result = run(state, 0, 0)
    expect(result.scrollTop).toBeNull()
    expect(result.atEnd).toBe(false)
    state = result.state

    result = run(state, 100, 0)
    expect(result.scrollTop).toBe(4)
    expect(result.state.position).toBe(4)
  })

  it('keeps sub-pixel progress when the DOM rounds scrollTop', () => {
    let state = createTeleprompterRunState(0)
    let domScrollTop = 0
    for (let frame = 0; frame <= 5; frame++) {
      const result = run(state, frame * 16, domScrollTop)
      state = result.state
      if (result.scrollTop !== null) {
        domScrollTop = Math.floor(result.scrollTop)
      }
    }
    // 40 px/s over five 16 ms frames = 3.2 px; each frame alone would round to 0.
    expect(domScrollTop).toBe(3)
    expect(state.position).toBeCloseTo(3.2)
  })

  it('stops at the bottom and reports the end', () => {
    let state = createTeleprompterRunState(96)
    state = run(state, 0, 96).state

    const result = run(state, 100, 96)
    expect(result.scrollTop).toBe(100)
    expect(result.atEnd).toBe(true)
  })

  it('stays armed while the note fits the window', () => {
    let state = createTeleprompterRunState(0)
    state = run(state, 0, 0, { maxScrollTop: 0 }).state

    const result = run(state, 100, 0, { maxScrollTop: 0 })
    expect(result.atEnd).toBe(false)
    expect(result.scrollTop).toBe(0)
  })

  it('holds after a manual scroll and resumes from the new offset once the hold expires', () => {
    let state = createTeleprompterRunState(0)
    state = run(state, 0, 0).state
    state = run(state, 100, 0).state
    expect(state.position).toBe(4)

    // The reader dragged the scrollbar to 60.
    let result = run(state, 200, 60)
    expect(result.holding).toBe(true)
    expect(result.scrollTop).toBeNull()
    expect(result.state.position).toBe(60)
    expect(result.state.holdUntil).toBe(200 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    state = result.state

    result = run(state, 200 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS - 1, 60)
    expect(result.holding).toBe(true)
    expect(result.scrollTop).toBeNull()
    state = result.state

    // Expiry re-primes the clock: this frame measures nothing yet.
    result = run(state, 200 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS, 60)
    expect(result.holding).toBe(false)
    expect(result.scrollTop).toBeNull()
    expect(result.state.holdUntil).toBeNull()
    state = result.state

    result = run(state, 300 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS, 60)
    expect(result.scrollTop).toBe(64)
  })

  it('extends the hold while the reader keeps scrolling', () => {
    let state = createTeleprompterRunState(0)
    state = holdTeleprompter(state, 1_000, 30)
    expect(state.holdUntil).toBe(1_000 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)

    const result = run(state, 1_500, 80)
    expect(result.holding).toBe(true)
    expect(result.state.holdUntil).toBe(1_500 + TELEPROMPTER_MANUAL_SCROLL_HOLD_MS)
    expect(result.state.position).toBe(80)
  })

  it('honours a custom hold length, including none at all', () => {
    let state = createTeleprompterRunState(0)
    state = run(state, 0, 0).state

    const result = run(state, 100, 50, { holdMs: 0 })
    expect(result.holding).toBe(false)
    expect(result.state.position).toBe(50)
    expect(result.state.holdUntil).toBe(100)

    // Zero hold: the very next frame primes and playback continues from 50.
    let next = run(result.state, 116, 50, { holdMs: 0 })
    expect(next.scrollTop).toBeNull()
    next = run(next.state, 216, 50, { holdMs: 0 })
    expect(next.scrollTop).toBe(54)
  })

  it('tolerates unusable inputs when holding', () => {
    const state = holdTeleprompter(createTeleprompterRunState(20), Number.NaN, Number.NaN, -5)
    expect(state).toEqual({ position: 20, previousTimestamp: null, holdUntil: 0 })
    expect(createTeleprompterRunState(Number.NaN).position).toBe(0)
  })
})

describe('space toggles playback only outside interactive targets', () => {
  it('accepts a bare Space on the document body', () => {
    expect(shouldSpaceTogglePlayback({ code: 'Space' }, { tagName: 'BODY' }, false)).toBe(true)
    expect(shouldSpaceTogglePlayback({ key: ' ' }, null, false)).toBe(true)
  })

  it('ignores other keys, key repeat, the editor and native controls', () => {
    expect(shouldSpaceTogglePlayback({ code: 'Enter' }, { tagName: 'BODY' }, false)).toBe(false)
    expect(
      shouldSpaceTogglePlayback({ code: 'Space', repeat: true }, { tagName: 'BODY' }, false),
    ).toBe(false)
    expect(shouldSpaceTogglePlayback({ code: 'Space' }, { tagName: 'DIV' }, true)).toBe(false)
    expect(
      shouldSpaceTogglePlayback(
        { code: 'Space' },
        { tagName: 'DIV', isContentEditable: true },
        false,
      ),
    ).toBe(false)
    for (const tagName of ['BUTTON', 'INPUT', 'textarea', 'SELECT', 'A']) {
      expect(shouldSpaceTogglePlayback({ code: 'Space' }, { tagName }, false)).toBe(false)
    }
  })
})
