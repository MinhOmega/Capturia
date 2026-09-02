import { describe, expect, it } from 'vitest'
import type { VideoSegment } from '@/components/video-editor/types'
import { computeNormalizationFactor, computeWaveformColumns } from './waveformColumns'

/**
 * 10 s of source audio at 1 block per 100 ms (N = 100). Only the block covering
 * 4.0–4.1 s (source) is loud; everything else is silent.
 */
function makePeaks(loudBlock: number, blocks = 100): Float32Array {
  const peaks = new Float32Array(blocks * 2)
  peaks[loudBlock * 2] = -0.5
  peaks[loudBlock * 2 + 1] = 0.5
  return peaks
}

const SOURCE_MS = 10000

describe('computeNormalizationFactor', () => {
  it('is 0 for empty or silent peaks', () => {
    expect(computeNormalizationFactor(null)).toBe(0)
    expect(computeNormalizationFactor(new Float32Array(4))).toBe(0)
  })

  it('is 1 over the loudest absolute peak', () => {
    expect(computeNormalizationFactor(new Float32Array([-0.25, 0.1, 0, 0.5]))).toBe(2)
  })
})

describe('computeWaveformColumns', () => {
  it('returns zeros for degenerate input', () => {
    const cols = computeWaveformColumns({
      peaks: makePeaks(40),
      sourceDurationMs: SOURCE_MS,
      rangeStartMs: 0,
      rangeEndMs: 0,
      width: 10,
    })
    expect(Array.from(cols)).toEqual(new Array(10).fill(0))
  })

  it('maps columns 1:1 to source time without segments', () => {
    // 100 columns over 10 s -> one column per 100 ms block
    const cols = computeWaveformColumns({
      peaks: makePeaks(40),
      sourceDurationMs: SOURCE_MS,
      rangeStartMs: 0,
      rangeEndMs: SOURCE_MS,
      width: 100,
    })
    const loudCols = Array.from(cols)
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0)
    expect(loudCols).toContain(40)
    expect(Math.min(...loudCols)).toBeGreaterThanOrEqual(39)
    expect(Math.max(...loudCols)).toBeLessThanOrEqual(41)
    expect(cols[40]).toBeCloseTo(1, 5)
  })

  it('shifts the waveform left when an earlier segment is deleted', () => {
    // Delete 0–2 s: source 4.0 s is now effective 2.0 s
    const segments: VideoSegment[] = [
      { id: 'a', startMs: 0, endMs: 2000, speed: 1, deleted: true },
      { id: 'b', startMs: 2000, endMs: 10000, speed: 1, deleted: false },
    ]
    const effectiveMs = 8000
    const cols = computeWaveformColumns({
      peaks: makePeaks(40),
      sourceDurationMs: SOURCE_MS,
      rangeStartMs: 0,
      rangeEndMs: effectiveMs,
      width: 80, // 100 ms per column
      segments,
    })
    const loudCols = Array.from(cols)
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0)
    expect(loudCols).toContain(20)
    expect(loudCols).not.toContain(40)
  })

  it('compresses the waveform inside a 2x segment after a split', () => {
    // Split at 2 s; the second segment plays at 2x. Effective duration = 2 + 4 = 6 s.
    // Source 4.0 s -> effective 2 + (4 - 2) / 2 = 3.0 s.
    const segments: VideoSegment[] = [
      { id: 'a', startMs: 0, endMs: 2000, speed: 1, deleted: false },
      { id: 'b', startMs: 2000, endMs: 10000, speed: 2, deleted: false },
    ]
    const effectiveMs = 6000
    const cols = computeWaveformColumns({
      peaks: makePeaks(40),
      sourceDurationMs: SOURCE_MS,
      rangeStartMs: 0,
      rangeEndMs: effectiveMs,
      width: 60, // 100 ms per column
      segments,
    })
    const loudCols = Array.from(cols)
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0)
    expect(loudCols).toContain(30)
    expect(loudCols.every((i) => i >= 29 && i <= 31)).toBe(true)
  })

  it('honours the visible range (zoomed / panned window)', () => {
    // Window 3–5 s effective, no segments, 20 columns of 100 ms; source 4.0 s -> column 10
    const cols = computeWaveformColumns({
      peaks: makePeaks(40),
      sourceDurationMs: SOURCE_MS,
      rangeStartMs: 3000,
      rangeEndMs: 5000,
      width: 20,
    })
    expect(cols[10]).toBeGreaterThan(0)
    expect(cols[0]).toBe(0)
    expect(cols[19]).toBe(0)
  })
})
