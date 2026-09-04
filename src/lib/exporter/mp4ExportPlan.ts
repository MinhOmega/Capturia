import type { ExportQuality } from './types'

export interface Mp4ExportPlanInput {
  quality: ExportQuality
  aspectRatio: number
  sourceWidth: number
  sourceHeight: number
  sourceFrameRate?: number
  /**
   * Frame rate the user picked in the export panel. Ignored when it is not one
   * of `getAvailableExportFrameRates(sourceFrameRate)`, so a saved preference
   * from a 60 fps recording cannot ask a 30 fps one to invent frames.
   */
  requestedFrameRate?: number
}

export interface Mp4ExportPlan {
  width: number
  height: number
  bitrate: number
  frameRate: number
  limitedBySource: boolean
  /** `true` when `requestedFrameRate` was dropped for being above the source. */
  frameRateLimitedBySource: boolean
  /** `true` when the export runs at a different rate than the source. */
  frameRateDiffersFromSource: boolean
}

type Dimensions = {
  width: number
  height: number
}

const DEFAULT_ASPECT_RATIO = 16 / 9

const QUALITY_TARGET_HEIGHT: Record<Exclude<ExportQuality, 'source'>, number> = {
  medium: 720,
  good: 1080,
}

const BITRATE_BPP_PER_FRAME: Record<ExportQuality, number> = {
  // Screen content is text-heavy and more sensitive to compression artifacts.
  medium: 0.1,
  good: 0.14,
  source: 0.22,
}

const BITRATE_LIMITS: Record<ExportQuality, { min: number; max: number }> = {
  medium: { min: 8_000_000, max: 24_000_000 },
  good: { min: 12_000_000, max: 48_000_000 },
  source: { min: 18_000_000, max: 140_000_000 },
}

function normalizeDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(2, Math.floor(value / 2) * 2)
}

/**
 * Source dimensions after the (normalised 0..1) crop, rounded to even. This is
 * the "source" the 'native' aspect exports at: no padding, no rescale beyond
 * what the quality preset caps.
 */
export function calculateEffectiveSourceDimensions(
  sourceWidth: number,
  sourceHeight: number,
  cropRegion?: { width: number; height: number },
): Dimensions {
  const cropWidth =
    Number.isFinite(cropRegion?.width) && (cropRegion?.width ?? 0) > 0 ? cropRegion!.width : 1
  const cropHeight =
    Number.isFinite(cropRegion?.height) && (cropRegion?.height ?? 0) > 0 ? cropRegion!.height : 1
  return {
    width: normalizeDimension(Math.round(sourceWidth * cropWidth), 1920),
    height: normalizeDimension(Math.round(sourceHeight * cropHeight), 1080),
  }
}

function normalizeAspectRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_ASPECT_RATIO
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function fitAspectRatioWithinBounds(
  aspectRatio: number,
  maxWidth: number,
  maxHeight: number,
): Dimensions {
  const safeMaxWidth = normalizeDimension(maxWidth, 2)
  const safeMaxHeight = normalizeDimension(maxHeight, 2)

  const boundsRatio = safeMaxWidth / safeMaxHeight

  let width: number
  let height: number

  if (boundsRatio > aspectRatio) {
    height = safeMaxHeight
    width = Math.floor((height * aspectRatio) / 2) * 2
  } else {
    width = safeMaxWidth
    height = Math.floor(width / aspectRatio / 2) * 2
  }

  if (width < 2 || height < 2) {
    return { width: 2, height: 2 }
  }

  if (width > safeMaxWidth) {
    width = safeMaxWidth
    height = Math.floor(width / aspectRatio / 2) * 2
  }
  if (height > safeMaxHeight) {
    height = safeMaxHeight
    width = Math.floor((height * aspectRatio) / 2) * 2
  }

  width = normalizeDimension(width, 2)
  height = normalizeDimension(height, 2)

  return {
    width: Math.max(2, Math.min(width, safeMaxWidth)),
    height: Math.max(2, Math.min(height, safeMaxHeight)),
  }
}

export function normalizeExportSourceFrameRate(sourceFrameRate?: number): number {
  if (!Number.isFinite(sourceFrameRate)) return 60
  const normalized = Math.round(sourceFrameRate || 60)
  if (normalized < 24) return 24
  if (normalized > 120) return 120
  return normalized
}

/**
 * Frame rates the export panel offers, before the source filter. Anything above
 * the source would be duplicated frames: more bytes, no more motion.
 */
export const EXPORT_FRAME_RATE_CHOICES: readonly number[] = [24, 30, 60]

/**
 * The subset of `EXPORT_FRAME_RATE_CHOICES` at or below the source rate, plus
 * the source rate itself when it is not already one of them (a 50 fps or
 * 120 fps recording must still be exportable at its own rate). Always at least
 * one entry, because `normalizeExportSourceFrameRate` floors the source at 24.
 */
export function getAvailableExportFrameRates(sourceFrameRate?: number): number[] {
  const sourceRate = normalizeExportSourceFrameRate(sourceFrameRate)
  const rates = EXPORT_FRAME_RATE_CHOICES.filter((rate) => rate <= sourceRate)
  if (!rates.includes(sourceRate)) rates.push(sourceRate)
  return rates.sort((a, b) => a - b)
}

/** `true` when `frameRate` is one of the rates this source may be exported at. */
export function isSupportedExportFrameRate(
  frameRate: number | undefined,
  sourceFrameRate?: number,
): boolean {
  if (!Number.isFinite(frameRate)) return false
  return getAvailableExportFrameRates(sourceFrameRate).includes(Math.round(frameRate as number))
}

export function resolveExportFrameRate(
  sourceFrameRate: number | undefined,
  quality: ExportQuality,
  requestedFrameRate?: number,
): number {
  const sourceRate = normalizeExportSourceFrameRate(sourceFrameRate)
  if (isSupportedExportFrameRate(requestedFrameRate, sourceFrameRate)) {
    return Math.round(requestedFrameRate as number)
  }
  if (quality === 'source') {
    return sourceRate
  }
  return Math.min(sourceRate, 60)
}

function calculateBitrate(
  width: number,
  height: number,
  frameRate: number,
  quality: ExportQuality,
): number {
  const pixels = Math.max(1, width * height)
  const fps = Math.max(1, frameRate)
  const raw = Math.round(pixels * fps * BITRATE_BPP_PER_FRAME[quality])
  const limits = BITRATE_LIMITS[quality]
  return clamp(raw, limits.min, limits.max)
}

export function calculateMp4ExportPlan(input: Mp4ExportPlanInput): Mp4ExportPlan {
  const aspectRatio = normalizeAspectRatio(input.aspectRatio)
  const sourceWidth = normalizeDimension(input.sourceWidth, 1920)
  const sourceHeight = normalizeDimension(input.sourceHeight, 1080)
  const sourceRate = normalizeExportSourceFrameRate(input.sourceFrameRate)
  const frameRate = resolveExportFrameRate(
    input.sourceFrameRate,
    input.quality,
    input.requestedFrameRate,
  )
  const frameRateLimitedBySource =
    Number.isFinite(input.requestedFrameRate) &&
    !isSupportedExportFrameRate(input.requestedFrameRate, input.sourceFrameRate)
  const frameRateDiffersFromSource = frameRate !== sourceRate

  const sourceBound = fitAspectRatioWithinBounds(aspectRatio, sourceWidth, sourceHeight)

  if (input.quality === 'source') {
    return {
      width: sourceBound.width,
      height: sourceBound.height,
      frameRate,
      bitrate: calculateBitrate(sourceBound.width, sourceBound.height, frameRate, input.quality),
      limitedBySource: false,
      frameRateLimitedBySource,
      frameRateDiffersFromSource,
    }
  }

  const targetHeight = QUALITY_TARGET_HEIGHT[input.quality]
  const requestedHeight = normalizeDimension(targetHeight, 720)
  const requestedWidth = normalizeDimension(Math.round(requestedHeight * aspectRatio), 1280)

  const bounded = fitAspectRatioWithinBounds(
    aspectRatio,
    Math.min(requestedWidth, sourceBound.width),
    Math.min(requestedHeight, sourceBound.height),
  )

  const limitedBySource = bounded.width < requestedWidth || bounded.height < requestedHeight

  return {
    width: bounded.width,
    height: bounded.height,
    frameRate,
    bitrate: calculateBitrate(bounded.width, bounded.height, frameRate, input.quality),
    limitedBySource,
    frameRateLimitedBySource,
    frameRateDiffersFromSource,
  }
}
