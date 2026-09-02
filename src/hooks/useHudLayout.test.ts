import { describe, expect, it } from 'vitest'
import {
  anchorPreservingResize,
  boundsFromHudAnchor,
  clampSizeToWorkArea,
  clampToWorkArea,
  hudAnchorOf,
  isHudOrientation,
  measureHudWindowSize,
  nextHudOrientation,
  pointInHudRects,
  sanitizeHudRects,
  translateBounds,
} from './useHudLayout'

const workArea = { x: 0, y: 40, width: 1920, height: 1040 }

describe('clampToWorkArea', () => {
  it('leaves a window that already fits untouched', () => {
    const bounds = { x: 100, y: 200, width: 300, height: 100 }
    expect(clampToWorkArea(bounds, workArea)).toEqual(bounds)
  })

  it('pulls a window back inside on every edge', () => {
    expect(clampToWorkArea({ x: -50, y: 0, width: 300, height: 100 }, workArea)).toEqual({
      x: 0,
      y: 40,
      width: 300,
      height: 100,
    })
    expect(clampToWorkArea({ x: 1900, y: 1070, width: 300, height: 100 }, workArea)).toEqual({
      x: 1620,
      y: 980,
      width: 300,
      height: 100,
    })
  })

  it('aligns an oversized window to the work area origin', () => {
    expect(clampToWorkArea({ x: 500, y: 500, width: 2500, height: 2000 }, workArea)).toEqual({
      x: 0,
      y: 40,
      width: 2500,
      height: 2000,
    })
  })

  it('honours a secondary display offset', () => {
    const second = { x: 1920, y: 0, width: 1280, height: 720 }
    expect(clampToWorkArea({ x: 1000, y: 10, width: 300, height: 100 }, second)).toEqual({
      x: 1920,
      y: 10,
      width: 300,
      height: 100,
    })
  })
})

describe('clampSizeToWorkArea', () => {
  it('rounds and bounds to the minimum and the work area', () => {
    expect(clampSizeToWorkArea({ width: 10.4, height: 5 }, workArea)).toEqual({
      width: 120,
      height: 80,
    })
    expect(clampSizeToWorkArea({ width: 5000, height: 3000 }, workArea)).toEqual({
      width: 1920,
      height: 1040,
    })
    expect(clampSizeToWorkArea({ width: 640.6, height: 200.2 }, workArea)).toEqual({
      width: 641,
      height: 200,
    })
  })
})

describe('anchorPreservingResize', () => {
  it('keeps the bottom-centre point while growing and shrinking', () => {
    const bounds = { x: 660, y: 900, width: 600, height: 160 }
    const grown = anchorPreservingResize(bounds, { width: 800, height: 300 }, workArea)
    expect(grown).toEqual({ x: 560, y: 760, width: 800, height: 300 })
    expect(hudAnchorOf(grown)).toEqual(hudAnchorOf(bounds))

    const shrunk = anchorPreservingResize(bounds, { width: 240, height: 120 }, workArea)
    expect(shrunk).toEqual({ x: 840, y: 940, width: 240, height: 120 })
    expect(hudAnchorOf(shrunk)).toEqual(hudAnchorOf(bounds))
  })

  it('returns identical bounds for an unchanged size', () => {
    const bounds = { x: 660, y: 900, width: 600, height: 160 }
    expect(anchorPreservingResize(bounds, { width: 600, height: 160 }, workArea)).toEqual(bounds)
  })

  it('slides back on screen when growth would cross an edge', () => {
    const bounds = { x: 0, y: 900, width: 300, height: 160 }
    const grown = anchorPreservingResize(bounds, { width: 600, height: 160 }, workArea)
    expect(grown).toEqual({ x: 0, y: 900, width: 600, height: 160 })
  })

  it('caps a vertical tray taller than the display at the work area height', () => {
    const bounds = { x: 860, y: 980, width: 200, height: 100 }
    const grown = anchorPreservingResize(bounds, { width: 200, height: 5000 }, workArea)
    expect(grown).toEqual({ x: 860, y: 40, width: 200, height: 1040 })
  })
})

describe('hud anchor persistence', () => {
  it('round-trips a window through its bottom-centre anchor', () => {
    const bounds = { x: 660, y: 900, width: 600, height: 160 }
    const anchor = hudAnchorOf(bounds)
    expect(anchor).toEqual({ x: 960, y: 1060 })
    expect(boundsFromHudAnchor(anchor, { width: 600, height: 160 }, workArea)).toEqual(bounds)
  })

  it('clamps an anchor that no longer fits the display', () => {
    const restored = boundsFromHudAnchor({ x: 5, y: 5 }, { width: 600, height: 160 }, workArea)
    expect(restored).toEqual({ x: 0, y: 40, width: 600, height: 160 })
  })
})

describe('translateBounds', () => {
  it('applies a rounded drag delta', () => {
    expect(translateBounds({ x: 10, y: 20, width: 5, height: 5 }, 1.6, -2.4)).toEqual({
      x: 12,
      y: 18,
      width: 5,
      height: 5,
    })
  })
})

describe('pointInHudRects', () => {
  const rects = [
    { x: 100, y: 50, width: 200, height: 40 },
    { x: 150, y: 0, width: 50, height: 50 },
  ]
  const origin = { x: 1000, y: 500 }

  it('offsets window-relative rects by the window origin', () => {
    expect(pointInHudRects({ x: 1100, y: 550 }, rects, origin)).toBe(true)
    expect(pointInHudRects({ x: 1299, y: 589 }, rects, origin)).toBe(true)
    expect(pointInHudRects({ x: 1300, y: 550 }, rects, origin)).toBe(false)
    expect(pointInHudRects({ x: 1160, y: 510 }, rects, origin)).toBe(true)
  })

  it('is false for no rects', () => {
    expect(pointInHudRects({ x: 1100, y: 550 }, [], origin)).toBe(false)
  })
})

describe('sanitizeHudRects', () => {
  it('drops malformed entries and rounds the rest', () => {
    expect(
      sanitizeHudRects([
        { x: 1.4, y: 2.6, width: 10.5, height: 4 },
        { x: Number.NaN, y: 0, width: 1, height: 1 },
        { x: 0, y: 0, width: -1, height: 1 },
        'nope',
        null,
      ]),
    ).toEqual([{ x: 1, y: 3, width: 11, height: 4 }])
    expect(sanitizeHudRects(undefined)).toEqual([])
  })
})

describe('measureHudWindowSize', () => {
  const viewport = { viewportWidth: 1000, viewportHeight: 400 }

  it('is symmetric around the viewport centre and reaches the highest box', () => {
    const size = measureHudWindowSize({
      ...viewport,
      rects: [{ x: 300, y: 300, width: 400, height: 52 }],
      sideMargin: 10,
      topMargin: 10,
    })
    expect(size).toEqual({ width: 420, height: 110 })
  })

  it('grows for a popover that overhangs one side', () => {
    const size = measureHudWindowSize({
      ...viewport,
      rects: [
        { x: 300, y: 340, width: 400, height: 52 },
        { x: 650, y: 100, width: 300, height: 200 },
      ],
      sideMargin: 0,
      topMargin: 0,
    })
    // The popover's right edge is 450 px from centre, so the window is 900 wide.
    expect(size).toEqual({ width: 900, height: 300 })
  })

  it('never reports less than the minimum window size', () => {
    expect(measureHudWindowSize({ ...viewport, rects: [], sideMargin: 0, topMargin: 0 })).toEqual({
      width: 120,
      height: 80,
    })
  })

  it('ignores empty boxes such as a closed popover placeholder', () => {
    const size = measureHudWindowSize({
      ...viewport,
      rects: [
        { x: 300, y: 340, width: 400, height: 52 },
        { x: 0, y: 0, width: 0, height: 0 },
      ],
      sideMargin: 0,
      topMargin: 0,
    })
    expect(size).toEqual({ width: 400, height: 80 })
  })
})

describe('orientation helpers', () => {
  it('validates and toggles', () => {
    expect(isHudOrientation('vertical')).toBe(true)
    expect(isHudOrientation('diagonal')).toBe(false)
    expect(isHudOrientation(1)).toBe(false)
    expect(nextHudOrientation('horizontal')).toBe('vertical')
    expect(nextHudOrientation('vertical')).toBe('horizontal')
  })
})
