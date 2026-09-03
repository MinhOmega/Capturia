import { describe, expect, it } from 'vitest'
import type { CropRegion } from '@/components/video-editor/types'
import {
  CROP_ASPECT_PRESETS,
  cropRegionEquals,
  getCenteredAspectCropRegion,
  getCropRegionAspect,
  getDefaultCropAspectLockState,
  isCropAspectPreset,
  normalizeAspectCropRegion,
  resizeCropRegion,
  resolveCropLockRatio,
  sanitizeCropRegion,
} from './aspectCrop'

describe('getCenteredAspectCropRegion', () => {
  it('returns centered square for 16:9 source', () => {
    const region = getCenteredAspectCropRegion(16 / 9, 1)
    expect(region.width).toBeCloseTo(0.5625, 5)
    expect(region.height).toBeCloseTo(1, 5)
    expect(region.x).toBeCloseTo((1 - 0.5625) / 2, 5)
    expect(region.y).toBeCloseTo(0, 5)
  })

  it('returns centered 16:9 crop for portrait source', () => {
    const region = getCenteredAspectCropRegion(9 / 16, 16 / 9)
    expect(region.width).toBeCloseTo(1, 5)
    expect(region.height).toBeCloseTo(0.31640625, 5)
    expect(region.x).toBeCloseTo(0, 5)
    expect(region.y).toBeCloseTo((1 - 0.31640625) / 2, 5)
  })
})

describe('normalizeAspectCropRegion', () => {
  it('converts arbitrary crop into target aspect while keeping center', () => {
    const normalized = normalizeAspectCropRegion(
      { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      16 / 9,
      1,
    )
    expect(normalized.width).toBeCloseTo(0.5625, 5)
    expect(normalized.height).toBeCloseTo(1, 5)
    expect(normalized.x).toBeCloseTo((1 - 0.5625) / 2, 5)
    expect(normalized.y).toBeCloseTo(0, 5)
  })

  it('keeps already-normalized regions stable', () => {
    const input = { x: 0.18, y: 0.12, width: 0.45, height: 0.8 }
    const normalized = normalizeAspectCropRegion(input, 16 / 9, 1)
    expect(cropRegionEquals(input, normalized)).toBe(true)
  })

  it('clamps out-of-range crop values', () => {
    const normalized = normalizeAspectCropRegion(
      { x: -0.5, y: -0.2, width: 2.5, height: 1.5 },
      16 / 9,
      1,
    )
    expect(normalized.x).toBeGreaterThanOrEqual(0)
    expect(normalized.y).toBeGreaterThanOrEqual(0)
    expect(normalized.x + normalized.width).toBeLessThanOrEqual(1)
    expect(normalized.y + normalized.height).toBeLessThanOrEqual(1)
    const pixelRatio = (normalized.width * 16) / 9 / normalized.height
    expect(pixelRatio).toBeCloseTo(1, 4)
  })
})

describe('sanitizeCropRegion (native aspect)', () => {
  it('keeps a free-form crop as is when it fits inside the source', () => {
    expect(sanitizeCropRegion({ x: 0.1, y: 0.2, width: 0.3, height: 0.7 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.7,
    })
  })

  it('clamps size and position into the source and replaces non-finite values', () => {
    expect(sanitizeCropRegion({ x: 0.9, y: -1, width: 0.5, height: 2 })).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    })
    expect(sanitizeCropRegion({ x: Number.NaN, y: 0, width: Number.NaN, height: 0.01 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 0.06,
    })
  })
})

function expectRegion(actual: CropRegion, expected: CropRegion) {
  expect(actual.x).toBeCloseTo(expected.x, 9)
  expect(actual.y).toBeCloseTo(expected.y, 9)
  expect(actual.width).toBeCloseTo(expected.width, 9)
  expect(actual.height).toBeCloseTo(expected.height, 9)
}

describe('resizeCropRegion', () => {
  const SOURCE = 16 / 9
  const base = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }
  const free = { lockRatio: null, sourceAspect: SOURCE }
  const pixelAspect = (r: { width: number; height: number }) => (r.width / r.height) * SOURCE

  describe('free-form', () => {
    it('moves a single edge and leaves the others alone', () => {
      const next = resizeCropRegion(base, 'right', { dx: 0.1, dy: 0.5 }, free)
      expectRegion(next, { x: 0.2, y: 0.2, width: 0.5, height: 0.4 })
      const left = resizeCropRegion(base, 'left', { dx: -0.1, dy: 0 }, free)
      expect(left.x).toBeCloseTo(0.1, 6)
      expect(left.width).toBeCloseTo(0.5, 6)
      const top = resizeCropRegion(base, 'top', { dx: 0.3, dy: 0.1 }, free)
      expectRegion(top, { x: 0.2, y: 0.3, width: 0.4, height: 0.3 })
    })

    it('moves both axes from a corner', () => {
      const next = resizeCropRegion(base, 'bottom-right', { dx: 0.1, dy: -0.1 }, free)
      expectRegion(next, { x: 0.2, y: 0.2, width: 0.5, height: 0.3 })
      const tl = resizeCropRegion(base, 'top-left', { dx: -0.2, dy: -0.2 }, free)
      expectRegion(tl, { x: 0, y: 0, width: 0.6, height: 0.6 })
    })

    it('clamps to the source bounds', () => {
      const next = resizeCropRegion(base, 'bottom-right', { dx: 1, dy: 1 }, free)
      expectRegion(next, { x: 0.2, y: 0.2, width: 0.8, height: 0.8 })
      const tl = resizeCropRegion(base, 'top-left', { dx: -1, dy: -1 }, free)
      expectRegion(tl, { x: 0, y: 0, width: 0.6, height: 0.6 })
    })

    it('never shrinks below the minimum size, even when dragged past the opposite edge', () => {
      const next = resizeCropRegion(base, 'right', { dx: -1, dy: 0 }, free)
      expect(next.width).toBeCloseTo(0.06, 6)
      expect(next.x).toBeCloseTo(0.2, 6)
      const top = resizeCropRegion(base, 'top', { dx: 0, dy: 1 }, free)
      expect(top.height).toBeCloseTo(0.06, 6)
      expect(top.y + top.height).toBeCloseTo(0.6, 6)
      const custom = resizeCropRegion(base, 'bottom', { dx: 0, dy: -1 }, { ...free, minSize: 0.1 })
      expect(custom.height).toBeCloseTo(0.1, 6)
    })

    it('ignores a non-finite delta', () => {
      expectRegion(resizeCropRegion(base, 'right', { dx: Number.NaN, dy: 0 }, free), base)
    })
  })

  describe('locked', () => {
    const square = { lockRatio: 1, sourceAspect: SOURCE }

    it('an edge drag keeps the ratio and grows the other axis around its centre', () => {
      const start = { x: 0.3, y: 0.3, width: 0.225, height: 0.4 } // 1:1 on 16:9
      const next = resizeCropRegion(start, 'right', { dx: 0.1, dy: 0 }, square)
      expect(next.x).toBeCloseTo(0.3, 6)
      expect(next.width).toBeCloseTo(0.325, 6)
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
      expect(next.y + next.height / 2).toBeCloseTo(0.5, 6)
    })

    it('a corner drag anchors the opposite corner and follows the dominant axis', () => {
      const start = { x: 0.3, y: 0.3, width: 0.225, height: 0.4 }
      const next = resizeCropRegion(start, 'bottom-right', { dx: 0.02, dy: 0.2 }, square)
      expect(next.x).toBeCloseTo(0.3, 6)
      expect(next.y).toBeCloseTo(0.3, 6)
      expect(next.height).toBeCloseTo(0.6, 6)
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
      const tl = resizeCropRegion(start, 'top-left', { dx: -0.1, dy: 0 }, square)
      expect(tl.x + tl.width).toBeCloseTo(0.525, 6)
      expect(tl.y + tl.height).toBeCloseTo(0.7, 6)
      expect(tl.width).toBeCloseTo(0.325, 6)
      expect(pixelAspect(tl)).toBeCloseTo(1, 6)
    })

    it('snaps a free crop to the ratio on the first locked resize', () => {
      const next = resizeCropRegion(base, 'bottom-right', { dx: 0, dy: 0 }, square)
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
      expect(next.x).toBeCloseTo(0.2, 6)
      expect(next.y).toBeCloseTo(0.2, 6)
    })

    it('stays inside the source when the anchored side runs out of room', () => {
      const start = { x: 0.6, y: 0.5, width: 0.225, height: 0.4 }
      const next = resizeCropRegion(start, 'bottom-right', { dx: 1, dy: 1 }, square)
      expect(next.x + next.width).toBeLessThanOrEqual(1 + 1e-9)
      expect(next.y + next.height).toBeLessThanOrEqual(1 + 1e-9)
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
      // Height is the binding axis here: 0.5 of the source remains below the anchor.
      expect(next.height).toBeCloseTo(0.5, 6)
    })

    it('an edge drag near the border shifts the centre instead of refusing to grow', () => {
      const start = { x: 0.1, y: 0, width: 0.225, height: 0.4 }
      const next = resizeCropRegion(start, 'right', { dx: 0.2, dy: 0 }, square)
      expect(next.y).toBeGreaterThanOrEqual(0)
      expect(next.width).toBeCloseTo(0.425, 6)
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
      expect(next.y).toBeCloseTo(0, 6)
    })

    it('respects the minimum size on both axes', () => {
      const wide = { lockRatio: 8, sourceAspect: SOURCE }
      const next = resizeCropRegion(base, 'right', { dx: -1, dy: 0 }, wide)
      expect(next.width).toBeGreaterThanOrEqual(0.06 - 1e-9)
      expect(next.height).toBeGreaterThanOrEqual(0.06 - 1e-9)
      expect(pixelAspect(next)).toBeCloseTo(8, 6)
    })

    it('an invalid lock ratio resizes free-form', () => {
      const next = resizeCropRegion(
        base,
        'right',
        { dx: 0.1, dy: 0 },
        { lockRatio: Number.NaN, sourceAspect: SOURCE },
      )
      expectRegion(next, { x: 0.2, y: 0.2, width: 0.5, height: 0.4 })
    })
  })
})

describe('crop aspect lock state', () => {
  it('getCropRegionAspect converts the normalized shape into a pixel aspect', () => {
    expect(getCropRegionAspect({ x: 0, y: 0, width: 1, height: 1 }, 16 / 9)).toBeCloseTo(16 / 9, 6)
    expect(getCropRegionAspect({ x: 0, y: 0, width: 0.5625, height: 1 }, 16 / 9)).toBeCloseTo(1, 6)
  })

  it('CROP_ASPECT_PRESETS is free plus every fixed output aspect', () => {
    expect(CROP_ASPECT_PRESETS[0]).toBe('free')
    expect(CROP_ASPECT_PRESETS).not.toContain('native')
    expect(CROP_ASPECT_PRESETS).toHaveLength(8)
    expect(isCropAspectPreset('4:5')).toBe(true)
    expect(isCropAspectPreset('native')).toBe(false)
  })

  it('default state: native is free, a matching crop is locked to its output aspect', () => {
    const full = { x: 0, y: 0, width: 1, height: 1 }
    expect(getDefaultCropAspectLockState('native', full, 16 / 9)).toEqual({
      preset: 'free',
      locked: false,
    })
    expect(getDefaultCropAspectLockState('16:9', full, 16 / 9)).toEqual({
      preset: '16:9',
      locked: true,
    })
    expect(
      getDefaultCropAspectLockState('1:1', getCenteredAspectCropRegion(16 / 9, 1), 16 / 9),
    ).toEqual({ preset: '1:1', locked: true })
    expect(getDefaultCropAspectLockState('1:1', full, 16 / 9)).toEqual({
      preset: 'free',
      locked: false,
    })
  })

  it('resolveCropLockRatio: unlocked is null, free keeps the current shape, presets are fixed', () => {
    const region = { x: 0, y: 0, width: 0.5, height: 1 }
    expect(resolveCropLockRatio({ preset: '1:1', locked: false }, region, 16 / 9)).toBeNull()
    expect(resolveCropLockRatio({ preset: 'free', locked: true }, region, 16 / 9)).toBeCloseTo(
      8 / 9,
      6,
    )
    expect(resolveCropLockRatio({ preset: '9:16', locked: true }, region, 16 / 9)).toBeCloseTo(
      9 / 16,
      6,
    )
  })
})
