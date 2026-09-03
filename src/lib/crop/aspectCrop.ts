import type { CropRegion } from '@/components/video-editor/types'
import { ASPECT_RATIOS, type AspectRatio, getAspectRatioValue } from '@/utils/aspectRatioUtils'

const MIN_SIZE = 0.06

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sanitizeAspect(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Clamp a crop into the source without imposing an aspect. This is the crop
 * model for the 'native' ("Original") aspect: the output ratio follows the crop
 * instead of the crop following a fixed ratio.
 */
export function sanitizeCropRegion(region: CropRegion): CropRegion {
  const width = clamp(Number.isFinite(region.width) ? region.width : 1, MIN_SIZE, 1)
  const height = clamp(Number.isFinite(region.height) ? region.height : 1, MIN_SIZE, 1)
  const x = clamp(Number.isFinite(region.x) ? region.x : 0, 0, 1 - width)
  const y = clamp(Number.isFinite(region.y) ? region.y : 0, 0, 1 - height)
  return { x, y, width, height }
}

export function getCenteredAspectCropRegion(
  sourceAspectInput: number,
  targetAspectInput: number,
): CropRegion {
  const sourceAspect = sanitizeAspect(sourceAspectInput, 16 / 9)
  const targetAspect = sanitizeAspect(targetAspectInput, sourceAspect)

  // ratio = (widthNorm * sourceAspect) / heightNorm
  let width = 1
  let height = sourceAspect / targetAspect

  if (height > 1) {
    height = 1
    width = targetAspect / sourceAspect
  }

  width = clamp(width, MIN_SIZE, 1)
  height = clamp(height, MIN_SIZE, 1)

  return {
    x: (1 - width) / 2,
    y: (1 - height) / 2,
    width,
    height,
  }
}

export function normalizeAspectCropRegion(
  input: CropRegion,
  sourceAspectInput: number,
  targetAspectInput: number,
): CropRegion {
  const sourceAspect = sanitizeAspect(sourceAspectInput, 16 / 9)
  const targetAspect = sanitizeAspect(targetAspectInput, sourceAspect)
  const region = sanitizeCropRegion(input)

  const centerX = region.x + region.width / 2
  const centerY = region.y + region.height / 2

  const maxWidthFromCenter = 2 * Math.min(centerX, 1 - centerX)
  const maxHeightFromCenter = 2 * Math.min(centerY, 1 - centerY)
  const maxWidthFromHeight = (maxHeightFromCenter * targetAspect) / sourceAspect
  const maxAllowedWidth = clamp(Math.min(maxWidthFromCenter, maxWidthFromHeight), MIN_SIZE, 1)

  const requestedWidthFromInput = Math.max(
    region.width,
    (region.height * targetAspect) / sourceAspect,
  )
  const width = clamp(requestedWidthFromInput, MIN_SIZE, maxAllowedWidth)
  const height = clamp((width * sourceAspect) / targetAspect, MIN_SIZE, 1)

  const nextX = clamp(centerX - width / 2, 0, 1 - width)
  const nextY = clamp(centerY - height / 2, 0, 1 - height)

  return {
    x: nextX,
    y: nextY,
    width,
    height,
  }
}

export function cropRegionEquals(a: CropRegion, b: CropRegion, epsilon = 1e-4): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon &&
    Math.abs(a.y - b.y) <= epsilon &&
    Math.abs(a.width - b.width) <= epsilon &&
    Math.abs(a.height - b.height) <= epsilon
  )
}

// ---------------------------------------------------------------------------
// Free-form crop with an optional aspect lock.
//
// The crop stored per output aspect is free-form: its shape is whatever the
// user last dragged. A fixed output aspect letterboxes a crop of another
// shape (the layout fits the cropped source into the canvas and pads the
// rest), and the 'native' output takes its size from the crop. The lock is a
// tool mode for the next resize, not a constraint on the stored value.
// ---------------------------------------------------------------------------

export type CropResizeHandle =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

export const CROP_RESIZE_HANDLES: readonly CropResizeHandle[] = [
  'top-left',
  'top',
  'top-right',
  'right',
  'bottom-right',
  'bottom',
  'bottom-left',
  'left',
]

/** Presets offered by the crop ratio select: every fixed output aspect plus free-form. */
export type CropAspectPreset = 'free' | Exclude<AspectRatio, 'native'>

export const CROP_ASPECT_PRESETS: readonly CropAspectPreset[] = [
  'free',
  ...(ASPECT_RATIOS.filter((ratio) => ratio !== 'native') as Exclude<AspectRatio, 'native'>[]),
]

export function isCropAspectPreset(value: unknown): value is CropAspectPreset {
  return typeof value === 'string' && (CROP_ASPECT_PRESETS as readonly string[]).includes(value)
}

export interface CropAspectLockState {
  preset: CropAspectPreset
  locked: boolean
}

export interface CropResizeOptions {
  /** Output pixel aspect (width / height) the crop must keep; `null` resizes free-form. */
  lockRatio: number | null
  /** Source pixel aspect (width / height); converts `lockRatio` into normalized units. */
  sourceAspect: number
  /** Smallest normalized edge, defaults to the module minimum. */
  minSize?: number
}

/** Pixel aspect (width / height) of a normalized crop on a source of the given aspect. */
export function getCropRegionAspect(region: CropRegion, sourceAspectInput: number): number {
  const sourceAspect = sanitizeAspect(sourceAspectInput, 16 / 9)
  const safe = sanitizeCropRegion(region)
  return (safe.width / safe.height) * sourceAspect
}

/**
 * Lock state to start from when none was chosen for this output aspect yet:
 * a crop that already matches the output aspect starts locked to it (the
 * behaviour before free-form crops existed), anything else starts free.
 */
export function getDefaultCropAspectLockState(
  aspectRatio: AspectRatio,
  region: CropRegion,
  sourceAspect: number,
): CropAspectLockState {
  if (aspectRatio === 'native') return { preset: 'free', locked: false }
  const target = getAspectRatioValue(aspectRatio)
  const current = getCropRegionAspect(region, sourceAspect)
  const matches = Math.abs(current - target) <= target * 0.01
  return matches ? { preset: aspectRatio, locked: true } : { preset: 'free', locked: false }
}

/**
 * The pixel aspect a resize must keep, or `null` for free-form. With the
 * 'free' preset the lock keeps the crop's current shape.
 */
export function resolveCropLockRatio(
  state: CropAspectLockState,
  region: CropRegion,
  sourceAspect: number,
): number | null {
  if (!state.locked) return null
  if (state.preset === 'free') return getCropRegionAspect(region, sourceAspect)
  return getAspectRatioValue(state.preset)
}

/**
 * Move one edge or corner of a crop by a normalized delta. Free-form when
 * `lockRatio` is null; otherwise the opposite edge / corner stays anchored
 * and the crop snaps to the ratio (a corner drag follows the dominant axis,
 * an edge drag grows the other axis around its centre). The result never
 * leaves the source and never shrinks below the minimum size.
 */
export function resizeCropRegion(
  region: CropRegion,
  handle: CropResizeHandle,
  delta: { dx: number; dy: number },
  options: CropResizeOptions,
): CropRegion {
  const start = sanitizeCropRegion(region)
  const minSize = clamp(options.minSize ?? MIN_SIZE, 0.001, 1)
  const dx = Number.isFinite(delta.dx) ? delta.dx : 0
  const dy = Number.isFinite(delta.dy) ? delta.dy : 0

  const movesLeft = handle === 'left' || handle === 'top-left' || handle === 'bottom-left'
  const movesRight = handle === 'right' || handle === 'top-right' || handle === 'bottom-right'
  const movesTop = handle === 'top' || handle === 'top-left' || handle === 'top-right'
  const movesBottom = handle === 'bottom' || handle === 'bottom-left' || handle === 'bottom-right'

  let left = start.x
  let right = start.x + start.width
  let top = start.y
  let bottom = start.y + start.height

  if (movesLeft) left = clamp(left + dx, 0, right - minSize)
  if (movesRight) right = clamp(right + dx, left + minSize, 1)
  if (movesTop) top = clamp(top + dy, 0, bottom - minSize)
  if (movesBottom) bottom = clamp(bottom + dy, top + minSize, 1)

  const lockRatio =
    options.lockRatio !== null && Number.isFinite(options.lockRatio) && options.lockRatio > 0
      ? options.lockRatio
      : null
  if (lockRatio === null) {
    return { x: left, y: top, width: right - left, height: bottom - top }
  }

  // Normalized width / height ratio equivalent to the requested pixel aspect.
  const sourceAspect = sanitizeAspect(options.sourceAspect, 16 / 9)
  const ratio = lockRatio / sourceAspect
  const minWidth = Math.max(minSize, minSize * ratio)

  const horizontal = movesLeft || movesRight
  const vertical = movesTop || movesBottom
  const freeWidth = right - left
  const freeHeight = bottom - top
  let width: number
  if (horizontal && vertical) width = Math.max(freeWidth, freeHeight * ratio)
  else if (horizontal) width = freeWidth
  else width = freeHeight * ratio

  const centerX = start.x + start.width / 2
  const centerY = start.y + start.height / 2
  const availableWidth = movesLeft ? right : movesRight ? 1 - left : 1
  const availableHeight = movesTop ? bottom : movesBottom ? 1 - top : 1
  const maxWidth = Math.min(availableWidth, availableHeight * ratio)
  width = clamp(width, minWidth, Math.max(minWidth, maxWidth))
  const height = width / ratio

  const x = movesLeft ? right - width : movesRight ? left : centerX - width / 2
  const y = movesTop ? bottom - height : movesBottom ? top : centerY - height / 2
  return sanitizeCropRegion({ x, y, width, height })
}
