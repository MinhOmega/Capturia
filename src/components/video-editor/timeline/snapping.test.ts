import { describe, expect, it } from 'vitest'
import {
  clampSpanToBounds,
  clampToNeighbours,
  clampVisibleRange,
  collectSnapTargets,
  computeSnapThresholdMs,
  formatTooltipMs,
  inferResizeMode,
  normaliseSpansToDuration,
  normaliseSpanToDuration,
  normaliseWheelDeltaPx,
  snapSpanToTargets,
  spansIntersect,
} from './snapping'

describe('computeSnapThresholdMs', () => {
  it('is 1% of the visible range', () => {
    expect(computeSnapThresholdMs(20000)).toBe(200)
  })

  it('never drops below 50 ms when zoomed in', () => {
    expect(computeSnapThresholdMs(100)).toBe(50)
    expect(computeSnapThresholdMs(0)).toBe(50)
  })
})

describe('collectSnapTargets', () => {
  it('always includes the timeline bounds', () => {
    expect(collectSnapTargets({ totalMs: 5000 }).sort((a, b) => a - b)).toEqual([0, 5000])
  })

  it('includes region edges, playhead, keyframes and extras but not the active item', () => {
    const targets = collectSnapTargets({
      totalMs: 10000,
      allRegionSpans: [
        { id: 'a', start: 1000, end: 2000 },
        { id: 'active', start: 3000, end: 4000 },
      ],
      softSnapSpans: [{ id: 'anno', start: 5000, end: 6000 }],
      activeItemId: 'active',
      currentTimeMs: 7000,
      keyframeTimesMs: [8000],
      extraTimesMs: [9000, Number.NaN],
    })
    expect(targets.sort((a, b) => a - b)).toEqual([
      0, 1000, 2000, 5000, 6000, 7000, 8000, 9000, 10000,
    ])
  })

  it('de-duplicates coincident targets', () => {
    const targets = collectSnapTargets({
      totalMs: 10000,
      allRegionSpans: [{ id: 'a', start: 0, end: 2000 }],
      extraTimesMs: [2000],
      currentTimeMs: 2000,
    })
    expect(targets.filter((t) => t === 2000)).toHaveLength(1)
  })
})

describe('snapSpanToTargets', () => {
  const targets = [0, 2000, 5000, 10000]

  it('returns the span untouched when nothing is within threshold', () => {
    const result = snapSpanToTargets({ start: 3000, end: 4000 }, targets, 'drag', 100, 1)
    expect(result).toEqual({ span: { start: 3000, end: 4000 }, snapPoint: null })
  })

  it('drag: preserves duration and snaps the closer edge', () => {
    // start is 60 ms from 2000, end is 30 ms from 5000 -> end wins
    const result = snapSpanToTargets({ start: 2060, end: 4970 }, targets, 'drag', 100, 1)
    expect(result.snapPoint).toBe(5000)
    expect(result.span).toEqual({ start: 2090, end: 5000 })
  })

  it('drag: prefers the start edge on a tie', () => {
    const result = snapSpanToTargets({ start: 2050, end: 4950 }, targets, 'drag', 100, 1)
    expect(result.snapPoint).toBe(2000)
    expect(result.span).toEqual({ start: 2000, end: 4900 })
  })

  it('resize-left: only moves the start edge', () => {
    const result = snapSpanToTargets({ start: 2040, end: 4000 }, targets, 'resize-left', 100, 1)
    expect(result).toEqual({ span: { start: 2000, end: 4000 }, snapPoint: 2000 })
  })

  it('resize-right: only moves the end edge', () => {
    const result = snapSpanToTargets({ start: 3000, end: 4960 }, targets, 'resize-right', 100, 1)
    expect(result).toEqual({ span: { start: 3000, end: 5000 }, snapPoint: 5000 })
  })

  it('resize: refuses a snap that would drop below the minimum duration', () => {
    const result = snapSpanToTargets({ start: 4900, end: 4990 }, targets, 'resize-right', 200, 500)
    expect(result.snapPoint).toBeNull()
    expect(result.span).toEqual({ start: 4900, end: 4990 })
  })

  it('snaps to the playhead and to segment boundaries passed as extras', () => {
    const extras = collectSnapTargets({
      totalMs: 10000,
      currentTimeMs: 6500,
      extraTimesMs: [3333],
    })
    expect(snapSpanToTargets({ start: 3300, end: 4300 }, extras, 'drag', 100, 1).snapPoint).toBe(
      3333,
    )
    expect(
      snapSpanToTargets({ start: 5000, end: 6460 }, extras, 'resize-right', 100, 1).snapPoint,
    ).toBe(6500)
  })

  it('is a no-op with no targets or a non-positive threshold', () => {
    const span = { start: 10, end: 20 }
    expect(snapSpanToTargets(span, [], 'drag', 100, 1).snapPoint).toBeNull()
    expect(snapSpanToTargets(span, [10], 'drag', 0, 1).snapPoint).toBeNull()
  })
})

describe('clampToNeighbours', () => {
  const siblings = [
    { id: 'left', start: 0, end: 2000 },
    { id: 'right', start: 6000, end: 8000 },
    { id: 'me', start: 3000, end: 4000 },
  ]

  it('pulls the right edge back to the next region start', () => {
    expect(clampToNeighbours({ start: 3000, end: 6500 }, siblings, 'me', 1, 10000)).toEqual({
      start: 3000,
      end: 6000,
    })
  })

  it('pushes the left edge to the previous region end', () => {
    expect(clampToNeighbours({ start: 1500, end: 4000 }, siblings, 'me', 1, 10000)).toEqual({
      start: 2000,
      end: 4000,
    })
  })

  it('ignores the active item itself', () => {
    expect(clampToNeighbours({ start: 2500, end: 3500 }, siblings, 'me', 1, 10000)).toEqual({
      start: 2500,
      end: 3500,
    })
  })

  it('restores the minimum duration after clamping', () => {
    const result = clampToNeighbours({ start: 5990, end: 6500 }, siblings, 'me', 200, 10000)
    expect(result.end - result.start).toBeGreaterThanOrEqual(200)
  })

  it('never exceeds the timeline bounds', () => {
    const result = clampToNeighbours({ start: -50, end: 12000 }, [], 'me', 1, 10000)
    expect(result.start).toBe(0)
    expect(result.end).toBe(10000)
  })
})

describe('clampSpanToBounds', () => {
  it('keeps a span that already fits', () => {
    expect(clampSpanToBounds({ start: 100, end: 900 }, 1000, 1)).toEqual({ start: 100, end: 900 })
  })

  it('shifts a span that runs past the end back inside the timeline', () => {
    expect(clampSpanToBounds({ start: 800, end: 1300 }, 1000, 1)).toEqual({ start: 500, end: 1000 })
  })

  it('never returns an end past totalMs, even for oversized spans', () => {
    const result = clampSpanToBounds({ start: -200, end: 5000 }, 1000, 1)
    expect(result).toEqual({ start: 0, end: 1000 })
  })

  it('enforces the minimum duration', () => {
    expect(clampSpanToBounds({ start: 500, end: 500 }, 1000, 50)).toEqual({ start: 500, end: 550 })
  })

  it('falls back to a free-floating span when the timeline has no length yet', () => {
    expect(clampSpanToBounds({ start: -10, end: 0 }, 0, 100)).toEqual({ start: 0, end: 100 })
  })
})

describe('inferResizeMode', () => {
  const committed = { start: 1000, end: 2000 }

  it('detects the left handle', () => {
    expect(inferResizeMode(committed, { start: 900, end: 2000 })).toBe('resize-left')
  })

  it('detects the right handle', () => {
    expect(inferResizeMode(committed, { start: 1000, end: 2200 })).toBe('resize-right')
  })

  it('returns null when it cannot tell which handle moved', () => {
    expect(inferResizeMode(committed, { start: 1000, end: 2000 })).toBeNull()
    expect(inferResizeMode(committed, { start: 900, end: 2100 })).toBeNull()
  })

  it('defaults to the right handle for unknown items', () => {
    expect(inferResizeMode(undefined, { start: 0, end: 1 })).toBe('resize-right')
  })
})

describe('spansIntersect', () => {
  it('treats adjacent spans as non-overlapping', () => {
    expect(spansIntersect({ start: 0, end: 1000 }, { start: 1000, end: 2000 })).toBe(false)
    expect(spansIntersect({ start: 0, end: 1001 }, { start: 1000, end: 2000 })).toBe(true)
    expect(spansIntersect({ start: 1500, end: 1600 }, { start: 1000, end: 2000 })).toBe(true)
  })
})

describe('clampVisibleRange', () => {
  it('returns the candidate when the timeline has no length', () => {
    expect(clampVisibleRange({ start: 5, end: 10 }, 0)).toEqual({ start: 5, end: 10 })
  })

  it('shows the whole timeline when the window is wider than it', () => {
    expect(clampVisibleRange({ start: -500, end: 20000 }, 10000)).toEqual({ start: 0, end: 10000 })
  })

  it('shifts the window back inside the bounds without changing its width', () => {
    expect(clampVisibleRange({ start: -200, end: 800 }, 10000)).toEqual({ start: 0, end: 1000 })
    expect(clampVisibleRange({ start: 9500, end: 10500 }, 10000)).toEqual({
      start: 9000,
      end: 10000,
    })
  })
})

describe('formatTooltipMs', () => {
  it('formats seconds below a minute and m:ss.s above', () => {
    expect(formatTooltipMs(1500)).toBe('1.5s')
    expect(formatTooltipMs(61500)).toBe('1:01.5')
  })
})

describe('normaliseWheelDeltaPx', () => {
  it('passes pixel deltas through unchanged', () => {
    expect(normaliseWheelDeltaPx(120, 0)).toBe(120)
    expect(normaliseWheelDeltaPx(-40.5, 0)).toBe(-40.5)
  })

  it('converts line deltas at 16 px a line', () => {
    expect(normaliseWheelDeltaPx(3, 1)).toBe(48)
    expect(normaliseWheelDeltaPx(-3, 1)).toBe(-48)
  })

  it('converts page deltas at 240 px a page', () => {
    expect(normaliseWheelDeltaPx(1, 2)).toBe(240)
    expect(normaliseWheelDeltaPx(-2, 2)).toBe(-480)
  })

  it('treats a non-finite delta as no movement', () => {
    expect(normaliseWheelDeltaPx(Number.NaN, 1)).toBe(0)
    expect(normaliseWheelDeltaPx(Number.POSITIVE_INFINITY, 0)).toBe(0)
  })
})

describe('normaliseSpanToDuration', () => {
  it('leaves a region that already fits alone', () => {
    expect(normaliseSpanToDuration({ start: 1000, end: 4000 }, 10_000, 100)).toEqual({
      action: 'keep',
    })
  })

  it('clamps a region that runs past the new end', () => {
    expect(normaliseSpanToDuration({ start: 1000, end: 14_000 }, 10_000, 100)).toEqual({
      action: 'clamp',
      start: 1000,
      end: 10_000,
    })
  })

  it('pulls a region back inside when its start no longer fits', () => {
    expect(normaliseSpanToDuration({ start: 9950, end: 12_000 }, 10_000, 100)).toEqual({
      action: 'clamp',
      start: 9900,
      end: 10_000,
    })
  })

  it('clamps a negative start', () => {
    expect(normaliseSpanToDuration({ start: -500, end: 2000 }, 10_000, 100)).toEqual({
      action: 'clamp',
      start: 0,
      end: 2000,
    })
  })

  it('drops an empty or inverted region', () => {
    expect(normaliseSpanToDuration({ start: 2000, end: 2000 }, 10_000, 100)).toEqual({
      action: 'drop',
    })
    expect(normaliseSpanToDuration({ start: 4000, end: 1000 }, 10_000, 100)).toEqual({
      action: 'drop',
    })
  })

  it('drops a region that now starts at or past the end', () => {
    expect(normaliseSpanToDuration({ start: 10_000, end: 12_000 }, 10_000, 100)).toEqual({
      action: 'drop',
    })
    expect(normaliseSpanToDuration({ start: 15_000, end: 16_000 }, 10_000, 100)).toEqual({
      action: 'drop',
    })
  })

  it('touches nothing while the duration is still unknown', () => {
    expect(normaliseSpanToDuration({ start: 1000, end: 4000 }, 0, 100)).toEqual({ action: 'keep' })
    expect(normaliseSpanToDuration({ start: 1000, end: 4000 }, Number.NaN, 100)).toEqual({
      action: 'keep',
    })
  })

  it('keeps a region when the whole timeline is shorter than the minimum length', () => {
    expect(normaliseSpanToDuration({ start: 0, end: 50 }, 50, 100)).toEqual({ action: 'keep' })
  })
})

describe('normaliseSpansToDuration', () => {
  it('reports the regions to move and the regions to drop', () => {
    const regions = [
      { id: 'keep', start: 0, end: 2000 },
      { id: 'clamp', start: 8000, end: 14_000 },
      { id: 'empty', start: 3000, end: 3000 },
      { id: 'past-end', start: 11_000, end: 12_000 },
    ]

    expect(normaliseSpansToDuration(regions, 10_000, 100)).toEqual({
      clamped: [{ id: 'clamp', start: 8000, end: 10_000 }],
      dropped: ['empty', 'past-end'],
    })
  })

  it('reports no work for a track that already fits', () => {
    const regions = [
      { id: 'a', start: 0, end: 2000 },
      { id: 'b', start: 3000, end: 4000 },
    ]
    expect(normaliseSpansToDuration(regions, 10_000, 100)).toEqual({ clamped: [], dropped: [] })
  })
})
