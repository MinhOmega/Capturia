import {
  DEFAULT_EXPORT_DECODE_PATH,
  EXPORT_DECODE_PATH_STORAGE_KEY,
  isExportDecodePath,
  type ExportConfig,
  type ExportDecodePath,
  type ExportProgress,
  type ExportResult,
} from './types'
import { VideoFileDecoder } from './videoDecoder'
import { StreamingVideoDecoder, type DecodedVideoInfo } from './streamingDecoder'
import {
  buildDecodeTimelinePlan,
  segmentsToSpeedTimeline,
  type DecodeTimelinePlan,
} from './segmentAdapter'
import type { SpeedTimelineSegment } from './timelineSegments'
import { downmixPlanarChannelsForExport } from '@/lib/audio/downmix'
import { WsolaTimeStretcher, isTimeStretchPassthroughSpeed } from '@/lib/audio/audioTimeStretch'
import {
  mixTrackStreams,
  type PlanarAudioChunk,
  resolveMixChannelCount,
} from '@/lib/audio/multiTrackMix'
import { PlanarChunkQueue } from '@/lib/audio/planarChunkQueue'
import { isBackgroundLoadError } from './backgroundErrors'
import {
  EXPORT_WARNING_DECODE_ENDED_EARLY,
  EXPORT_WARNING_DECODER_FALLBACK,
} from './decoderFallback'
import {
  classifyExportError,
  DecoderFallbackError,
  EXPORT_ERROR_MESSAGE_PREFIXES,
  EXPORT_ERROR_MESSAGES,
  ExportDecoderError,
  ExportEncoderError,
} from './exportErrors'
import { FrameRenderer } from './frameRenderer'
import { EXPORT_VIDEO_CODEC_STRINGS } from './videoCodecSupport'
import { VideoMuxer } from './muxer'
import type {
  ZoomRegion,
  CropRegion,
  TrimRegion,
  AnnotationRegion,
  AudioEditRegion,
  VideoSegment,
} from '@/components/video-editor/types'
import {
  effectiveToSourceMsWithSegments,
  getEffectiveDurationMsWithSegments,
} from '@/lib/trim/timeMapping'
import type { SubtitleCue } from '@/lib/analysis/types'
import { frameDurationUs, frameIndexToTimestampUs, normalizeFrameRate } from './frameClock'
import type { CursorStyleConfig, CursorTrack } from '@/lib/cursor'
import {
  getAudioEditGainMultiplierAtTime,
  normalizeAudioEditRegions,
} from '@/lib/audio/audioEditRegions'
import {
  normalizeExportAudioProcessingConfig,
  resolveExportAudioNormalizationGain,
  type AudioEnergyStats,
  type NormalizedExportAudioProcessingConfig,
} from '@/lib/audio/exportAudioProcessing'
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  UrlSource,
  type InputAudioTrack,
} from 'mediabunny'
import { getPlatform } from '@/utils/platformUtils'
import type { AspectRatio } from '@/utils/aspectRatioUtils'
import { selectExportAudioCodec, type ExportAudioCodec } from './audioCodecSelection'
import { resolveSourceDurationMs } from './sourceDuration'
import { loadLocalSourceBlob } from './localSourceFile'
import {
  getSourceCopyFastPathBlockers,
  getSourceCopyProbeBlockers,
  probeSourceCopyCandidate,
  type SourceCopyProbe,
} from './sourceCopyFastPath'
import type { ExportQuality } from './types'

export interface VideoExporterConfig extends ExportConfig {
  videoUrl: string
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
  audioEditRegions?: AudioEditRegion[]
  previewWidth?: number
  previewHeight?: number
  cursorTrack?: CursorTrack | null
  cursorStyle?: Partial<CursorStyleConfig>
  onProgress?: (progress: ExportProgress) => void
  playbackSpeed?: number
  segments?: VideoSegment[]
  /**
   * Probed real duration of the source (ms). Preferred over `video.duration`
   * when present; see `resolveSourceDurationMs`.
   */
  sourceDurationMs?: number
  /**
   * Frame source: `'webcodecs'` (StreamingVideoDecoder, single decode pass)
   * or `'seek'` (HTMLVideoElement seek-only). Defaults to
   * `DEFAULT_EXPORT_DECODE_PATH`; see `readExportDecodePathOverride`.
   */
  decodePath?: ExportDecodePath
  /**
   * Editor aspect ratio and quality preset behind `width`/`height`/`bitrate`.
   * Only read by the source-copy fast path (`sourceCopyFastPath.ts`): when
   * either is absent the fast path is disabled and the export renders.
   */
  aspectRatio?: AspectRatio
  quality?: ExportQuality
  /**
   * Probed frame rate of the recording. Only read by the source-copy fast path,
   * which cannot serve an export whose rate differs from the source's.
   */
  sourceFrameRate?: number
  /**
   * Forces the pre-cache export compositor (see `compositorKeys.ts`). Absent
   * means "follow the `capturia.exportLegacyCompositor` override, else off".
   */
  legacyCompositor?: boolean
}

type TimeRangeMs = {
  startMs: number
  endMs: number
}

type AudioGainSegment = {
  startMs: number
  endMs: number
  gain: number
}

type AudioFrameSlice = {
  sourceBuffer: AudioBuffer
  startFrame: number
  endFrame: number
  gain: number
  /** Index into the kept-range list the slice was read for (ranges are visited in order). */
  rangeIndex: number
  /** Absolute source time of `startFrame`, in ms. */
  sourceStartMs: number
}

/** Export encoders are configured for mono/stereo only; wider sources are downmixed. */
const MAX_EXPORT_AUDIO_CHANNELS = 2
/** PCM frames per `AudioBuffer` handed to the muxer on the time-stretched path. */
const TIME_STRETCH_OUTPUT_FRAMES = 4096
/** Source-domain silence is fed to the stretcher in chunks of this many frames. */
const TIME_STRETCH_SILENCE_CHUNK_FRAMES = 8192
/**
 * Per-segment frame quantisation used by `StreamingVideoDecoder` /
 * `computeExportMetrics`: `ceil((dur - EPSILON) / speed * fps)`.
 */
const SEGMENT_FRAME_EPSILON_SEC = 0.001

const DEFAULT_AUDIO_GAIN = 1
const MAX_AUDIO_GAIN = 2
const EXPORT_WARNING_AUDIO_TRACK_UNAVAILABLE = 'editor.exportWarningAudioTrackUnavailable'
const EXPORT_WARNING_AUDIO_CODEC_UNSUPPORTED = 'editor.exportWarningAudioCodecUnsupported'
/** Some of the source's audio tracks could not be decoded or mixed and were left out. */
const EXPORT_WARNING_AUDIO_TRACKS_SKIPPED = 'editor.exportWarningAudioTracksSkipped'

/** One decoded span of source audio, shaped like mediabunny's `WrappedAudioBuffer`. */
interface SourceAudioBuffer {
  buffer: AudioBuffer
  /** Source time of the first sample, in seconds. */
  timestamp: number
  /** Seconds covered by `buffer`. */
  duration: number
}

/** Adapts a decoder sink's buffers to the planar chunks the multi-track mixer consumes. */
async function* planarChunksFromBuffers(
  buffers: AsyncIterable<SourceAudioBuffer>,
): AsyncGenerator<PlanarAudioChunk, void, undefined> {
  for await (const wrapped of buffers) {
    const { buffer } = wrapped
    yield {
      timestampSec: wrapped.timestamp,
      sampleRate: buffer.sampleRate,
      planes: Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
        buffer.getChannelData(channel),
      ),
    }
  }
}

function isExportAudioDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem('capturia.exportDebugAudio') === '1'
  } catch {
    return false
  }
}

/**
 * Support/QA override for the frame decode path: `localStorage` key
 * `capturia.exportDecodePath` set to `'webcodecs'` or `'seek'`. Any other
 * value (or no value) returns `undefined` so the exporter default applies.
 */
export function readExportDecodePathOverride(): ExportDecodePath | undefined {
  try {
    const value = globalThis.localStorage?.getItem(EXPORT_DECODE_PATH_STORAGE_KEY)
    return isExportDecodePath(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** How long a full encoder queue may stay full before the attempt is declared stalled. */
const ENCODER_STALL_TIMEOUT_MS = 15_000
/** Upper bound for the final `VideoEncoder.flush()`; a stuck encoder must not hang the export. */
const ENCODER_FLUSH_TIMEOUT_MS = 20_000
/** Software encoders get a shorter queue so Windows does not balloon memory. */
const SOFTWARE_ENCODER_MAX_QUEUE = 32
/** H.264 High 5.1: the codec every platform can encode and every player can read. */
const DEFAULT_EXPORT_CODEC = EXPORT_VIDEO_CODEC_STRINGS.h264
/**
 * Platforms that try the software encoder first. Windows hardware encoders
 * were the source of the encoder-stall reports, so software goes first there;
 * everywhere else hardware is preferred. Kept as a constant so the ordering can
 * be flipped after measurements.
 */
export const SOFTWARE_FIRST_ENCODER_PLATFORMS: ReadonlySet<string> = new Set(['win32'])

/** Encoder preference order for `platform` (an Electron `process.platform` value). */
export function getEncoderPreferences(platform: string | undefined): HardwareAcceleration[] {
  if (platform && SOFTWARE_FIRST_ENCODER_PLATFORMS.has(platform)) {
    return ['prefer-software', 'prefer-hardware']
  }
  return ['prefer-hardware', 'prefer-software']
}

/** One (codec, hardware preference) pair for `export()` to try, in order. */
export interface EncoderAttempt {
  codec: string
  hardwareAcceleration: HardwareAcceleration
  /** `true` when this attempt is not the requested codec but the H.264 fallback. */
  codecFellBack: boolean
}

/**
 * Every encoder configuration the export may try, most-wanted first: the
 * requested codec on each hardware preference, then — when the request was not
 * H.264 — H.264 on each. A probe can say HEVC is supported and `configure()`
 * still fail on the driver, so the fallback is part of the run, not of the UI.
 */
export function buildEncoderAttempts(
  requestedCodec: string | undefined,
  platform: string | undefined,
): EncoderAttempt[] {
  const preferences = getEncoderPreferences(platform)
  const requested = requestedCodec || DEFAULT_EXPORT_CODEC
  const codecs: Array<{ codec: string; codecFellBack: boolean }> = [
    { codec: requested, codecFellBack: false },
  ]
  if (requested !== DEFAULT_EXPORT_CODEC) {
    codecs.push({ codec: DEFAULT_EXPORT_CODEC, codecFellBack: true })
  }
  return codecs.flatMap(({ codec, codecFellBack }) =>
    preferences.map((hardwareAcceleration) => ({ codec, hardwareAcceleration, codecFellBack })),
  )
}

/**
 * Waits for the encoder's queue to drain below maxEncodeQueue before returning.
 *
 * The stall timer starts fresh on each call (not from the encoder's last output), so a
 * long gap before this call - e.g. the decoder discarding frames inside a trim region -
 * doesn't get blamed on the encoder once real frames resume.
 */
export async function waitForEncoderQueueSpace(params: {
  getQueueSize: () => number
  maxEncodeQueue: number
  isCancelled: () => boolean
  encoderPreference: HardwareAcceleration
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const now = params.now ?? Date.now
  const sleep = params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  const stallWaitStartAt = now()
  while (params.getQueueSize() >= params.maxEncodeQueue && !params.isCancelled()) {
    if (now() - stallWaitStartAt > ENCODER_STALL_TIMEOUT_MS) {
      throw new Error(
        params.encoderPreference === 'prefer-hardware'
          ? EXPORT_ERROR_MESSAGES.encoderStallHardware
          : EXPORT_ERROR_MESSAGES.encoderStallSoftware,
      )
    }
    await sleep(5)
  }
}

// Error classes live in ./exportErrors so the UI can classify results without
// pulling in the exporter; re-exported here for existing importers.
export { ExportEncoderError }

export function getSeekToleranceSeconds(frameRate: number): number {
  const safeFrameRate = Number.isFinite(frameRate) && frameRate > 0 ? frameRate : 60
  return Math.max(1 / (safeFrameRate * 2), 1 / 240)
}

export function shouldSeekToTime(
  currentTime: number,
  targetTime: number,
  frameRate: number,
): boolean {
  return Math.abs(currentTime - targetTime) > getSeekToleranceSeconds(frameRate)
}

export function estimateRemainingSeconds(
  currentFrame: number,
  totalFrames: number,
  elapsedMs: number,
): number {
  if (
    !Number.isFinite(currentFrame) ||
    !Number.isFinite(totalFrames) ||
    !Number.isFinite(elapsedMs)
  ) {
    return 0
  }
  if (currentFrame <= 0 || totalFrames <= currentFrame || elapsedMs <= 0) {
    return 0
  }
  const msPerFrame = elapsedMs / currentFrame
  return Math.max(0, Math.round(((totalFrames - currentFrame) * msPerFrame) / 1000))
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = globalThis.setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

export function clampAudioGain(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AUDIO_GAIN
  return Math.max(0, Math.min(MAX_AUDIO_GAIN, value as number))
}

export function buildAudioGainSegments(
  rangeStartMs: number,
  rangeEndMs: number,
  baseGain: number,
  audioEditRegions: AudioEditRegion[] | undefined,
): AudioGainSegment[] {
  const safeStart = Math.max(0, Math.min(rangeStartMs, rangeEndMs))
  const safeEnd = Math.max(safeStart, Math.max(rangeStartMs, rangeEndMs))
  if (safeEnd <= safeStart) {
    return []
  }

  const normalizedBaseGain = clampAudioGain(baseGain)
  if (!audioEditRegions?.length) {
    return [{ startMs: safeStart, endMs: safeEnd, gain: normalizedBaseGain }]
  }

  const boundaries = new Set<number>([safeStart, safeEnd])
  for (const region of audioEditRegions) {
    if (region.endMs <= safeStart || region.startMs >= safeEnd) {
      continue
    }
    boundaries.add(Math.max(safeStart, region.startMs))
    boundaries.add(Math.min(safeEnd, region.endMs))
  }

  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right)
  const segments: AudioGainSegment[] = []

  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const segmentStartMs = sortedBoundaries[index]
    const segmentEndMs = sortedBoundaries[index + 1]
    if (segmentEndMs <= segmentStartMs) {
      continue
    }

    const midpointMs = segmentStartMs + (segmentEndMs - segmentStartMs) / 2
    const regionMultiplier = getAudioEditGainMultiplierAtTime(midpointMs, audioEditRegions)
    segments.push({
      startMs: segmentStartMs,
      endMs: segmentEndMs,
      gain: clampAudioGain(normalizedBaseGain * regionMultiplier),
    })
  }

  return segments
}

export function normalizeTrimRanges(
  trimRegions: TrimRegion[] | undefined,
  totalDurationMs: number,
): TimeRangeMs[] {
  if (!trimRegions?.length || !Number.isFinite(totalDurationMs) || totalDurationMs <= 0) {
    return []
  }

  const sorted = trimRegions
    .map((region) => {
      const start = Number.isFinite(region.startMs) ? region.startMs : 0
      const end = Number.isFinite(region.endMs) ? region.endMs : start
      return {
        startMs: Math.max(0, Math.min(start, totalDurationMs)),
        endMs: Math.max(0, Math.min(end, totalDurationMs)),
      }
    })
    .filter((region) => region.endMs > region.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  if (sorted.length === 0) {
    return []
  }

  const merged: TimeRangeMs[] = []
  for (const region of sorted) {
    const previous = merged[merged.length - 1]
    if (!previous || region.startMs > previous.endMs) {
      merged.push({ ...region })
      continue
    }

    previous.endMs = Math.max(previous.endMs, region.endMs)
  }

  return merged
}

export function buildKeptRanges(
  totalDurationMs: number,
  trimRegions: TrimRegion[] | undefined,
): TimeRangeMs[] {
  if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0) {
    return []
  }

  const normalizedTrims = normalizeTrimRanges(trimRegions, totalDurationMs)
  if (normalizedTrims.length === 0) {
    return [{ startMs: 0, endMs: totalDurationMs }]
  }

  const kept: TimeRangeMs[] = []
  let cursorMs = 0

  for (const trim of normalizedTrims) {
    if (trim.startMs > cursorMs) {
      kept.push({ startMs: cursorMs, endMs: trim.startMs })
    }
    cursorMs = Math.max(cursorMs, trim.endMs)
  }

  if (cursorMs < totalDurationMs) {
    kept.push({ startMs: cursorMs, endMs: totalDurationMs })
  }

  return kept.filter((range) => range.endMs > range.startMs)
}

/**
 * Per-segment output frame counts the video path renders for `timeline`.
 *
 * - `'webcodecs'`: `StreamingVideoDecoder` emits `ceil((dur - eps) / speed * fps)`
 *   frames per segment (see `computeExportMetrics`).
 * - `'seek'`: `exportFramesBySeeking` renders `ceil(effectiveDuration * fps)`
 *   frames and maps frame `k` at output time `k / fps` onto the timeline, so a
 *   segment owns the frames whose output time falls inside its cumulative span.
 *
 * The last segment absorbs any rounding difference so the counts always sum to
 * `totalFrames`, the number the video path actually produced.
 */
export function buildVideoFrameCountsForTimeline(
  timeline: SpeedTimelineSegment[],
  frameRate: number,
  totalFrames: number,
  decodePath: ExportDecodePath,
): number[] {
  if (timeline.length === 0) {
    return []
  }
  const fps = normalizeFrameRate(frameRate)
  const counts: number[] = []
  let cumulativeSec = 0
  let cumulativeFrames = 0
  for (const segment of timeline) {
    const durationSec = Math.max(0, segment.endSec - segment.startSec)
    const speed = segment.speed > 0 ? segment.speed : 1
    let frames: number
    if (decodePath === 'webcodecs') {
      frames = Math.max(0, Math.ceil(((durationSec - SEGMENT_FRAME_EPSILON_SEC) / speed) * fps))
    } else {
      const nextCumulativeSec = cumulativeSec + durationSec / speed
      const nextCumulativeFrames = Math.ceil(nextCumulativeSec * fps - 1e-6)
      frames = Math.max(0, nextCumulativeFrames - cumulativeFrames)
      cumulativeSec = nextCumulativeSec
    }
    counts.push(frames)
    cumulativeFrames += frames
  }
  const previous = cumulativeFrames - counts[counts.length - 1]
  counts[counts.length - 1] = Math.max(0, Math.floor(totalFrames) - previous)
  return counts
}

/**
 * Output PCM frames each timeline segment must contribute so the audio track is
 * exactly as long as the video: segment boundaries are the `frameClock`
 * timestamps of the cumulative frame index, converted to samples, so the sum
 * telescopes to `round(ts(totalFrames) * sampleRate)` with no per-segment drift.
 */
export function buildAudioSegmentSampleBudget(
  frameCounts: number[],
  frameRate: number,
  sampleRate: number,
): number[] {
  const toSamples = (frameIndex: number) =>
    Math.round((frameIndexToTimestampUs(frameIndex, frameRate) * sampleRate) / 1_000_000)
  let cumulativeFrames = 0
  return frameCounts.map((frames) => {
    const start = toSamples(cumulativeFrames)
    cumulativeFrames += Math.max(0, frames)
    return Math.max(0, toSamples(cumulativeFrames) - start)
  })
}

export class VideoExporter {
  private config: VideoExporterConfig
  private decoder: VideoFileDecoder | null = null
  private streamingDecoder: StreamingVideoDecoder | null = null
  /** Set once the WebCodecs path failed before its first frame; forces the seek path. */
  private decoderFallbackActive = false
  private renderer: FrameRenderer | null = null
  private encoder: VideoEncoder | null = null
  private muxer: VideoMuxer | null = null
  private cancelled = false
  private encodeQueue = 0
  private readonly MAX_ENCODE_QUEUE = 120
  private maxEncodeQueue = this.MAX_ENCODE_QUEUE
  private encoderPreference: HardwareAcceleration = 'prefer-hardware'
  /** Codec of the attempt in flight; `export()` walks it down to H.264 on failure. */
  private activeCodec: string | null = null
  /** Set by the VideoEncoder `error` callback; surfaces at the next frame / flush. */
  private fatalEncoderError: ExportEncoderError | null = null
  private videoDescription: Uint8Array | undefined
  private videoColorSpace: VideoColorSpaceInit | undefined
  private muxingChain: Promise<void> = Promise.resolve()
  private muxingError: Error | null = null
  private chunkCount = 0
  private readonly FINALIZE_TIMEOUT_MS = 120_000
  private exportStartedAtMs = 0
  private progressTick = 0
  private finalizingHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  private finalizingCurrentFrame = 0
  private finalizingTotalFrames = 0
  private finalizingDetailKey: string | undefined
  private lastRenderingFrameCount = 0
  private lastThroughputLogAtMs = 0
  private seekCount = 0
  private samplingMode: 'seek-only' | 'webcodecs' = 'seek-only'
  private maxObservedTimingDriftMs = 0
  private sourceDurationMs = 0
  private platform: string | undefined
  private audioCodec: ExportAudioCodec = 'aac'
  private sourceTrimRanges: TimeRangeMs[] = []
  private sourceAudioEditRegions: AudioEditRegion[] = []
  /** Kept source spans (with speed) the video path renders; drives the audio retiming. */
  private audioTimeline: SpeedTimelineSegment[] = []
  /** Frame count the video path renders for `audioTimeline`. */
  private audioTotalFrames = 0
  private sourceAudioInput: Input | null = null
  private sourceAudioTrack: InputAudioTrack | null = null
  /**
   * Every decodable audio track that shares the primary track's sample rate,
   * primary first. One entry (or none, in tests that stub the primary) keeps
   * the single-sink path byte-identical; two or more are summed per range.
   */
  private sourceAudioTracks: InputAudioTrack[] = []
  /** Audio stream count the WebCodecs demuxer reported (diagnostics only). */
  private sourceAudioStreamCount: number | null = null
  private readonly warnings = new Set<string>()
  private readonly audioProcessing: NormalizedExportAudioProcessingConfig

  constructor(config: VideoExporterConfig) {
    const audioGain = clampAudioGain(config.audioGain)
    this.audioProcessing = normalizeExportAudioProcessingConfig(config.audioProcessing)
    this.config = {
      ...config,
      audioEnabled: config.audioEnabled !== false,
      audioGain,
      frameRate: normalizeFrameRate(config.frameRate),
    }
  }

  private getSourceTrimRanges(totalDurationMs: number): TimeRangeMs[] {
    if (this.sourceDurationMs > 0 && Math.abs(totalDurationMs - this.sourceDurationMs) < 0.5) {
      return this.sourceTrimRanges
    }

    return normalizeTrimRanges(this.config.trimRegions, totalDurationMs)
  }

  private getEffectiveDuration(totalDuration: number): number {
    const totalDurationMs = Math.max(0, totalDuration * 1000)
    if (totalDurationMs <= 0) {
      return 0
    }

    // Use segment-aware calculation if segments are provided
    if (this.config.segments?.length) {
      return getEffectiveDurationMsWithSegments(this.config.segments) / 1000
    }

    const trimRanges = this.getSourceTrimRanges(totalDurationMs)
    const trimmedMs = trimRanges.reduce((sum, region) => sum + (region.endMs - region.startMs), 0)
    const speed = Math.max(0.25, this.config.playbackSpeed ?? 1)
    return Math.max(0, (totalDurationMs - trimmedMs) / speed / 1000)
  }

  private mapEffectiveToSourceTime(effectiveTimeMs: number): number {
    if (this.sourceDurationMs <= 0) {
      return Math.max(0, effectiveTimeMs)
    }

    let sourceTimeMs = effectiveTimeMs

    for (const trim of this.sourceTrimRanges) {
      if (sourceTimeMs < trim.startMs) {
        break
      }

      const trimDuration = trim.endMs - trim.startMs
      sourceTimeMs += trimDuration
    }

    return Math.max(0, Math.min(sourceTimeMs, this.sourceDurationMs))
  }

  private async openSourceInputFromUrl(): Promise<Input> {
    return new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(this.config.videoUrl),
    })
  }

  private async openSourceInputFromBlob(): Promise<Input> {
    const response = await fetch(this.config.videoUrl)
    if (!response.ok && response.status !== 0) {
      throw new Error(
        `Failed to fetch source media for audio extraction (status ${response.status})`,
      )
    }

    const blob = await response.blob()
    return new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(blob),
    })
  }

  private disposeSourceAudioInput(): void {
    if (this.sourceAudioInput) {
      try {
        this.sourceAudioInput.dispose()
      } catch (error) {
        console.warn('Error disposing source audio input:', error)
      }
    }

    this.sourceAudioInput = null
    this.sourceAudioTrack = null
    this.sourceAudioTracks = []
  }

  private async resolveSourceAudioTrack(): Promise<boolean> {
    this.disposeSourceAudioInput()
    if (this.config.audioEnabled === false) {
      return false
    }

    try {
      const input = await this.openSourceInputFromUrl()
      const audioTrack = await input.getPrimaryAudioTrack()
      if (audioTrack) {
        this.sourceAudioInput = input
        this.sourceAudioTrack = audioTrack
        this.sourceAudioTracks = await this.collectMixableAudioTracks(input, audioTrack)
        return true
      }
      input.dispose()
    } catch (urlError) {
      console.warn(
        '[VideoExporter] Unable to read source audio via UrlSource. Retrying with BlobSource.',
        urlError,
      )
    }

    try {
      const input = await this.openSourceInputFromBlob()
      const audioTrack = await input.getPrimaryAudioTrack()
      if (audioTrack) {
        this.sourceAudioInput = input
        this.sourceAudioTrack = audioTrack
        this.sourceAudioTracks = await this.collectMixableAudioTracks(input, audioTrack)
        return true
      }
      input.dispose()
      return false
    } catch (blobError) {
      console.warn(
        '[VideoExporter] Audio track extraction failed; continuing with video-only export.',
        blobError,
      )
      this.disposeSourceAudioInput()
      return false
    }
  }

  /**
   * Lists every audio track of the container that can be summed with the
   * primary one: decodable and at the same sample rate. Tracks that fail
   * either test are left out with `EXPORT_WARNING_AUDIO_TRACKS_SKIPPED` so a
   * silent-mic export is never a surprise. Files with a single track return
   * just the primary and take the unchanged single-sink path.
   */
  private async collectMixableAudioTracks(
    input: Input,
    primary: InputAudioTrack,
  ): Promise<InputAudioTrack[]> {
    let tracks: InputAudioTrack[]
    try {
      tracks = await input.getAudioTracks()
    } catch (error) {
      console.warn('[VideoExporter] Unable to list source audio tracks; using the primary.', error)
      return [primary]
    }

    const mixable: InputAudioTrack[] = [primary]
    let skipped = 0
    for (const track of tracks) {
      if (track === primary || track.id === primary.id) continue
      let decodable = false
      try {
        decodable = await track.canDecode()
      } catch {
        decodable = false
      }
      if (!decodable) {
        skipped += 1
        console.warn(
          `[VideoExporter] Skipping source audio track ${track.id}: codec ${track.codec ?? 'unknown'} cannot be decoded.`,
        )
        continue
      }
      if (track.sampleRate !== primary.sampleRate) {
        skipped += 1
        console.warn(
          `[VideoExporter] Skipping source audio track ${track.id}: sample rate ${track.sampleRate} differs from the primary track (${primary.sampleRate}).`,
        )
        continue
      }
      mixable.push(track)
    }

    if (skipped > 0) this.addWarning(EXPORT_WARNING_AUDIO_TRACKS_SKIPPED)
    if (this.sourceAudioStreamCount !== null && this.sourceAudioStreamCount !== tracks.length) {
      console.warn(
        `[VideoExporter] Demuxer reported ${this.sourceAudioStreamCount} audio stream(s) but the container lists ${tracks.length}.`,
      )
    }
    if (mixable.length > 1) {
      console.info(`[VideoExporter] Mixing ${mixable.length} source audio tracks`, {
        sampleRate: primary.sampleRate,
        channels: mixable.map((track) => track.numberOfChannels),
        skipped,
        demuxerAudioStreamCount: this.sourceAudioStreamCount,
      })
    }
    return mixable
  }

  /**
   * Source audio read for one time span, as `AudioBufferSink.buffers` would
   * deliver it. A single track is read straight from its sink; several tracks
   * are read in lockstep and summed by `mixTrackStreams` (see
   * `src/lib/audio/multiTrackMix.ts`), so the rest of the audio chain never
   * sees the difference.
   */
  private createSourceAudioReader(): (
    startSec: number,
    endSec: number,
  ) => AsyncIterable<SourceAudioBuffer> {
    const tracks =
      this.sourceAudioTracks.length > 1
        ? this.sourceAudioTracks
        : [this.sourceAudioTrack as InputAudioTrack]
    if (tracks.length === 1) {
      const sink = new AudioBufferSink(tracks[0])
      return (startSec, endSec) => sink.buffers(startSec, endSec)
    }

    const sinks = tracks.map((track) => new AudioBufferSink(track))
    const sampleRate = tracks[0].sampleRate
    const channels = resolveMixChannelCount(tracks.map((track) => track.numberOfChannels))
    return (startSec, endSec) =>
      this.mixedSourceAudioBuffers(sinks, startSec, endSec, sampleRate, channels)
  }

  private async *mixedSourceAudioBuffers(
    sinks: AudioBufferSink[],
    startSec: number,
    endSec: number,
    sampleRate: number,
    channels: 1 | 2,
  ): AsyncGenerator<SourceAudioBuffer, void, undefined> {
    const sources = sinks.map((sink) => planarChunksFromBuffers(sink.buffers(startSec, endSec)))
    const mixed = mixTrackStreams(sources, {
      sampleRate,
      channels,
      isCancelled: () => this.cancelled,
    })
    for await (const chunk of mixed) {
      const length = chunk.planes[0]?.length ?? 0
      if (length === 0) continue
      const buffer = new AudioBuffer({ length, numberOfChannels: channels, sampleRate })
      for (let channel = 0; channel < channels; channel += 1) {
        buffer.getChannelData(channel).set(chunk.planes[channel])
      }
      yield { buffer, timestamp: chunk.timestampSec, duration: length / sampleRate }
    }
  }

  private addWarning(warningKey: string): void {
    if (!warningKey) return
    this.warnings.add(warningKey)
  }

  private getWarnings(): string[] | undefined {
    const warnings = new Set(this.warnings)
    if (this.decoderFallbackActive) {
      warnings.add(EXPORT_WARNING_DECODER_FALLBACK)
    }
    if (warnings.size === 0) return undefined
    return Array.from(warnings)
  }

  private resolveDecodePath(): ExportDecodePath {
    if (this.decoderFallbackActive) return 'seek'
    const requested = this.config.decodePath ?? DEFAULT_EXPORT_DECODE_PATH
    if (requested === 'webcodecs' && typeof VideoDecoder === 'undefined') {
      console.warn('[VideoExporter] VideoDecoder is unavailable; using the seek decode path')
      return 'seek'
    }
    return requested
  }

  private reportPreparingProgress(copiedBytes: number, totalBytes: number): void {
    if (!this.config.onProgress) return
    this.progressTick += 1
    const now = Date.now()
    this.config.onProgress({
      currentFrame: 0,
      totalFrames: 0,
      percentage: totalBytes > 0 ? Math.min(100, (copiedBytes / totalBytes) * 100) : 0,
      estimatedTimeRemaining: 0,
      phase: 'preparing',
      updatedAtMs: now,
      elapsedMs: this.exportStartedAtMs > 0 ? Math.max(0, now - this.exportStartedAtMs) : 0,
      activityTick: this.progressTick,
      isHeartbeat: false,
    })
  }

  /**
   * Opens the source with the WebCodecs streaming decoder. Large local files
   * are copied into OPFS first (reported as the `'preparing'` phase). Any
   * failure here is converted into a `DecoderFallbackError` so `export()`
   * restarts on the seek path.
   */
  private async loadStreamingDecoderMetadata(): Promise<DecodedVideoInfo> {
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

  private createAudioSlice(
    sourceBuffer: AudioBuffer,
    startFrame: number,
    endFrame: number,
    gain: number,
    limiterLinear: number,
  ): AudioBuffer | null {
    const safeStart = Math.max(0, Math.min(startFrame, sourceBuffer.length))
    const safeEnd = Math.max(safeStart, Math.min(endFrame, sourceBuffer.length))
    const frameCount = safeEnd - safeStart

    if (frameCount <= 0) {
      return null
    }

    const sourceChannels = sourceBuffer.numberOfChannels
    const targetChannels = Math.min(sourceChannels, MAX_EXPORT_AUDIO_CHANNELS)

    const sliced = new AudioBuffer({
      length: frameCount,
      numberOfChannels: targetChannels,
      sampleRate: sourceBuffer.sampleRate,
    })

    let channelPlanes: Float32Array[]
    if (targetChannels !== sourceChannels) {
      // Multichannel capture (5.1/7.1 system audio): fold to stereo so the
      // AAC encoder never sees a 6/8-channel config it cannot encode.
      const sourcePlanes = Array.from({ length: sourceChannels }, (_, channel) =>
        sourceBuffer.getChannelData(channel).subarray(safeStart, safeEnd),
      )
      const downmixed = downmixPlanarChannelsForExport(sourcePlanes, targetChannels)
      channelPlanes = Array.from({ length: targetChannels }, (_, channel) =>
        downmixed.subarray(channel * frameCount, (channel + 1) * frameCount),
      )
    } else {
      channelPlanes = Array.from({ length: targetChannels }, (_, channel) =>
        sourceBuffer.getChannelData(channel).subarray(safeStart, safeEnd),
      )
    }

    for (let channel = 0; channel < targetChannels; channel += 1) {
      const source = channelPlanes[channel]
      const target = sliced.getChannelData(channel)

      if (gain === 1 && limiterLinear >= 0.9999) {
        target.set(source)
        continue
      }

      for (let i = 0; i < frameCount; i += 1) {
        const scaled = source[i] * gain
        target[i] = Math.max(-limiterLinear, Math.min(limiterLinear, scaled))
      }
    }

    return sliced
  }

  /**
   * Reads the source audio for each of `keptRanges` in order and hands the
   * visitor gain-annotated slices (audio-edit regions applied per slice).
   */
  private async forEachAudioFrameSlice(
    baseGain: number,
    keptRanges: TimeRangeMs[],
    visitor: (slice: AudioFrameSlice) => Promise<void> | void,
  ): Promise<void> {
    if (!this.sourceAudioTrack || this.sourceDurationMs <= 0 || this.cancelled) {
      return
    }

    if (keptRanges.length === 0) {
      return
    }

    const readBuffers = this.createSourceAudioReader()

    for (let rangeIndex = 0; rangeIndex < keptRanges.length; rangeIndex += 1) {
      const range = keptRanges[rangeIndex]
      if (this.cancelled) {
        break
      }

      const startSeconds = range.startMs / 1000
      const endSeconds = range.endMs / 1000
      const decodeStartSeconds = Math.max(0, startSeconds - 0.1)

      for await (const wrapped of readBuffers(decodeStartSeconds, endSeconds)) {
        if (this.cancelled) {
          return
        }

        const sourceBuffer = wrapped.buffer
        const bufferStartMs = wrapped.timestamp * 1000
        const bufferEndMs = bufferStartMs + wrapped.duration * 1000
        const clipStartMs = Math.max(bufferStartMs, range.startMs)
        const clipEndMs = Math.min(bufferEndMs, range.endMs)

        if (clipEndMs <= clipStartMs) {
          continue
        }

        const gainSegments = buildAudioGainSegments(
          clipStartMs,
          clipEndMs,
          baseGain,
          this.sourceAudioEditRegions,
        )
        const sampleRate = sourceBuffer.sampleRate

        for (const segment of gainSegments) {
          const startFrame = Math.floor(((segment.startMs - bufferStartMs) / 1000) * sampleRate)
          const endFrame = Math.ceil(((segment.endMs - bufferStartMs) / 1000) * sampleRate)
          if (endFrame <= startFrame) {
            continue
          }

          await visitor({
            sourceBuffer,
            startFrame,
            endFrame,
            gain: segment.gain,
            rangeIndex,
            sourceStartMs: bufferStartMs + (startFrame / sampleRate) * 1000,
          })
        }
      }
    }
  }

  private accumulateAudioEnergyStats(
    stats: AudioEnergyStats,
    sourceBuffer: AudioBuffer,
    startFrame: number,
    endFrame: number,
    gain: number,
  ): void {
    if (!Number.isFinite(gain) || gain <= 0) {
      return
    }

    const safeStart = Math.max(0, Math.min(startFrame, sourceBuffer.length))
    const safeEnd = Math.max(safeStart, Math.min(endFrame, sourceBuffer.length))
    if (safeEnd <= safeStart) {
      return
    }

    for (let channel = 0; channel < sourceBuffer.numberOfChannels; channel += 1) {
      const source = sourceBuffer.getChannelData(channel)
      for (let frame = safeStart; frame < safeEnd; frame += 1) {
        const sample = source[frame] * gain
        const absSample = Math.abs(sample)
        stats.peakAbs = Math.max(stats.peakAbs, absSample)
        stats.sumSquares += sample * sample
        stats.sampleCount += 1
      }
    }
  }

  private async exportAudioTrack(): Promise<void> {
    if (!this.sourceAudioTrack || !this.muxer || this.sourceDurationMs <= 0 || this.cancelled) {
      return
    }
    const muxer = this.muxer

    // Segments at 1x copy straight through; any other speed sends the whole
    // timeline through the WSOLA path so every segment is clamped to the frame
    // count the video path rendered for it.
    const timeline = this.audioTimeline
    const needsTimeStretch = timeline.some(
      (segment) => !isTimeStretchPassthroughSpeed(segment.speed),
    )
    const keptRanges: TimeRangeMs[] = needsTimeStretch
      ? timeline.map((segment) => ({
          startMs: segment.startSec * 1000,
          endMs: segment.endSec * 1000,
        }))
      : buildKeptRanges(this.sourceDurationMs, this.config.trimRegions)

    const baseGain = clampAudioGain(this.config.audioGain)
    const stats: AudioEnergyStats = {
      sampleCount: 0,
      sumSquares: 0,
      peakAbs: 0,
    }

    if (this.audioProcessing.normalizeLoudness) {
      await this.forEachAudioFrameSlice(baseGain, keptRanges, async (slice) => {
        this.accumulateAudioEnergyStats(
          stats,
          slice.sourceBuffer,
          slice.startFrame,
          slice.endFrame,
          slice.gain,
        )
      })
    }

    const normalization = resolveExportAudioNormalizationGain({
      stats,
      processing: this.audioProcessing,
    })
    const globalGain = normalization.appliedGain
    const limiterLinear = this.audioProcessing.limiterLinear

    if (!needsTimeStretch) {
      await this.forEachAudioFrameSlice(baseGain, keptRanges, async (slice) => {
        const sliceGain = slice.gain * globalGain
        const audioSlice = this.createAudioSlice(
          slice.sourceBuffer,
          slice.startFrame,
          slice.endFrame,
          sliceGain,
          limiterLinear,
        )
        if (!audioSlice) {
          return
        }
        await muxer.addAudioBuffer(audioSlice)
      })
      return
    }

    await this.exportTimeStretchedAudio(
      muxer,
      timeline,
      keptRanges,
      baseGain,
      globalGain,
      limiterLinear,
    )
  }

  /**
   * Offline, pitch-preserving audio for timelines with a non-1x segment.
   *
   * The slice pipeline (kept ranges -> audio-edit gain -> loudness gain +
   * limiter -> downmix in `createAudioSlice`) stays the source; each timeline
   * segment then owns one `WsolaTimeStretcher` whose output is clamped to the
   * exact sample budget of the frames the video path rendered for that segment
   * (padded with silence on underrun), collected through a `PlanarChunkQueue`
   * and handed to the muxer as fixed-size `AudioBuffer`s.
   */
  private async exportTimeStretchedAudio(
    muxer: VideoMuxer,
    timeline: SpeedTimelineSegment[],
    keptRanges: TimeRangeMs[],
    baseGain: number,
    globalGain: number,
    limiterLinear: number,
  ): Promise<void> {
    const frameRate = this.config.frameRate
    const frameCounts = buildVideoFrameCountsForTimeline(
      timeline,
      frameRate,
      this.audioTotalFrames,
      this.samplingMode === 'webcodecs' ? 'webcodecs' : 'seek',
    )

    // Output format is fixed by the first decoded slice.
    let sampleRate = 0
    let channels = 0
    let sampleBudget: number[] = []
    let outQueue: PlanarChunkQueue | null = null

    // Per-segment state.
    let openIndex = -1
    let nextIndex = 0
    let stretcher: WsolaTimeStretcher | null = null
    let segmentExpected = 0
    let segmentEmitted = 0

    const silencePlanes = (count: number): Float32Array[] =>
      Array.from({ length: channels }, () => new Float32Array(count))

    const flushOutput = async (drainAll: boolean): Promise<void> => {
      if (!outQueue) {
        return
      }
      while (
        !this.cancelled &&
        (outQueue.length >= TIME_STRETCH_OUTPUT_FRAMES || (drainAll && outQueue.length > 0))
      ) {
        const take = Math.min(TIME_STRETCH_OUTPUT_FRAMES, outQueue.length)
        const data = outQueue.take(take)
        const buffer = new AudioBuffer({ length: take, numberOfChannels: channels, sampleRate })
        for (let channel = 0; channel < channels; channel += 1) {
          buffer.getChannelData(channel).set(data.subarray(channel * take, (channel + 1) * take))
        }
        await muxer.addAudioBuffer(buffer)
      }
    }

    // Clamp each segment's emitted output to its budget (drops the WSOLA tail
    // overshoot) so cumulative A/V timing matches the retimed video.
    const emitStretched = (planes: Float32Array[]): void => {
      const produced = planes[0]?.length ?? 0
      const allowed = Math.max(0, segmentExpected - segmentEmitted)
      const take = Math.min(produced, allowed)
      outQueue?.push(planes, take)
      segmentEmitted += take
    }

    // Source-domain silence through the open stretcher (compressed by its speed).
    const feedSourceSilence = (count: number): void => {
      if (!stretcher) {
        return
      }
      let remaining = count
      while (remaining > 0) {
        const n = Math.min(TIME_STRETCH_SILENCE_CHUNK_FRAMES, remaining)
        emitStretched(stretcher.push(silencePlanes(n)))
        remaining -= n
      }
    }

    const startSegment = (index: number): void => {
      openIndex = index
      nextIndex = index + 1
      segmentExpected = sampleBudget[index] ?? 0
      segmentEmitted = 0
      stretcher = new WsolaTimeStretcher({
        sampleRate,
        channels,
        speed: timeline[index].speed,
        expectedOutputSamples: segmentExpected,
      })
    }

    const finalizeSegment = (): void => {
      if (!stretcher) {
        return
      }
      emitStretched(stretcher.flush())
      // Pad the deficit with silence when WSOLA under-fills a short high-speed
      // segment (or the source ran out) so the segment keeps its exact length.
      if (segmentEmitted < segmentExpected) {
        const pad = segmentExpected - segmentEmitted
        outQueue?.push(silencePlanes(pad), pad)
        segmentEmitted += pad
      }
      stretcher = null
    }

    await this.forEachAudioFrameSlice(baseGain, keptRanges, async (slice) => {
      if (this.cancelled) {
        return
      }
      if (sampleRate === 0) {
        sampleRate = slice.sourceBuffer.sampleRate
        channels = Math.min(slice.sourceBuffer.numberOfChannels, MAX_EXPORT_AUDIO_CHANNELS)
        sampleBudget = buildAudioSegmentSampleBudget(frameCounts, frameRate, sampleRate)
        outQueue = new PlanarChunkQueue(channels)
      }

      const index = slice.rangeIndex
      if (stretcher && openIndex !== index) {
        finalizeSegment()
      }
      // Segments the source never reached (a gap in the audio track) are pure silence.
      while (nextIndex < index) {
        startSegment(nextIndex)
        finalizeSegment()
      }
      if (!stretcher) {
        startSegment(index)
        // A source whose first sample lands after the segment start (codec
        // priming, or an audio track that starts after the video) keeps its
        // true source-time position: fill the head with silence, as the video
        // path holds its first frame over the same span.
        const headGapMs = slice.sourceStartMs - keptRanges[index].startMs
        const headGapFrames = Math.round((headGapMs / 1000) * sampleRate)
        if (headGapFrames > 0) {
          feedSourceSilence(headGapFrames)
        }
      }

      const audioSlice = this.createAudioSlice(
        slice.sourceBuffer,
        slice.startFrame,
        slice.endFrame,
        slice.gain * globalGain,
        limiterLinear,
      )
      if (!audioSlice || !stretcher) {
        return
      }
      const planes = Array.from({ length: channels }, (_, channel) =>
        audioSlice.getChannelData(Math.min(channel, audioSlice.numberOfChannels - 1)),
      )
      emitStretched(stretcher.push(planes))
      await flushOutput(false)
    })

    if (this.cancelled || sampleRate === 0) {
      return
    }

    // Close the segment still open at end-of-stream, then pad any segment that
    // never received audio (source shorter than the timeline) with silence.
    finalizeSegment()
    while (nextIndex < timeline.length) {
      startSegment(nextIndex)
      finalizeSegment()
    }
    await flushOutput(true)
  }

  /**
   * Runs the export, retrying with the next encoder configuration when the
   * encoder itself fails (`ExportEncoderError`) — the next hardware preference
   * first, then H.264 when the requested codec was something else — and
   * re-running on the seek decode path when the WebCodecs decoder fails before
   * its first frame.
   */
  async export(): Promise<ExportResult> {
    this.decoderFallbackActive = false
    this.platform = await getPlatform()

    // No edit touches pixels or audio: hand the source file over as-is.
    const sourceCopy = await this.trySourceCopyFastPath()
    if (sourceCopy) return sourceCopy

    const attempts = buildEncoderAttempts(this.config.codec, this.platform)
    let lastError: unknown = null

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]
      this.activeCodec = attempt.codec
      try {
        const result = await this.runExportAttemptWithDecoderFallback(attempt.hardwareAcceleration)
        // Only a finished file has an encoder worth reporting; a cancellation
        // returns from the same call and must stay the bare result it is.
        if (!result.success) return result
        return {
          ...result,
          encoder: {
            codec: attempt.codec,
            hardwareAcceleration: attempt.hardwareAcceleration,
            retried: index > 0,
            usedSoftwareFallback: index > 0 && attempt.hardwareAcceleration === 'prefer-software',
            codecFellBack: attempt.codecFellBack,
          },
        }
      } catch (error) {
        lastError = error
        if (this.cancelled) {
          return { success: false, error: 'Export cancelled' }
        }
        const nextAttempt = attempts[index + 1]
        if (!(error instanceof ExportEncoderError) || !nextAttempt) {
          return this.toFailureResult(error)
        }
        console.warn(
          `[VideoExporter] ${attempt.codec} / ${attempt.hardwareAcceleration} export attempt failed; ` +
            `retrying with ${nextAttempt.codec} / ${nextAttempt.hardwareAcceleration}.`,
          error,
        )
      }
    }

    return this.toFailureResult(lastError ?? new Error('Export failed'))
  }

  private reportCopyingProgress(percentage: number): void {
    if (!this.config.onProgress) return
    this.progressTick += 1
    const now = Date.now()
    this.config.onProgress({
      currentFrame: percentage >= 100 ? 1 : 0,
      totalFrames: 1,
      percentage: Math.max(0, Math.min(100, percentage)),
      estimatedTimeRemaining: 0,
      phase: 'copying',
      updatedAtMs: now,
      elapsedMs: this.exportStartedAtMs > 0 ? Math.max(0, now - this.exportStartedAtMs) : 0,
      activityTick: this.progressTick,
      isHeartbeat: false,
    })
  }

  /**
   * Opens the source with mediabunny for the container/track probe. The
   * `UrlSource` reads only the bytes the demuxer asks for; when it cannot be
   * used the whole file is read (bounded by the in-memory limit) and reused as
   * the copy result.
   */
  private async probeSourceForCopy(): Promise<{ probe: SourceCopyProbe; blob: Blob | null }> {
    let input: Input | null = null
    try {
      input = await this.openSourceInputFromUrl()
      return { probe: await probeSourceCopyCandidate(input), blob: null }
    } catch (urlError) {
      input?.dispose()
      input = null
      console.warn(
        '[VideoExporter] Unable to probe the source via UrlSource for the fast path. Retrying with BlobSource.',
        urlError,
      )
      const blob = await loadLocalSourceBlob(this.config.videoUrl)
      if (!blob) throw new Error('source is too large to read in memory')
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
      return { probe: await probeSourceCopyCandidate(input), blob }
    } finally {
      input?.dispose()
    }
  }

  /**
   * Source-copy fast path. Returns the finished export when the configuration
   * has no blockers, the file is a plain MP4 (H.264/HEVC/AV1 + at most one
   * AAC/Opus track) at exactly the planned output size, and it fits the
   * in-memory read limit; `null` otherwise, in which case the caller renders.
   */
  private async trySourceCopyFastPath(): Promise<ExportResult | null> {
    const blockers = getSourceCopyFastPathBlockers(this.config)
    if (blockers.length > 0) {
      console.info('[VideoExporter] source-copy fast path disabled', { blockers })
      return null
    }
    if (typeof window === 'undefined' || !window.electronAPI?.readBinaryFile) {
      console.info('[VideoExporter] source-copy fast path disabled', {
        blockers: ['local file access is unavailable'],
      })
      return null
    }

    this.exportStartedAtMs = Date.now()
    this.progressTick = 0
    try {
      const { probe, blob: probedBlob } = await this.probeSourceForCopy()
      const probeBlockers = getSourceCopyProbeBlockers(probe, {
        width: this.config.width,
        height: this.config.height,
      })
      if (probeBlockers.length > 0) {
        console.info('[VideoExporter] source-copy fast path disabled', {
          blockers: probeBlockers,
          source: probe,
        })
        return null
      }
      if (this.cancelled) return { success: false, error: 'Export cancelled' }

      this.reportCopyingProgress(0)
      const blob = probedBlob ?? (await loadLocalSourceBlob(this.config.videoUrl))
      if (!blob) {
        console.info('[VideoExporter] source-copy fast path disabled', {
          blockers: ['source is too large to read in memory'],
        })
        return null
      }
      if (this.cancelled) return { success: false, error: 'Export cancelled' }
      this.reportCopyingProgress(100)

      console.info('[VideoExporter] source-copy fast path used: source copied verbatim', {
        source: probe,
        bytes: blob.size,
        elapsedMs: Date.now() - this.exportStartedAtMs,
      })
      return {
        success: true,
        blob: blob.type ? blob : new Blob([blob], { type: 'video/mp4' }),
        sourceCopy: true,
      }
    } catch (error) {
      if (this.cancelled) return { success: false, error: 'Export cancelled' }
      console.warn(
        '[VideoExporter] source-copy fast path probe failed; using the render pipeline.',
        error,
      )
      return null
    }
  }

  private async runExportAttemptWithDecoderFallback(
    encoderPreference: HardwareAcceleration,
  ): Promise<ExportResult> {
    try {
      return await this.runExportAttempt(encoderPreference)
    } catch (error) {
      if (error instanceof DecoderFallbackError && !this.cancelled) {
        console.warn(
          '[VideoExporter] WebCodecs decode path failed before the first frame; retrying on the seek path.',
          error.cause,
        )
        this.decoderFallbackActive = true
        return await this.runExportAttempt(encoderPreference)
      }
      throw error
    }
  }

  private toFailureResult(error: unknown): ExportResult {
    if (isBackgroundLoadError(error)) {
      // Not retryable: the background will not load on a second attempt either.
      console.error('Export error: background failed to load:', error.displayUrl)
      return {
        success: false,
        error: error.message,
        errorKind: 'background-load',
        backgroundUrl: error.displayUrl,
      }
    }
    console.error('Export error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorKind: classifyExportError(error),
    }
  }

  /**
   * One full export pass. Throws on failure (the caller maps errors to an
   * `ExportResult`); returns a cancelled result when `cancel()` was called.
   */
  private async runExportAttempt(encoderPreference: HardwareAcceleration): Promise<ExportResult> {
    try {
      this.cleanup()
      this.cancelled = false
      this.muxingError = null
      this.fatalEncoderError = null
      this.encoderPreference = encoderPreference
      this.exportStartedAtMs = Date.now()
      this.progressTick = 0
      this.lastRenderingFrameCount = 0
      this.lastThroughputLogAtMs = this.exportStartedAtMs
      this.seekCount = 0
      this.maxObservedTimingDriftMs = 0
      this.samplingMode = 'seek-only'
      this.sourceDurationMs = 0
      this.sourceAudioEditRegions = []
      this.audioTimeline = []
      this.audioTotalFrames = 0
      this.warnings.clear()

      this.platform = await getPlatform()
      const decodePath = this.resolveDecodePath()
      this.samplingMode = decodePath === 'webcodecs' ? 'webcodecs' : 'seek-only'
      let videoInfo: { width: number; height: number; duration: number }
      this.sourceAudioStreamCount = null
      if (decodePath === 'webcodecs') {
        const metadata = await this.loadStreamingDecoderMetadata()
        this.sourceAudioStreamCount = metadata.audioStreamCount
        videoInfo = metadata
      } else {
        this.decoder = new VideoFileDecoder()
        try {
          videoInfo = await this.decoder.loadVideo(this.config.videoUrl)
        } catch (error) {
          if (this.cancelled) throw error
          throw new ExportDecoderError(error)
        }
      }
      this.sourceDurationMs = resolveSourceDurationMs(
        videoInfo.duration,
        this.config.sourceDurationMs,
      )
      if (this.sourceDurationMs !== Math.max(0, videoInfo.duration * 1000)) {
        console.warn(
          '[VideoExporter] Using probed source duration',
          this.sourceDurationMs,
          'ms instead of',
          videoInfo.duration,
          's',
        )
      }
      this.sourceTrimRanges = normalizeTrimRanges(this.config.trimRegions, this.sourceDurationMs)
      this.sourceAudioEditRegions = normalizeAudioEditRegions(
        this.config.audioEditRegions,
        this.sourceDurationMs,
      )
      let hasSourceAudio = await this.resolveSourceAudioTrack()
      if (this.config.audioEnabled && !hasSourceAudio) {
        this.addWarning(EXPORT_WARNING_AUDIO_TRACK_UNAVAILABLE)
      }

      // MP4 audio needs AAC or, when that encoder is missing (e.g. Chromium on
      // Linux without proprietary codecs), Opus. Only when neither is available
      // is the audio dropped with a warning.
      this.audioCodec = 'aac'
      if (hasSourceAudio) {
        const selectedCodec = await selectExportAudioCodec()
        if (!selectedCodec) {
          console.warn(
            '[VideoExporter] Neither AAC nor Opus audio encoding is supported on this system, exporting without audio',
          )
          hasSourceAudio = false
          this.sourceAudioTrack = null
          this.addWarning(EXPORT_WARNING_AUDIO_CODEC_UNSUPPORTED)
        } else {
          this.audioCodec = selectedCodec
          if (selectedCodec !== 'aac') {
            console.info(
              `[VideoExporter] AAC encoder unavailable, using ${selectedCodec} audio in MP4`,
            )
          }
        }
      }

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
        platform: this.platform,
        legacyCompositor: this.config.legacyCompositor,
      })
      await this.renderer.initialize()

      await this.initializeEncoder(encoderPreference)

      this.muxer = new VideoMuxer(this.config, hasSourceAudio, this.audioCodec)
      await this.muxer.initialize()

      const videoElement = this.decoder?.getVideoElement() ?? null
      if (!this.streamingDecoder && !videoElement) {
        throw new Error('Video element not available')
      }

      let decodePlan: DecodeTimelinePlan | null = null
      let effectiveDuration: number
      let totalFrames: number
      if (this.streamingDecoder) {
        // The decoder emits an exact per-segment frame count; take it from the
        // same trim/speed regions decodeAll() will consume so both agree.
        decodePlan = buildDecodeTimelinePlan({
          segments: this.config.segments,
          trimRegions: this.config.trimRegions,
          playbackSpeed: this.config.playbackSpeed,
          sourceDurationMs: this.sourceDurationMs,
          decoderDurationSec: videoInfo.duration,
        })
        const metrics = this.streamingDecoder.getExportMetrics(
          this.config.frameRate,
          decodePlan.trimRegions,
          decodePlan.speedRegions,
        )
        effectiveDuration = metrics.effectiveDuration
        totalFrames = metrics.totalFrames
      } else {
        effectiveDuration = this.getEffectiveDuration(this.sourceDurationMs / 1000)
        totalFrames = Math.ceil(effectiveDuration * this.config.frameRate)
      }

      // The audio path retimes itself against the same kept-span timeline and
      // the same frame count the video path renders, so A/V never drift.
      this.audioTimeline =
        decodePlan?.segments ??
        segmentsToSpeedTimeline(
          this.config.segments,
          this.config.trimRegions,
          this.sourceDurationMs / 1000,
          this.config.playbackSpeed,
        )
      this.audioTotalFrames = totalFrames

      console.log(
        '[VideoExporter] Original duration:',
        videoInfo.duration,
        's (using',
        this.sourceDurationMs / 1000,
        's)',
      )
      console.log('[VideoExporter] Effective duration:', effectiveDuration, 's')
      console.log('[VideoExporter] Total frames to export:', totalFrames)
      console.log('[VideoExporter] Decode path:', this.samplingMode)

      let frameIndex = 0
      if (isExportAudioDebugEnabled()) {
        console.log('[ExportAudioDebug][VideoExporter] mode decision', {
          mode: this.samplingMode,
          audioEnabled: this.config.audioEnabled,
        })
      }
      if (this.streamingDecoder && decodePlan) {
        frameIndex = await this.exportFramesByDecoding(
          this.streamingDecoder,
          decodePlan,
          totalFrames,
        )
      } else if (videoElement) {
        frameIndex = await this.exportFramesBySeeking(videoElement, totalFrames, frameIndex)
      }

      if (frameIndex < totalFrames && !this.cancelled) {
        if (this.streamingDecoder) {
          // The streaming decoder already reported the short decode as a
          // warning: the export is slightly shorter, not failed. Only a decoder
          // that delivered nothing is treated as fatal.
          console.warn(
            `[VideoExporter] Streaming decode ended early: rendered ${frameIndex} of ${totalFrames} frames.`,
          )
          this.addWarning(EXPORT_WARNING_DECODE_ENDED_EARLY)
        } else {
          throw new Error(`Export ended early: rendered ${frameIndex} of ${totalFrames} frames.`)
        }
      }

      if (this.fatalEncoderError) {
        throw this.fatalEncoderError
      }

      if (this.cancelled) {
        if (this.muxingError) {
          throw this.muxingError
        }
        return { success: false, error: 'Export cancelled' }
      }

      this.startFinalizingHeartbeat(totalFrames, totalFrames, 'dialogs.export.finalize.flush')

      // Run encoder flush and audio extraction in parallel — they're independent.
      // Audio extraction reads the source file while encoder flushes its queue.
      const audioPromise = hasSourceAudio
        ? withTimeout(this.exportAudioTrack(), this.FINALIZE_TIMEOUT_MS, 'audio encode')
        : Promise.resolve()

      if (this.encoder && this.encoder.state === 'configured') {
        await this.runFinalizingStep('dialogs.export.finalize.flush', this.flushEncoder())
      }

      if (this.fatalEncoderError) {
        throw this.fatalEncoderError
      }

      await this.runFinalizingStep(
        'dialogs.export.finalize.mux',
        withTimeout(this.waitForMuxDrain(), this.FINALIZE_TIMEOUT_MS, 'mux drain'),
      )

      if (hasSourceAudio) {
        await this.runFinalizingStep('dialogs.export.finalize.audio', audioPromise)
      }

      const blob = await this.runFinalizingStep(
        'dialogs.export.finalize.package',
        withTimeout(this.muxer!.finalize(), this.FINALIZE_TIMEOUT_MS, 'mux finalize'),
      )
      this.stopFinalizingHeartbeat()

      const totalElapsedMs = Date.now() - this.exportStartedAtMs
      console.log('[VideoExporter] Export complete', {
        totalFrames,
        totalElapsedMs,
        avgRenderFps:
          totalElapsedMs > 0 ? Number(((totalFrames * 1000) / totalElapsedMs).toFixed(2)) : 0,
        samplingMode: this.samplingMode,
        seekCount: this.seekCount,
        maxObservedTimingDriftMs: Number(this.maxObservedTimingDriftMs.toFixed(2)),
        audioTracksMixed: this.sourceAudioTracks.length,
        demuxerAudioStreamCount: this.sourceAudioStreamCount,
      })

      return { success: true, blob, warnings: this.getWarnings() }
    } finally {
      this.cleanup()
    }
  }

  /**
   * Final `VideoEncoder.flush()` with a hard timeout. A hardware encoder that
   * never drains is reported as an encoder failure so `export()` can retry
   * with the next preference instead of hanging for the 120 s finalize budget.
   */
  private async flushEncoder(): Promise<void> {
    if (!this.encoder || this.encoder.state !== 'configured') return
    const stalledMessage =
      this.encoderPreference === 'prefer-hardware'
        ? EXPORT_ERROR_MESSAGES.encoderFlushTimeoutHardware
        : EXPORT_ERROR_MESSAGES.encoderFlushTimeoutSoftware
    try {
      await withTimeout(this.encoder.flush(), ENCODER_FLUSH_TIMEOUT_MS, 'encoder flush')
    } catch (error) {
      if (this.fatalEncoderError) throw this.fatalEncoderError
      if (this.cancelled) return
      const timedOut = error instanceof Error && /timed out/.test(error.message)
      if (timedOut) throw new ExportEncoderError(stalledMessage, error, 'encoder-flush-timeout')
      throw new ExportEncoderError(
        `${EXPORT_ERROR_MESSAGE_PREFIXES.encoderFlushFailed}${error instanceof Error ? error.message : String(error)}`,
        error,
        'encoder-failed',
      )
    }
  }

  /**
   * WebCodecs frame export: `StreamingVideoDecoder.decodeAll` walks the source
   * once and hands over one `VideoFrame` per output frame (already resampled to
   * the target frame rate and routed through the trim/speed plan). Each frame
   * goes through the same `renderAndEncodeFrame` as the seek path. No media
   * element is involved, so the silent-export guarantee holds by construction.
   */
  private async exportFramesByDecoding(
    streamingDecoder: StreamingVideoDecoder,
    plan: DecodeTimelinePlan,
    totalFrames: number,
  ): Promise<number> {
    let frameIndex = 0
    let callbackError: unknown = null

    try {
      await streamingDecoder.decodeAll(
        this.config.frameRate,
        plan.trimRegions,
        plan.speedRegions,
        async (videoFrame, _exportTimestampUs, sourceTimestampMs) => {
          try {
            if (this.cancelled || frameIndex >= totalFrames) {
              return
            }
            await this.renderAndEncodeFrame(videoFrame, frameIndex, totalFrames, sourceTimestampMs)
            frameIndex++
          } catch (error) {
            callbackError = callbackError ?? error
            streamingDecoder.cancel()
            throw error
          } finally {
            videoFrame.close()
          }
        },
        (message) => {
          console.warn('[VideoExporter] Streaming decoder warning:', message)
          this.addWarning(EXPORT_WARNING_DECODE_ENDED_EARLY)
        },
      )
    } catch (error) {
      if (callbackError) {
        // Render/encode failure, not a decoder failure: never fall back.
        throw callbackError
      }
      if (frameIndex === 0 && !this.cancelled) {
        throw new DecoderFallbackError(error)
      }
      if (this.cancelled) throw error
      // Frames were already delivered: too late to fall back, the decoder failure ends the export.
      throw new ExportDecoderError(error)
    }

    if (frameIndex === 0 && totalFrames > 0 && !this.cancelled) {
      throw new DecoderFallbackError(new Error('Streaming decoder delivered no frames'))
    }

    return frameIndex
  }

  private getSourceTimeMsForFrame(frameIndex: number): number {
    const outputTimeStepMs = 1000 / this.config.frameRate
    const outputTimeMs = frameIndex * outputTimeStepMs

    // Use segment-aware mapping if segments are provided
    if (this.config.segments?.length) {
      return effectiveToSourceMsWithSegments(outputTimeMs, this.config.segments)
    }

    const speed = Math.max(0.25, this.config.playbackSpeed ?? 1)
    // Output time advances at 1/speed rate through effective timeline
    const effectiveTimeMs = outputTimeMs * speed
    return this.mapEffectiveToSourceTime(effectiveTimeMs)
  }

  private updateProgress(
    currentFrame: number,
    totalFrames: number,
    phase: ExportProgress['phase'] = 'rendering',
    phaseDetailKey?: string,
    isHeartbeat = false,
  ): void {
    if (!this.config.onProgress) return
    this.progressTick += 1

    const now = Date.now()
    const elapsedMs = this.exportStartedAtMs > 0 ? Math.max(0, now - this.exportStartedAtMs) : 0
    const estimatedTimeRemaining =
      phase === 'rendering' ? estimateRemainingSeconds(currentFrame, totalFrames, elapsedMs) : 0

    this.config.onProgress({
      currentFrame,
      totalFrames,
      percentage: totalFrames > 0 ? (currentFrame / totalFrames) * 100 : 100,
      estimatedTimeRemaining,
      phase,
      phaseDetailKey,
      updatedAtMs: now,
      elapsedMs,
      activityTick: this.progressTick,
      isHeartbeat,
    })
  }

  private getKeyFrameIntervalFrames(): number {
    // Use ~4-second keyframe interval for better encoding efficiency.
    // Shorter intervals (2.5s) cause more I-frames and reduce compression
    // throughput with negligible quality benefit at our bitrates.
    return Math.max(1, Math.round(this.config.frameRate * 4))
  }

  private startFinalizingHeartbeat(
    currentFrame: number,
    totalFrames: number,
    phaseDetailKey: string,
  ): void {
    this.stopFinalizingHeartbeat()
    this.finalizingCurrentFrame = currentFrame
    this.finalizingTotalFrames = totalFrames
    this.finalizingDetailKey = phaseDetailKey
    this.updateProgress(currentFrame, totalFrames, 'finalizing', phaseDetailKey, false)

    this.finalizingHeartbeatTimer = globalThis.setInterval(() => {
      this.updateProgress(
        this.finalizingCurrentFrame,
        this.finalizingTotalFrames,
        'finalizing',
        this.finalizingDetailKey,
        true,
      )
    }, 1000)
  }

  private stopFinalizingHeartbeat(): void {
    if (this.finalizingHeartbeatTimer !== null) {
      globalThis.clearInterval(this.finalizingHeartbeatTimer)
      this.finalizingHeartbeatTimer = null
    }
  }

  private async runFinalizingStep<T>(phaseDetailKey: string, operation: Promise<T>): Promise<T> {
    this.finalizingDetailKey = phaseDetailKey
    this.updateProgress(
      this.finalizingCurrentFrame,
      this.finalizingTotalFrames,
      'finalizing',
      phaseDetailKey,
      false,
    )
    return operation
  }

  private async renderAndEncodeFrame(
    videoSource: HTMLVideoElement | VideoFrame,
    frameIndex: number,
    totalFrames: number,
    sampledFrameTimeMs: number,
    effectTimeMs = sampledFrameTimeMs,
  ): Promise<void> {
    if (this.fatalEncoderError) {
      throw this.fatalEncoderError
    }

    const timestamp = frameIndexToTimestampUs(frameIndex, this.config.frameRate)
    const duration = frameDurationUs(frameIndex, this.config.frameRate)

    await this.renderer!.renderFrame(videoSource, Math.round(sampledFrameTimeMs * 1000), {
      effectTimeMs,
    })

    const canvas = this.renderer!.getCanvas()

    let exportFrame: VideoFrame
    if (this.platform === 'linux') {
      // On some Linux systems the GPU shared-image path (EGL/Ozone) fails
      // silently, producing empty frames, so build the frame from a CPU readback.
      const canvasCtx = canvas.getContext('2d')
      if (!canvasCtx) {
        throw new Error('Composite canvas 2D context unavailable')
      }
      const imageData = canvasCtx.getImageData(0, 0, canvas.width, canvas.height)
      exportFrame = new VideoFrame(imageData.data.buffer, {
        format: 'RGBA',
        codedWidth: canvas.width,
        codedHeight: canvas.height,
        timestamp,
        duration,
        colorSpace: {
          primaries: 'bt709',
          transfer: 'iec61966-2-1',
          matrix: 'rgb',
          fullRange: true,
        },
      })
    } else {
      // @ts-expect-error - colorSpace is not in TypeScript's VideoFrameInit yet but works at runtime.
      exportFrame = new VideoFrame(canvas, {
        timestamp,
        duration,
        colorSpace: {
          primaries: 'bt709',
          transfer: 'iec61966-2-1',
          matrix: 'rgb',
          fullRange: true,
        },
      })
    }

    try {
      await waitForEncoderQueueSpace({
        getQueueSize: () => this.encodeQueue,
        maxEncodeQueue: this.maxEncodeQueue,
        isCancelled: () => this.cancelled || this.fatalEncoderError !== null,
        encoderPreference: this.encoderPreference,
      })
    } catch (error) {
      exportFrame.close()
      throw new ExportEncoderError(
        error instanceof Error ? error.message : String(error),
        error,
        'encoder-stall',
      )
    }

    if (this.fatalEncoderError) {
      exportFrame.close()
      throw this.fatalEncoderError
    }

    if (this.encoder && this.encoder.state === 'configured') {
      this.encodeQueue++
      this.encoder.encode(exportFrame, {
        keyFrame: frameIndex % this.getKeyFrameIntervalFrames() === 0,
      })
    } else {
      console.warn(`[Frame ${frameIndex}] Encoder not ready! State: ${this.encoder?.state}`)
    }

    exportFrame.close()
    this.updateProgress(frameIndex + 1, totalFrames)

    const now = Date.now()
    if (now - this.lastThroughputLogAtMs >= 1000) {
      const frameDelta = frameIndex + 1 - this.lastRenderingFrameCount
      const msDelta = now - this.lastThroughputLogAtMs
      const renderFps = msDelta > 0 ? (frameDelta * 1000) / msDelta : 0
      console.log(
        `[VideoExporter] Throughput: frame ${frameIndex + 1}/${totalFrames} | ${Number(renderFps.toFixed(1))} fps | elapsed ${Math.round((now - this.exportStartedAtMs) / 1000)}s`,
      )
      this.lastRenderingFrameCount = frameIndex + 1
      this.lastThroughputLogAtMs = now
    }
  }

  private async seekVideoTo(
    videoElement: HTMLVideoElement,
    targetTimeSeconds: number,
  ): Promise<void> {
    const safeDuration = Number.isFinite(videoElement.duration)
      ? videoElement.duration
      : targetTimeSeconds + 1
    const epsilon = 1 / Math.max(this.config.frameRate, 30)
    const clampedTime = Math.max(
      0,
      Math.min(targetTimeSeconds, Math.max(0, safeDuration - epsilon)),
    )

    if (!shouldSeekToTime(videoElement.currentTime, clampedTime, this.config.frameRate)) {
      await this.waitForVideoFrame(videoElement)
      return
    }

    const seekedPromise = new Promise<void>((resolve) => {
      videoElement.addEventListener('seeked', () => resolve(), { once: true })
    })
    this.seekCount += 1
    videoElement.currentTime = clampedTime
    await seekedPromise
    await this.waitForVideoFrame(videoElement)
  }

  /**
   * Pipelined frame export: overlaps seek I/O with render+encode work.
   *
   * Instead of the sequential seek→wait→render→encode per frame, we start
   * the seek for the *next* frame while the current frame is being rendered
   * and encoded.  On typical hardware this hides 50-80% of seek latency,
   * yielding ~2-3× throughput improvement.
   */
  private async exportFramesBySeeking(
    videoElement: HTMLVideoElement,
    totalFrames: number,
    startFrameIndex = 0,
  ): Promise<number> {
    if (isExportAudioDebugEnabled()) {
      console.log('[ExportAudioDebug][VideoExporter] exportFramesBySeeking start', {
        totalFrames,
        startFrameIndex,
        initialPaused: videoElement.paused,
        initialMuted: videoElement.muted,
        initialVolume: videoElement.volume,
      })
    }
    let frameIndex = startFrameIndex

    // --- Seek to the first frame and wait ---
    if (frameIndex < totalFrames && !this.cancelled) {
      const firstTargetMs = this.getSourceTimeMsForFrame(frameIndex)
      await this.seekVideoTo(videoElement, firstTargetMs / 1000)
    }

    while (frameIndex < totalFrames && !this.cancelled) {
      const targetSourceTimeMs = this.getSourceTimeMsForFrame(frameIndex)
      const sampledFrameTimeMs = Math.max(0, videoElement.currentTime * 1000)
      this.maxObservedTimingDriftMs = Math.max(
        this.maxObservedTimingDriftMs,
        Math.abs(sampledFrameTimeMs - targetSourceTimeMs),
      )

      // --- Pipeline: start seeking to the NEXT frame while we render the current one ---
      const nextFrameIndex = frameIndex + 1
      let nextSeekPromise: Promise<void> | null = null
      if (nextFrameIndex < totalFrames && !this.cancelled) {
        const nextTargetMs = this.getSourceTimeMsForFrame(nextFrameIndex)
        nextSeekPromise = this.seekVideoToNonBlocking(videoElement, nextTargetMs / 1000)
      }

      // Render + encode current frame (CPU work overlaps with seek I/O)
      await this.renderAndEncodeFrame(
        videoElement,
        frameIndex,
        totalFrames,
        sampledFrameTimeMs,
        targetSourceTimeMs,
      )

      // Wait for the prefetched seek to complete before processing next frame
      if (nextSeekPromise) {
        await nextSeekPromise
      }

      frameIndex++
    }

    return frameIndex
  }

  /**
   * Non-blocking seek that starts the seek operation and returns a promise.
   * Does NOT wait for requestVideoFrameCallback — the caller should await
   * the returned promise only when it needs the frame data.
   */
  private seekVideoToNonBlocking(
    videoElement: HTMLVideoElement,
    targetTimeSeconds: number,
  ): Promise<void> {
    const safeDuration = Number.isFinite(videoElement.duration)
      ? videoElement.duration
      : targetTimeSeconds + 1
    const epsilon = 1 / Math.max(this.config.frameRate, 30)
    const clampedTime = Math.max(
      0,
      Math.min(targetTimeSeconds, Math.max(0, safeDuration - epsilon)),
    )

    if (!shouldSeekToTime(videoElement.currentTime, clampedTime, this.config.frameRate)) {
      // Already close enough — just wait for the frame to be ready
      return this.waitForVideoFrame(videoElement)
    }

    const seekedPromise = new Promise<void>((resolve) => {
      videoElement.addEventListener('seeked', () => resolve(), { once: true })
    })
    this.seekCount += 1
    videoElement.currentTime = clampedTime

    // Return a promise that resolves after both seek and frame are ready
    return seekedPromise.then(() => this.waitForVideoFrame(videoElement))
  }

  private enqueueMuxOperation(task: () => Promise<void>): void {
    this.muxingChain = this.muxingChain.then(async () => {
      if (this.muxingError || this.cancelled) {
        return
      }

      try {
        await task()
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        if (!this.muxingError) {
          this.muxingError = normalized
        }
        this.cancelled = true
      }
    })
  }

  private async waitForMuxDrain(): Promise<void> {
    await this.muxingChain
    if (this.muxingError) {
      throw this.muxingError
    }
  }

  private async initializeEncoder(hardwareAcceleration: HardwareAcceleration): Promise<void> {
    this.encodeQueue = 0
    this.muxingChain = Promise.resolve()
    this.muxingError = null
    this.chunkCount = 0
    this.fatalEncoderError = null
    this.encoderPreference = hardwareAcceleration
    this.maxEncodeQueue =
      hardwareAcceleration === 'prefer-software'
        ? Math.min(this.MAX_ENCODE_QUEUE, SOFTWARE_ENCODER_MAX_QUEUE)
        : this.MAX_ENCODE_QUEUE
    let videoDescription: Uint8Array | undefined

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !videoDescription) {
          const desc = meta.decoderConfig.description
          videoDescription = new Uint8Array(desc instanceof ArrayBuffer ? desc : (desc as any))
          this.videoDescription = videoDescription
        }

        if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
          this.videoColorSpace = meta.decoderConfig.colorSpace
        }

        const isFirstChunk = this.chunkCount === 0
        this.chunkCount++

        this.enqueueMuxOperation(async () => {
          if (isFirstChunk && this.videoDescription) {
            const colorSpace = this.videoColorSpace || {
              primaries: 'bt709',
              transfer: 'iec61966-2-1',
              matrix: 'rgb',
              fullRange: true,
            }

            const metadata: EncodedVideoChunkMetadata = {
              decoderConfig: {
                codec: this.activeCodec || this.config.codec || DEFAULT_EXPORT_CODEC,
                codedWidth: this.config.width,
                codedHeight: this.config.height,
                description: this.videoDescription,
                colorSpace,
              },
            }

            await this.muxer!.addVideoChunk(chunk, metadata)
            return
          }

          await this.muxer!.addVideoChunk(chunk, meta)
        })

        this.encodeQueue = Math.max(0, this.encodeQueue - 1)
      },
      error: (error) => {
        console.error('[VideoExporter] Encoder error:', error)
        // Do not mark the export as cancelled: the failure surfaces at the next
        // frame / flush as an ExportEncoderError so export() can retry with the
        // next encoder preference. The decoder is stopped so it does not keep
        // producing frames for a dead encoder.
        if (!this.fatalEncoderError) {
          this.fatalEncoderError = new ExportEncoderError(
            `${EXPORT_ERROR_MESSAGE_PREFIXES.encoderFailed}${error instanceof Error ? error.message : String(error)}`,
            error,
            'encoder-failed',
          )
        }
        this.streamingDecoder?.cancel()
      },
    })

    const codec = this.activeCodec || this.config.codec || DEFAULT_EXPORT_CODEC

    const encoderConfig: VideoEncoderConfig = {
      codec,
      width: this.config.width,
      height: this.config.height,
      bitrate: this.config.bitrate,
      framerate: this.config.frameRate,
      // 'realtime' dramatically improves encoding throughput at a minor
      // file-size cost.  The difference is negligible at the bitrates we use
      // (5-25 Mbps VBR) and avoids the encoder becoming a bottleneck.
      latencyMode: 'realtime',
      bitrateMode: 'variable',
      hardwareAcceleration,
    }

    const support = await VideoEncoder.isConfigSupported(encoderConfig)
    if (!support.supported) {
      throw new ExportEncoderError(
        hardwareAcceleration === 'prefer-hardware'
          ? EXPORT_ERROR_MESSAGES.encoderUnsupportedHardware
          : EXPORT_ERROR_MESSAGES.encoderUnsupportedSoftware,
        undefined,
        'encoder-unsupported',
      )
    }

    console.log(
      `[VideoExporter] Using ${hardwareAcceleration === 'prefer-hardware' ? 'hardware' : 'software'} ` +
        `${codec} encoding (queue ${this.maxEncodeQueue})`,
    )
    this.encoder.configure(encoderConfig)
  }

  cancel(): void {
    this.cancelled = true
    this.streamingDecoder?.cancel()
    this.cleanup()
  }

  private async waitForVideoFrame(videoElement: HTMLVideoElement, timeoutMs = 80): Promise<void> {
    if (typeof videoElement.requestVideoFrameCallback === 'function') {
      await new Promise<void>((resolve) => {
        let settled = false
        const timeout = window.setTimeout(() => {
          if (!settled) {
            settled = true
            resolve()
          }
        }, timeoutMs)

        videoElement.requestVideoFrameCallback(() => {
          if (!settled) {
            settled = true
            window.clearTimeout(timeout)
            resolve()
          }
        })
      })
      return
    }

    // Fallback: yield to the event loop with minimal delay
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  }

  private cleanup(): void {
    this.stopFinalizingHeartbeat()
    this.disposeSourceAudioInput()

    if (this.encoder) {
      try {
        if (this.encoder.state === 'configured') {
          this.encoder.close()
        }
      } catch (e) {
        console.warn('Error closing encoder:', e)
      }
      this.encoder = null
    }

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

    this.muxer = null
    this.encodeQueue = 0
    this.maxEncodeQueue = this.MAX_ENCODE_QUEUE
    this.fatalEncoderError = null
    this.muxingChain = Promise.resolve()
    this.muxingError = null
    this.chunkCount = 0
    this.exportStartedAtMs = 0
    this.progressTick = 0
    this.finalizingCurrentFrame = 0
    this.finalizingTotalFrames = 0
    this.finalizingDetailKey = undefined
    this.lastRenderingFrameCount = 0
    this.lastThroughputLogAtMs = 0
    this.seekCount = 0
    this.samplingMode = 'seek-only'
    this.videoDescription = undefined
    this.videoColorSpace = undefined
    this.sourceDurationMs = 0
    this.sourceTrimRanges = []
    this.warnings.clear()
  }
}
