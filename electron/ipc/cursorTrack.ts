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
    events?: Array<{
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
    }>
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
export type CursorTrackEventPayload = NonNullable<CursorTrackPayload['events']>[number]

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
  const payload = JSON.stringify(
    {
      version: 1,
      cursorTrack: sanitized,
    },
    null,
    2,
  )
  await fs.writeFile(sidecarPath, payload, 'utf-8')
}

export function sanitizeCursorTrack(
  input?: CurrentVideoMetadata['cursorTrack'] | null,
): CurrentVideoMetadata['cursorTrack'] | undefined {
  if (!input || !Array.isArray(input.samples) || input.samples.length === 0) return undefined

  const samples = input.samples
    .slice(0, 6_000)
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

  if (samples.length === 0) return undefined
  const events = Array.isArray(input.events)
    ? input.events
        .slice(0, 1_200)
        .map((event) => {
          if (!event || typeof event !== 'object') return null
          const type: 'click' | 'selection' | null =
            event.type === 'selection' ? 'selection' : event.type === 'click' ? 'click' : null
          if (!type) return null

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

          const normalizedEvent: CursorTrackEventPayload = {
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
        .filter((event): event is NonNullable<typeof event> => Boolean(event))
        .sort((a, b) => a.startMs - b.startMs)
    : []

  const clickCountFromEvents = events.reduce(
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

  const events = Array.isArray(track.events)
    ? track.events
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
    : track.events

  return { ...track, samples, events }
}
