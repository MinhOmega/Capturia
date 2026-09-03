import { describe, expect, it } from 'vitest'
import { shiftTrimRegionsMsForCaptionBuffer, trimLeadingSilenceMono16k } from './leadingSilence'

const RATE = 16_000

function withSpeechAt(startSec: number, totalSec: number): Float32Array {
  const out = new Float32Array(Math.round(totalSec * RATE))
  for (let i = Math.round(startSec * RATE); i < out.length; i++) {
    out[i] = 0.3 * Math.sin(i / 20)
  }
  return out
}

describe('trimLeadingSilenceMono16k', () => {
  it('leaves audio untouched when speech starts immediately', () => {
    const samples = withSpeechAt(0, 1)
    const result = trimLeadingSilenceMono16k(samples)
    expect(result.trimSec).toBe(0)
    expect(result.samples).toBe(samples)
  })

  it('drops the silent prefix but keeps a short pre-roll before the first peak', () => {
    const samples = withSpeechAt(2, 3)
    const result = trimLeadingSilenceMono16k(samples)
    // First 50 ms window with a peak starts at 2.0 s; pre-roll is 120 ms.
    expect(result.trimSec).toBeCloseTo(2 - 0.12, 2)
    expect(result.samples.length).toBe(samples.length - Math.round(result.trimSec * RATE))
  })

  it('keeps fully silent audio (nothing to anchor on)', () => {
    const samples = new Float32Array(RATE)
    const result = trimLeadingSilenceMono16k(samples)
    expect(result.trimSec).toBe(0)
    expect(result.samples.length).toBe(RATE)
  })

  it('ignores buffers shorter than one analysis window', () => {
    const samples = new Float32Array(100).fill(0.5)
    expect(trimLeadingSilenceMono16k(samples)).toEqual({ samples, trimSec: 0 })
  })
})

describe('shiftTrimRegionsMsForCaptionBuffer', () => {
  it('shifts regions left and drops the ones that collapse', () => {
    const regions = [
      { id: 'a', startMs: 0, endMs: 500 },
      { id: 'b', startMs: 800, endMs: 2_000 },
    ]
    expect(shiftTrimRegionsMsForCaptionBuffer(regions, 1_000)).toEqual([
      { id: 'b', startMs: 0, endMs: 1_000 },
    ])
  })

  it('returns the same array when nothing was trimmed', () => {
    const regions = [{ id: 'a', startMs: 0, endMs: 500 }]
    expect(shiftTrimRegionsMsForCaptionBuffer(regions, 0)).toBe(regions)
  })
})
