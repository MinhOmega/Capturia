import { describe, expect, it } from 'vitest'
import type { CursorTrack } from '@/lib/cursor/types'
import type { ZoomFocus } from '../types'
import { AUTO_FOLLOW_PARAMS } from './constants'
import {
  adaptiveSmoothFactor,
  advanceFollowFocus,
  buildCursorTelemetry,
  interpolateCursorAt,
  timeCorrectedFollowFactor,
} from './cursorFollowUtils'

const track: CursorTrack = {
  samples: [
    { timeMs: 0, x: 0.1, y: 0.5 },
    { timeMs: 1000, x: 0.3, y: 0.5, visible: false },
    { timeMs: 2000, x: 0.5, y: 0.5 },
    { timeMs: 4000, x: 0.9, y: 0.5 },
  ],
}

describe('buildCursorTelemetry (CursorTrack adapter)', () => {
  it('maps x/y to cx/cy, drops hidden and non-finite samples and sorts by time', () => {
    const points = buildCursorTelemetry({
      samples: [
        { timeMs: 4000, x: 0.9, y: 0.5 },
        { timeMs: 0, x: 0.1, y: 0.5 },
        { timeMs: 1000, x: 0.3, y: 0.5, visible: false },
        { timeMs: 3000, x: Number.NaN, y: 0.5 },
      ],
    })
    expect(points).toEqual([
      { timeMs: 0, cx: 0.1, cy: 0.5 },
      { timeMs: 4000, cx: 0.9, cy: 0.5 },
    ])
  })

  it('is memoised per track identity and empty for a missing track', () => {
    expect(buildCursorTelemetry(track)).toBe(buildCursorTelemetry(track))
    expect(buildCursorTelemetry(null)).toEqual([])
    expect(buildCursorTelemetry({ samples: [] })).toEqual([])
  })
})

describe('interpolateCursorAt', () => {
  const telemetry = buildCursorTelemetry(track)

  it('holds the first / last sample outside the recorded range', () => {
    expect(interpolateCursorAt(telemetry, -100)).toEqual({ cx: 0.1, cy: 0.5 })
    expect(interpolateCursorAt(telemetry, 9000)).toEqual({ cx: 0.9, cy: 0.5 })
  })

  it('lerps between neighbouring samples, skipping hidden ones', () => {
    // The hidden sample at 1000 ms is not a keyframe: 0 -> 2000 ms is one segment.
    expect(interpolateCursorAt(telemetry, 1000)?.cx).toBeCloseTo(0.3, 6)
    expect(interpolateCursorAt(telemetry, 3000)?.cx).toBeCloseTo(0.7, 6)
    expect(interpolateCursorAt([], 0)).toBeNull()
  })
})

describe('timeCorrectedFollowFactor / adaptiveSmoothFactor', () => {
  it('returns the base factor at the reference interval and 0 when paused', () => {
    expect(timeCorrectedFollowFactor(0.25, 25, 25)).toBeCloseTo(0.25, 9)
    expect(timeCorrectedFollowFactor(0.25, 0, 25)).toBe(0)
    expect(timeCorrectedFollowFactor(0.25, -5, 25)).toBe(0)
  })

  it('composes: two half steps equal one full step', () => {
    const full = 1 - timeCorrectedFollowFactor(0.2, 30, 25)
    const half = 1 - timeCorrectedFollowFactor(0.2, 15, 25)
    expect(half * half).toBeCloseTo(full, 9)
  })

  it('ramps from minFactor (close) to maxFactor (far)', () => {
    const prev: ZoomFocus = { cx: 0.5, cy: 0.5 }
    expect(adaptiveSmoothFactor(prev, prev, 0.1, 0.25, 0.15)).toBeCloseTo(0.1, 9)
    expect(adaptiveSmoothFactor({ cx: 0.9, cy: 0.5 }, prev, 0.1, 0.25, 0.15)).toBeCloseTo(0.25, 9)
    expect(adaptiveSmoothFactor({ cx: 0.575, cy: 0.5 }, prev, 0.1, 0.25, 0.15)).toBeCloseTo(
      0.175,
      9,
    )
  })
})

describe('advanceFollowFocus', () => {
  const target: ZoomFocus = { cx: 0.8, cy: 0.3 }
  const start: ZoomFocus = { cx: 0.2, cy: 0.6 }

  function run(stepMs: number, totalMs: number) {
    let focus = start
    for (let t = stepMs; t <= totalMs + 1e-9; t += stepMs) {
      focus = advanceFollowFocus(focus, target, stepMs, AUTO_FOLLOW_PARAMS)
    }
    return focus
  }

  it('holds still for a non-positive dt', () => {
    expect(advanceFollowFocus(start, target, 0, AUTO_FOLLOW_PARAMS)).toBe(start)
    expect(advanceFollowFocus(start, target, -16, AUTO_FOLLOW_PARAMS)).toBe(start)
  })

  it('moves toward the target without overshooting', () => {
    const next = advanceFollowFocus(start, target, 16, AUTO_FOLLOW_PARAMS)
    expect(next.cx).toBeGreaterThan(start.cx)
    expect(next.cx).toBeLessThan(target.cx)
    expect(next.cy).toBeLessThan(start.cy)
    expect(next.cy).toBeGreaterThan(target.cy)
  })

  it('converges the same amount of content time apart at 30 and 60 fps (frame-rate independent)', () => {
    // The factor is distance-adaptive, so the two chunkings are not bit-identical;
    // they must agree far more tightly than the distance travelled.
    for (const totalMs of [200, 600, 1500]) {
      const at30 = run(1000 / 30, totalMs)
      const at60 = run(1000 / 60, totalMs)
      const travelled = Math.hypot(at60.cx - start.cx, at60.cy - start.cy)
      const spread = Math.hypot(at30.cx - at60.cx, at30.cy - at60.cy)
      expect(travelled).toBeGreaterThan(0.05)
      expect(spread).toBeLessThan(travelled * 0.02)
    }
    // And it settles at the target either way.
    expect(run(1000 / 30, 4000).cx).toBeCloseTo(target.cx, 3)
    expect(run(1000 / 60, 4000).cx).toBeCloseTo(target.cx, 3)
  })
})
