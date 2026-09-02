import { describe, expect, it } from 'vitest'
import {
  type AnnotationRegion,
  createBlurAnnotationRegion,
  DEFAULT_BLUR_DATA,
} from '@/components/video-editor/types'
import {
  getNormalizedMosaicBlockSize,
  type ImageDataLike,
  renderMosaicRegion,
} from '@/lib/blurEffects'
import { renderAnnotations, renderBlurRegion } from './annotationRenderer'

/**
 * A minimal 2D-context stand-in backed by an RGBA buffer: enough for the blur
 * pass (getImageData / putImageData) to run under node without a canvas.
 */
class FakeCanvasContext {
  readonly canvas: { width: number; height: number }
  readonly buffer: Uint8ClampedArray

  constructor(width: number, height: number, fill: (x: number, y: number) => number[]) {
    this.canvas = { width, height }
    this.buffer = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b, a] = fill(x, y)
        const offset = (y * width + x) * 4
        this.buffer[offset] = r
        this.buffer[offset + 1] = g
        this.buffer[offset + 2] = b
        this.buffer[offset + 3] = a
      }
    }
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike {
    const data = new Uint8ClampedArray(sw * sh * 4)
    for (let y = 0; y < sh; y++) {
      const from = ((sy + y) * this.canvas.width + sx) * 4
      data.set(this.buffer.subarray(from, from + sw * 4), y * sw * 4)
    }
    return { data, width: sw, height: sh }
  }

  putImageData(imageData: ImageDataLike, dx: number, dy: number): void {
    for (let y = 0; y < imageData.height; y++) {
      const to = ((dy + y) * this.canvas.width + dx) * 4
      this.buffer.set(
        imageData.data.subarray(y * imageData.width * 4, (y + 1) * imageData.width * 4),
        to,
      )
    }
  }

  pixel(x: number, y: number): number[] {
    const offset = (y * this.canvas.width + x) * 4
    return Array.from(this.buffer.slice(offset, offset + 4))
  }
}

/** Synthetic frame: a diagonal colour ramp, so every block averages to a distinct value. */
function syntheticFrame(width: number, height: number): FakeCanvasContext {
  return new FakeCanvasContext(width, height, (x, y) => [
    (x * 7) % 256,
    (y * 11) % 256,
    ((x + y) * 3) % 256,
    255,
  ])
}

function asContext(fake: FakeCanvasContext): CanvasRenderingContext2D {
  return fake as unknown as CanvasRenderingContext2D
}

const PREVIEW = { width: 400, height: 300 }

function blurRegion(overrides: Partial<AnnotationRegion> = {}): AnnotationRegion {
  return {
    ...createBlurAnnotationRegion({ id: 'blur-1', startMs: 0, endMs: 1000, zIndex: 1 }),
    position: { x: 10, y: 20 },
    size: { width: 25, height: 30 },
    ...overrides,
  }
}

describe('blur export parity with the preview routine', () => {
  it('produces the same pixels as renderMosaicRegion applied to the preview-sized region', () => {
    const region = blurRegion()
    const exported = syntheticFrame(PREVIEW.width, PREVIEW.height)
    // The preview samples the same box from the same frame and runs the shared routine.
    const preview = syntheticFrame(PREVIEW.width, PREVIEW.height)
    const x = Math.round((region.position.x / 100) * PREVIEW.width)
    const y = Math.round((region.position.y / 100) * PREVIEW.height)
    const w = Math.round((region.size.width / 100) * PREVIEW.width)
    const h = Math.round((region.size.height / 100) * PREVIEW.height)
    const previewPixels = preview.getImageData(x, y, w, h)
    renderMosaicRegion(
      previewPixels,
      region.blurData,
      getNormalizedMosaicBlockSize(region.blurData),
    )
    preview.putImageData(previewPixels, x, y)

    renderBlurRegion(
      asContext(exported),
      region,
      (region.position.x / 100) * PREVIEW.width,
      (region.position.y / 100) * PREVIEW.height,
      (region.size.width / 100) * PREVIEW.width,
      (region.size.height / 100) * PREVIEW.height,
      1,
    )

    expect(Array.from(exported.buffer)).toEqual(Array.from(preview.buffer))
    // And it actually changed something inside the box, nothing outside it.
    const untouched = syntheticFrame(PREVIEW.width, PREVIEW.height)
    expect(exported.pixel(x + 3, y + 3)).not.toEqual(untouched.pixel(x + 3, y + 3))
    expect(exported.pixel(x - 1, y - 1)).toEqual(untouched.pixel(x - 1, y - 1))
    expect(exported.pixel(x + w, y + h)).toEqual(untouched.pixel(x + w, y + h))
  })

  it('scales the block grid with the output so a 2x export has 2x blocks of the same layout', () => {
    const region = blurRegion({ blurData: { ...DEFAULT_BLUR_DATA, blockSize: 8 } })
    const scale = 2
    const output = { width: PREVIEW.width * scale, height: PREVIEW.height * scale }
    // Frame content is a 2x nearest-neighbour upscale of the preview frame.
    const previewFrame = syntheticFrame(PREVIEW.width, PREVIEW.height)
    const outputFrame = new FakeCanvasContext(output.width, output.height, (x, y) =>
      previewFrame.pixel(Math.floor(x / scale), Math.floor(y / scale)),
    )

    renderBlurRegion(
      asContext(previewFrame),
      region,
      (region.position.x / 100) * PREVIEW.width,
      (region.position.y / 100) * PREVIEW.height,
      (region.size.width / 100) * PREVIEW.width,
      (region.size.height / 100) * PREVIEW.height,
      1,
    )
    renderBlurRegion(
      asContext(outputFrame),
      region,
      (region.position.x / 100) * output.width,
      (region.position.y / 100) * output.height,
      (region.size.width / 100) * output.width,
      (region.size.height / 100) * output.height,
      scale,
    )

    // Each output block is the 2x2 upscale of a preview block: sample block centres.
    const x = Math.round((region.position.x / 100) * PREVIEW.width)
    const y = Math.round((region.position.y / 100) * PREVIEW.height)
    for (const [bx, by] of [
      [0, 0],
      [1, 0],
      [2, 3],
      [5, 6],
    ]) {
      const px = x + bx * 8 + 4
      const py = y + by * 8 + 4
      expect(outputFrame.pixel(px * scale, py * scale)).toEqual(previewFrame.pixel(px, py))
    }
  })

  it('keeps the frame outside the ellipse for oval regions at output resolution', () => {
    const region = blurRegion({ blurData: { ...DEFAULT_BLUR_DATA, shape: 'oval', color: 'black' } })
    const frame = syntheticFrame(PREVIEW.width, PREVIEW.height)
    const untouched = syntheticFrame(PREVIEW.width, PREVIEW.height)
    const x = Math.round((region.position.x / 100) * PREVIEW.width)
    const y = Math.round((region.position.y / 100) * PREVIEW.height)
    const w = Math.round((region.size.width / 100) * PREVIEW.width)
    const h = Math.round((region.size.height / 100) * PREVIEW.height)

    renderBlurRegion(asContext(frame), region, x, y, w, h, 1)

    expect(frame.pixel(x, y)).toEqual(untouched.pixel(x, y))
    expect(frame.pixel(x + w - 1, y + h - 1)).toEqual(untouched.pixel(x + w - 1, y + h - 1))
    const cx = x + Math.floor(w / 2)
    const cy = y + Math.floor(h / 2)
    expect(frame.pixel(cx, cy)).not.toEqual(untouched.pixel(cx, cy))
    // Black shade darkens the centre.
    expect(frame.pixel(cx, cy)[0]).toBeLessThan(untouched.pixel(cx, cy)[0] + 1)
  })

  it('clips regions that hang off the frame edge instead of throwing', () => {
    const region = blurRegion({ position: { x: 90, y: 90 }, size: { width: 30, height: 30 } })
    const frame = syntheticFrame(PREVIEW.width, PREVIEW.height)
    expect(() =>
      renderBlurRegion(
        asContext(frame),
        region,
        (region.position.x / 100) * PREVIEW.width,
        (region.position.y / 100) * PREVIEW.height,
        (region.size.width / 100) * PREVIEW.width,
        (region.size.height / 100) * PREVIEW.height,
        1,
      ),
    ).not.toThrow()
    const untouched = syntheticFrame(PREVIEW.width, PREVIEW.height)
    expect(frame.pixel(PREVIEW.width - 1, PREVIEW.height - 1)).not.toEqual(
      untouched.pixel(PREVIEW.width - 1, PREVIEW.height - 1),
    )
  })

  it('is invoked through renderAnnotations for active blur regions only', async () => {
    const active = blurRegion()
    const inactive = blurRegion({ id: 'blur-2', startMs: 5000, endMs: 6000 })
    const frame = syntheticFrame(PREVIEW.width, PREVIEW.height)
    const untouched = syntheticFrame(PREVIEW.width, PREVIEW.height)

    await renderAnnotations(
      asContext(frame),
      [inactive, active],
      PREVIEW.width,
      PREVIEW.height,
      500,
      1,
    )

    const x = Math.round((active.position.x / 100) * PREVIEW.width) + 2
    const y = Math.round((active.position.y / 100) * PREVIEW.height) + 2
    expect(frame.pixel(x, y)).not.toEqual(untouched.pixel(x, y))
  })
})
