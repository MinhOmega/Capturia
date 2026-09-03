import { describe, expect, it } from 'vitest'
import { cubicBezier, easeOutScreenStudio, smoothStep } from './mathUtils'

describe('cubicBezier', () => {
  it('is pinned at both ends and clamps the input', () => {
    expect(cubicBezier(0.16, 1, 0.3, 1, 0)).toBe(0)
    expect(cubicBezier(0.16, 1, 0.3, 1, 1)).toBeCloseTo(1, 6)
    expect(cubicBezier(0.16, 1, 0.3, 1, -1)).toBe(0)
    expect(cubicBezier(0.16, 1, 0.3, 1, 2)).toBeCloseTo(1, 6)
  })

  it('reproduces the identity curve for linear control points', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(cubicBezier(0, 0, 1, 1, t)).toBeCloseTo(t, 5)
    }
  })

  it('matches the ease-in-out reference values', () => {
    // cubic-bezier(0.42, 0, 0.58, 1) at 0.5 is exactly 0.5 by symmetry.
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 5)
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.25)).toBeLessThan(0.25)
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.75)).toBeGreaterThan(0.75)
  })
})

describe('easeOutScreenStudio', () => {
  it('launches fast and lands softly, monotonically', () => {
    let previous = 0
    for (let i = 1; i <= 100; i += 1) {
      const value = easeOutScreenStudio(i / 100)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      previous = value
    }
    // Well over half way through the motion after a quarter of the time.
    expect(easeOutScreenStudio(0.25)).toBeGreaterThan(0.7)
    // Practically settled in the last fifth.
    expect(easeOutScreenStudio(0.8)).toBeGreaterThan(0.98)
  })
})

describe('smoothStep', () => {
  it('keeps the legacy Hermite shape', () => {
    expect(smoothStep(0.5)).toBe(0.5)
    expect(smoothStep(0.25)).toBeCloseTo(0.15625, 6)
  })
})
