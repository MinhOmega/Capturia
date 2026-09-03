import { describe, expect, it } from 'vitest'
import { findFreeGapAt, planDuplicateSpan } from './regionPlacement'

const totalMs = 10000

describe('findFreeGapAt', () => {
  it('returns the gap to the end when there are no regions', () => {
    const { ok, gapMs } = findFreeGapAt([], 2000, totalMs)
    expect(ok).toBe(true)
    expect(gapMs).toBe(8000)
  })

  it('rejects a playhead that lands inside an existing region', () => {
    const regions = [{ startMs: 1000, endMs: 4000 }]
    const { ok } = findFreeGapAt(regions, 2000, totalMs)
    expect(ok).toBe(false)
  })

  it("clamps the gap to the next region's start", () => {
    const regions = [{ startMs: 5000, endMs: 7000 }]
    const { ok, gapMs } = findFreeGapAt(regions, 2000, totalMs)
    expect(ok).toBe(true)
    expect(gapMs).toBe(3000)
  })

  it('rejects placement with no room before the end', () => {
    const { ok, gapMs } = findFreeGapAt([], totalMs, totalMs)
    expect(ok).toBe(false)
    expect(gapMs).toBe(0)
  })

  it("rejects placement that lands exactly on a region's startMs", () => {
    const regions = [{ startMs: 5000, endMs: 7000 }]
    const { ok } = findFreeGapAt(regions, 5000, totalMs)
    expect(ok).toBe(false)
  })

  it('allows placement adjacent to (exactly at the end of) an existing region', () => {
    const regions = [{ startMs: 0, endMs: 2000 }]
    const { ok, gapMs } = findFreeGapAt(regions, 2000, totalMs)
    expect(ok).toBe(true)
    expect(gapMs).toBe(8000)
  })

  it('sorts unordered regions before computing the next gap', () => {
    const regions = [
      { startMs: 8000, endMs: 9000 },
      { startMs: 3000, endMs: 4000 },
    ]
    const { ok, gapMs } = findFreeGapAt(regions, 1000, totalMs)
    expect(ok).toBe(true)
    expect(gapMs).toBe(2000)
  })
})

describe('planDuplicateSpan', () => {
  it('places the copy straight after the original with the same length', () => {
    expect(planDuplicateSpan({ startMs: 1000, endMs: 3000 }, totalMs)).toEqual({
      startMs: 3000,
      endMs: 5000,
    })
  })

  it('shortens the copy rather than running past the end of the recording', () => {
    expect(planDuplicateSpan({ startMs: 6000, endMs: 9000 }, totalMs)).toEqual({
      startMs: 9000,
      endMs: 10_000,
    })
  })

  it('shortens the copy rather than overlapping the next region', () => {
    const source = { startMs: 1000, endMs: 3000 }
    const siblings = [source, { startMs: 3500, endMs: 6000 }]
    expect(planDuplicateSpan(source, totalMs, siblings)).toEqual({ startMs: 3000, endMs: 3500 })
  })

  it('ignores the original when it is passed among the siblings', () => {
    const source = { startMs: 1000, endMs: 3000 }
    expect(planDuplicateSpan(source, totalMs, [source])).toEqual({ startMs: 3000, endMs: 5000 })
  })

  it('refuses when there is no room after the region', () => {
    // Ends exactly at the duration.
    expect(planDuplicateSpan({ startMs: 8000, endMs: 10_000 }, totalMs)).toBeNull()
    // Another region starts the instant this one ends.
    expect(
      planDuplicateSpan({ startMs: 1000, endMs: 3000 }, totalMs, [{ startMs: 3000, endMs: 4000 }]),
    ).toBeNull()
  })

  it('refuses a region with no length or an unknown duration', () => {
    expect(planDuplicateSpan({ startMs: 1000, endMs: 1000 }, totalMs)).toBeNull()
    expect(planDuplicateSpan({ startMs: 1000, endMs: 3000 }, Number.NaN)).toBeNull()
  })

  it('rounds the span to whole milliseconds', () => {
    expect(planDuplicateSpan({ startMs: 1000.4, endMs: 2999.6 }, totalMs)).toEqual({
      startMs: 3000,
      endMs: 4999,
    })
  })
})
