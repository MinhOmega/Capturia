import { describe, expect, it } from 'vitest'
import type { TrimRegion, VideoSegment } from '@/components/video-editor/types'
import { getEffectiveDurationMsWithSegments } from '@/lib/trim/timeMapping'
import {
  buildDecodeTimelinePlan,
  getSpeedTimelineDurationSec,
  segmentsToSpeedTimeline,
} from './segmentAdapter'
import { computeExportMetrics } from './streamingDecoder'
import { buildSpeedSegments, type SpeedTimelineSegment } from './timelineSegments'

function seg(startMs: number, endMs: number, speed = 1, deleted = false): VideoSegment {
  return { id: `seg-${startMs}-${endMs}`, startMs, endMs, deleted, speed }
}

function trim(startMs: number, endMs: number): TrimRegion {
  return { id: `trim-${startMs}-${endMs}`, startMs, endMs }
}

function expectTimelineClose(actual: SpeedTimelineSegment[], expected: SpeedTimelineSegment[]) {
  expect(actual).toHaveLength(expected.length)
  actual.forEach((segment, index) => {
    expect(segment.startSec).toBeCloseTo(expected[index].startSec, 9)
    expect(segment.endSec).toBeCloseTo(expected[index].endSec, 9)
    expect(segment.speed).toBe(expected[index].speed)
  })
}

describe('segmentsToSpeedTimeline', () => {
  it('returns the whole source at 1x when nothing is edited', () => {
    expect(segmentsToSpeedTimeline(undefined, undefined, 10)).toEqual([
      { startSec: 0, endSec: 10, speed: 1 },
    ])
    expect(segmentsToSpeedTimeline([], [], 10)).toEqual([{ startSec: 0, endSec: 10, speed: 1 }])
  })

  it('returns nothing for a zero or invalid duration', () => {
    expect(segmentsToSpeedTimeline(undefined, undefined, 0)).toEqual([])
    expect(segmentsToSpeedTimeline(undefined, undefined, Number.NaN)).toEqual([])
  })

  it('applies the global playback speed when no segments are set', () => {
    expect(segmentsToSpeedTimeline(undefined, undefined, 10, 2)).toEqual([
      { startSec: 0, endSec: 10, speed: 2 },
    ])
  })

  it('clamps the global playback speed to the seek path floor and ignores invalid values', () => {
    expect(segmentsToSpeedTimeline(undefined, undefined, 10, 0.1)[0].speed).toBe(0.25)
    expect(segmentsToSpeedTimeline(undefined, undefined, 10, Number.NaN)[0].speed).toBe(1)
    expect(segmentsToSpeedTimeline(undefined, undefined, 10, 0)[0].speed).toBe(1)
  })

  it('keeps the non-trimmed spans with the global speed when only trims are set', () => {
    expect(
      segmentsToSpeedTimeline(undefined, [trim(2000, 4000), trim(8000, 10000)], 10, 1.5),
    ).toEqual([
      { startSec: 0, endSec: 2, speed: 1.5 },
      { startSec: 4, endSec: 8, speed: 1.5 },
    ])
  })

  it('drops deleted segments and carries per-segment speed', () => {
    const segments = [seg(0, 2000), seg(2000, 4000, 1, true), seg(4000, 7000, 2), seg(7000, 10000)]
    expect(segmentsToSpeedTimeline(segments, undefined, 10)).toEqual([
      { startSec: 0, endSec: 2, speed: 1 },
      { startSec: 4, endSec: 7, speed: 2 },
      { startSec: 7, endSec: 10, speed: 1 },
    ])
  })

  it('ignores the global playback speed once segments are present', () => {
    expect(segmentsToSpeedTimeline([seg(0, 10000)], undefined, 10, 4)).toEqual([
      { startSec: 0, endSec: 10, speed: 1 },
    ])
  })

  it('intersects segments with the non-trimmed part of the source', () => {
    const segments = [seg(0, 5000, 2), seg(5000, 10000)]
    expect(segmentsToSpeedTimeline(segments, [trim(4000, 6000)], 10)).toEqual([
      { startSec: 0, endSec: 4, speed: 2 },
      { startSec: 6, endSec: 10, speed: 1 },
    ])
  })

  it('merges adjacent segments that share a speed', () => {
    const segments = [seg(0, 3000), seg(3000, 6000), seg(6000, 8000, 3), seg(8000, 10000, 3)]
    expect(segmentsToSpeedTimeline(segments, undefined, 10)).toEqual([
      { startSec: 0, endSec: 6, speed: 1 },
      { startSec: 6, endSec: 10, speed: 3 },
    ])
  })

  it('clamps segments to the source duration and drops slivers', () => {
    const segments = [seg(0, 9999), seg(9999, 12000, 2)]
    expect(segmentsToSpeedTimeline(segments, undefined, 10)).toEqual([
      { startSec: 0, endSec: 9.999, speed: 1 },
      { startSec: 9.999, endSec: 10, speed: 2 },
    ])
    // Everything past the source end is gone; a 0.05 ms crumb is dropped.
    expect(segmentsToSpeedTimeline([seg(0, 9999.95), seg(9999.95, 10000)], undefined, 10)).toEqual([
      { startSec: 0, endSec: 9.99995, speed: 1 },
    ])
  })

  it('sorts unordered segments and sanitises invalid speeds', () => {
    const segments = [seg(5000, 10000, Number.NaN), seg(0, 5000, 0)]
    expect(segmentsToSpeedTimeline(segments, undefined, 10)).toEqual([
      { startSec: 0, endSec: 10, speed: 1 },
    ])
  })

  it('returns an empty timeline when every segment is deleted', () => {
    expect(segmentsToSpeedTimeline([seg(0, 10000, 1, true)], undefined, 10)).toEqual([])
  })
})

describe('effective duration parity with the seek path', () => {
  const fixtures: { name: string; segments: VideoSegment[] }[] = [
    { name: 'plain partition', segments: [seg(0, 4000), seg(4000, 10000)] },
    {
      name: 'deleted middle',
      segments: [seg(0, 2000), seg(2000, 5000, 1, true), seg(5000, 10000)],
    },
    {
      name: 'mixed speeds',
      segments: [seg(0, 2000, 0.5), seg(2000, 6000, 2), seg(6000, 10000, 4)],
    },
    {
      name: 'deleted + speed',
      segments: [seg(0, 3000, 1, true), seg(3000, 8000, 1.5), seg(8000, 10000, 1, true)],
    },
  ]

  for (const fixture of fixtures) {
    it(`matches getEffectiveDurationMsWithSegments for ${fixture.name}`, () => {
      const timeline = segmentsToSpeedTimeline(fixture.segments, undefined, 10)
      const expectedSec = getEffectiveDurationMsWithSegments(fixture.segments) / 1000
      expect(getSpeedTimelineDurationSec(timeline)).toBeCloseTo(expectedSec, 9)

      const plan = buildDecodeTimelinePlan({ segments: fixture.segments, sourceDurationMs: 10000 })
      const metrics = computeExportMetrics(10, 30, plan.trimRegions, plan.speedRegions)
      expect(metrics.effectiveDuration).toBeCloseTo(expectedSec, 9)
    })
  }

  it('matches (total - trimmed) / speed for the legacy trims + global speed model', () => {
    const trims = [trim(1000, 2000), trim(6000, 9000)]
    const plan = buildDecodeTimelinePlan({
      trimRegions: trims,
      playbackSpeed: 2,
      sourceDurationMs: 10000,
    })
    const expectedSec = (10000 - 1000 - 3000) / 2 / 1000
    expect(getSpeedTimelineDurationSec(plan.segments)).toBeCloseTo(expectedSec, 9)
    const metrics = computeExportMetrics(10, 60, plan.trimRegions, plan.speedRegions)
    expect(metrics.effectiveDuration).toBeCloseTo(expectedSec, 9)
    // Single kept speed => the decoder emits the same count the seek path computes.
    expect(metrics.totalFrames).toBe(Math.ceil((expectedSec - 0.001) * 60))
  })

  it('never emits fewer frames than the seek path estimate for a multi-segment edit', () => {
    const segments = [
      seg(0, 1500, 2),
      seg(1500, 4000),
      seg(4000, 4500, 1, true),
      seg(4500, 10000, 0.5),
    ]
    const plan = buildDecodeTimelinePlan({ segments, sourceDurationMs: 10000 })
    const metrics = computeExportMetrics(10, 30, plan.trimRegions, plan.speedRegions)
    const seekEstimate = Math.ceil((getEffectiveDurationMsWithSegments(segments) / 1000) * 30)
    expect(metrics.totalFrames).toBeGreaterThanOrEqual(seekEstimate - 1)
    expect(metrics.totalFrames).toBeLessThanOrEqual(seekEstimate + plan.segments.length)
  })
})

describe('buildDecodeTimelinePlan', () => {
  it('round-trips through the decoder segment builder', () => {
    const cases: DecodeCase[] = [
      { segments: [seg(0, 2000), seg(2000, 4000, 1, true), seg(4000, 7000, 2), seg(7000, 10000)] },
      { segments: [seg(0, 10000)] },
      { segments: [seg(0, 3000, 1, true), seg(3000, 10000, 3)] },
      { trimRegions: [trim(500, 1500)], playbackSpeed: 1 },
      { trimRegions: [trim(0, 1000), trim(9000, 10000)], playbackSpeed: 2 },
      { segments: [seg(0, 5000, 2), seg(5000, 10000)], trimRegions: [trim(4000, 6000)] },
    ]

    for (const testCase of cases) {
      const plan = buildDecodeTimelinePlan({ ...testCase, sourceDurationMs: 10000 })
      const rebuilt = buildSpeedSegments(10, plan.trimRegions, plan.speedRegions)
      expectTimelineClose(rebuilt, plan.segments)
    }
  })

  it('emits no regions for an unedited source', () => {
    const plan = buildDecodeTimelinePlan({ sourceDurationMs: 10000 })
    expect(plan.trimRegions).toEqual([])
    expect(plan.speedRegions).toEqual([])
    expect(plan.segments).toEqual([{ startSec: 0, endSec: 10, speed: 1 }])
  })

  it('trims the tail when the decoder reports more than the resolved source duration', () => {
    const plan = buildDecodeTimelinePlan({ sourceDurationMs: 9500, decoderDurationSec: 10 })
    expect(plan.segments).toEqual([{ startSec: 0, endSec: 9.5, speed: 1 }])
    expect(plan.trimRegions).toEqual([{ id: 'decode-trim-tail', startMs: 9500, endMs: 10000 }])
    expectTimelineClose(buildSpeedSegments(10, plan.trimRegions, plan.speedRegions), plan.segments)
  })

  it('never extends the edit past the decoder duration', () => {
    const plan = buildDecodeTimelinePlan({ sourceDurationMs: 12000, decoderDurationSec: 10 })
    expect(plan.segments).toEqual([{ startSec: 0, endSec: 10, speed: 1 }])
    expect(plan.trimRegions).toEqual([])
  })

  it('turns every deleted segment into a trim and every non-1x span into a speed region', () => {
    const plan = buildDecodeTimelinePlan({
      segments: [seg(0, 2000), seg(2000, 4000, 1, true), seg(4000, 7000, 2), seg(7000, 10000)],
      sourceDurationMs: 10000,
    })
    expect(plan.trimRegions).toEqual([{ id: 'decode-trim-1', startMs: 2000, endMs: 4000 }])
    expect(plan.speedRegions).toEqual([
      { id: 'decode-speed-1', startMs: 4000, endMs: 7000, speed: 2 },
    ])
  })
})

type DecodeCase = {
  segments?: VideoSegment[]
  trimRegions?: TrimRegion[]
  playbackSpeed?: number
}
