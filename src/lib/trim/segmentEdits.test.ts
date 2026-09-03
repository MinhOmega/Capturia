import { describe, expect, it } from 'vitest'

import type { VideoSegment } from '@/components/video-editor/types'
import { MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from '@/components/video-editor/types'

import {
  applySpeedToAllSegments,
  isSingleFullLengthSegment,
  resetAllSegmentEdits,
} from './segmentEdits'

function segment(overrides: Partial<VideoSegment> = {}): VideoSegment {
  return { id: 'seg-1', startMs: 0, endMs: 1000, deleted: false, speed: 1, ...overrides }
}

describe('applySpeedToAllSegments', () => {
  it('gives every segment the same speed, deleted ones included', () => {
    const segments = [
      segment({ id: 'seg-1', speed: 1 }),
      segment({ id: 'seg-2', startMs: 1000, endMs: 2000, speed: 2 }),
      segment({ id: 'seg-3', startMs: 2000, endMs: 3000, speed: 0.5, deleted: true }),
    ]

    const next = applySpeedToAllSegments(segments, 1.5)

    expect(next.map((s) => s.speed)).toEqual([1.5, 1.5, 1.5])
    // Nothing but the speed moves.
    expect(next.map((s) => [s.id, s.startMs, s.endMs, s.deleted])).toEqual(
      segments.map((s) => [s.id, s.startMs, s.endMs, s.deleted]),
    )
  })

  it('clamps to the supported speed range', () => {
    expect(applySpeedToAllSegments([segment()], 1000)[0].speed).toBe(MAX_PLAYBACK_SPEED)
    expect(applySpeedToAllSegments([segment()], 0)[0].speed).toBe(MIN_PLAYBACK_SPEED)
  })

  it('returns the same array when every segment already has the speed', () => {
    const segments = [segment({ speed: 2 }), segment({ id: 'seg-2', speed: 2 })]
    expect(applySpeedToAllSegments(segments, 2)).toBe(segments)
  })

  it('keeps the objects of the segments that already match', () => {
    const settled = segment({ id: 'seg-1', speed: 2 })
    const next = applySpeedToAllSegments([settled, segment({ id: 'seg-2', speed: 1 })], 2)
    expect(next[0]).toBe(settled)
    expect(next[1].speed).toBe(2)
  })
})

describe('resetAllSegmentEdits', () => {
  it('replaces every trim, cut and speed with one full-length segment', () => {
    const segments = [
      segment({ id: 'seg-1', startMs: 0, endMs: 400, speed: 2 }),
      segment({ id: 'seg-2', startMs: 400, endMs: 900, deleted: true }),
      segment({ id: 'seg-3', startMs: 900, endMs: 3000, speed: 0.5 }),
    ]

    expect(resetAllSegmentEdits(segments, 3000, 'seg-9')).toEqual([
      { id: 'seg-9', startMs: 0, endMs: 3000, deleted: false, speed: 1 },
    ])
  })

  it('rounds the duration to whole milliseconds', () => {
    expect(resetAllSegmentEdits([segment()], 2999.6, 'seg-9')[0].endMs).toBe(3000)
  })

  it('returns the same array when the timeline is already one untouched segment', () => {
    const segments = [segment({ id: 'seg-1', startMs: 0, endMs: 3000 })]
    expect(resetAllSegmentEdits(segments, 3000, 'seg-9')).toBe(segments)
  })

  it('does nothing when the duration is not known yet', () => {
    const segments = [segment()]
    expect(resetAllSegmentEdits(segments, 0, 'seg-9')).toBe(segments)
    expect(resetAllSegmentEdits(segments, Number.NaN, 'seg-9')).toBe(segments)
  })

  it('isSingleFullLengthSegment only accepts the exact untouched shape', () => {
    expect(isSingleFullLengthSegment([segment({ endMs: 3000 })], 3000)).toBe(true)
    expect(isSingleFullLengthSegment([segment({ endMs: 3000, speed: 2 })], 3000)).toBe(false)
    expect(isSingleFullLengthSegment([segment({ endMs: 3000, deleted: true })], 3000)).toBe(false)
    expect(isSingleFullLengthSegment([segment({ startMs: 10, endMs: 3000 })], 3000)).toBe(false)
    expect(isSingleFullLengthSegment([segment({ endMs: 2000 })], 3000)).toBe(false)
    expect(isSingleFullLengthSegment([segment(), segment({ id: 'seg-2' })], 3000)).toBe(false)
  })
})
