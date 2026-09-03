import GIF from 'gif.js'
import type {
  ExportDecodePath,
  ExportProgress,
  ExportResult,
  GifFrameRate,
  GifSizePreset,
  GIF_SIZE_PRESETS,
} from './types'
import { VideoFileDecoder } from './videoDecoder'
import { StreamingVideoDecoder } from './streamingDecoder'
import { isBackgroundLoadError } from './backgroundErrors'
import { FrameRenderer } from './frameRenderer'
import type {
  ZoomRegion,
  CropRegion,
  TrimRegion,
  AnnotationRegion,
  VideoSegment,
} from '@/components/video-editor/types'
import type { SubtitleCue } from '@/lib/analysis/types'
import type { CursorStyleConfig, CursorTrack } from '@/lib/cursor'
import { getPlatform } from '@/utils/platformUtils'
import { resolveSourceDurationMs } from './sourceDuration'
import {
  DecoderFallbackError,
  EXPORT_WARNING_DECODE_ENDED_EARLY,
  EXPORT_WARNING_DECODER_FALLBACK,
  resolveExportDecodePath,
} from './decoderFallback'
import { buildGifFramePlan, type GifFramePlan } from './gifExportPlan'
import { readExportDecodePathOverride } from './videoExporter'

const GIF_WORKER_URL = new URL('gif.js/dist/gif.worker.js', import.meta.url).toString()

interface GifExporterConfig {
  videoUrl: string
  width: number
  height: number
  frameRate: GifFrameRate
  loop: boolean
  sizePreset: GifSizePreset
  wallpaper: string
  zoomRegions: ZoomRegion[]
  trimRegions?: TrimRegion[]
  showShadow: boolean
  shadowIntensity: number
  showBlur: boolean
  /** Zoom motion blur amount 0..1 (0 = off). */
  motionBlurAmount?: number
  borderRadius?: number
  padding?: number
  videoPadding?: number
  cropRegion: CropRegion
  annotationRegions?: AnnotationRegion[]
  subtitleCues?: SubtitleCue[]
  previewWidth?: number
  previewHeight?: number
  cursorTrack?: CursorTrack | null
  cursorStyle?: Partial<CursorStyleConfig>
  onProgress?: (progress: ExportProgress) => void
  playbackSpeed?: number
  segments?: VideoSegment[]
  /** Probed real duration of the source (ms); preferred over `video.duration`. */
  sourceDurationMs?: number
  /**
   * Frame source, same switch as the MP4 exporter: `'webcodecs'`
   * (`StreamingVideoDecoder`, single decode pass) or `'seek'`
   * (`HTMLVideoElement` seek per frame). When omitted the localStorage
   * override (`readExportDecodePathOverride`) applies, then the exporter
   * default (`DEFAULT_EXPORT_DECODE_PATH`, currently `'seek'`).
   */
  decodePath?: ExportDecodePath
}

/**
 * Calculate output dimensions based on size preset and source dimensions while preserving aspect ratio.
 * @param sourceWidth - Original video width
 * @param sourceHeight - Original video height
 * @param sizePreset - The size preset to use
 * @param sizePresets - The size presets configuration
 * @returns The calculated output dimensions
 */
/**
 * GIF output size for a size preset. Without `targetAspectRatio` the source
 * ratio is kept (legacy behaviour, exact source dimensions when not scaled).
 * With it (the editor's selected aspect, incl. 'native' = cropped source ratio)
 * the output is fitted to that ratio: within the source bounds for 'original'
 * or when the source is already no taller than the preset, else at the
 * preset height. Never upscales the source.
 */
export function calculateOutputDimensions(
  sourceWidth: number,
  sourceHeight: number,
  sizePreset: GifSizePreset,
  sizePresets: typeof GIF_SIZE_PRESETS,
  targetAspectRatio?: number,
): { width: number; height: number } {
  const preset = sizePresets[sizePreset]
  const maxHeight = preset.maxHeight
  const fitsWithoutScaling = sourceHeight <= maxHeight || sizePreset === 'original'

  if (targetAspectRatio === undefined) {
    if (fitsWithoutScaling) {
      return { width: sourceWidth, height: sourceHeight }
    }
    const aspectRatio = sourceWidth / sourceHeight
    const newHeight = maxHeight
    const newWidth = Math.round(newHeight * aspectRatio)
    // Ensure dimensions are even (required for some encoders)
    return {
      width: newWidth % 2 === 0 ? newWidth : newWidth + 1,
      height: newHeight % 2 === 0 ? newHeight : newHeight + 1,
    }
  }

  const sourceAspect = sourceWidth / sourceHeight
  const aspectRatio =
    Number.isFinite(targetAspectRatio) && targetAspectRatio > 0 ? targetAspectRatio : sourceAspect
  const toEven = (value: number) => Math.max(2, Math.floor(value / 2) * 2)

  if (fitsWithoutScaling) {
    if (aspectRatio >= sourceAspect) {
      const width = toEven(sourceWidth)
      return { width, height: toEven(width / aspectRatio) }
    }
    const height = toEven(sourceHeight)
    return { width: toEven(height * aspectRatio), height }
  }

  return {
    width: toEven(Math.round(maxHeight * aspectRatio)),
    height: toEven(maxHeight),
  }
}

/**
 * gif.js worker pool size: leave one core for the render loop, never fewer than
 * one worker and never more than eight (diminishing returns past that).
 */
export function resolveGifWorkerCount(hardwareConcurrency: number | undefined): number {
  const cores =
    Number.isFinite(hardwareConcurrency) && (hardwareConcurrency as number) > 0
      ? Math.floor(hardwareConcurrency as number)
      : 4
  return Math.max(1, Math.min(8, cores - 1))
}

type SourceVideoInfo = { width: number; height: number; duration: number }

/** How long the first-frame wait gives the compositor before it gives up. */
const PRESENTED_FRAME_TIMEOUT_MS = 80

/**
 * Wait for the video to present a decoded frame, but never longer than
 * `PRESENTED_FRAME_TIMEOUT_MS`.
 *
 * `requestVideoFrameCallback` only fires on a *new* presentation. When the
 * frame is already on screen by the time the seek resolves — which is what
 * happens under software rendering, and is a race everywhere else — the
 * callback never fires and an unbounded wait hangs the whole export. The
 * MP4 exporter bounds the same wait (`VideoExporter.waitForVideoFrame`);
 * this keeps the GIF path in line with it.
 */
async function waitForPresentedFrame(videoElement: HTMLVideoElement): Promise<void> {
  if (typeof videoElement.requestVideoFrameCallback !== 'function') return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, PRESENTED_FRAME_TIMEOUT_MS)
    videoElement.requestVideoFrameCallback(() => finish())
  })
}

export class GifExporter {
  private config: GifExporterConfig
  private decoder: VideoFileDecoder | null = null
  private streamingDecoder: StreamingVideoDecoder | null = null
  private renderer: FrameRenderer | null = null
  private gif: GIF | null = null
  private cancelled = false
  /** Set once the WebCodecs path failed before its first frame; forces the seek path. */
  private decoderFallbackActive = false
  private readonly warnings = new Set<string>()

  constructor(config: GifExporterConfig) {
    this.config = config
  }

  private resolveDecodePath(): ExportDecodePath {
    const requested = this.config.decodePath ?? readExportDecodePathOverride()
    const hasVideoDecoder = typeof VideoDecoder !== 'undefined'
    if (requested === 'webcodecs' && !hasVideoDecoder && !this.decoderFallbackActive) {
      console.warn('[GifExporter] VideoDecoder is unavailable; using the seek decode path')
    }
    return resolveExportDecodePath({
      requested,
      fallbackActive: this.decoderFallbackActive,
      hasVideoDecoder,
    })
  }

  private getWarnings(): string[] | undefined {
    const warnings = new Set(this.warnings)
    if (this.decoderFallbackActive) warnings.add(EXPORT_WARNING_DECODER_FALLBACK)
    return warnings.size > 0 ? Array.from(warnings) : undefined
  }

  /**
   * Runs the export; a WebCodecs decoder failure before the first rendered
   * frame restarts the whole attempt on the seek path (same rule as the MP4
   * exporter) and reports `editor.exportWarningDecoderFallback`.
   */
  async export(): Promise<ExportResult> {
    this.decoderFallbackActive = false
    try {
      try {
        return await this.runExportAttempt()
      } catch (error) {
        if (error instanceof DecoderFallbackError && !this.cancelled) {
          console.warn(
            '[GifExporter] WebCodecs decode path failed before the first frame; retrying on the seek path.',
            error.cause,
          )
          this.decoderFallbackActive = true
          return await this.runExportAttempt()
        }
        throw error
      }
    } catch (error) {
      return this.toFailureResult(error)
    } finally {
      this.cleanup()
    }
  }

  private toFailureResult(error: unknown): ExportResult {
    if (isBackgroundLoadError(error)) {
      // Not retryable: the background will not load on a second attempt either.
      console.error('GIF Export error: background failed to load:', error.displayUrl)
      return {
        success: false,
        error: error.message,
        errorKind: 'background-load',
        backgroundUrl: error.displayUrl,
      }
    }
    console.error('GIF Export error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  private reportPreparingProgress(copiedBytes: number, totalBytes: number): void {
    this.config.onProgress?.({
      currentFrame: 0,
      totalFrames: 0,
      percentage: totalBytes > 0 ? Math.min(100, (copiedBytes / totalBytes) * 100) : 0,
      estimatedTimeRemaining: 0,
      phase: 'preparing',
    })
  }

  /**
   * Opens the source with the WebCodecs streaming decoder (large local files
   * are copied into OPFS first, reported as `'preparing'`). Any failure here
   * becomes a `DecoderFallbackError` so `export()` restarts on the seek path.
   */
  private async loadStreamingDecoderMetadata(): Promise<SourceVideoInfo> {
    const streamingDecoder = new StreamingVideoDecoder()
    this.streamingDecoder = streamingDecoder
    try {
      return await streamingDecoder.loadMetadata(
        this.config.videoUrl,
        ({ copiedBytes, totalBytes }) => {
          this.reportPreparingProgress(copiedBytes, totalBytes)
        },
      )
    } catch (error) {
      if (this.cancelled) throw error
      throw new DecoderFallbackError(error)
    }
  }

  /** One full export pass. Throws on failure; returns a cancelled result when `cancel()` was called. */
  private async runExportAttempt(): Promise<ExportResult> {
    this.cleanup()
    this.cancelled = false
    this.warnings.clear()

    const platform = await getPlatform()
    const decodePath = this.resolveDecodePath()

    let videoInfo: SourceVideoInfo
    if (decodePath === 'webcodecs') {
      videoInfo = await this.loadStreamingDecoderMetadata()
    } else {
      this.decoder = new VideoFileDecoder()
      videoInfo = await this.decoder.loadVideo(this.config.videoUrl)
    }

    // Initialize frame renderer
    this.renderer = new FrameRenderer({
      width: this.config.width,
      height: this.config.height,
      wallpaper: this.config.wallpaper,
      zoomRegions: this.config.zoomRegions,
      showShadow: this.config.showShadow,
      shadowIntensity: this.config.shadowIntensity,
      showBlur: this.config.showBlur,
      motionBlurAmount: this.config.motionBlurAmount,
      borderRadius: this.config.borderRadius,
      padding: this.config.padding,
      cropRegion: this.config.cropRegion,
      videoWidth: videoInfo.width,
      videoHeight: videoInfo.height,
      annotationRegions: this.config.annotationRegions,
      subtitleCues: this.config.subtitleCues,
      previewWidth: this.config.previewWidth,
      previewHeight: this.config.previewHeight,
      cursorTrack: this.config.cursorTrack,
      cursorStyle: this.config.cursorStyle,
      platform,
    })
    await this.renderer.initialize()

    // Initialize GIF encoder
    // Loop: 0 = infinite loop, 1 = play once (no loop)
    const repeat = this.config.loop ? 0 : 1

    this.gif = new GIF({
      workers: resolveGifWorkerCount(navigator.hardwareConcurrency),
      quality: 10,
      width: this.config.width,
      height: this.config.height,
      workerScript: GIF_WORKER_URL,
      repeat,
      background: '#000000',
      transparent: null,
      dither: 'FloydSteinberg',
    })

    // Frame plan (excluding trim regions, applying speed) for the chosen path.
    const sourceDurationMs = resolveSourceDurationMs(
      videoInfo.duration,
      this.config.sourceDurationMs,
    )
    const plan = buildGifFramePlan({
      decodePath,
      frameRate: this.config.frameRate,
      sourceDurationMs,
      decoderDurationSec: videoInfo.duration,
      segments: this.config.segments,
      trimRegions: this.config.trimRegions,
      playbackSpeed: this.config.playbackSpeed,
    })
    const { totalFrames } = plan

    console.log('[GifExporter] Decode path:', decodePath)
    console.log('[GifExporter] Original duration:', videoInfo.duration, 's')
    console.log('[GifExporter] Effective duration:', plan.effectiveDurationSec, 's')
    console.log('[GifExporter] Total frames to export:', totalFrames)
    console.log('[GifExporter] Frame rate:', this.config.frameRate, 'FPS')
    console.log('[GifExporter] Frame delay:', plan.frameDelayMs, 'ms')
    console.log('[GifExporter] Loop:', this.config.loop ? 'infinite' : 'once')

    if (this.streamingDecoder && plan.decodePlan) {
      await this.exportFramesByDecoding(this.streamingDecoder, plan)
    } else {
      const videoElement = this.decoder?.getVideoElement()
      if (!videoElement) {
        throw new Error('Video element not available')
      }
      await this.exportFramesBySeeking(videoElement, plan)
    }

    if (this.cancelled) {
      return { success: false, error: 'Export cancelled' }
    }

    // Update progress to show we're now in the finalizing phase
    this.config.onProgress?.({
      currentFrame: totalFrames,
      totalFrames,
      percentage: 100,
      estimatedTimeRemaining: 0,
      phase: 'finalizing',
    })

    // Render the GIF
    const gif = this.gif
    const blob = await new Promise<Blob>((resolve) => {
      gif.on('finished', (blob: Blob) => {
        resolve(blob)
      })

      // Track rendering progress
      gif.on('progress', (progress: number) => {
        this.config.onProgress?.({
          currentFrame: totalFrames,
          totalFrames,
          percentage: 100,
          estimatedTimeRemaining: 0,
          phase: 'finalizing',
          renderProgress: Math.round(progress * 100),
        })
      })

      // gif.js doesn't have a typed 'error' event, but we can catch errors in the try/catch
      gif.render()
    })

    return { success: true, blob, warnings: this.getWarnings() }
  }

  /** Renders one source frame with all effects and appends the canvas to the GIF. */
  private async renderAndAddFrame(
    source: HTMLVideoElement | VideoFrame,
    sourceTimestampUs: number,
    frameDelayMs: number,
  ): Promise<void> {
    if (!this.renderer || !this.gif) throw new Error('GIF exporter is not initialized')
    await this.renderer.renderFrame(source, sourceTimestampUs)
    this.gif.addFrame(this.renderer.getCanvas(), { delay: frameDelayMs, copy: true })
  }

  private reportFrameProgress(frameIndex: number, totalFrames: number): void {
    this.config.onProgress?.({
      currentFrame: frameIndex,
      totalFrames,
      percentage: totalFrames > 0 ? (frameIndex / totalFrames) * 100 : 100,
      estimatedTimeRemaining: 0,
    })
  }

  /**
   * WebCodecs frame export: `decodeAll` walks the source once and hands over
   * one `VideoFrame` per output frame (already resampled to the GIF frame rate
   * and routed through the trim/speed plan). A decoder failure before the
   * first rendered frame requests the seek fallback; render failures never do.
   */
  private async exportFramesByDecoding(
    streamingDecoder: StreamingVideoDecoder,
    plan: GifFramePlan,
  ): Promise<number> {
    const { totalFrames } = plan
    let frameIndex = 0
    let callbackError: unknown = null

    try {
      await streamingDecoder.decodeAll(
        this.config.frameRate,
        plan.decodePlan?.trimRegions,
        plan.decodePlan?.speedRegions,
        async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
          try {
            if (this.cancelled || frameIndex >= totalFrames) {
              return
            }
            await this.renderAndAddFrame(videoFrame, sourceTimestampMs * 1000, plan.frameDelayMs)
            frameIndex++
            this.reportFrameProgress(frameIndex, totalFrames)
          } catch (error) {
            callbackError = callbackError ?? error
            streamingDecoder.cancel()
            throw error
          } finally {
            videoFrame.close()
          }
        },
        (message) => {
          console.warn('[GifExporter] Streaming decoder warning:', message)
          this.warnings.add(EXPORT_WARNING_DECODE_ENDED_EARLY)
        },
      )
    } catch (error) {
      if (callbackError) {
        // Render failure, not a decoder failure: never fall back.
        throw callbackError
      }
      if (frameIndex === 0 && !this.cancelled) {
        throw new DecoderFallbackError(error)
      }
      throw error
    }

    // A decoder that returns without emitting anything is a decode failure, so
    // it falls back - unless the frame callback itself failed, which never does.
    if (frameIndex === 0 && totalFrames > 0 && !this.cancelled && !callbackError) {
      throw new DecoderFallbackError(new Error('Streaming decoder delivered no frames'))
    }
    if (callbackError) throw callbackError

    return frameIndex
  }

  /** Seek path: one `HTMLVideoElement` seek per output frame, next seek overlapped with rendering. */
  private async exportFramesBySeeking(
    videoElement: HTMLVideoElement,
    plan: GifFramePlan,
  ): Promise<number> {
    const { totalFrames } = plan
    const seekTo = (timeSec: number): Promise<void> => {
      const seeked = new Promise<void>((resolve) => {
        videoElement.addEventListener('seeked', () => resolve(), { once: true })
      })
      videoElement.currentTime = timeSec
      return seeked
    }

    let frameIndex = 0

    // Seek to the first frame upfront
    if (frameIndex < totalFrames && !this.cancelled) {
      await seekTo(plan.sourceTimeMsForFrame(frameIndex) / 1000)
      await waitForPresentedFrame(videoElement)
    }

    while (frameIndex < totalFrames && !this.cancelled) {
      const i = frameIndex
      const timestamp = i * (1_000_000 / this.config.frameRate)
      const sourceTimeMs = plan.sourceTimeMsForFrame(i)

      // Create a VideoFrame from the video element
      const videoFrame = new VideoFrame(videoElement, { timestamp })

      // Start seeking to the next frame AFTER we've captured the current VideoFrame
      let nextSeekPromise: Promise<void> | null = null
      if (i + 1 < totalFrames) {
        const nextVideoTime = plan.sourceTimeMsForFrame(i + 1) / 1000
        if (Math.abs(videoElement.currentTime - nextVideoTime) > 0.001) {
          nextSeekPromise = seekTo(nextVideoTime)
        }
      }

      // Render the frame with all effects (CPU work overlaps seek I/O)
      try {
        await this.renderAndAddFrame(videoFrame, sourceTimeMs * 1000, plan.frameDelayMs)
      } finally {
        videoFrame.close()
      }

      // Wait for next frame seek to complete
      if (nextSeekPromise) {
        await nextSeekPromise
      }

      frameIndex++
      this.reportFrameProgress(frameIndex, totalFrames)
    }

    return frameIndex
  }

  cancel(): void {
    this.cancelled = true
    this.streamingDecoder?.cancel()
    if (this.gif) {
      this.gif.abort()
    }
    this.cleanup()
  }

  private cleanup(): void {
    if (this.decoder) {
      try {
        this.decoder.destroy()
      } catch (e) {
        console.warn('Error destroying decoder:', e)
      }
      this.decoder = null
    }

    if (this.streamingDecoder) {
      try {
        this.streamingDecoder.destroy()
      } catch (e) {
        console.warn('Error destroying streaming decoder:', e)
      }
      this.streamingDecoder = null
    }

    if (this.renderer) {
      try {
        this.renderer.destroy()
      } catch (e) {
        console.warn('Error destroying renderer:', e)
      }
      this.renderer = null
    }

    this.gif = null
  }
}
