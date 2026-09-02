import { describe, expect, it } from 'vitest'
import {
  createTextAnnotationRegion,
  getZoomScale,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  resolveTextAnnotationContent,
  ZOOM_DEPTH_SCALES,
  type ZoomDepth,
  type ZoomRegion,
  DEFAULT_ZOOM_MOTION_BLUR,
  resolveProjectMotionBlurAmount,
  computeRotation3DContainScale,
  DEFAULT_ROTATION_3D,
  getRotation3D,
  isRotation3DIdentity,
  lerpRotation3D,
  normalizeRotationPreset,
  ROTATION_3D_PRESET_ORDER,
  ROTATION_3D_PRESETS,
  rotation3DPerspective,
  type Rotation3DPreset,
} from './types'

function zoomRegion(overrides: Partial<ZoomRegion> = {}): ZoomRegion {
  return {
    id: 'zoom-1',
    startMs: 0,
    endMs: 1000,
    depth: 3,
    focus: { cx: 0.5, cy: 0.5 },
    ...overrides,
  }
}

describe('getZoomScale', () => {
  it('falls back to the depth preset when customScale is unset', () => {
    for (const depth of [1, 2, 3, 4, 5, 6] as ZoomDepth[]) {
      expect(getZoomScale(zoomRegion({ depth }))).toBe(ZOOM_DEPTH_SCALES[depth])
    }
    expect(getZoomScale(zoomRegion({ depth: 2, customScale: undefined }))).toBe(
      ZOOM_DEPTH_SCALES[2],
    )
  })

  it('prefers a finite customScale over the preset', () => {
    expect(getZoomScale(zoomRegion({ depth: 3, customScale: 2.35 }))).toBe(2.35)
  })

  it('clamps customScale into the supported range', () => {
    expect(getZoomScale(zoomRegion({ customScale: 0.2 }))).toBe(MIN_ZOOM_SCALE)
    expect(getZoomScale(zoomRegion({ customScale: 12 }))).toBe(MAX_ZOOM_SCALE)
    expect(getZoomScale(zoomRegion({ customScale: Number.POSITIVE_INFINITY }))).toBe(MAX_ZOOM_SCALE)
    expect(getZoomScale(zoomRegion({ customScale: Number.NEGATIVE_INFINITY }))).toBe(MIN_ZOOM_SCALE)
  })

  it('ignores NaN customScale and uses the preset', () => {
    expect(getZoomScale(zoomRegion({ depth: 4, customScale: Number.NaN }))).toBe(
      ZOOM_DEPTH_SCALES[4],
    )
  })

  it('keeps the preset table inside the custom range', () => {
    for (const scale of Object.values(ZOOM_DEPTH_SCALES)) {
      expect(scale).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE)
      expect(scale).toBeLessThanOrEqual(MAX_ZOOM_SCALE)
    }
  })
})

// Regression coverage for upstream #127: a freshly created text annotation must
// start with truly empty content so the properties panel's placeholder shows
// and typing replaces rather than appends to baked-in text.
describe('createTextAnnotationRegion', () => {
  it('starts with empty content, not a baked-in placeholder string', () => {
    const region = createTextAnnotationRegion({
      id: 'annotation-1',
      startMs: 1000,
      endMs: 2000,
      zIndex: 1,
    })

    expect(region.content).toBe('')
    expect(region.type).toBe('text')
    expect(region.id).toBe('annotation-1')
    expect(region.zIndex).toBe(1)
  })

  it('gives every region its own position/size/style objects', () => {
    const a = createTextAnnotationRegion({ id: 'a', startMs: 0, endMs: 1, zIndex: 0 })
    const b = createTextAnnotationRegion({ id: 'b', startMs: 0, endMs: 1, zIndex: 0 })
    expect(a.style).not.toBe(b.style)
    expect(a.position).not.toBe(b.position)
    expect(a.size).not.toBe(b.size)
  })
})

describe('resolveTextAnnotationContent', () => {
  it('falls back to empty content when no prior text was stored', () => {
    expect(resolveTextAnnotationContent(undefined)).toBe('')
  })

  it('preserves existing text content when converting an existing region to text', () => {
    expect(resolveTextAnnotationContent('hello world')).toBe('hello world')
  })
})

describe('resolveProjectMotionBlurAmount (schema migration)', () => {
  it('maps the legacy boolean to the default amount or off', () => {
    expect(resolveProjectMotionBlurAmount({ motionBlurEnabled: true })).toBe(
      DEFAULT_ZOOM_MOTION_BLUR,
    )
    expect(DEFAULT_ZOOM_MOTION_BLUR).toBe(0.35)
    expect(resolveProjectMotionBlurAmount({ motionBlurEnabled: false })).toBe(0)
  })

  it('prefers a numeric amount over the legacy boolean and clamps it to 0..1', () => {
    expect(
      resolveProjectMotionBlurAmount({ motionBlurAmount: 0.6, motionBlurEnabled: false }),
    ).toBe(0.6)
    expect(resolveProjectMotionBlurAmount({ motionBlurAmount: 0, motionBlurEnabled: true })).toBe(0)
    expect(resolveProjectMotionBlurAmount({ motionBlurAmount: 4 })).toBe(1)
    expect(resolveProjectMotionBlurAmount({ motionBlurAmount: -1 })).toBe(0)
  })

  it('ignores non-finite amounts and defaults to off when both fields are missing', () => {
    expect(
      resolveProjectMotionBlurAmount({ motionBlurAmount: Number.NaN, motionBlurEnabled: true }),
    ).toBe(DEFAULT_ZOOM_MOTION_BLUR)
    expect(resolveProjectMotionBlurAmount({})).toBe(0)
  })
})

describe('3D rotation presets', () => {
  it('resolves a region preset to its angles and missing / unknown presets to identity', () => {
    expect(getRotation3D(zoomRegion({ rotationPreset: 'iso' }))).toEqual(ROTATION_3D_PRESETS.iso)
    expect(getRotation3D(zoomRegion({ rotationPreset: 'left' }))).toEqual({
      rotationX: 0,
      rotationY: -22,
      rotationZ: 0,
    })
    expect(getRotation3D(zoomRegion({ rotationPreset: 'right' }))).toEqual({
      rotationX: 0,
      rotationY: 22,
      rotationZ: 0,
    })
    expect(getRotation3D(zoomRegion())).toBe(DEFAULT_ROTATION_3D)
    expect(getRotation3D({ rotationPreset: 'tilt' as unknown as Rotation3DPreset })).toBe(
      DEFAULT_ROTATION_3D,
    )
    expect(ROTATION_3D_PRESET_ORDER).toEqual(['iso', 'left', 'right'])
  })

  it('normalizeRotationPreset keeps only the three known strings', () => {
    expect(normalizeRotationPreset('iso')).toBe('iso')
    expect(normalizeRotationPreset('left')).toBe('left')
    expect(normalizeRotationPreset('right')).toBe('right')
    expect(normalizeRotationPreset('Iso')).toBeUndefined()
    expect(normalizeRotationPreset('none')).toBeUndefined()
    expect(normalizeRotationPreset(1)).toBeUndefined()
    expect(normalizeRotationPreset(null)).toBeUndefined()
    expect(normalizeRotationPreset(undefined)).toBeUndefined()
  })

  it('isRotation3DIdentity tolerates sub-epsilon noise only', () => {
    expect(isRotation3DIdentity(DEFAULT_ROTATION_3D)).toBe(true)
    expect(isRotation3DIdentity({ rotationX: 0.005, rotationY: -0.005, rotationZ: 0 })).toBe(true)
    expect(isRotation3DIdentity({ rotationX: 0, rotationY: 0.02, rotationZ: 0 })).toBe(false)
    expect(isRotation3DIdentity(ROTATION_3D_PRESETS.iso)).toBe(false)
  })

  it('lerpRotation3D interpolates every axis linearly', () => {
    const mid = lerpRotation3D(DEFAULT_ROTATION_3D, ROTATION_3D_PRESETS.iso, 0.5)
    expect(mid).toEqual({ rotationX: -5, rotationY: -8, rotationZ: 0 })
    expect(lerpRotation3D(DEFAULT_ROTATION_3D, ROTATION_3D_PRESETS.iso, 0)).toEqual(
      DEFAULT_ROTATION_3D,
    )
    expect(lerpRotation3D(DEFAULT_ROTATION_3D, ROTATION_3D_PRESETS.iso, 1)).toEqual(
      ROTATION_3D_PRESETS.iso,
    )
    const between = lerpRotation3D(ROTATION_3D_PRESETS.left, ROTATION_3D_PRESETS.right, 0.25)
    expect(between.rotationY).toBeCloseTo(-11, 6)
  })

  it('rotation3DPerspective is 2.6x the shorter viewport side', () => {
    expect(rotation3DPerspective(1920, 1080)).toBeCloseTo(1080 * 2.6, 6)
    expect(rotation3DPerspective(600, 800)).toBeCloseTo(600 * 2.6, 6)
  })

  describe('computeRotation3DContainScale', () => {
    const W = 1920
    const H = 1080
    const P = rotation3DPerspective(W, H)

    it('returns 1 for the identity rotation', () => {
      expect(computeRotation3DContainScale(DEFAULT_ROTATION_3D, W, H, P)).toBe(1)
    })

    it('never scales up and shrinks the tilted presets so the projected box fits its rect', () => {
      for (const preset of ROTATION_3D_PRESET_ORDER) {
        const s = computeRotation3DContainScale(ROTATION_3D_PRESETS[preset], W, H, P)
        expect(s).toBeGreaterThan(0.8)
        expect(s).toBeLessThan(1)
      }
    })

    it('matches the projected-corner math for a pure Y rotation', () => {
      // rotateY(theta): x' = x cos(theta), z' = -x sin(theta); a corner with z' > 0 is
      // closer to the viewer and scales by P / (P - z'). That corner is the limiting one.
      const theta = (22 * Math.PI) / 180
      const halfW = W / 2
      const halfH = H / 2
      const nearZ = halfW * Math.sin(theta)
      const f = P / (P - nearZ)
      const maxX = halfW * Math.cos(theta) * f
      const maxY = halfH * f
      const expected = Math.min(halfW / maxX, halfH / maxY, 1)
      expect(computeRotation3DContainScale(ROTATION_3D_PRESETS.right, W, H, P)).toBeCloseTo(
        expected,
        10,
      )
      // The mirrored preset projects the same extents.
      expect(computeRotation3DContainScale(ROTATION_3D_PRESETS.left, W, H, P)).toBeCloseTo(
        expected,
        10,
      )
    })

    it('is orthographic when perspective is 0: rotateY always fits, rotateZ needs shrinking', () => {
      const theta = (22 * Math.PI) / 180
      expect(computeRotation3DContainScale(ROTATION_3D_PRESETS.right, W, H, 0)).toBeCloseTo(1, 10)
      const z = computeRotation3DContainScale(
        { rotationX: 0, rotationY: 0, rotationZ: 22 },
        W,
        H,
        0,
      )
      const maxY = (W / 2) * Math.sin(theta) + (H / 2) * Math.cos(theta)
      expect(z).toBeCloseTo(Math.min(1, H / 2 / maxY), 10)
    })

    it('returns 1 instead of exploding when a corner reaches the eye plane', () => {
      expect(
        computeRotation3DContainScale({ rotationX: 0, rotationY: 89, rotationZ: 0 }, W, H, 10),
      ).toBe(1)
    })
  })
})
