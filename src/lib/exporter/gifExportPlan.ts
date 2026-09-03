import type { TrimRegion, VideoSegment } from '@/components/video-editor/types'
import {
  effectiveToSourceMsWithSegments,
  getEffectiveDurationMsWithSegments,
} from '@/lib/trim/timeMapping'
import { buildDecodeTimelinePlan, type DecodeTimelinePlan } from './segmentAdapter'
import { computeExportMetrics } from './streamingDecoder'
import type { ExportDecodePath } from './types'

/**
 * Frame plan for a GIF export on either decode path.
 *
 * - `'seek'`: the historical rule. Output length is the segment-aware
 *   effective duration (or source minus trims, divided by the global speed)
 *   and frame `k` samples the source at the time output `k / fps` maps to.
 * - `'webcodecs'`: the same `VideoSegment[]` / trims / speed are mapped onto
 *   the streaming decoder's trim + speed regions through `segmentAdapter`, and
 *   the frame count is the exact number `decodeAll` will emit
 *   (`computeExportMetrics`), so progress and the GIF length agree with the
 *   frames actually delivered.
 */
export interface GifFramePlanInput {
  decodePath: ExportDecodePath
  frameRate: number
  /** Resolved source duration (probed or reported), in ms. */
  sourceDurationMs: number
  /** Duration reported by the decoder's own scan (seconds); webcodecs path only. */
  decoderDurationSec?: number
  segments?: VideoSegment[]
  trimRegions?: TrimRegion[]
  playbackSpeed?: number
}

export interface GifFramePlan {
  decodePath: ExportDecodePath
  totalFrames: number
  effectiveDurationSec: number
  /** gif.js frame delay, in ms. */
  frameDelayMs: number
  /** Regions for `StreamingVideoDecoder.decodeAll`; null on the seek path. */
  decodePlan: DecodeTimelinePlan | null
  /** Source time (ms) output frame `index` samples. */
  sourceTimeMsForFrame(index: number): number
}

/** Capturia's seek path clamps the global playback speed to this floor. */
const MIN_PLAYBACK_SPEED = 0.25

function clampSpeed(playbackSpeed: number | undefined): number {
  return Math.max(MIN_PLAYBACK_SPEED, playbackSpeed ?? 1)
}

/** Effective (output) time -> source time by skipping over sorted trim regions. */
export function mapEffectiveToSourceMs(effectiveMs: number, sortedTrims: TrimRegion[]): number {
  let sourceMs = effectiveMs
  for (const trim of sortedTrims) {
    if (sourceMs < trim.startMs) break
    sourceMs += trim.endMs - trim.startMs
  }
  return sourceMs
}

function buildSeekPlan(input: GifFramePlanInput): GifFramePlan {
  const { frameRate, segments, playbackSpeed } = input
  const trims = [...(input.trimRegions ?? [])].sort((a, b) => a.startMs - b.startMs)
  const sourceDurationSec = input.sourceDurationMs / 1000
  const speed = clampSpeed(playbackSpeed)

  let effectiveDurationSec: number
  if (segments?.length) {
    effectiveDurationSec = getEffectiveDurationMsWithSegments(segments) / 1000
  } else {
    const trimmedSec = trims.reduce((sum, trim) => sum + (trim.endMs - trim.startMs) / 1000, 0)
    effectiveDurationSec = (sourceDurationSec - trimmedSec) / speed
  }
  const stepMs = 1000 / frameRate

  return {
    decodePath: 'seek',
    totalFrames: Math.max(0, Math.ceil(effectiveDurationSec * frameRate)),
    effectiveDurationSec,
    frameDelayMs: Math.round(1000 / frameRate),
    decodePlan: null,
    sourceTimeMsForFrame(index) {
      if (segments?.length) {
        return effectiveToSourceMsWithSegments(index * stepMs, segments)
      }
      return mapEffectiveToSourceMs(index * stepMs * speed, trims)
    },
  }
}

function buildWebCodecsPlan(input: GifFramePlanInput): GifFramePlan {
  const { frameRate } = input
  const decoderDurationSec =
    typeof input.decoderDurationSec === 'number' && Number.isFinite(input.decoderDurationSec)
      ? input.decoderDurationSec
      : input.sourceDurationMs / 1000
  const decodePlan = buildDecodeTimelinePlan({
    segments: input.segments,
    trimRegions: input.trimRegions,
    playbackSpeed: input.playbackSpeed,
    sourceDurationMs: input.sourceDurationMs,
    decoderDurationSec,
  })
  const metrics = computeExportMetrics(
    decoderDurationSec,
    frameRate,
    decodePlan.trimRegions,
    decodePlan.speedRegions,
  )

  return {
    decodePath: 'webcodecs',
    totalFrames: metrics.totalFrames,
    effectiveDurationSec: metrics.effectiveDuration,
    frameDelayMs: Math.round(1000 / frameRate),
    decodePlan,
    sourceTimeMsForFrame(index) {
      const outputSec = index / frameRate
      let cumulativeSec = 0
      for (const segment of decodePlan.segments) {
        const segmentOutputSec = (segment.endSec - segment.startSec) / segment.speed
        if (outputSec < cumulativeSec + segmentOutputSec) {
          return (segment.startSec + (outputSec - cumulativeSec) * segment.speed) * 1000
        }
        cumulativeSec += segmentOutputSec
      }
      const last = decodePlan.segments[decodePlan.segments.length - 1]
      return last ? last.endSec * 1000 : 0
    },
  }
}

export function buildGifFramePlan(input: GifFramePlanInput): GifFramePlan {
  return input.decodePath === 'webcodecs' ? buildWebCodecsPlan(input) : buildSeekPlan(input)
}
