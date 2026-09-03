import type { TrimRegion, VideoSegment } from '@/components/video-editor/types'
import { normalizeTrimRanges } from '@/lib/trim/timeMapping'
import type { SpeedRegion, SpeedTimelineSegment } from './timelineSegments'

/**
 * Adapter between Capturia's timeline model and the decoder's trim/speed model.
 *
 * Capturia describes an edit as `VideoSegment[]` (a partition of the source
 * into `{startMs, endMs, deleted, speed}` spans) plus legacy `TrimRegion[]`
 * and a global `playbackSpeed`. `StreamingVideoDecoder.decodeAll` and
 * `getExportMetrics` expect `TrimRegion[]` (spans to drop) and
 * `SpeedRegion[]` (spans played at a non-1x speed). Both models describe the
 * same thing - an ordered list of kept source spans, each with a speed - so
 * the conversion goes through that common form (`SpeedTimelineSegment[]`).
 */

/** Kept spans shorter than this are dropped (matches the decoder's own sliver guard). */
const MIN_SPAN_MS = 0.1
/** Two spans closer than this are considered touching and may merge. */
const MERGE_TOLERANCE_MS = 1e-6
/** Capturia's seek path clamps the global playback speed to this floor. */
const MIN_PLAYBACK_SPEED = 0.25

interface SpanMs {
  startMs: number
  endMs: number
  speed: number
}

export interface DecodeTimelinePlan {
  /** Kept source spans in output order, in seconds. */
  segments: SpeedTimelineSegment[]
  /** Regions to drop, for `decodeAll` / `getExportMetrics`. */
  trimRegions: TrimRegion[]
  /** Regions played at a non-1x speed, for `decodeAll` / `getExportMetrics`. */
  speedRegions: SpeedRegion[]
}

export interface DecodeTimelineInput {
  segments?: VideoSegment[]
  trimRegions?: TrimRegion[]
  playbackSpeed?: number
  /** Source duration the edit was authored against (probed/resolved), in ms. */
  sourceDurationMs: number
  /**
   * Duration reported by the decoder's packet scan, in seconds. When it is
   * longer than `sourceDurationMs` the tail is trimmed so the decoder stops
   * where the editor believes the recording ends. Defaults to `sourceDurationMs`.
   */
  decoderDurationSec?: number
}

function sanitizeSegmentSpeed(speed: number): number {
  return Number.isFinite(speed) && speed > 0 ? speed : 1
}

function sanitizeGlobalSpeed(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return 1
  return Math.max(MIN_PLAYBACK_SPEED, speed)
}

function keptRangesMs(durationMs: number, trimRegions: TrimRegion[] | undefined): SpanMs[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return []
  const trims = normalizeTrimRanges(trimRegions ?? [], durationMs)
  const kept: SpanMs[] = []
  let cursor = 0
  for (const trim of trims) {
    if (trim.startMs > cursor) kept.push({ startMs: cursor, endMs: trim.startMs, speed: 1 })
    cursor = Math.max(cursor, trim.endMs)
  }
  if (cursor < durationMs) kept.push({ startMs: cursor, endMs: durationMs, speed: 1 })
  return kept
}

function normalizeSpans(spans: SpanMs[]): SpanMs[] {
  const result: SpanMs[] = []
  for (const span of spans) {
    if (span.endMs - span.startMs <= MIN_SPAN_MS) continue
    const previous = result[result.length - 1]
    if (
      previous &&
      previous.speed === span.speed &&
      Math.abs(previous.endMs - span.startMs) <= MERGE_TOLERANCE_MS
    ) {
      previous.endMs = span.endMs
      continue
    }
    result.push({ ...span })
  }
  return result
}

function buildKeptSpansMs(
  segments: VideoSegment[] | undefined,
  trimRegions: TrimRegion[] | undefined,
  durationMs: number,
  playbackSpeed: number | undefined,
): SpanMs[] {
  const kept = keptRangesMs(durationMs, trimRegions)
  if (kept.length === 0) return []

  if (!segments?.length) {
    const speed = sanitizeGlobalSpeed(playbackSpeed)
    return normalizeSpans(kept.map((range) => ({ ...range, speed })))
  }

  // Segments are a partition of the source; the global playback speed does not
  // apply on top of them (mirrors `effectiveToSourceMsWithSegments`).
  const ordered = segments
    .filter((segment) => !segment.deleted)
    .map((segment) => ({
      startMs: Math.max(0, Math.min(segment.startMs, durationMs)),
      endMs: Math.max(0, Math.min(segment.endMs, durationMs)),
      speed: sanitizeSegmentSpeed(segment.speed),
    }))
    .filter((segment) => segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  const pieces: SpanMs[] = []
  for (const segment of ordered) {
    for (const range of kept) {
      const startMs = Math.max(segment.startMs, range.startMs)
      const endMs = Math.min(segment.endMs, range.endMs)
      if (endMs > startMs) pieces.push({ startMs, endMs, speed: segment.speed })
    }
  }
  return normalizeSpans(pieces)
}

function spansToSeconds(spans: SpanMs[]): SpeedTimelineSegment[] {
  return spans.map((span) => ({
    startSec: span.startMs / 1000,
    endSec: span.endMs / 1000,
    speed: span.speed,
  }))
}

/**
 * Converts Capturia's `VideoSegment[]` (+ legacy trims, + global speed when no
 * segments are set) into the ordered kept-span timeline the decoder works on.
 *
 * - deleted segments are dropped, kept ones carry their own speed;
 * - every span is intersected with the non-trimmed part of the source;
 * - adjacent spans with the same speed are merged, slivers are dropped;
 * - with no segments the whole non-trimmed source plays at `playbackSpeed`
 *   (clamped to >= 0.25 like the seek path).
 */
export function segmentsToSpeedTimeline(
  segments: VideoSegment[] | undefined,
  trimRegions: TrimRegion[] | undefined,
  durationSec: number,
  playbackSpeed?: number,
): SpeedTimelineSegment[] {
  const durationMs = Number.isFinite(durationSec) ? Math.max(0, durationSec * 1000) : 0
  return spansToSeconds(buildKeptSpansMs(segments, trimRegions, durationMs, playbackSpeed))
}

/** Output duration (seconds) of a kept-span timeline: sum of span length / speed. */
export function getSpeedTimelineDurationSec(segments: SpeedTimelineSegment[]): number {
  return segments.reduce(
    (sum, segment) => sum + (segment.endSec - segment.startSec) / segment.speed,
    0,
  )
}

/**
 * Builds the trim/speed regions `StreamingVideoDecoder` needs so that
 * `buildSpeedSegments(decoderDurationSec, trimRegions, speedRegions)` yields
 * exactly `segments`. Gaps between kept spans (and before the first / after
 * the last, up to the decoder's duration) become trims; spans with a non-1x
 * speed become speed regions.
 */
export function buildDecodeTimelinePlan(input: DecodeTimelineInput): DecodeTimelinePlan {
  const sourceDurationMs = Number.isFinite(input.sourceDurationMs)
    ? Math.max(0, input.sourceDurationMs)
    : 0
  const decoderDurationMs =
    typeof input.decoderDurationSec === 'number' && Number.isFinite(input.decoderDurationSec)
      ? Math.max(0, input.decoderDurationSec * 1000)
      : sourceDurationMs
  // Never let the edit reach past what the decoder can actually deliver.
  const editDurationMs = Math.min(sourceDurationMs, decoderDurationMs)

  const spans = buildKeptSpansMs(
    input.segments,
    input.trimRegions,
    editDurationMs,
    input.playbackSpeed,
  )

  const trimRegions: TrimRegion[] = []
  const speedRegions: SpeedRegion[] = []
  let cursorMs = 0
  spans.forEach((span, index) => {
    if (span.startMs > cursorMs + MERGE_TOLERANCE_MS) {
      trimRegions.push({ id: `decode-trim-${index}`, startMs: cursorMs, endMs: span.startMs })
    }
    if (span.speed !== 1) {
      speedRegions.push({
        id: `decode-speed-${index}`,
        startMs: span.startMs,
        endMs: span.endMs,
        speed: span.speed,
      })
    }
    cursorMs = span.endMs
  })
  if (decoderDurationMs > cursorMs + MERGE_TOLERANCE_MS) {
    trimRegions.push({ id: 'decode-trim-tail', startMs: cursorMs, endMs: decoderDurationMs })
  }

  return { segments: spansToSeconds(spans), trimRegions, speedRegions }
}
