import { BLUR_TRACKER_TUNING, type GrayImage, rgbaToGray, type TrackerFrame } from './trackerCore'

/**
 * Decoded pixels to the two gray images the tracker reads: a whole-frame
 * thumbnail and an on-demand crop.
 *
 * Both are `drawImage` calls with a source rectangle, so the crop and the
 * downscale happen in one GPU-backed step and only two small `getImageData`
 * reads per frame reach the CPU. The canvases are reused across frames: at ten
 * samples a second for minutes on end, allocating a pair of canvases per frame
 * is the kind of garbage that shows up as a stutter.
 */

/** Anything `drawImage` accepts that also knows its own pixel size. */
export type TrackerImage = VideoFrame | ImageBitmap | HTMLVideoElement | OffscreenCanvas

export function imageWidth(image: TrackerImage): number {
  const source = image as Partial<Record<'displayWidth' | 'videoWidth' | 'width', number>>
  return source.displayWidth ?? source.videoWidth ?? source.width ?? 0
}

export function imageHeight(image: TrackerImage): number {
  const source = image as Partial<Record<'displayHeight' | 'videoHeight' | 'height', number>>
  return source.displayHeight ?? source.videoHeight ?? source.height ?? 0
}

interface Surface {
  canvas: OffscreenCanvas
  context: OffscreenCanvasRenderingContext2D
}

function createSurface(width: number, height: number): Surface {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
  // `willReadFrequently` matters here: every draw is followed by a
  // `getImageData`, which on a GPU-backed canvas means a readback stall.
  const context = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
  if (!context) throw new Error('OffscreenCanvas 2D context is not available')
  return { canvas, context }
}

/**
 * The scratch canvases one tracking run reuses. One instance per run; not safe
 * to share between two runs on different threads.
 */
export class TrackerCanvasScratch {
  private coarse: Surface | null = null
  private fine: Surface | null = null

  private surfaceFor(kind: 'coarse' | 'fine', width: number, height: number): Surface {
    const current = kind === 'coarse' ? this.coarse : this.fine
    if (current && current.canvas.width === width && current.canvas.height === height)
      return current
    const surface = createSurface(width, height)
    if (kind === 'coarse') this.coarse = surface
    else this.fine = surface
    return surface
  }

  /** Draws `image` scaled into a canvas of `width x height` and reads it back as gray. */
  draw(
    kind: 'coarse' | 'fine',
    image: TrackerImage,
    source: { x: number; y: number; w: number; h: number },
    width: number,
    height: number,
  ): GrayImage {
    const surface = this.surfaceFor(kind, width, height)
    surface.context.drawImage(
      image as CanvasImageSource,
      source.x,
      source.y,
      source.w,
      source.h,
      0,
      0,
      width,
      height,
    )
    const { data } = surface.context.getImageData(0, 0, width, height)
    return rgbaToGray(data, width, height)
  }
}

/**
 * A {@link TrackerFrame} over one decoded image. The coarse thumbnail is drawn
 * eagerly (every frame needs it); crops are drawn on demand.
 *
 * The caller keeps ownership of `image` and must close it after the frame has
 * been analysed. Nothing here retains it beyond the call.
 */
export function createCanvasTrackerFrame(
  image: TrackerImage,
  scratch: TrackerCanvasScratch,
): TrackerFrame {
  const sourceWidth = imageWidth(image)
  const sourceHeight = imageHeight(image)
  const coarseWidth = Math.min(sourceWidth, BLUR_TRACKER_TUNING.coarseWidth)
  const coarseHeight = Math.max(1, Math.round((sourceHeight * coarseWidth) / sourceWidth))

  const coarse = scratch.draw(
    'coarse',
    image,
    { x: 0, y: 0, w: sourceWidth, h: sourceHeight },
    coarseWidth,
    coarseHeight,
  )

  return {
    sourceWidth,
    sourceHeight,
    coarse,
    sample: (rect, outWidth, outHeight) => scratch.draw('fine', image, rect, outWidth, outHeight),
  }
}
