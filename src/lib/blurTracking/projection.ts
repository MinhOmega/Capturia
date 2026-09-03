import type { CropRegion } from '@/components/video-editor/types'
import type { NormRect } from './keyframes'

/**
 * Source space <-> stage space, for geometry that is attached to the recorded
 * pixels rather than to the output frame.
 *
 * A legacy blur region stores its box as a percentage of the *stage*, so it
 * lands on different content in a 9:16 export than in 16:9 and does not follow
 * the zoom camera. A tracked blur stores source-normalised rectangles instead
 * and is projected here, exactly the way a cursor sample is
 * (`projectCursorToViewport`), which makes it follow crop, camera and every
 * export aspect for free.
 *
 * `projectSourcePointToStage` is the one piece of arithmetic behind both, so
 * the cursor and the blur cannot drift apart. See
 * `docs/specs/tracked-blur-regions.md` §2.5.
 */

/** Everything needed to place source-normalised geometry on the output stage. */
export interface StageGeometry {
  /** Output canvas / overlay container size, px. */
  stageSize: { width: number; height: number }
  /** Mask origin in camera-local px (preview: `maskRect.x/y`; export: 0,0). */
  baseOffset: { x: number; y: number }
  /** The video mask (the cropped video as displayed) in camera-local px. */
  maskRect: { width: number; height: number }
  /** Visible portion of the source, 0..1. */
  cropRegion: CropRegion
  /** `cameraContainer` scale and position after `applyZoomTransform`. */
  camera: { scale: number; x: number; y: number }
}

/** A rectangle in stage pixels. */
export interface StagePxRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ProjectedPoint {
  x: number
  y: number
  /** The source point lies inside the active crop, so it is on screen at all. */
  inCrop: boolean
}

/**
 * Source-normalised point (0..1 of the *full* frame) to stage pixels:
 * re-normalise against the crop, place on the mask, apply the camera.
 *
 * `projectCursorToViewport` and `projectSourceRectToStage` both go through
 * this; changing the arithmetic in one place changes it for both, which is the
 * point of the function existing.
 */
export function projectSourcePointToStage(args: {
  normalizedX: number
  normalizedY: number
  cropRegion: CropRegion
  baseOffset: { x: number; y: number }
  maskRect: { width: number; height: number }
  cameraScale: { x: number; y: number }
  cameraPosition: { x: number; y: number }
}): ProjectedPoint {
  const {
    normalizedX,
    normalizedY,
    cropRegion,
    baseOffset,
    maskRect,
    cameraScale,
    cameraPosition,
  } = args

  // Samples are normalised against the full frame; re-normalise against the
  // crop before projecting onto the mask (which shows only the cropped area).
  const cropValid = cropRegion.width > 0 && cropRegion.height > 0
  const inCropX = (normalizedX - cropRegion.x) / Math.max(0.0001, cropRegion.width)
  const inCropY = (normalizedY - cropRegion.y) / Math.max(0.0001, cropRegion.height)
  const inCrop = cropValid && inCropX >= 0 && inCropX <= 1 && inCropY >= 0 && inCropY <= 1

  const localX = baseOffset.x + inCropX * maskRect.width
  const localY = baseOffset.y + inCropY * maskRect.height

  return {
    x: localX * cameraScale.x + cameraPosition.x,
    y: localY * cameraScale.y + cameraPosition.y,
    inCrop,
  }
}

function cameraScaleOf(geometry: StageGeometry): { x: number; y: number } {
  const scale = Number.isFinite(geometry.camera.scale) ? geometry.camera.scale : 1
  return { x: scale, y: scale }
}

/** The mask (the video itself) in stage pixels, which is what a blur may never spill out of. */
export function projectMaskToStage(geometry: StageGeometry): StagePxRect {
  const scale = cameraScaleOf(geometry)
  return {
    x: geometry.baseOffset.x * scale.x + geometry.camera.x,
    y: geometry.baseOffset.y * scale.y + geometry.camera.y,
    width: geometry.maskRect.width * scale.x,
    height: geometry.maskRect.height * scale.y,
  }
}

export interface ProjectedStageRect extends StagePxRect {
  /** True when the rect was cut down by the mask, so part of the content is off screen. */
  clipped: boolean
}

/**
 * A source-normalised rectangle in stage pixels, clipped to the video mask, or
 * `null` when none of it is visible.
 *
 * The camera is a uniform scale plus a translation, so a rectangle stays a
 * rectangle and mapping the two corners is exact. Clipping to the mask is what
 * keeps a mosaic off the wallpaper padding around the video.
 */
export function projectSourceRectToStage(
  rect: NormRect,
  geometry: StageGeometry,
): ProjectedStageRect | null {
  if (!(rect.w > 0) || !(rect.h > 0)) return null

  const cameraScale = cameraScaleOf(geometry)
  const shared = {
    cropRegion: geometry.cropRegion,
    baseOffset: geometry.baseOffset,
    maskRect: geometry.maskRect,
    cameraScale,
    cameraPosition: { x: geometry.camera.x, y: geometry.camera.y },
  }
  const topLeft = projectSourcePointToStage({
    normalizedX: rect.x,
    normalizedY: rect.y,
    ...shared,
  })
  const bottomRight = projectSourcePointToStage({
    normalizedX: rect.x + rect.w,
    normalizedY: rect.y + rect.h,
    ...shared,
  })

  const left = Math.min(topLeft.x, bottomRight.x)
  const top = Math.min(topLeft.y, bottomRight.y)
  const right = Math.max(topLeft.x, bottomRight.x)
  const bottom = Math.max(topLeft.y, bottomRight.y)

  const mask = projectMaskToStage(geometry)
  const clippedLeft = Math.max(left, mask.x)
  const clippedTop = Math.max(top, mask.y)
  const clippedRight = Math.min(right, mask.x + mask.width)
  const clippedBottom = Math.min(bottom, mask.y + mask.height)
  if (!(clippedRight > clippedLeft) || !(clippedBottom > clippedTop)) return null

  return {
    x: clippedLeft,
    y: clippedTop,
    width: clippedRight - clippedLeft,
    height: clippedBottom - clippedTop,
    clipped:
      clippedLeft > left + 1e-9 ||
      clippedTop > top + 1e-9 ||
      clippedRight < right - 1e-9 ||
      clippedBottom < bottom - 1e-9,
  }
}

/**
 * Exact inverse of {@link projectSourceRectToStage} before clipping: what the
 * user's drag in the preview means in source space. Phase 3 writes the result
 * as a user pin, and the anchor box of a new track goes through it too.
 */
export function stageRectToSourceRect(rect: StagePxRect, geometry: StageGeometry): NormRect {
  const scale = cameraScaleOf(geometry)
  const safeScaleX = scale.x === 0 ? 1 : scale.x
  const safeScaleY = scale.y === 0 ? 1 : scale.y
  const maskWidth = geometry.maskRect.width === 0 ? 1 : geometry.maskRect.width
  const maskHeight = geometry.maskRect.height === 0 ? 1 : geometry.maskRect.height

  const toSourceX = (stageX: number): number => {
    const localX = (stageX - geometry.camera.x) / safeScaleX
    const inCropX = (localX - geometry.baseOffset.x) / maskWidth
    return geometry.cropRegion.x + inCropX * geometry.cropRegion.width
  }
  const toSourceY = (stageY: number): number => {
    const localY = (stageY - geometry.camera.y) / safeScaleY
    const inCropY = (localY - geometry.baseOffset.y) / maskHeight
    return geometry.cropRegion.y + inCropY * geometry.cropRegion.height
  }

  const x = toSourceX(rect.x)
  const y = toSourceY(rect.y)
  return { x, y, w: toSourceX(rect.x + rect.width) - x, h: toSourceY(rect.y + rect.height) - y }
}
