/**
 * Cache keys and the escape hatch for the export compositor.
 *
 * `FrameRenderer` reuses three things across frames — the video texture, the
 * tessellated crop/rounded mask and the rasterised drop shadow. Each of them is
 * only valid while the inputs it was built from stay the same, so each is keyed
 * on exactly those inputs. The key builders live here, away from the WebGL
 * code, so the invalidation rules can be unit-tested without a browser.
 *
 * `legacyCompositor` turns every one of those caches off and puts the renderer
 * back on the allocate-per-frame path it used before, so a suspected
 * compositing regression can be A/B'd in the field without a new build.
 */

import type { CropRegion, Rotation3D } from '@/components/video-editor/types'

/**
 * `localStorage` key that forces the pre-cache compositor (support / QA switch),
 * mirroring `capturia.exportDecodePath`. `'1'` or `'true'` enables it.
 */
export const EXPORT_LEGACY_COMPOSITOR_STORAGE_KEY = 'capturia.exportLegacyCompositor'

/** Reads the legacy-compositor override; `undefined` when it is not set. */
export function readLegacyCompositorOverride(): boolean | undefined {
  try {
    const value = globalThis.localStorage?.getItem(EXPORT_LEGACY_COMPOSITOR_STORAGE_KEY)
    if (value === null || value === undefined) return undefined
    if (value === '1' || value === 'true') return true
    if (value === '0' || value === 'false') return false
    return undefined
  } catch {
    return undefined
  }
}

/** Everything `FrameRenderer.updateLayout` reads to tessellate the mask. */
export interface MaskGeometryInput {
  /** Output canvas size. */
  width: number
  height: number
  /** Undecoded source size, before the crop. */
  videoWidth: number
  videoHeight: number
  cropRegion: CropRegion
  borderRadius: number
  padding: number
  previewWidth: number
  previewHeight: number
}

function num(value: number | undefined): string {
  // Round-tripping through a fixed precision keeps float noise from a resize
  // handler out of the key without ever merging two visibly different layouts.
  return Number.isFinite(value) ? (value as number).toFixed(4) : 'x'
}

/**
 * Identity of the mask geometry. Two configurations with the same key produce
 * the same `Graphics` path, so the tessellation can be reused.
 */
export function buildMaskGeometryKey(input: MaskGeometryInput): string {
  return [
    num(input.width),
    num(input.height),
    num(input.videoWidth),
    num(input.videoHeight),
    num(input.cropRegion?.x),
    num(input.cropRegion?.y),
    num(input.cropRegion?.width),
    num(input.cropRegion?.height),
    num(input.borderRadius),
    num(input.padding),
    num(input.previewWidth),
    num(input.previewHeight),
  ].join('|')
}

/**
 * Everything that changes the *silhouette* the drop shadow is cast from. The
 * shadow is black at a fixed alpha profile, so it depends on the alpha channel
 * of the rendered stage and nothing else: the mask rectangle, the camera
 * transform that moves it and the 3D tilt that warps it.
 */
export interface ShadowGeometryInput {
  width: number
  height: number
  shadowIntensity: number
  maskWidth: number
  maskHeight: number
  maskBorderRadius: number
  baseOffsetX: number
  baseOffsetY: number
  cameraScaleX: number
  cameraScaleY: number
  cameraX: number
  cameraY: number
  rotation3D: Rotation3D
}

export function buildShadowGeometryKey(input: ShadowGeometryInput): string {
  return [
    num(input.width),
    num(input.height),
    num(input.shadowIntensity),
    num(input.maskWidth),
    num(input.maskHeight),
    num(input.maskBorderRadius),
    num(input.baseOffsetX),
    num(input.baseOffsetY),
    num(input.cameraScaleX),
    num(input.cameraScaleY),
    num(input.cameraX),
    num(input.cameraY),
    num(input.rotation3D?.rotationX),
    num(input.rotation3D?.rotationY),
    num(input.rotation3D?.rotationZ),
  ].join('|')
}

/**
 * The triple `drop-shadow()` chain the export composites the video through.
 * Constant for a whole export (intensity never changes mid-run), so it is
 * built once and reused.
 */
export function buildShadowFilter(intensity: number): string {
  const blur1 = 48 * intensity
  const blur2 = 16 * intensity
  const blur3 = 8 * intensity
  const alpha1 = 0.7 * intensity
  const alpha2 = 0.5 * intensity
  const alpha3 = 0.3 * intensity
  const offset = 12 * intensity
  return (
    `drop-shadow(0 ${offset}px ${blur1}px rgba(0,0,0,${alpha1})) ` +
    `drop-shadow(0 ${offset / 3}px ${blur2}px rgba(0,0,0,${alpha2})) ` +
    `drop-shadow(0 ${offset / 6}px ${blur3}px rgba(0,0,0,${alpha3}))`
  )
}

/** Whether a decoded frame can go into an existing texture source of this size. */
export function canReuseTextureSource(
  current: { width: number; height: number } | null,
  next: { width: number; height: number },
): boolean {
  if (!current) return false
  return current.width === next.width && current.height === next.height
}

/** Pixel size of a frame source, whichever shape it arrives in. */
export function getFrameSourceSize(source: HTMLVideoElement | VideoFrame): {
  width: number
  height: number
} {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight }
  }
  const frame = source as VideoFrame
  return {
    width: frame.displayWidth || frame.codedWidth || 0,
    height: frame.displayHeight || frame.codedHeight || 0,
  }
}
