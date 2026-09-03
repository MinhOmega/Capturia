import { describe, expect, it } from 'vitest'
import type { VideoSegment } from '../types'
import {
  clampNativePlaybackRate,
  FRAME_STEP_PREVIEW_HINT_KEY,
  MAX_FRAME_STEP_TICK_SEC,
  MAX_NATIVE_PLAYBACK_RATE,
  planFrameStep,
  probeNativePlaybackRateCap,
  resolvePreviewSpeed,
  resolvePreviewSpeedMode,
} from './frameStepPreview'

function seg(id: string, startMs: number, endMs: number, speed = 1, deleted = false): VideoSegment {
  return { id, startMs, endMs, speed, deleted }
}

describe('resolvePreviewSpeedMode / clampNativePlaybackRate', () => {
  it('plays natively up to the cap and frame-steps above it', () => {
    expect(resolvePreviewSpeedMode(1)).toBe('native')
    expect(resolvePreviewSpeedMode(16)).toBe('native')
    expect(resolvePreviewSpeedMode(16.5)).toBe('frame-step')
    expect(resolvePreviewSpeedMode(40)).toBe('frame-step')
    expect(resolvePreviewSpeedMode(Number.NaN)).toBe('native')
  })

  it('respects a lower probed cap', () => {
    expect(resolvePreviewSpeedMode(10, 8)).toBe('frame-step')
    expect(resolvePreviewSpeedMode(8, 8)).toBe('native')
  })

  it('clamps the element rate into the accepted range', () => {
    expect(clampNativePlaybackRate(40)).toBe(MAX_NATIVE_PLAYBACK_RATE)
    expect(clampNativePlaybackRate(0.01)).toBe(0.0625)
    expect(clampNativePlaybackRate(2)).toBe(2)
    expect(clampNativePlaybackRate(10, 8)).toBe(8)
    expect(clampNativePlaybackRate(Number.NaN)).toBe(1)
  })

  it('exposes the hint key the speed UI shows', () => {
    expect(FRAME_STEP_PREVIEW_HINT_KEY).toBe('settings.speedPreviewFrameSteppingHint')
  })
})

describe('resolvePreviewSpeed', () => {
  const segments = [seg('a', 0, 1000, 40), seg('b', 1000, 2000, 1, true), seg('c', 2000, 3000, 2)]

  it('multiplies the segment speed by the preview rate', () => {
    expect(resolvePreviewSpeed(500, segments, 1)).toBe(40)
    expect(resolvePreviewSpeed(2500, segments, 2)).toBe(4)
  })

  it('treats deleted stretches, gaps and an invalid rate as 1x', () => {
    expect(resolvePreviewSpeed(1500, segments, 1)).toBe(1)
    expect(resolvePreviewSpeed(5000, segments, 1)).toBe(1)
    expect(resolvePreviewSpeed(500, segments, Number.NaN)).toBe(40)
    expect(resolvePreviewSpeed(500, [], 32)).toBe(32)
  })
})

describe('planFrameStep', () => {
  const fast = seg('fast', 0, 10_000, 40)
  const slow = seg('slow', 10_000, 20_000, 1)
  const gap = seg('gap', 20_000, 30_000, 1, true)
  const tail = seg('tail', 30_000, 40_000, 40)

  it('advances by speed x wall time inside a fast segment', () => {
    const plan = planFrameStep({
      fromSec: 1,
      dtSec: 1 / 60,
      segments: [fast, slow],
      previewRate: 1,
      durationSec: 40,
    })
    expect(plan.kind).toBe('advance')
    expect(plan.toSec).toBeCloseTo(1 + 40 / 60, 9)
    if (plan.kind === 'advance') expect(plan.speed).toBe(40)
  })

  it('applies the global preview rate on top of the segment speed', () => {
    const plan = planFrameStep({
      fromSec: 1,
      dtSec: 0.01,
      segments: [fast, slow],
      previewRate: 2,
      durationSec: 40,
    })
    expect(plan.toSec).toBeCloseTo(1 + 40 * 2 * 0.01, 9)
  })

  it('spends the remainder of a boundary-crossing tick in the next segment at its own speed, then hands back', () => {
    // 9.99 s in `fast` is 249.75 ms of effective time; `fast` lasts 250 ms
    // effective. A 16 ms tick leaves 15.75 ms for `slow` at 1x.
    const plan = planFrameStep({
      fromSec: 9.99,
      dtSec: 0.016,
      segments: [fast, slow],
      previewRate: 1,
      durationSec: 40,
    })
    expect(plan.kind).toBe('hand-back')
    expect(plan.toSec).toBeCloseTo(10.01575, 9)
    if (plan.kind === 'hand-back') expect(plan.speed).toBe(1)
  })

  it('skips a deleted stretch and keeps stepping in the fast segment after it', () => {
    // `slow` is 10 s effective; from 19.99 s a 20 ms tick leaves 10 ms for `tail` at 40x.
    const plan = planFrameStep({
      fromSec: 19.99,
      dtSec: 0.02,
      segments: [fast, slow, gap, tail],
      previewRate: 1,
      durationSec: 40,
    })
    expect(plan.kind).toBe('advance')
    expect(plan.toSec).toBeCloseTo(30.4, 9)
  })

  it('moves a clock that sits inside a deleted stretch to the next kept segment', () => {
    const plan = planFrameStep({
      fromSec: 25,
      dtSec: 0,
      segments: [fast, slow, gap, tail],
      previewRate: 1,
      durationSec: 40,
    })
    expect(plan.kind).toBe('advance')
    expect(plan.toSec).toBeCloseTo(30, 9)
  })

  it('ends at the last kept segment when the effective timeline runs out', () => {
    const plan = planFrameStep({
      fromSec: 39.9,
      dtSec: 0.1,
      segments: [fast, slow, gap, tail],
      previewRate: 1,
      durationSec: 40,
    })
    expect(plan).toEqual({ kind: 'end', toSec: 40 })
  })

  it('ends at the media duration when it is shorter than the segment model', () => {
    // 9.9 s + 0.1 s at 40x then 1x lands at 10.0975 s; the media stops at 10.05 s.
    const plan = planFrameStep({
      fromSec: 9.9,
      dtSec: 0.1,
      segments: [fast, slow],
      previewRate: 1,
      durationSec: 10.05,
    })
    expect(plan).toEqual({ kind: 'end', toSec: 10.05 })
  })

  it('keeps going past an unknown (non-finite) duration', () => {
    const plan = planFrameStep({
      fromSec: 5,
      dtSec: 0.016,
      segments: [fast, slow],
      previewRate: 1,
      durationSec: Number.NaN,
    })
    expect(plan.kind).toBe('advance')
  })

  it('caps a huge tick (hidden tab) and ignores negative / NaN ticks', () => {
    const long = seg('long', 0, 100_000, 40)
    const capped = planFrameStep({
      fromSec: 1,
      dtSec: 5,
      segments: [long],
      previewRate: 1,
      durationSec: 100,
    })
    expect(capped.toSec).toBeCloseTo(1 + 40 * MAX_FRAME_STEP_TICK_SEC, 9)
    for (const dtSec of [-1, Number.NaN]) {
      const plan = planFrameStep({
        fromSec: 1,
        dtSec,
        segments: [fast, slow],
        previewRate: 1,
        durationSec: 40,
      })
      expect(plan.toSec).toBe(1)
    }
  })

  it('without a segment model the preview rate alone decides the mode', () => {
    const stepping = planFrameStep({
      fromSec: 1,
      dtSec: 0.1,
      segments: [],
      previewRate: 32,
      durationSec: 40,
    })
    expect(stepping).toEqual({ kind: 'advance', toSec: 1 + 3.2, speed: 32 })
    const native = planFrameStep({
      fromSec: 1,
      dtSec: 0.1,
      segments: [],
      previewRate: 2,
      durationSec: 40,
    })
    expect(native.kind).toBe('hand-back')
  })

  it('honours a lower probed cap when deciding to hand back', () => {
    const plan = planFrameStep({
      fromSec: 1,
      dtSec: 0.016,
      segments: [seg('ten', 0, 10_000, 10)],
      previewRate: 1,
      durationSec: 10,
      nativeCap: 8,
    })
    expect(plan.kind).toBe('advance')
  })
})

describe('probeNativePlaybackRateCap', () => {
  it('finds the cap on an element that throws above it (Chromium)', () => {
    const el = {
      _rate: 1,
      get playbackRate() {
        return this._rate
      },
      set playbackRate(v: number) {
        if (v > 16) throw new Error('NotSupportedError')
        this._rate = v
      },
    }
    expect(probeNativePlaybackRateCap(el, [32, 16, 8])).toBe(16)
    expect(el.playbackRate).toBe(1)
  })

  it('reads the cap back from an element that clamps silently', () => {
    const el = {
      _rate: 2,
      get playbackRate() {
        return this._rate
      },
      set playbackRate(v: number) {
        this._rate = Math.min(v, 5)
      },
    }
    expect(probeNativePlaybackRateCap(el)).toBe(5)
    expect(el.playbackRate).toBe(2)
  })

  it('falls back to 1 when every candidate is refused', () => {
    const el = {
      get playbackRate() {
        return 1
      },
      set playbackRate(_v: number) {
        throw new Error('nope')
      },
    }
    expect(probeNativePlaybackRateCap(el)).toBe(1)
  })
})
