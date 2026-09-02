import { describe, expect, it } from 'vitest'
import {
  type AnnotationRegion,
  DEFAULT_BLUR_DATA,
  DEFAULT_BLUR_BLOCK_SIZE,
  DEFAULT_BLUR_INTENSITY,
  MAX_BLUR_BLOCK_SIZE,
  MAX_BLUR_INTENSITY,
  MIN_BLUR_BLOCK_SIZE,
  MIN_BLUR_INTENSITY,
  createBlurAnnotationRegion,
  createTextAnnotationRegion,
} from '@/components/video-editor/types'
import {
  applyMosaicToImageData,
  getBlurOverlayColor,
  getBlurShade,
  getNormalizedMosaicBlockSize,
  type ImageDataLike,
  isInsideOval,
  normalizeAnnotationBlurData,
  normalizeBlurColor,
  normalizeBlurData,
  normalizeBlurShape,
  normalizeBlurType,
  renderMosaicRegion,
} from './blurEffects'

function createTestImage(width: number, height: number): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      data[offset] = x * 20 + y
      data[offset + 1] = y * 20 + x
      data[offset + 2] = (x + y) * 10
      data[offset + 3] = 255
    }
  }
  return { data, width, height }
}

function pixel(image: ImageDataLike, x: number, y: number): number[] {
  const offset = (y * image.width + x) * 4
  return Array.from(image.data.slice(offset, offset + 4))
}

function uniqueColours(image: ImageDataLike): number {
  const seen = new Set<string>()
  for (let i = 0; i < image.data.length; i += 4) {
    seen.add(Array.from(image.data.slice(i, i + 4)).join(','))
  }
  return seen.size
}

describe('applyMosaicToImageData', () => {
  it('collapses each block to the average of its pixels', () => {
    const image = createTestImage(4, 4)
    const expectedRed = Math.round(
      (pixel(image, 0, 0)[0] +
        pixel(image, 1, 0)[0] +
        pixel(image, 0, 1)[0] +
        pixel(image, 1, 1)[0]) /
        4,
    )

    applyMosaicToImageData(image, 2)

    expect(pixel(image, 0, 0)).toEqual(pixel(image, 1, 1))
    expect(pixel(image, 0, 0)[0]).toBe(expectedRed)
    // The neighbouring block is a different colour.
    expect(pixel(image, 2, 0)).not.toEqual(pixel(image, 0, 0))
  })

  it('reduces an 8x8 image with 4px blocks to exactly four colours', () => {
    const image = createTestImage(8, 8)
    const before = uniqueColours(image)
    applyMosaicToImageData(image, 4)
    expect(uniqueColours(image)).toBe(4)
    expect(uniqueColours(image)).toBeLessThan(before)
  })

  it('averages partial edge blocks over their own pixels only', () => {
    const image = createTestImage(5, 3)
    applyMosaicToImageData(image, 4)
    // Right column (x = 4) is a 1x3 block: the average of its own three pixels.
    const expected = Math.round(
      (pixel(createTestImage(5, 3), 4, 0)[0] +
        pixel(createTestImage(5, 3), 4, 1)[0] +
        pixel(createTestImage(5, 3), 4, 2)[0]) /
        3,
    )
    expect(pixel(image, 4, 0)[0]).toBe(expected)
    expect(pixel(image, 4, 2)[0]).toBe(expected)
  })

  it('is a no-op for block size 1 or an empty image', () => {
    const image = createTestImage(3, 3)
    const original = new Uint8ClampedArray(image.data)
    applyMosaicToImageData(image, 1)
    expect(Array.from(image.data)).toEqual(Array.from(original))
    expect(() =>
      applyMosaicToImageData({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, 4),
    ).not.toThrow()
  })
})

describe('renderMosaicRegion', () => {
  it('tints the mosaic with the shade colour', () => {
    const image = createTestImage(4, 4)
    renderMosaicRegion(image, { ...DEFAULT_BLUR_DATA, color: 'black' }, 4)
    const averaged = applyMosaicToImageData(createTestImage(4, 4), 4)
    const { a } = getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'black' })
    const expectedRed = Math.round(pixel(averaged, 0, 0)[0] * (1 - a))
    expect(pixel(image, 0, 0)[0]).toBe(expectedRed)
    expect(pixel(image, 3, 3)[3]).toBe(255)
  })

  it('keeps the original pixels outside the ellipse for oval regions', () => {
    const image = createTestImage(12, 8)
    const original = createTestImage(12, 8)
    renderMosaicRegion(image, { ...DEFAULT_BLUR_DATA, shape: 'oval', color: 'black' }, 4)

    expect(isInsideOval(0, 0, 12, 8)).toBe(false)
    expect(isInsideOval(6, 4, 12, 8)).toBe(true)
    expect(pixel(image, 0, 0)).toEqual(pixel(original, 0, 0))
    expect(pixel(image, 11, 7)).toEqual(pixel(original, 11, 7))
    expect(pixel(image, 6, 4)).not.toEqual(pixel(original, 6, 4))
  })

  it('grows alpha towards opaque where the frame was transparent', () => {
    const image: ImageDataLike = { data: new Uint8ClampedArray(4 * 4), width: 2, height: 2 }
    renderMosaicRegion(image, { ...DEFAULT_BLUR_DATA, color: 'white' }, 2)
    const { a } = getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'white' })
    expect(pixel(image, 0, 0)[3]).toBe(Math.round(255 * a))
  })
})

describe('shade helpers', () => {
  it('scales the shade alpha with intensity and clamps it', () => {
    const base = getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'black' }).a
    expect(base).toBeCloseTo(0.72)
    expect(getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'black', intensity: 6 }).a).toBeCloseTo(0.36)
    expect(getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'black', intensity: 40 }).a).toBe(0.95)
    expect(getBlurShade({ ...DEFAULT_BLUR_DATA, color: 'white' }).a).toBeCloseTo(0.06)
    expect(getBlurOverlayColor({ ...DEFAULT_BLUR_DATA, color: 'black' })).toBe(
      'rgba(0, 0, 0, 0.720)',
    )
    expect(getBlurOverlayColor(undefined)).toBe('rgba(255, 255, 255, 0.060)')
  })

  it('scales the block size with the output scale factor', () => {
    expect(getNormalizedMosaicBlockSize(DEFAULT_BLUR_DATA)).toBe(DEFAULT_BLUR_BLOCK_SIZE)
    expect(getNormalizedMosaicBlockSize({ ...DEFAULT_BLUR_DATA, blockSize: 10 }, 2)).toBe(20)
    expect(getNormalizedMosaicBlockSize({ ...DEFAULT_BLUR_DATA, blockSize: 10 }, 0.05)).toBe(1)
    expect(getNormalizedMosaicBlockSize(undefined, 1)).toBe(DEFAULT_BLUR_BLOCK_SIZE)
  })
})

describe('normalisers', () => {
  it('forces the mosaic type and validates shape and colour', () => {
    expect(normalizeBlurType('blur')).toBe('mosaic')
    expect(normalizeBlurType(undefined)).toBe('mosaic')
    expect(normalizeBlurShape('oval')).toBe('oval')
    expect(normalizeBlurShape('freehand')).toBe('rectangle')
    expect(normalizeBlurColor('black')).toBe('black')
    expect(normalizeBlurColor('red')).toBe('white')
  })

  it('clamps intensity and block size and fills defaults', () => {
    expect(normalizeBlurData(undefined)).toEqual(DEFAULT_BLUR_DATA)
    expect(normalizeBlurData({ intensity: 999, blockSize: -3 })).toMatchObject({
      intensity: MAX_BLUR_INTENSITY,
      blockSize: MIN_BLUR_BLOCK_SIZE,
    })
    expect(normalizeBlurData({ intensity: 'x', blockSize: Number.NaN })).toMatchObject({
      intensity: DEFAULT_BLUR_INTENSITY,
      blockSize: DEFAULT_BLUR_BLOCK_SIZE,
    })
    expect(normalizeBlurData({ intensity: 0, blockSize: 1000 })).toMatchObject({
      intensity: MIN_BLUR_INTENSITY,
      blockSize: MAX_BLUR_BLOCK_SIZE,
    })
  })

  it('normalises a restored annotation list without touching non-blur regions', () => {
    const text = createTextAnnotationRegion({
      id: 'annotation-1',
      startMs: 0,
      endMs: 1000,
      zIndex: 1,
    })
    const blur = createBlurAnnotationRegion({ id: 'blur-1', startMs: 0, endMs: 1000, zIndex: 2 })
    const legacyBlur = {
      ...blur,
      id: 'blur-2',
      blurData: { type: 'blur', shape: 'freehand', intensity: 80 },
    }
    const strayText = { ...text, id: 'annotation-2', blurData: DEFAULT_BLUR_DATA }
    const missing = { ...blur, id: 'blur-3', blurData: undefined }

    const result = normalizeAnnotationBlurData([
      text,
      blur,
      legacyBlur as unknown as AnnotationRegion,
      strayText,
      missing,
    ])

    expect(result[0]).toBe(text)
    expect(result[1].blurData).toEqual(DEFAULT_BLUR_DATA)
    expect(result[2].blurData).toEqual({
      ...DEFAULT_BLUR_DATA,
      intensity: MAX_BLUR_INTENSITY,
    })
    expect(result[3]).not.toHaveProperty('blurData')
    expect(result[3].type).toBe('text')
    expect(result[4].blurData).toEqual(DEFAULT_BLUR_DATA)
  })
})
