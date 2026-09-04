import type { CaptionSegment } from './transcribe'

/**
 * Word-boundary snapping for caption segments (P2-F4).
 *
 * Whisper's segment boundaries land on its own 20 ms frame grid, which is
 * regularly a few tens of milliseconds inside a word: the caption appears with
 * the first consonant already gone, or disappears mid-syllable. The audio itself
 * says where the word actually ends — the RMS envelope dips between words — so
 * each boundary is nudged to the quietest point within a short window of it.
 *
 * Everything here is pure and works on the same mono 16 kHz buffer the
 * transcriber was handed, so it can be unit-tested without any audio stack.
 */

/** Envelope resolution. 10 ms is short enough to see a stop consonant's gap. */
export const RMS_FRAME_MS = 10

/**
 * How far from a boundary a quieter point may be taken from. The batch called
 * this a lookback; the window is symmetric because moving an *end* boundary
 * only backwards is exactly the cut this is meant to avoid — the quiet point
 * after the last syllable is usually a few frames later, not earlier.
 */
export const SNAP_WINDOW_MS = 150

/** Below this the move is not worth making: it is inside Whisper's own grid noise. */
export const MIN_SNAP_SHIFT_MS = 20

export interface RmsEnvelope {
  /** Mean square root amplitude per frame. */
  frames: Float32Array
  frameMs: number
  durationMs: number
}

/**
 * RMS per fixed-length frame. A trailing partial frame is measured over the
 * samples it actually has, so the envelope covers the whole buffer.
 */
export function computeRmsEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameMs: number = RMS_FRAME_MS,
): RmsEnvelope {
  const safeFrameMs = Math.max(1, Math.round(frameMs))
  const safeSampleRate = Math.max(1, Math.round(sampleRate))
  const frameSamples = Math.max(1, Math.round((safeFrameMs * safeSampleRate) / 1000))
  const frameCount = Math.ceil(samples.length / frameSamples)
  const frames = new Float32Array(Math.max(0, frameCount))

  for (let index = 0; index < frameCount; index += 1) {
    const from = index * frameSamples
    const to = Math.min(samples.length, from + frameSamples)
    let sum = 0
    for (let at = from; at < to; at += 1) {
      const value = samples[at]
      sum += value * value
    }
    frames[index] = to > from ? Math.sqrt(sum / (to - from)) : 0
  }

  return {
    frames,
    frameMs: safeFrameMs,
    durationMs: Math.round((samples.length / safeSampleRate) * 1000),
  }
}

export interface SnapBoundaryOptions {
  /** Search radius around the boundary, in milliseconds. */
  windowMs?: number
  /** Moves smaller than this are dropped. */
  minShiftMs?: number
  /** The boundary may not move before this time. */
  minMs?: number
  /** The boundary may not move past this time. */
  maxMs?: number
}

/**
 * The quietest point within `windowMs` of `timeMs`, or `timeMs` itself when
 * nothing nearby is quieter, the move would be under `minShiftMs`, or the
 * bounds leave no room. Ties go to the candidate closest to the original
 * boundary, so the result never drifts further than it has to.
 */
export function snapBoundaryMs(
  envelope: RmsEnvelope,
  timeMs: number,
  options: SnapBoundaryOptions = {},
): number {
  const frameCount = envelope.frames.length
  if (frameCount === 0) return timeMs
  if (!Number.isFinite(timeMs)) return timeMs

  const windowMs = Math.max(0, options.windowMs ?? SNAP_WINDOW_MS)
  const minShiftMs = Math.max(0, options.minShiftMs ?? MIN_SNAP_SHIFT_MS)
  const minMs = options.minMs ?? 0
  const maxMs = options.maxMs ?? envelope.durationMs

  const toFrame = (ms: number) => Math.round(ms / envelope.frameMs)
  const toMs = (frame: number) => frame * envelope.frameMs

  const centerFrame = toFrame(timeMs)
  if (centerFrame < 0 || centerFrame >= frameCount) return timeMs

  const radius = Math.floor(windowMs / envelope.frameMs)
  const lowFrame = Math.max(0, Math.max(centerFrame - radius, toFrame(minMs)))
  const highFrame = Math.min(frameCount - 1, Math.min(centerFrame + radius, toFrame(maxMs)))
  if (highFrame < lowFrame) return timeMs

  const centerEnergy = envelope.frames[Math.min(Math.max(centerFrame, 0), frameCount - 1)]
  let bestFrame = centerFrame
  let bestEnergy = centerEnergy
  let bestDistance = 0

  for (let frame = lowFrame; frame <= highFrame; frame += 1) {
    const energy = envelope.frames[frame]
    const distance = Math.abs(frame - centerFrame)
    if (energy < bestEnergy || (energy === bestEnergy && distance < bestDistance)) {
      bestFrame = frame
      bestEnergy = energy
      bestDistance = distance
    }
  }

  const snappedMs = toMs(bestFrame)
  if (Math.abs(snappedMs - timeMs) < minShiftMs) return timeMs
  if (snappedMs < minMs || snappedMs > maxMs) return timeMs
  return snappedMs
}

export interface SnapSegmentsOptions extends SnapBoundaryOptions {
  sampleRate: number
  frameMs?: number
}

/**
 * Snap every segment's start and end to a nearby quiet point. Segments stay in
 * order and keep a positive length: a boundary may not move past its
 * neighbours, and a snap that would collapse a segment is dropped.
 */
export function snapCaptionSegmentBoundaries(
  segments: readonly CaptionSegment[],
  samples: Float32Array,
  options: SnapSegmentsOptions,
): CaptionSegment[] {
  if (segments.length === 0 || samples.length === 0) return [...segments]
  const envelope = computeRmsEnvelope(samples, options.sampleRate, options.frameMs)
  if (envelope.frames.length === 0) return [...segments]

  const next = segments.map((segment) => ({ ...segment }))
  for (let index = 0; index < next.length; index += 1) {
    const segment = next[index]
    const startMs = segment.startSec * 1000
    const endMs = segment.endSec * 1000
    const previousEndMs = index > 0 ? next[index - 1].endSec * 1000 : 0
    const nextStartMs =
      index < next.length - 1 ? next[index + 1].startSec * 1000 : envelope.durationMs

    const snappedStartMs = snapBoundaryMs(envelope, startMs, {
      ...options,
      minMs: previousEndMs,
      maxMs: endMs,
    })
    const snappedEndMs = snapBoundaryMs(envelope, endMs, {
      ...options,
      minMs: snappedStartMs,
      maxMs: nextStartMs,
    })

    if (snappedEndMs > snappedStartMs) {
      segment.startSec = snappedStartMs / 1000
      segment.endSec = snappedEndMs / 1000
    }
  }

  return next
}
