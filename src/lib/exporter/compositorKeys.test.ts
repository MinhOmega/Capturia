import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ROTATION_3D } from '@/components/video-editor/types'
import {
  EXPORT_LEGACY_COMPOSITOR_STORAGE_KEY,
  buildMaskGeometryKey,
  buildShadowFilter,
  buildShadowGeometryKey,
  canReuseTextureSource,
  getFrameSourceSize,
  readLegacyCompositorOverride,
  type MaskGeometryInput,
  type ShadowGeometryInput,
} from './compositorKeys'

const MASK: MaskGeometryInput = {
  width: 1920,
  height: 1080,
  videoWidth: 2560,
  videoHeight: 1440,
  cropRegion: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 },
  borderRadius: 24,
  padding: 10,
  previewWidth: 1920,
  previewHeight: 1080,
}

const SHADOW: ShadowGeometryInput = {
  width: 1920,
  height: 1080,
  shadowIntensity: 0.8,
  maskWidth: 1600,
  maskHeight: 900,
  maskBorderRadius: 24,
  baseOffsetX: 160,
  baseOffsetY: 90,
  cameraScaleX: 1,
  cameraScaleY: 1,
  cameraX: 0,
  cameraY: 0,
  rotation3D: DEFAULT_ROTATION_3D,
}

describe('buildMaskGeometryKey', () => {
  it('is stable for the same inputs', () => {
    expect(buildMaskGeometryKey(MASK)).toBe(buildMaskGeometryKey({ ...MASK }))
  })

  it.each([
    ['canvas width', { width: 1280 }],
    ['canvas height', { height: 720 }],
    ['source width', { videoWidth: 1920 }],
    ['source height', { videoHeight: 1080 }],
    ['corner radius', { borderRadius: 25 }],
    ['padding', { padding: 11 }],
    ['preview width', { previewWidth: 1280 }],
    ['preview height', { previewHeight: 720 }],
  ])('changes when the %s changes', (_label, patch) => {
    expect(buildMaskGeometryKey({ ...MASK, ...patch })).not.toBe(buildMaskGeometryKey(MASK))
  })

  it.each([
    ['x', { x: 0.11 }],
    ['y', { y: 0.21 }],
    ['width', { width: 0.81 }],
    ['height', { height: 0.71 }],
  ])('changes when the crop %s changes', (_label, patch) => {
    const moved = { ...MASK, cropRegion: { ...MASK.cropRegion, ...patch } }
    expect(buildMaskGeometryKey(moved)).not.toBe(buildMaskGeometryKey(MASK))
  })

  it('ignores float noise below the quantisation step', () => {
    const jittered = { ...MASK, padding: 10 + 1e-9 }
    expect(buildMaskGeometryKey(jittered)).toBe(buildMaskGeometryKey(MASK))
  })

  it('does not throw on a missing crop region', () => {
    const missing = { ...MASK, cropRegion: undefined as unknown as MaskGeometryInput['cropRegion'] }
    expect(() => buildMaskGeometryKey(missing)).not.toThrow()
  })
})

describe('buildShadowGeometryKey', () => {
  it('is stable for the same silhouette', () => {
    expect(buildShadowGeometryKey(SHADOW)).toBe(buildShadowGeometryKey({ ...SHADOW }))
  })

  it.each([
    ['shadow intensity', { shadowIntensity: 0.7 }],
    ['mask width', { maskWidth: 1601 }],
    ['mask height', { maskHeight: 901 }],
    ['mask radius', { maskBorderRadius: 25 }],
    ['base offset x', { baseOffsetX: 161 }],
    ['base offset y', { baseOffsetY: 91 }],
    ['camera scale x', { cameraScaleX: 1.0001 }],
    ['camera scale y', { cameraScaleY: 1.0001 }],
    ['camera x', { cameraX: 0.5 }],
    ['camera y', { cameraY: 0.5 }],
  ])('changes when the %s changes', (_label, patch) => {
    expect(buildShadowGeometryKey({ ...SHADOW, ...patch })).not.toBe(buildShadowGeometryKey(SHADOW))
  })

  it('changes when the 3D tilt changes', () => {
    const tilted = { ...SHADOW, rotation3D: { rotationX: -12, rotationY: -18, rotationZ: -2 } }
    expect(buildShadowGeometryKey(tilted)).not.toBe(buildShadowGeometryKey(SHADOW))
  })

  it('treats a settled camera as the same silhouette', () => {
    // The zoom spring converges asymptotically; below the quantisation step the
    // silhouette is identical and the cached raster stays valid.
    const settling = { ...SHADOW, cameraX: 1e-6, cameraScaleX: 1 + 1e-7 }
    expect(buildShadowGeometryKey(settling)).toBe(buildShadowGeometryKey(SHADOW))
  })
})

describe('buildShadowFilter', () => {
  it('builds the three-layer drop-shadow chain scaled by intensity', () => {
    const filter = buildShadowFilter(1)
    expect(filter).toContain('drop-shadow(0 12px 48px rgba(0,0,0,0.7))')
    expect(filter).toContain('drop-shadow(0 4px 16px rgba(0,0,0,0.5))')
    expect(filter).toContain('drop-shadow(0 2px 8px rgba(0,0,0,0.3))')
  })

  it('scales every term with the intensity', () => {
    expect(buildShadowFilter(0.5)).toContain('drop-shadow(0 6px 24px rgba(0,0,0,0.35))')
  })

  it('uses only pure black, which is what makes the layer cacheable', () => {
    expect(buildShadowFilter(0.8).match(/rgba\(0,0,0,/g)).toHaveLength(3)
  })
})

describe('canReuseTextureSource', () => {
  it('refuses when there is no source yet', () => {
    expect(canReuseTextureSource(null, { width: 100, height: 50 })).toBe(false)
  })

  it('accepts an identical pixel size', () => {
    expect(canReuseTextureSource({ width: 100, height: 50 }, { width: 100, height: 50 })).toBe(true)
  })

  it.each([[{ width: 101, height: 50 }], [{ width: 100, height: 51 }], [{ width: 0, height: 0 }]])(
    'refuses a different pixel size %j',
    (next) => {
      expect(canReuseTextureSource({ width: 100, height: 50 }, next)).toBe(false)
    },
  )
})

describe('getFrameSourceSize', () => {
  it('reads displayWidth/Height from a VideoFrame-shaped source', () => {
    const frame = { displayWidth: 1920, displayHeight: 1080 } as unknown as VideoFrame
    expect(getFrameSourceSize(frame)).toEqual({ width: 1920, height: 1080 })
  })

  it('falls back to the coded size when there is no display size', () => {
    const frame = { codedWidth: 1280, codedHeight: 720 } as unknown as VideoFrame
    expect(getFrameSourceSize(frame)).toEqual({ width: 1280, height: 720 })
  })
})

describe('readLegacyCompositorOverride', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubStorage(value: string | null): void {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === EXPORT_LEGACY_COMPOSITOR_STORAGE_KEY ? value : null),
    })
  }

  it('is undefined when the key is absent, so the caller keeps its default', () => {
    stubStorage(null)
    expect(readLegacyCompositorOverride()).toBeUndefined()
  })

  it.each([['1'], ['true']])('reads %s as on', (value) => {
    stubStorage(value)
    expect(readLegacyCompositorOverride()).toBe(true)
  })

  it.each([['0'], ['false']])('reads %s as off', (value) => {
    stubStorage(value)
    expect(readLegacyCompositorOverride()).toBe(false)
  })

  it('ignores an unparseable value rather than guessing', () => {
    stubStorage('maybe')
    expect(readLegacyCompositorOverride()).toBeUndefined()
  })

  it('survives a storage that throws (private mode, sandboxed frame)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied')
      },
    })
    expect(readLegacyCompositorOverride()).toBeUndefined()
  })
})
