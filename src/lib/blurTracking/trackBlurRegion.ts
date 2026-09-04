import type { BlurTrack } from '@/components/video-editor/types'
import { resolveExportDecodePath } from '@/lib/exporter/decoderFallback'
import { StreamingVideoDecoder } from '@/lib/exporter/streamingDecoder'
import type { ExportDecodePath } from '@/lib/exporter/types'
import { VideoFileDecoder } from '@/lib/exporter/videoDecoder'
import { BlurTrackSession } from './blurTrackSession'
import { createCanvasTrackerFrame, TrackerCanvasScratch, type TrackerImage } from './frameSource'
import type { NormRect } from './keyframes'
import {
  buildBlurTrack,
  buildSampleGrid,
  normRectToSourcePx,
  planBackwardChunks,
} from './trackPlan'
import { BLUR_TRACKER_TUNING, type SourceRectPx, type TrackerSample } from './trackerCore'
import type { BlurTrackerWorkerRequest, BlurTrackerWorkerResponse } from './blurTracker.worker'

/**
 * Runs a track over a recording and returns the keyframes.
 *
 * The tracker never touches the editor's `<video>`: it opens its own decoder on
 * the source file exactly as the exporter does, and takes the same decode path
 * export would (`resolveExportDecodePath`), so a machine that exports by
 * seeking tracks by seeking. Every gradient and correlation happens in a
 * worker; this file decodes, hands frames over, and assembles the result.
 *
 * See `docs/specs/tracked-blur-regions.md` §1.11.
 */

/** Grid intervals decoded per backward chunk. Bounded so the held frames stay well under 64 MB. */
export const BACKWARD_CHUNK_INTERVALS = 16

export class BlurTrackingRefusedError extends Error {
  constructor(
    readonly reason: 'low-detail' | 'degenerate-rect',
    readonly stdDev: number,
  ) {
    super(`Blur tracking refused the anchor patch: ${reason}`)
    this.name = 'BlurTrackingRefusedError'
  }
}

declare global {
  interface Window {
    /**
     * Dev-only handle installed by `VideoEditor` when `BLUR_TRACKING_ENABLED`
     * is on, for checking a track by hand in the browser harness. Phase 1 has
     * no UI; see `docs/specs/tracked-blur-regions.md` §4.3.
     */
    __capturiaBlurTracking?: {
      track: (regionId?: string) => Promise<BlurTrack | null>
    }
  }
}

export interface TrackBlurRegionProgress {
  /** Source milliseconds decoded so far, across both passes. */
  decodedMs: number
  /** Source milliseconds the two passes cover in total. */
  totalMs: number
}

export interface TrackBlurRegionOptions {
  videoUrl: string
  /** The region's span, source ms. */
  startMs: number
  endMs: number
  /** The instant the user drew the box at, source ms. */
  anchorMs: number
  /** The box as drawn, source-normalised. */
  anchorRect: NormRect
  /** Overrides the export decode-path rule; the browser test forces the seek path with it. */
  decodePath?: ExportDecodePath
  sampleIntervalMs?: number
  signal?: AbortSignal
  onProgress?: (progress: TrackBlurRegionProgress) => void
  /** Off in tests that want the analysis inline and a stack trace they can read. */
  useWorker?: boolean
}

export interface TrackBlurRegionResult {
  track: BlurTrack
  /** The path actually used. A silent fallback would change results without saying so. */
  decodePath: ExportDecodePath
  /** Wall time spent decoding, ms. */
  decodeMs: number
  /** Wall time spent analysing, ms, and how many frames that was. */
  analyseMs: number
  analysedSamples: number
  /**
   * Wall time of each frame handed to the analyser, ms. Diagnostic only - the
   * benchmark reports the median and the 90th percentile from it, which a mean
   * over a run that includes the JIT warming up would hide.
   */
  analyseDurationsMs: number[]
  /** False when the run had to copy frames through `ImageBitmap` to reach the worker. */
  transferredVideoFrames: boolean
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Blur tracking was cancelled', 'AbortError')
}

function closeImage(image: TrackerImage): void {
  if ('close' in image && typeof image.close === 'function') image.close()
}

// ---------------------------------------------------------------------------
// Analyser: the session, on this thread or in the worker
// ---------------------------------------------------------------------------

interface Analyser {
  push(image: TrackerImage, timeMs: number): Promise<TrackerSample[]>
  isComplete(): boolean
  dispose(): Promise<void>
}

class LocalAnalyser implements Analyser {
  private constructor(private readonly session: BlurTrackSession<TrackerImage>) {}

  static create(
    anchorImage: TrackerImage,
    anchorRect: SourceRectPx,
    anchorMs: number,
    gridTimes: number[],
    scratch: TrackerCanvasScratch,
  ): LocalAnalyser {
    const created = BlurTrackSession.create(anchorImage, anchorRect, anchorMs, {
      toFrame: (image) => createCanvasTrackerFrame(image, scratch),
      release: closeImage,
      gridTimes,
    })
    // Ownership of the anchor image passes here, matching the worker, which
    // has it transferred and closes it.
    closeImage(anchorImage)
    if (!created.ok) throw new BlurTrackingRefusedError(created.reason, created.stdDev)
    return new LocalAnalyser(created.session)
  }

  push(image: TrackerImage, timeMs: number): Promise<TrackerSample[]> {
    return Promise.resolve(this.session.push(image, timeMs))
  }

  isComplete(): boolean {
    return this.session.isComplete()
  }

  dispose(): Promise<void> {
    this.session.dispose()
    return Promise.resolve()
  }
}

/**
 * The session in a worker, one frame in flight.
 *
 * Frames are **transferred**, not copied, so a `VideoFrame` reaches the worker
 * without a pixel copy and the worker owns closing it. Awaiting each frame's
 * reply is the backpressure: the decoder cannot run ahead of the analysis and
 * pile up decoded frames, which is what exhausts a decoder's buffer pool.
 */
class WorkerAnalyser implements Analyser {
  private complete = false
  private nextId = 1
  private transferredVideoFrames = true

  private constructor(private readonly worker: Worker) {}

  static async create(
    anchorImage: TrackerImage,
    anchorRect: SourceRectPx,
    anchorMs: number,
    gridTimes: number[],
  ): Promise<WorkerAnalyser> {
    const worker = new Worker(new URL('./blurTracker.worker.ts', import.meta.url), {
      type: 'module',
    })
    const analyser = new WorkerAnalyser(worker)
    const reply = analyser.request(
      { type: 'init', image: anchorImage, anchorRect, anchorMs, gridTimes },
      [anchorImage as unknown as Transferable],
    )
    const response = await reply
    if (response.type === 'refused') {
      worker.terminate()
      throw new BlurTrackingRefusedError(
        response.reason as 'low-detail' | 'degenerate-rect',
        response.stdDev,
      )
    }
    if (response.type !== 'ready') {
      worker.terminate()
      throw new Error(
        response.type === 'error' ? response.message : 'The blur tracker worker failed to start',
      )
    }
    return analyser
  }

  usedVideoFrameTransfer(): boolean {
    return this.transferredVideoFrames
  }

  private request(
    message: BlurTrackerWorkerRequest,
    transfer: Transferable[],
  ): Promise<BlurTrackerWorkerResponse> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<BlurTrackerWorkerResponse>) => {
        this.worker.removeEventListener('message', onMessage)
        this.worker.removeEventListener('error', onError)
        resolve(event.data)
      }
      const onError = (event: ErrorEvent) => {
        this.worker.removeEventListener('message', onMessage)
        this.worker.removeEventListener('error', onError)
        reject(new Error(event.message || 'The blur tracker worker failed'))
      }
      this.worker.addEventListener('message', onMessage)
      this.worker.addEventListener('error', onError)
      try {
        this.worker.postMessage(message, transfer)
      } catch (error) {
        this.worker.removeEventListener('message', onMessage)
        this.worker.removeEventListener('error', onError)
        reject(error)
      }
    })
  }

  async push(image: TrackerImage, timeMs: number): Promise<TrackerSample[]> {
    const id = this.nextId++
    let response: BlurTrackerWorkerResponse
    try {
      response = await this.request({ type: 'frame', image, timeMs, id }, [
        image as unknown as Transferable,
      ])
    } catch (error) {
      // Some builds refuse to transfer a `VideoFrame` across a worker
      // boundary. Copying through an `ImageBitmap` costs a GPU blit per frame
      // and is the documented fallback rather than a reason to fail.
      if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error
      this.transferredVideoFrames = false
      const bitmap = await createImageBitmap(image as ImageBitmapSource)
      closeImage(image)
      response = await this.request({ type: 'frame', image: bitmap, timeMs, id }, [bitmap])
    }
    if (response.type === 'error') throw new Error(response.message)
    if (response.type !== 'sample') return []
    this.complete = response.complete
    return response.samples
  }

  isComplete(): boolean {
    return this.complete
  }

  async dispose(): Promise<void> {
    try {
      await this.request({ type: 'cancel' }, [])
    } catch {
      /* the worker is going away regardless */
    }
    this.worker.terminate()
  }
}

// ---------------------------------------------------------------------------
// Frame streams
// ---------------------------------------------------------------------------

type FrameVisitor = (image: TrackerImage, timeMs: number) => Promise<void>

interface FrameStream {
  sourceSize: { width: number; height: number }
  /** Every frame in `[startMs, endMs]`, ascending. Ownership of each image passes to the visitor. */
  forEachFrame(startMs: number, endMs: number, visit: FrameVisitor): Promise<void>
  /** Only the frames nearest each instant of `gridTimes` (ascending), as owned bitmaps. */
  collectAt(gridTimes: number[]): Promise<Array<{ image: ImageBitmap; timeMs: number }>>
  dispose(): void
}

class WebCodecsFrameStream implements FrameStream {
  private constructor(
    private readonly decoder: StreamingVideoDecoder,
    readonly sourceSize: { width: number; height: number },
    private readonly signal: AbortSignal | undefined,
    private readonly onDecoded: (timeMs: number) => void,
  ) {}

  static async open(
    videoUrl: string,
    signal: AbortSignal | undefined,
    onDecoded: (timeMs: number) => void,
  ): Promise<WebCodecsFrameStream> {
    const decoder = new StreamingVideoDecoder()
    const info = await decoder.loadMetadata(videoUrl)
    return new WebCodecsFrameStream(
      decoder,
      { width: info.width, height: info.height },
      signal,
      onDecoded,
    )
  }

  async forEachFrame(startMs: number, endMs: number, visit: FrameVisitor): Promise<void> {
    await this.decoder.decodeRange(
      { startSec: startMs / 1000, endSec: endMs / 1000 },
      async (frame, timestampMs) => {
        this.onDecoded(timestampMs)
        // `visit` may transfer the frame to the worker, which takes ownership;
        // closing here would then be a double close, so the visitor is handed
        // the frame outright and this closes only what comes back untouched.
        await visit(frame, timestampMs)
      },
      { signal: this.signal },
    )
  }

  async collectAt(gridTimes: number[]): Promise<Array<{ image: ImageBitmap; timeMs: number }>> {
    if (gridTimes.length === 0) return []
    const kept: Array<{ image: ImageBitmap; timeMs: number }> = []
    // Held in objects rather than `let`: the assignments happen inside the
    // decode callback, where control-flow narrowing cannot follow them.
    const cursor = { index: 0 }
    const carried: { frame: { image: ImageBitmap; timeMs: number } | null } = { frame: null }

    await this.decoder.decodeRange(
      {
        startSec: gridTimes[0] / 1000,
        // A tail past the last instant: without a frame on the far side of it
        // the nearest-frame rule has nothing to compare against and the last
        // instant goes unfilled, which shifts every sample of a backward chunk
        // by one grid interval.
        endSec: gridTimes[gridTimes.length - 1] / 1000 + 0.2,
      },
      async (frame, timestampMs) => {
        try {
          this.onDecoded(timestampMs)
          if (cursor.index >= gridTimes.length) return
          const gridTime = gridTimes[cursor.index]
          if (timestampMs < gridTime) {
            carried.frame?.image.close()
            carried.frame = { image: await createImageBitmap(frame), timeMs: timestampMs }
            return
          }
          // At or past the instant: the nearer of the two frames either side wins.
          const current = { image: await createImageBitmap(frame), timeMs: timestampMs }
          const held = carried.frame
          if (held && gridTime - held.timeMs <= current.timeMs - gridTime) {
            kept.push(held)
            carried.frame = current
          } else {
            held?.image.close()
            kept.push(current)
            carried.frame = null
          }
          cursor.index++
        } finally {
          frame.close()
        }
      },
      { signal: this.signal },
    )
    // The recording ended before a frame past the last instant: the frame in
    // hand is the nearest one there will ever be.
    if (cursor.index < gridTimes.length && carried.frame) kept.push(carried.frame)
    else carried.frame?.image.close()
    return kept
  }

  dispose(): void {
    this.decoder.destroy()
  }
}

class SeekFrameStream implements FrameStream {
  private constructor(
    private readonly decoder: VideoFileDecoder,
    private readonly video: HTMLVideoElement,
    readonly sourceSize: { width: number; height: number },
    private readonly signal: AbortSignal | undefined,
    private readonly onDecoded: (timeMs: number) => void,
  ) {}

  static async open(
    videoUrl: string,
    signal: AbortSignal | undefined,
    onDecoded: (timeMs: number) => void,
  ): Promise<SeekFrameStream> {
    const decoder = new VideoFileDecoder()
    const info = await decoder.loadVideo(videoUrl)
    const video = decoder.getVideoElement()
    if (!video) throw new Error('The source video could not be opened for seeking.')
    return new SeekFrameStream(
      decoder,
      video,
      { width: info.width, height: info.height },
      signal,
      onDecoded,
    )
  }

  /**
   * The seek path has no frames between the grid instants to offer, so this
   * yields exactly the grid. Densification is therefore impossible here and the
   * union rule at render time (§1.8 rule 2) is what keeps a fast scroll covered.
   */
  forEachFrame(): Promise<void> {
    return Promise.reject(new Error('The seek path yields grid frames only; use collectAt'))
  }

  async collectAt(gridTimes: number[]): Promise<Array<{ image: ImageBitmap; timeMs: number }>> {
    const kept: Array<{ image: ImageBitmap; timeMs: number }> = []
    for (const timeMs of gridTimes) {
      throwIfAborted(this.signal)
      await seekTo(this.video, timeMs / 1000)
      kept.push({ image: await createImageBitmap(this.video), timeMs })
      this.onDecoded(timeMs)
    }
    return kept
  }

  dispose(): void {
    this.decoder.destroy()
  }
}

function seekTo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Seeking the source video failed'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = timeSec
  })
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function trackBlurRegion(
  options: TrackBlurRegionOptions,
): Promise<TrackBlurRegionResult> {
  const {
    videoUrl,
    startMs,
    endMs,
    anchorMs,
    anchorRect,
    signal,
    onProgress,
    sampleIntervalMs = BLUR_TRACKER_TUNING.sampleIntervalMs,
    useWorker = true,
  } = options
  throwIfAborted(signal)

  const decodePath = resolveExportDecodePath({
    requested: options.decodePath,
    fallbackActive: false,
    hasVideoDecoder: typeof VideoDecoder !== 'undefined',
  })
  const grid = buildSampleGrid(anchorMs, startMs, endMs, sampleIntervalMs)
  const totalMs = Math.max(1, endMs - startMs)
  let decodedMs = 0
  let decodeMs = 0
  let analyseMs = 0
  let analysed = 0
  const analyseDurationsMs: number[] = []
  const reportDecoded = (timeMs: number): void => {
    const reached = Math.min(totalMs, Math.abs(timeMs - anchorMs))
    if (reached <= decodedMs) return
    decodedMs = reached
    onProgress?.({ decodedMs, totalMs })
  }

  const scratch = new TrackerCanvasScratch()
  const stream =
    decodePath === 'webcodecs'
      ? await WebCodecsFrameStream.open(videoUrl, signal, reportDecoded)
      : await SeekFrameStream.open(videoUrl, signal, reportDecoded)
  const anchorPx = normRectToSourcePx(anchorRect, stream.sourceSize)
  const samples: TrackerSample[] = []
  let transferredVideoFrames = true

  const openAnalyser = async (
    anchorImage: TrackerImage,
    mirroredAnchorMs: number,
    gridTimes: number[],
  ): Promise<Analyser> => {
    if (!useWorker || typeof Worker === 'undefined') {
      return LocalAnalyser.create(anchorImage, anchorPx, mirroredAnchorMs, gridTimes, scratch)
    }
    const worker = await WorkerAnalyser.create(anchorImage, anchorPx, mirroredAnchorMs, gridTimes)
    return worker
  }

  try {
    // ---- forward -----------------------------------------------------------
    {
      let analyser: Analyser | null = null
      if (decodePath === 'webcodecs') {
        const started = performance.now()
        // The template must come from the frame *nearest* the anchor, not the
        // first one past it: at 30 fps the first frame past can be a full frame
        // period late, and the whole track then sits that far off its content.
        const beforeAnchor: { image: TrackerImage | null; timeMs: number } = {
          image: null,
          timeMs: 0,
        }
        await stream.forEachFrame(anchorMs - 100, endMs, async (frame, timeMs) => {
          throwIfAborted(signal)
          if (!analyser) {
            if (timeMs < anchorMs) {
              if (beforeAnchor.image) closeImage(beforeAnchor.image)
              beforeAnchor.image = frame
              beforeAnchor.timeMs = timeMs
              return
            }
            const held = beforeAnchor.image
            beforeAnchor.image = null
            if (held !== null && anchorMs - beforeAnchor.timeMs < timeMs - anchorMs) {
              analyser = await openAnalyser(held, anchorMs, grid.forward)
              analysed++
              // `frame` is past the anchor and still belongs to this interval;
              // fall through and let the session have it.
            } else {
              if (held) closeImage(held)
              analyser = await openAnalyser(frame, anchorMs, grid.forward)
              analysed++
              return
            }
          }
          if (analyser.isComplete()) {
            closeImage(frame)
            return
          }
          const analyseStart = performance.now()
          const produced = await analyser.push(frame, timeMs)
          const elapsed = performance.now() - analyseStart
          analyseMs += elapsed
          if (produced.length > 0) analyseDurationsMs.push(elapsed / produced.length)
          analysed += produced.length
          for (const sample of produced) samples.push(sample)
        })
        decodeMs += performance.now() - started - analyseMs
      } else {
        const started = performance.now()
        const frames = await stream.collectAt([anchorMs, ...grid.forward])
        decodeMs += performance.now() - started
        const [anchorFrame, ...rest] = frames
        if (!anchorFrame) throw new Error('The recording had no frame at the anchor time.')
        analyser = await openAnalyser(anchorFrame.image, anchorMs, grid.forward)
        analysed++
        for (const held of rest) {
          throwIfAborted(signal)
          const analyseStart = performance.now()
          const produced = await analyser.push(held.image, held.timeMs)
          const elapsed = performance.now() - analyseStart
          analyseMs += elapsed
          if (produced.length > 0) analyseDurationsMs.push(elapsed / produced.length)
          analysed += produced.length
          for (const sample of produced) samples.push(sample)
        }
      }
      if (analyser) {
        if (analyser instanceof WorkerAnalyser) {
          transferredVideoFrames = analyser.usedVideoFrameTransfer()
        }
        await analyser.dispose()
      }
    }

    // ---- backward ----------------------------------------------------------
    // Decoding is forward-only, so each chunk is decoded forwards, its grid
    // frames kept, and the session driven over them newest-first on a mirrored
    // clock: the tracker only ever asks how much time passed since the previous
    // sample, so negating the timestamps makes one implementation serve both
    // directions. The sign goes back on when the samples are collected.
    if (grid.backward.length > 0) {
      let analyser: Analyser | null = null
      for (const chunk of planBackwardChunks(grid.backward, BACKWARD_CHUNK_INTERVALS)) {
        throwIfAborted(signal)
        const ascending = [...chunk].reverse()
        const started = performance.now()
        const frames = await stream.collectAt(analyser ? ascending : [...ascending, anchorMs])
        decodeMs += performance.now() - started
        if (!analyser) {
          const anchorFrame = frames.pop()
          if (!anchorFrame) throw new Error('The recording had no frame at the anchor time.')
          analyser = await openAnalyser(
            anchorFrame.image,
            -anchorMs,
            grid.backward.map((time) => -time),
          )
          analysed++
        }
        for (const held of [...frames].reverse()) {
          throwIfAborted(signal)
          const analyseStart = performance.now()
          const produced = await analyser.push(held.image, -held.timeMs)
          const elapsed = performance.now() - analyseStart
          analyseMs += elapsed
          if (produced.length > 0) analyseDurationsMs.push(elapsed / produced.length)
          analysed += produced.length
          for (const sample of produced) samples.push({ ...sample, timeMs: -sample.timeMs })
        }
      }
      if (analyser) {
        if (analyser instanceof WorkerAnalyser) {
          transferredVideoFrames = transferredVideoFrames && analyser.usedVideoFrameTransfer()
        }
        await analyser.dispose()
      }
    }
  } finally {
    stream.dispose()
  }

  throwIfAborted(signal)
  const track = buildBlurTrack(samples, {
    sourceSize: stream.sourceSize,
    anchorMs,
    sampleIntervalMs,
  })
  return {
    track,
    decodePath,
    decodeMs,
    analyseMs,
    analysedSamples: analysed,
    analyseDurationsMs,
    transferredVideoFrames,
  }
}
