import { describe, expect, it } from 'vitest'
import type { VideoSegment } from '@/components/video-editor/types'
import { adjacentMarkerMs, markersToEffectiveMs } from './recordingMarkers'

const segment = (
  id: string,
  startMs: number,
  endMs: number,
  extra: Partial<VideoSegment> = {},
): VideoSegment => ({ id, startMs, endMs, deleted: false, speed: 1, ...extra })

describe('markersToEffectiveMs', () => {
  it('returns nothing for a recording that has no markers', () => {
    expect(markersToEffectiveMs(undefined, [], [])).toEqual([])
    expect(markersToEffectiveMs([], [], [])).toEqual([])
  })

  it('passes markers through untouched when nothing is trimmed', () => {
    expect(markersToEffectiveMs([2_000, 500, 500], [], [])).toEqual([500, 2_000])
  })

  it('drops non-finite and negative times', () => {
    expect(markersToEffectiveMs([Number.NaN, -1, 100], [], [])).toEqual([100])
  })

  it('shifts markers back past a trimmed stretch and drops the ones inside it', () => {
    const trims = [{ startMs: 1_000, endMs: 2_000 }]
    expect(markersToEffectiveMs([500, 1_500, 2_500], [], trims)).toEqual([500, 1_500])
  })

  it('follows segment speed and drops markers inside a deleted segment', () => {
    const segments = [
      segment('a', 0, 1_000),
      segment('b', 1_000, 2_000, { deleted: true }),
      // Twice as fast: 1 000 ms of source becomes 500 ms of timeline.
      segment('c', 2_000, 4_000, { speed: 2 }),
    ]
    expect(markersToEffectiveMs([500, 1_500, 3_000], segments, [])).toEqual([500, 1_500])
  })
})

describe('adjacentMarkerMs', () => {
  const markers = [500, 1_500, 4_000]

  it('finds the next and previous marker', () => {
    expect(adjacentMarkerMs(markers, 0, 'next')).toBe(500)
    expect(adjacentMarkerMs(markers, 600, 'next')).toBe(1_500)
    expect(adjacentMarkerMs(markers, 4_000, 'previous')).toBe(1_500)
    expect(adjacentMarkerMs(markers, 1_400, 'previous')).toBe(500)
  })

  it('answers null at either end and for a recording without markers', () => {
    expect(adjacentMarkerMs(markers, 4_000, 'next')).toBeNull()
    expect(adjacentMarkerMs(markers, 500, 'previous')).toBeNull()
    expect(adjacentMarkerMs([], 0, 'next')).toBeNull()
    expect(adjacentMarkerMs(markers, Number.NaN, 'next')).toBeNull()
  })

  it('does not land back on the marker the playhead just seeked to', () => {
    // A seek can round the time by a millisecond or two; without the epsilon
    // the next jump would return the marker it is already sitting on.
    expect(adjacentMarkerMs(markers, 1_502, 'next')).toBe(4_000)
    expect(adjacentMarkerMs(markers, 1_498, 'previous')).toBe(500)
  })
})
