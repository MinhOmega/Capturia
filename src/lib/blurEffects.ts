import {
  type AnnotationRegion,
  type BlurColor,
  type BlurData,
  type BlurShape,
  type BlurType,
  DEFAULT_BLUR_BLOCK_SIZE,
  DEFAULT_BLUR_INTENSITY,
  MAX_BLUR_BLOCK_SIZE,
  MAX_BLUR_INTENSITY,
  MIN_BLUR_BLOCK_SIZE,
  MIN_BLUR_INTENSITY,
} from '@/components/video-editor/types'
import { normalizeBlurTrack } from './blurTracking/keyframes'

/**
 * Pure helpers behind blur (mosaic) regions. The preview overlay and the
 * exporter both call `renderMosaicRegion` on the pixels under the region so
 * the two paths cannot drift: same block averaging, same oval mask, same shade.
 */

/** Structural subset of `ImageData` so the helpers run in node tests without a canvas. */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function normalizeBlurType(value: unknown): BlurType {
  void value
  return 'mosaic'
}

export function normalizeBlurShape(value: unknown): BlurShape {
  return value === 'oval' ? 'oval' : 'rectangle'
}

export function normalizeBlurColor(value: unknown): BlurColor {
  return value === 'black' ? 'black' : 'white'
}

export function normalizeBlurIntensity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, MIN_BLUR_INTENSITY, MAX_BLUR_INTENSITY)
    : DEFAULT_BLUR_INTENSITY
}

export function normalizeBlurBlockSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, MIN_BLUR_BLOCK_SIZE, MAX_BLUR_BLOCK_SIZE)
    : DEFAULT_BLUR_BLOCK_SIZE
}

/** Coerces anything (an old save, a partial object, garbage) into valid blur settings. */
export function normalizeBlurData(value: unknown): BlurData {
  const raw =
    value && typeof value === 'object' ? (value as Partial<Record<keyof BlurData, unknown>>) : {}
  return {
    type: normalizeBlurType(raw.type),
    shape: normalizeBlurShape(raw.shape),
    color: normalizeBlurColor(raw.color),
    intensity: normalizeBlurIntensity(raw.intensity),
    blockSize: normalizeBlurBlockSize(raw.blockSize),
  }
}

/**
 * Persistence normaliser for the annotation list of a restored project. Blur
 * regions always get valid `blurData` (defaults when missing); other regions
 * keep their fields untouched apart from dropping a stray `blurData`, so a
 * project saved before blur regions existed round-trips unchanged.
 */
export function normalizeAnnotationBlurData(regions: AnnotationRegion[]): AnnotationRegion[] {
  return regions.map((region) => {
    if (region.type === 'blur') {
      const normalized: AnnotationRegion = {
        ...region,
        blurData: normalizeBlurData(region.blurData),
      }
      // An unusable track degrades the region to the static box it was before
      // tracking existed, which is always a valid thing for it to be.
      const blurTrack = normalizeBlurTrack(region.blurTrack)
      if (blurTrack) normalized.blurTrack = blurTrack
      else delete normalized.blurTrack
      return normalized
    }
    if (region.blurData !== undefined || region.blurTrack !== undefined) {
      const { blurData: _dropped, blurTrack: _droppedTrack, ...rest } = region
      return rest
    }
    return region
  })
}

/** Mosaic cell size in pixels of the target surface (`scaleFactor` = output px per preview px). */
export function getNormalizedMosaicBlockSize(
  blurData: BlurData | null | undefined,
  scaleFactor = 1,
): number {
  const base = normalizeBlurBlockSize(blurData?.blockSize)
  return Math.max(1, Math.round(base * Math.max(scaleFactor, 0.01)))
}

const WHITE_SHADE_BASE_ALPHA = 0.06
const BLACK_SHADE_BASE_ALPHA = 0.72
const MAX_SHADE_ALPHA = 0.95

/**
 * The tint composited over the mosaic. `intensity` scales the alpha linearly
 * around the default (12 keeps the base alphas), clamped so black never fully
 * hides the mosaic.
 */
export function getBlurShade(blurData: BlurData | null | undefined): {
  r: number
  g: number
  b: number
  a: number
} {
  const color = normalizeBlurColor(blurData?.color)
  const intensity = normalizeBlurIntensity(blurData?.intensity)
  const base = color === 'black' ? BLACK_SHADE_BASE_ALPHA : WHITE_SHADE_BASE_ALPHA
  const a = clamp((base * intensity) / DEFAULT_BLUR_INTENSITY, 0, MAX_SHADE_ALPHA)
  const channel = color === 'black' ? 0 : 255
  return { r: channel, g: channel, b: channel, a }
}

/** CSS colour of the shade (used by the settings panel swatches). */
export function getBlurOverlayColor(blurData: BlurData | null | undefined): string {
  const { r, g, b, a } = getBlurShade(blurData)
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
}

/** True when the pixel centre (x + 0.5, y + 0.5) lies inside the ellipse inscribed in width x height. */
export function isInsideOval(x: number, y: number, width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false
  const rx = width / 2
  const ry = height / 2
  const dx = (x + 0.5 - rx) / rx
  const dy = (y + 0.5 - ry) / ry
  return dx * dx + dy * dy <= 1
}

/** Averages every `blockSize` x `blockSize` cell in place (partial cells at the edges are averaged over their own pixels). */
export function applyMosaicToImageData<T extends ImageDataLike>(
  imageData: T,
  blockSize: number,
): T {
  const { width, height, data } = imageData
  const cell = Math.max(1, Math.floor(blockSize))
  if (width <= 0 || height <= 0 || cell <= 1) return imageData

  for (let blockY = 0; blockY < height; blockY += cell) {
    const blockHeight = Math.min(cell, height - blockY)
    for (let blockX = 0; blockX < width; blockX += cell) {
      const blockWidth = Math.min(cell, width - blockX)
      const pixelCount = blockWidth * blockHeight
      if (pixelCount <= 0) continue

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let y = blockY; y < blockY + blockHeight; y++) {
        let offset = (y * width + blockX) * 4
        for (let x = 0; x < blockWidth; x++) {
          r += data[offset]
          g += data[offset + 1]
          b += data[offset + 2]
          a += data[offset + 3]
          offset += 4
        }
      }

      const avgR = Math.round(r / pixelCount)
      const avgG = Math.round(g / pixelCount)
      const avgB = Math.round(b / pixelCount)
      const avgA = Math.round(a / pixelCount)
      for (let y = blockY; y < blockY + blockHeight; y++) {
        let offset = (y * width + blockX) * 4
        for (let x = 0; x < blockWidth; x++) {
          data[offset] = avgR
          data[offset + 1] = avgG
          data[offset + 2] = avgB
          data[offset + 3] = avgA
          offset += 4
        }
      }
    }
  }

  return imageData
}

/**
 * Renders a blur region onto the pixels it covers, in place:
 * 1. mosaic with `blockSizePx` cells aligned to the region's top-left,
 * 2. shade tint composited over the mosaic,
 * 3. for `oval`, pixels outside the inscribed ellipse are restored to the
 *    source so the caller can write the buffer back without a clip path.
 *
 * `opacity` (default 1) blends the result back over the untouched pixels
 * (`out = orig*(1-a) + mosaic*a`), which is how a tracked region fades out
 * when its content goes off screen. At 1 the blend is skipped entirely, so
 * every existing caller and the preview/export parity are byte-identical.
 *
 * Both the preview overlay and the exporter call this on a copy of the frame
 * region, so the result is identical up to the source frame's resolution.
 */
export function renderMosaicRegion<T extends ImageDataLike>(
  imageData: T,
  blurData: BlurData | null | undefined,
  blockSizePx: number,
  opacity = 1,
): T {
  const { width, height, data } = imageData
  if (width <= 0 || height <= 0) return imageData

  const alpha = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
  if (alpha <= 0) return imageData

  const shape = normalizeBlurShape(blurData?.shape)
  const original = shape === 'oval' || alpha < 1 ? new Uint8ClampedArray(data) : null

  applyMosaicToImageData(imageData, blockSizePx)

  const shade = getBlurShade(blurData)
  const keep = 1 - shade.a
  const shadeR = shade.r * shade.a
  const shadeG = shade.g * shade.a
  const shadeB = shade.b * shade.a

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      if (original && shape === 'oval' && !isInsideOval(x, y, width, height)) {
        data[offset] = original[offset]
        data[offset + 1] = original[offset + 1]
        data[offset + 2] = original[offset + 2]
        data[offset + 3] = original[offset + 3]
        continue
      }
      const r = data[offset] * keep + shadeR
      const g = data[offset + 1] * keep + shadeG
      const b = data[offset + 2] * keep + shadeB
      // Alpha: the shade is drawn over whatever is there, so coverage only grows.
      const a = data[offset + 3] + (255 - data[offset + 3]) * shade.a
      if (original && alpha < 1) {
        const inverse = 1 - alpha
        data[offset] = Math.round(original[offset] * inverse + r * alpha)
        data[offset + 1] = Math.round(original[offset + 1] * inverse + g * alpha)
        data[offset + 2] = Math.round(original[offset + 2] * inverse + b * alpha)
        data[offset + 3] = Math.round(original[offset + 3] * inverse + a * alpha)
        continue
      }
      data[offset] = Math.round(r)
      data[offset + 1] = Math.round(g)
      data[offset + 2] = Math.round(b)
      data[offset + 3] = Math.round(a)
    }
  }

  return imageData
}
