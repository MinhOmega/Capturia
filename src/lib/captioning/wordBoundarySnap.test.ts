import { describe, expect, it } from 'vitest'
import type { CaptionSegment } from './transcribe'
import {
  computeRmsEnvelope,
  MIN_SNAP_SHIFT_MS,
  RMS_FRAME_MS,
  snapBoundaryMs,
  snapCaptionSegmentBoundaries,
  SNAP_WINDOW_MS,
} from './wordBoundarySnap'

const SAMPLE_RATE = 16_000

/**
 * A buffer of `loudRanges` (in ms) at amplitude 1 and silence everywhere else,
 * so the RMS envelope has exact, checkable edges.
 */
function tone(durationMs: number, loudRanges: Array<[number, number]>): Float32Array {
  const samples = new Float32Array(Math.round((durationMs * SAMPLE_RATE) / 1000))
  for (const [fromMs, toMs] of loudRanges) {
    const from = Math.round((fromMs * SAMPLE_RATE) / 1000)
    const to = Math.round((toMs * SAMPLE_RATE) / 1000)
    for (let at = from; at < Math.min(to, samples.length); at += 1) {
      samples[at] = at % 2 === 0 ? 0.9 : -0.9
    }
  }
  return samples
}

describe('computeRmsEnvelope', () => {
  it('measures one frame per frameMs of audio', () => {
    const envelope = computeRmsEnvelope(tone(100, []), SAMPLE_RATE, 10)
    expect(envelope.frames).toHaveLength(10)
    expect(envelope.frameMs).toBe(10)
    expect(envelope.durationMs).toBe(100)
  })

  it('is loud inside a tone and silent outside it', () => {
    const envelope = computeRmsEnvelope(tone(100, [[30, 60]]), SAMPLE_RATE, 10)
    expect(envelope.frames[0]).toBe(0)
    expect(envelope.frames[4]).toBeCloseTo(0.9, 3)
    expect(envelope.frames[9]).toBe(0)
  })

  it('measures a trailing partial frame over the samples it has', () => {
    // 25 ms of audio at a 10 ms frame: three frames, the last one half-length.
    const envelope = computeRmsEnvelope(tone(25, [[0, 25]]), SAMPLE_RATE, 10)
    expect(envelope.frames).toHaveLength(3)
    expect(envelope.frames[2]).toBeCloseTo(0.9, 3)
  })

  it('survives an empty buffer and a nonsense frame length', () => {
    expect(computeRmsEnvelope(new Float32Array(0), SAMPLE_RATE).frames).toHaveLength(0)
    expect(computeRmsEnvelope(tone(50, []), SAMPLE_RATE, 0).frameMs).toBe(1)
  })

  it('defaults to a 10 ms frame', () => {
    expect(computeRmsEnvelope(tone(100, []), SAMPLE_RATE).frameMs).toBe(RMS_FRAME_MS)
  })
})

describe('snapBoundaryMs', () => {
  // Speech from 0-200 ms, a gap to 300 ms, speech again to 500 ms.
  const envelope = computeRmsEnvelope(
    tone(500, [
      [0, 200],
      [300, 500],
    ]),
    SAMPLE_RATE,
  )

  it('pulls a boundary that landed inside a word out to the gap', () => {
    // A snapped boundary is the *start* of the quiet frame it picked: the first
    // silent frame after speech stops at 200 ms, and the last silent frame
    // before speech resumes at 300 ms (290-300 ms).
    expect(snapBoundaryMs(envelope, 180)).toBe(200)
    expect(snapBoundaryMs(envelope, 330)).toBe(290)
  })

  it('leaves a boundary already in the quiet part alone', () => {
    expect(snapBoundaryMs(envelope, 250)).toBe(250)
  })

  it('does not move a boundary by less than the minimum shift', () => {
    // 195 ms is 5 ms from the gap: real, but below the threshold.
    expect(snapBoundaryMs(envelope, 195)).toBe(195)
    expect(snapBoundaryMs(envelope, 195, { minShiftMs: 0 })).toBe(200)
    expect(MIN_SNAP_SHIFT_MS).toBe(20)
  })

  it('does not look further than the window', () => {
    // 400 ms is 100 ms from the gap's far edge; with a 30 ms window there is
    // nothing quieter in reach.
    expect(snapBoundaryMs(envelope, 400, { windowMs: 30 })).toBe(400)
    expect(SNAP_WINDOW_MS).toBe(150)
  })

  it('respects the bounds a caller imposes', () => {
    expect(snapBoundaryMs(envelope, 180, { maxMs: 190 })).toBe(180)
    expect(snapBoundaryMs(envelope, 330, { minMs: 320 })).toBe(330)
  })

  it('prefers the nearest of two equally quiet points', () => {
    // The whole gap is silent; from 260 ms the nearest silent frame is itself,
    // and from 210 ms the nearest quiet frame is 210 ms too.
    expect(snapBoundaryMs(envelope, 260)).toBe(260)
  })

  it('returns the input for an empty envelope, a NaN time and an out-of-range time', () => {
    const empty = computeRmsEnvelope(new Float32Array(0), SAMPLE_RATE)
    expect(snapBoundaryMs(empty, 100)).toBe(100)
    expect(snapBoundaryMs(envelope, Number.NaN)).toBeNaN()
    expect(snapBoundaryMs(envelope, 9_000)).toBe(9_000)
    expect(snapBoundaryMs(envelope, -50)).toBe(-50)
  })
})

describe('snapCaptionSegmentBoundaries', () => {
  const samples = tone(1000, [
    [0, 200],
    [300, 500],
    [600, 900],
  ])

  function segment(startSec: number, endSec: number, text = 'word'): CaptionSegment {
    return { startSec, endSec, text }
  }

  it('moves both ends of a segment to the surrounding gaps', () => {
    const [snapped] = snapCaptionSegmentBoundaries([segment(0.33, 0.48)], samples, {
      sampleRate: SAMPLE_RATE,
    })
    expect(snapped.startSec).toBeCloseTo(0.29, 5)
    expect(snapped.endSec).toBeCloseTo(0.5, 5)
  })

  it('keeps the text untouched', () => {
    const [snapped] = snapCaptionSegmentBoundaries([segment(0.33, 0.48, 'hello')], samples, {
      sampleRate: SAMPLE_RATE,
    })
    expect(snapped.text).toBe('hello')
  })

  it('never lets a boundary cross a neighbour', () => {
    const snapped = snapCaptionSegmentBoundaries(
      [segment(0.31, 0.49), segment(0.5, 0.62)],
      samples,
      { sampleRate: SAMPLE_RATE },
    )
    expect(snapped[0].endSec).toBeLessThanOrEqual(snapped[1].startSec)
    expect(snapped[0].startSec).toBeLessThan(snapped[0].endSec)
  })

  it('leaves a segment alone rather than collapsing it', () => {
    const input = [segment(0.29, 0.305)]
    const [snapped] = snapCaptionSegmentBoundaries(input, samples, { sampleRate: SAMPLE_RATE })
    expect(snapped.endSec).toBeGreaterThan(snapped.startSec)
  })

  it('returns a copy, never the input objects', () => {
    const input = [segment(0.33, 0.48)]
    const snapped = snapCaptionSegmentBoundaries(input, samples, { sampleRate: SAMPLE_RATE })
    expect(snapped[0]).not.toBe(input[0])
    expect(input[0].startSec).toBeCloseTo(0.33, 5)
  })

  it('is a no-op for empty input', () => {
    expect(snapCaptionSegmentBoundaries([], samples, { sampleRate: SAMPLE_RATE })).toEqual([])
    expect(
      snapCaptionSegmentBoundaries([segment(0, 1)], new Float32Array(0), {
        sampleRate: SAMPLE_RATE,
      }),
    ).toEqual([segment(0, 1)])
  })

  it('leaves boundaries alone in continuous speech with no gap to find', () => {
    const continuous = tone(1000, [[0, 1000]])
    const input = [segment(0.3, 0.6)]
    const snapped = snapCaptionSegmentBoundaries(input, continuous, { sampleRate: SAMPLE_RATE })
    expect(snapped[0].startSec).toBeCloseTo(0.3, 5)
    expect(snapped[0].endSec).toBeCloseTo(0.6, 5)
  })
})
