import fs from 'node:fs/promises'
import path from 'node:path'
import type { CaptureBounds, CaptureBoundsMode } from '../../src/lib/cursor/captureSpace'
import { type CursorKind, normalizeCursorKind } from '../../src/lib/cursor/cursorKinds'

/**
 * Cursor-track payload: the shape recorded by the tracker, persisted next to a
 * recording as `<video>.cursor.json`, and echoed back through
 * `get-current-video-path`. Pure (fs + path only) so it is testable without
 * Electron; the live tracker is in `./cursorTracker.ts`.
 */

/**
 * A pointer gesture the cursor tracker folded out of the raw samples. Spans a
 * range of time and has a place on screen, which is what the editor's auto-zoom
 * anchors on.
 */
export type CursorTrackPointerEvent = {
  type: 'click' | 'selection'
  startMs: number
  endMs: number
  point: { x: number; y: number }
  startPoint?: { x: number; y: number }
  endPoint?: { x: number; y: number }
  bounds?: {
    minX: number
    minY: number
    maxX: number
    maxY: number
    width: number
    height: number
  }
}

/**
 * D2: a moment the user flagged while recording, from the global shortcut or
 * the HUD button. An instant rather than a span, and it has no place on screen -
 * it only marks *when*. Markers ride in the same `events` array so a sidecar
 * written before this batch still loads (it simply has none), and they are
 * never dropped by the size policy: losing one loses something the user
 * deliberately recorded.
 */
export type CursorTrackMarkerEvent = {
  type: 'marker'
  timeMs: number
}

export type CursorTrackEventPayload = CursorTrackPointerEvent | CursorTrackMarkerEvent

export function isCursorTrackMarkerEvent(
  event: CursorTrackEventPayload,
): event is CursorTrackMarkerEvent {
  return event.type === 'marker'
}

export function isCursorTrackPointerEvent(
  event: CursorTrackEventPayload,
): event is CursorTrackPointerEvent {
  return event.type === 'click' || event.type === 'selection'
}

/**
 * Ceiling on flagged moments in one recording. Separate from the pointer-event
 * cap so a session full of clicks can never squeeze the markers out.
 */
export const MAX_CURSOR_TRACK_MARKERS = 5_000

export type CurrentVideoMetadata = {
  frameRate?: number
  width?: number
  height?: number
  mimeType?: string
  capturedAt?: number
  systemCursorMode?: 'always' | 'never'
  hasMicrophoneAudio?: boolean
  /**
   * Wall-clock length of the capture, minus pauses. Only used to patch the WebM
   * Duration header of a streamed recording; never persisted in the metadata.
   */
  durationMs?: number
  cursorTrack?: {
    source?: 'recorded' | 'synthetic'
    samples: Array<{
      timeMs: number
      x: number
      y: number
      click?: boolean
      visible?: boolean
      /**
       * A `CursorKind` after `sanitizeCursorTrack`; raw input may carry legacy
       * names (`ibeam` -> `text`) or anything else (-> `arrow`).
       */
      cursorKind?: CursorKind | string
    }>
    events?: CursorTrackEventPayload[]
    space?: {
      mode?: CaptureBoundsMode
      displayId?: string
      bounds?: CaptureBounds
    }
    stats?: {
      sampleCount?: number
      clickCount?: number
    }
    capture?: {
      sourceId?: string
      width?: number
      height?: number
    }
  }
}

export type CursorTrackPayload = NonNullable<CurrentVideoMetadata['cursorTrack']>

export function resolveCursorSidecarPath(videoPath: string): string {
  const parsed = path.parse(videoPath)
  return path.join(parsed.dir, `${parsed.name}.cursor.json`)
}

export async function readCursorTrackSidecar(
  videoPath: string,
): Promise<CurrentVideoMetadata['cursorTrack'] | undefined> {
  return readCursorTrackSidecarFile(resolveCursorSidecarPath(videoPath))
}

/**
 * Reads a sidecar by its own path. Used when the sidecar is not next to the
 * video (the recording was moved and the media-links registry found the old
 * one by fingerprint); `readCursorTrackSidecar` is the derived-path form.
 */
export async function readCursorTrackSidecarFile(
  sidecarPath: string,
): Promise<CurrentVideoMetadata['cursorTrack'] | undefined> {
  try {
    const raw = await fs.readFile(sidecarPath, 'utf-8')
    const parsed = JSON.parse(raw) as
      | { cursorTrack?: CurrentVideoMetadata['cursorTrack'] }
      | CurrentVideoMetadata['cursorTrack']
    const input =
      (parsed as { cursorTrack?: CurrentVideoMetadata['cursorTrack'] }).cursorTrack ??
      (parsed as CurrentVideoMetadata['cursorTrack'])
    return sanitizeCursorTrack(input)
  } catch {
    return undefined
  }
}

export async function writeCursorTrackSidecar(
  videoPath: string,
  cursorTrack: CurrentVideoMetadata['cursorTrack'],
): Promise<void> {
  const sanitized = sanitizeCursorTrack(cursorTrack)
  if (!sanitized) return
  const sidecarPath = resolveCursorSidecarPath(videoPath)
  // Indented for the short tracks a human might open, compact past that: the
  // indentation of a two-hour track doubles a file that is already tens of MB.
  // Both forms are the same JSON, so an old reader is unaffected.
  const indent =
    sanitized.samples.length > DEFAULT_CURSOR_TRACK_COMPACTION.compactAboveSamples ? undefined : 2
  const payload = JSON.stringify(
    {
      version: 1,
      cursorTrack: sanitized,
    },
    null,
    indent,
  )
  await fs.writeFile(sidecarPath, payload, 'utf-8')
}

/** A cursor sample as far as the compaction rules care: when it happened, and whether it is a click. */
export type CursorSampleTiming = { timeMs: number; click?: boolean }
/** A click / selection event as far as the compaction rules care: the span it covers. */
export type CursorEventTiming = { startMs: number; endMs: number }

export type CursorTrackCompactionLimits = {
  /**
   * Rate the samples outside an event guard are decimated to. 30 Hz is at or
   * above the rate the cursor overlay and auto-zoom actually resolve.
   */
  targetSampleRateHz: number
  /** Samples this close to a click / selection are kept whatever the spacing rule says. */
  eventGuardMs: number
  /**
   * Tracks at or below this many samples are returned untouched. It is the cap
   * the pre-1.9 head slice used, so every track that used to survive whole is
   * still byte-for-byte what it was.
   */
  compactAboveSamples: number
  /** Absolute ceiling. 260 000 at 30 Hz is ~2.4 h of recording. */
  maxSamples: number
  /**
   * Ceiling on the serialized sample array. Only a backstop: 2 h at 30 Hz
   * serializes to roughly 25 MB, so this never trips on a real recording.
   */
  maxSampleBytes: number
}

export const DEFAULT_CURSOR_TRACK_COMPACTION: CursorTrackCompactionLimits = Object.freeze({
  targetSampleRateHz: 30,
  eventGuardMs: 250,
  compactAboveSamples: 6_000,
  maxSamples: 260_000,
  maxSampleBytes: 32 * 1024 * 1024,
})

/**
 * Smallest possible serialization of one sanitized sample, used to skip the
 * (expensive) byte measurement for any track that cannot reach the ceiling:
 * `{"timeMs":0,"x":0,"y":0,"click":false,"visible":true,"cursorKind":"arrow"},`
 */
const MIN_SERIALIZED_SAMPLE_BYTES = 72

function mergeGuardIntervals(
  events: readonly CursorEventTiming[] | undefined,
  guardMs: number,
): CursorTrackPauseRange[] {
  if (!events || events.length === 0) return []
  const spans = events
    .map((event) => ({
      startMs: Number(event.startMs) - guardMs,
      endMs: Number(event.endMs) + guardMs,
    }))
    .filter((span) => Number.isFinite(span.startMs) && Number.isFinite(span.endMs))
    .sort((a, b) => a.startMs - b.startMs)

  const merged: CursorTrackPauseRange[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs)
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

/**
 * Time-based decimation: every click and every sample inside an event guard is
 * kept, and the rest are thinned to `targetSampleRateHz`. Samples must already
 * be ordered by `timeMs`; the first and last are always kept so the track still
 * spans the whole recording.
 *
 * The due time advances on its own grid rather than from the last kept sample:
 * a tracker running at 60 Hz would otherwise only ever keep every third sample
 * (16 ms ticks, 33 ms spacing) and land at 20 Hz instead of the 30 asked for.
 */
export function decimateCursorTrackSamples<S extends CursorSampleTiming>(
  samples: readonly S[],
  events: readonly CursorEventTiming[] | undefined,
  options: { targetSampleRateHz?: number; eventGuardMs?: number } = {},
): S[] {
  const rateHz = options.targetSampleRateHz ?? DEFAULT_CURSOR_TRACK_COMPACTION.targetSampleRateHz
  const guardMs = options.eventGuardMs ?? DEFAULT_CURSOR_TRACK_COMPACTION.eventGuardMs
  if (samples.length === 0 || !Number.isFinite(rateHz) || rateHz <= 0) return [...samples]

  const intervalMs = 1_000 / rateHz
  const guards = mergeGuardIntervals(events, guardMs)
  const kept: S[] = []
  let guardIndex = 0
  let nextDueMs = Number.NEGATIVE_INFINITY

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    const timeMs = Number(sample.timeMs)
    while (guardIndex < guards.length && guards[guardIndex].endMs < timeMs) guardIndex += 1
    const insideGuard = guardIndex < guards.length && timeMs >= guards[guardIndex].startMs
    const isEdge = index === 0 || index === samples.length - 1
    const isDue = timeMs >= nextDueMs
    if (sample.click === true || insideGuard || isEdge || isDue) {
      kept.push(sample)
    }
    if (isDue) {
      nextDueMs = Number.isFinite(nextDueMs) ? nextDueMs : timeMs
      while (nextDueMs <= timeMs) nextDueMs += intervalMs
    }
  }
  return kept
}

/**
 * Drops samples uniformly across the track until at most `maxCount` remain.
 * Clicks and the two end samples are never candidates: a burst of clicks can
 * leave the result above the target rather than lose an event the editor draws,
 * and the track must still span the whole recording.
 */
export function thinCursorTrackSamples<S extends CursorSampleTiming>(
  samples: readonly S[],
  maxCount: number,
): S[] {
  if (samples.length <= maxCount) return [...samples]

  const lastIndex = samples.length - 1
  const isProtected = (sample: S, index: number): boolean =>
    sample.click === true || index === 0 || index === lastIndex
  let protectedCount = 0
  for (let index = 0; index <= lastIndex; index += 1) {
    if (isProtected(samples[index], index)) protectedCount += 1
  }
  const droppableCount = samples.length - protectedCount
  const budget = Math.max(0, maxCount - protectedCount)
  if (droppableCount === 0 || budget >= droppableCount) return [...samples]

  const step = budget / droppableCount
  const kept: S[] = []
  let credit = 0
  for (let index = 0; index <= lastIndex; index += 1) {
    const sample = samples[index]
    if (isProtected(sample, index)) {
      kept.push(sample)
      continue
    }
    credit += step
    if (credit >= 1) {
      credit -= 1
      kept.push(sample)
    }
  }
  return kept
}

/**
 * The whole size policy for a cursor track, in one place: leave short tracks
 * alone, decimate long ones to ~30 Hz around their clicks, and fall back to a
 * uniform thin when even that is over the count or byte ceiling. Both ceilings
 * drop across the whole recording, never off the tail, so the editor's cursor
 * overlay and auto-zoom keep working to the last frame.
 */
export function compactCursorTrackSamples<S extends CursorSampleTiming>(
  samples: readonly S[],
  events: readonly CursorEventTiming[] | undefined,
  limits: Partial<CursorTrackCompactionLimits> = {},
): S[] {
  const resolved: CursorTrackCompactionLimits = { ...DEFAULT_CURSOR_TRACK_COMPACTION, ...limits }
  if (samples.length <= resolved.compactAboveSamples) return [...samples]

  let result = decimateCursorTrackSamples(samples, events, resolved)
  if (result.length > resolved.maxSamples) {
    const before = result.length
    result = thinCursorTrackSamples(result, resolved.maxSamples)
    console.warn(
      `[cursor-track] sample ceiling reached: thinned ${before} -> ${result.length} samples (max ${resolved.maxSamples})`,
    )
  }

  // Measuring costs a full serialization, so only do it for a track long enough
  // to possibly exceed the ceiling.
  if (result.length * MIN_SERIALIZED_SAMPLE_BYTES > resolved.maxSampleBytes) {
    const bytes = JSON.stringify(result).length
    if (bytes > resolved.maxSampleBytes) {
      const before = result.length
      const target = Math.max(1, Math.floor(result.length * (resolved.maxSampleBytes / bytes)))
      result = thinCursorTrackSamples(result, target)
      console.warn(
        `[cursor-track] payload ceiling reached: ${bytes} bytes over ${resolved.maxSampleBytes}; thinned ${before} -> ${result.length} samples`,
      )
    }
  }

  return result
}

export function sanitizeCursorTrack(
  input?: CurrentVideoMetadata['cursorTrack'] | null,
): CurrentVideoMetadata['cursorTrack'] | undefined {
  if (!input || !Array.isArray(input.samples) || input.samples.length === 0) return undefined

  const normalizedSamples = input.samples
    .map((sample) => {
      const timeMs = Number(sample.timeMs)
      const x = Number(sample.x)
      const y = Number(sample.y)
      if (!Number.isFinite(timeMs) || !Number.isFinite(x) || !Number.isFinite(y)) return null
      const cursorKind: CursorKind = normalizeCursorKind(sample.cursorKind)
      return {
        timeMs: Math.max(0, Math.round(timeMs)),
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
        click: Boolean(sample.click),
        visible: sample.visible === false ? false : true,
        cursorKind,
      }
    })
    .filter((sample): sample is NonNullable<typeof sample> => Boolean(sample))
    .sort((a, b) => a.timeMs - b.timeMs)

  if (normalizedSamples.length === 0) return undefined
  const rawEvents: CursorTrackEventPayload[] = Array.isArray(input.events) ? input.events : []

  // D2: markers are split off before the pointer events are capped, so a
  // session full of clicks can never cost the user a moment they flagged
  // deliberately. They also carry no coordinates, so none of the point / bounds
  // normalization below applies to them.
  const markers: CursorTrackMarkerEvent[] = rawEvents
    .filter(
      (event): event is CursorTrackMarkerEvent =>
        Boolean(event) && typeof event === 'object' && event.type === 'marker',
    )
    .map((event) => Number(event.timeMs))
    .filter((timeMs) => Number.isFinite(timeMs))
    .map((timeMs) => ({ type: 'marker' as const, timeMs: Math.max(0, Math.round(timeMs)) }))
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, MAX_CURSOR_TRACK_MARKERS)

  const pointerEvents = rawEvents
    .filter(
      (event): event is CursorTrackPointerEvent =>
        Boolean(event) &&
        typeof event === 'object' &&
        (event.type === 'click' || event.type === 'selection'),
    )
    // Raised from 1 200 with the sample ceiling: a two-hour session can hold
    // well over a thousand clicks, and a dropped click loses an auto-zoom.
    .slice(0, 20_000)
    .map((event): CursorTrackPointerEvent | null => {
      const type: 'click' | 'selection' = event.type === 'selection' ? 'selection' : 'click'

      const startMs = Number(event.startMs)
      const endMs = Number(event.endMs)
      const pointX = Number(event.point?.x)
      const pointY = Number(event.point?.y)
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        !Number.isFinite(pointX) ||
        !Number.isFinite(pointY)
      ) {
        return null
      }

      const normalizedStartMs = Math.max(0, Math.round(startMs))
      const normalizedEndMs = Math.max(normalizedStartMs, Math.round(endMs))
      const normalizedPoint = {
        x: Math.min(1, Math.max(0, pointX)),
        y: Math.min(1, Math.max(0, pointY)),
      }

      const startPointX = Number(event.startPoint?.x)
      const startPointY = Number(event.startPoint?.y)
      const normalizedStartPoint =
        Number.isFinite(startPointX) && Number.isFinite(startPointY)
          ? {
              x: Math.min(1, Math.max(0, startPointX)),
              y: Math.min(1, Math.max(0, startPointY)),
            }
          : undefined

      const endPointX = Number(event.endPoint?.x)
      const endPointY = Number(event.endPoint?.y)
      const normalizedEndPoint =
        Number.isFinite(endPointX) && Number.isFinite(endPointY)
          ? {
              x: Math.min(1, Math.max(0, endPointX)),
              y: Math.min(1, Math.max(0, endPointY)),
            }
          : undefined

      const boundsMinX = Number(event.bounds?.minX)
      const boundsMinY = Number(event.bounds?.minY)
      const boundsMaxX = Number(event.bounds?.maxX)
      const boundsMaxY = Number(event.bounds?.maxY)
      const normalizedBounds = [boundsMinX, boundsMinY, boundsMaxX, boundsMaxY].every(
        Number.isFinite,
      )
        ? (() => {
            const minX = Math.min(1, Math.max(0, boundsMinX))
            const minY = Math.min(1, Math.max(0, boundsMinY))
            const maxX = Math.max(minX, Math.min(1, Math.max(0, boundsMaxX)))
            const maxY = Math.max(minY, Math.min(1, Math.max(0, boundsMaxY)))
            return {
              minX,
              minY,
              maxX,
              maxY,
              width: maxX - minX,
              height: maxY - minY,
            }
          })()
        : undefined

      const normalizedEvent: CursorTrackPointerEvent = {
        type,
        startMs: normalizedStartMs,
        endMs: normalizedEndMs,
        point: normalizedPoint,
      }
      if (normalizedStartPoint) {
        normalizedEvent.startPoint = normalizedStartPoint
      }
      if (normalizedEndPoint) {
        normalizedEvent.endPoint = normalizedEndPoint
      }
      if (normalizedBounds) {
        normalizedEvent.bounds = normalizedBounds
      }
      return normalizedEvent
    })
    .filter((event): event is CursorTrackPointerEvent => Boolean(event))
    .sort((a, b) => a.startMs - b.startMs)

  // Pointer events first, markers after, each already sorted: the editor reads
  // them by type, and keeping the groups apart means the pointer-event cap and
  // the marker cap can never interfere.
  const events: CursorTrackEventPayload[] = [...pointerEvents, ...markers]

  // Size policy last, so the decimator can protect the samples around the
  // events it has just normalized.
  const samples = compactCursorTrackSamples(normalizedSamples, pointerEvents)

  const clickCountFromEvents = pointerEvents.reduce(
    (count, event) => count + (event.type === 'click' ? 1 : 0),
    0,
  )
  const clickCountFromSamples = samples.filter((sample) => sample.click).length
  const clickCountFallback = Math.max(clickCountFromSamples, clickCountFromEvents)
  const normalized: NonNullable<CurrentVideoMetadata['cursorTrack']> = {
    source: input.source === 'synthetic' ? 'synthetic' : 'recorded',
    samples,
  }

  if (events.length > 0) {
    normalized.events = events
  }

  if (input.space) {
    const boundsInput = input.space.bounds
    const x = Number(boundsInput?.x)
    const y = Number(boundsInput?.y)
    const width = Number(boundsInput?.width)
    const height = Number(boundsInput?.height)
    if ([x, y, width, height].every(Number.isFinite) && width >= 1 && height >= 1) {
      normalized.space = {
        mode: input.space.mode === 'source-display' ? 'source-display' : 'virtual-desktop',
        displayId:
          typeof input.space.displayId === 'string' && input.space.displayId.trim().length > 0
            ? input.space.displayId.trim()
            : undefined,
        bounds: {
          x,
          y,
          width,
          height,
        },
      }
    }
  }

  if (input.stats) {
    const sampleCount = Number(input.stats.sampleCount)
    const clickCount = Number(input.stats.clickCount)
    normalized.stats = {
      sampleCount:
        Number.isFinite(sampleCount) && sampleCount >= 0 ? Math.floor(sampleCount) : samples.length,
      clickCount:
        Number.isFinite(clickCount) && clickCount >= 0
          ? Math.floor(clickCount)
          : clickCountFallback,
    }
  }

  if (input.capture) {
    const width = Number(input.capture.width)
    const height = Number(input.capture.height)
    const sourceId =
      typeof input.capture.sourceId === 'string' && input.capture.sourceId.trim().length > 0
        ? input.capture.sourceId.trim()
        : undefined
    if (sourceId || (Number.isFinite(width) && Number.isFinite(height))) {
      normalized.capture = {
        sourceId,
        width: Number.isFinite(width) && width >= 2 ? Math.floor(width) : undefined,
        height: Number.isFinite(height) && height >= 2 ? Math.floor(height) : undefined,
      }
    }
  }

  return normalized
}

export function sanitizeVideoMetadata(
  metadata?: CurrentVideoMetadata | null,
): CurrentVideoMetadata | null {
  if (!metadata) return null

  const frameRate = Number(metadata.frameRate)
  const width = Number(metadata.width)
  const height = Number(metadata.height)
  const capturedAt = Number(metadata.capturedAt)

  const normalized: CurrentVideoMetadata = {}
  if (Number.isFinite(frameRate) && frameRate >= 1 && frameRate <= 240) {
    normalized.frameRate = Math.round(frameRate)
  }
  if (Number.isFinite(width) && width >= 2) {
    normalized.width = Math.floor(width)
  }
  if (Number.isFinite(height) && height >= 2) {
    normalized.height = Math.floor(height)
  }
  if (typeof metadata.mimeType === 'string' && metadata.mimeType.trim().length > 0) {
    normalized.mimeType = metadata.mimeType.trim()
  }
  if (Number.isFinite(capturedAt) && capturedAt > 0) {
    normalized.capturedAt = Math.floor(capturedAt)
  }
  if (metadata.systemCursorMode === 'always' || metadata.systemCursorMode === 'never') {
    normalized.systemCursorMode = metadata.systemCursorMode
  }
  if (typeof metadata.hasMicrophoneAudio === 'boolean') {
    normalized.hasMicrophoneAudio = metadata.hasMicrophoneAudio
  }

  const cursorTrack = sanitizeCursorTrack(metadata.cursorTrack)
  if (cursorTrack) {
    normalized.cursorTrack = cursorTrack
  }

  return Object.keys(normalized).length > 0 ? normalized : null
}

export type CursorTrackPauseRange = { startMs: number; endMs: number }

/** Sort, clamp and drop empty / non-finite ranges; overlapping ranges are merged. */
export function normalizeCursorTrackPauseRanges(
  ranges: readonly CursorTrackPauseRange[],
): CursorTrackPauseRange[] {
  const sorted = ranges
    .map((range) => ({
      startMs: Math.max(0, Math.min(Number(range.startMs), Number(range.endMs))),
      endMs: Math.max(0, Math.max(Number(range.startMs), Number(range.endMs))),
    }))
    .filter((range) => Number.isFinite(range.startMs) && Number.isFinite(range.endMs))
    .filter((range) => range.endMs > range.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  const merged: CursorTrackPauseRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/**
 * Map a recording-relative wall-clock time onto the paused-time-removed
 * timeline: everything spent inside earlier ranges is subtracted, and a time
 * inside a range collapses onto that range's start.
 */
function collapsePausedTime(timeMs: number, ranges: readonly CursorTrackPauseRange[]): number {
  let paused = 0
  for (const range of ranges) {
    if (timeMs > range.endMs) {
      paused += range.endMs - range.startMs
      continue
    }
    if (timeMs >= range.startMs) {
      paused += timeMs - range.startMs
    }
    break
  }
  return Math.max(0, timeMs - paused)
}

function isInsideRange(timeMs: number, ranges: readonly CursorTrackPauseRange[]): boolean {
  return ranges.some((range) => timeMs >= range.startMs && timeMs <= range.endMs)
}

/**
 * Collapses recording pauses out of the cursor track: the tracker keeps
 * sampling on the wall clock while a recording is paused, but the video
 * timeline (MediaRecorder pause, or the native helper's retimed samples) has
 * no gap. Samples inside a pause
 * are dropped and later samples shift back by the paused duration. Capturia
 * also carries click / selection events: an event entirely inside a pause is
 * dropped, otherwise both of its ends are collapsed the same way.
 *
 * Pure; returns the input untouched when there is nothing to do.
 */
export function compactCursorTrackPauseRanges<
  T extends Pick<CursorTrackPayload, 'samples' | 'events'>,
>(track: T, ranges: readonly CursorTrackPauseRange[]): T {
  const normalizedRanges = normalizeCursorTrackPauseRanges(ranges)
  if (normalizedRanges.length === 0) return track

  const samples = (Array.isArray(track.samples) ? track.samples : [])
    .filter((sample) => !isInsideRange(Number(sample.timeMs), normalizedRanges))
    .map((sample) => ({
      ...sample,
      timeMs: collapsePausedTime(Number(sample.timeMs), normalizedRanges),
    }))
    .sort((a, b) => a.timeMs - b.timeMs)

  const rawEvents = Array.isArray(track.events) ? track.events : []

  const pointerEvents = rawEvents
    .filter(isCursorTrackPointerEvent)
    .filter((event) => {
      const startInside = isInsideRange(Number(event.startMs), normalizedRanges)
      const endInside = isInsideRange(Number(event.endMs), normalizedRanges)
      if (!startInside || !endInside) return true
      // Both ends inside: keep only when the event spans across a resume.
      return normalizedRanges.every(
        (range) => !(event.startMs >= range.startMs && event.endMs <= range.endMs),
      )
    })
    .map((event) => ({
      ...event,
      startMs: collapsePausedTime(Number(event.startMs), normalizedRanges),
      endMs: collapsePausedTime(Number(event.endMs), normalizedRanges),
    }))
    .sort((a, b) => a.startMs - b.startMs)

  // D2: a marker is an instant, so there is no "spans a resume" case. One
  // dropped inside a pause is a moment the user flagged on a frame the video
  // does not contain; the rest shift back like the samples do.
  const markers = rawEvents
    .filter(isCursorTrackMarkerEvent)
    .filter((event) => !isInsideRange(Number(event.timeMs), normalizedRanges))
    .map((event) => ({
      ...event,
      timeMs: collapsePausedTime(Number(event.timeMs), normalizedRanges),
    }))
    .sort((a, b) => a.timeMs - b.timeMs)

  const events = Array.isArray(track.events) ? [...pointerEvents, ...markers] : track.events

  return { ...track, samples, events }
}
