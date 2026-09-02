/**
 * Fixed ratios plus `'native'` ("Original"): the cropped source's own ratio, so
 * the video fills the frame edge to edge with no padding and exports at the
 * cropped source dimensions. Its numeric value depends on the source and the
 * crop, so callers with that context must use resolveAspectRatioValue().
 */
export const ASPECT_RATIOS = [
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '4:5',
  '16:10',
  '10:16',
  'native',
] as const

export type AspectRatio = (typeof ASPECT_RATIOS)[number]

export const NATIVE_ASPECT_RATIO: AspectRatio = 'native'

/** Used for `'native'` when the source dimensions are unknown (e.g. before metadata loads). */
const NATIVE_ASPECT_RATIO_FALLBACK = 16 / 9

export function isAspectRatio(value: unknown): value is AspectRatio {
  return typeof value === 'string' && (ASPECT_RATIOS as readonly string[]).includes(value)
}

/**
 * Returns the numeric value of an aspect ratio. `'native'` returns the 16:9
 * fallback; callers with source/crop context should use resolveAspectRatioValue().
 * Uses exhaustive type checking to ensure all AspectRatio cases are handled.
 * If TypeScript errors here, a new ratio was added to the type but not handled.
 */
export function getAspectRatioValue(aspectRatio: AspectRatio): number {
  switch (aspectRatio) {
    case '16:9':
      return 16 / 9
    case '9:16':
      return 9 / 16
    case '1:1':
      return 1
    case '4:3':
      return 4 / 3
    case '4:5':
      return 4 / 5
    case '16:10':
      return 16 / 10
    case '10:16':
      return 10 / 16
    case 'native':
      return NATIVE_ASPECT_RATIO_FALLBACK
    default: {
      // Ensures all cases are handled - TypeScript errors if missing
      const _exhaustiveCheck: never = aspectRatio
      return _exhaustiveCheck
    }
  }
}

interface NormalizedCropRegion {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Ratio of the cropped source (`crop` is normalised 0..1 of the source). Falls
 * back to 16:9 when the source dimensions or the crop are unusable.
 */
export function getNativeAspectRatioValue(
  videoWidth: number,
  videoHeight: number,
  cropRegion?: NormalizedCropRegion,
): number {
  const cropW = cropRegion?.width ?? 1
  const cropH = cropRegion?.height ?? 1
  if (
    !Number.isFinite(videoWidth) ||
    !Number.isFinite(videoHeight) ||
    !Number.isFinite(cropW) ||
    !Number.isFinite(cropH) ||
    videoWidth <= 0 ||
    videoHeight <= 0 ||
    cropW <= 0 ||
    cropH <= 0
  ) {
    return NATIVE_ASPECT_RATIO_FALLBACK
  }

  const ratio = (videoWidth * cropW) / (videoHeight * cropH)
  return Number.isFinite(ratio) && ratio > 0 ? ratio : NATIVE_ASPECT_RATIO_FALLBACK
}

/** Numeric ratio for any aspect, resolving `'native'` against the source and its crop. */
export function resolveAspectRatioValue(
  aspectRatio: AspectRatio,
  videoWidth: number,
  videoHeight: number,
  cropRegion?: NormalizedCropRegion,
): number {
  return aspectRatio === 'native'
    ? getNativeAspectRatioValue(videoWidth, videoHeight, cropRegion)
    : getAspectRatioValue(aspectRatio)
}

export function getAspectRatioDimensions(
  aspectRatio: AspectRatio,
  baseWidth: number,
): { width: number; height: number } {
  const ratio = getAspectRatioValue(aspectRatio)
  return {
    width: baseWidth,
    height: baseWidth / ratio,
  }
}

/** Non-localised label; UI code translates `'native'` via `settings.aspectRatioNative`. */
export function getAspectRatioLabel(aspectRatio: AspectRatio): string {
  if (aspectRatio === 'native') return 'Original'
  return aspectRatio
}

export function formatAspectRatioForCSS(aspectRatio: AspectRatio, nativeRatio?: number): string {
  if (aspectRatio === 'native') {
    const ratio =
      nativeRatio !== undefined && Number.isFinite(nativeRatio) && nativeRatio > 0
        ? nativeRatio
        : NATIVE_ASPECT_RATIO_FALLBACK
    return String(ratio)
  }
  return aspectRatio.replace(':', '/')
}
