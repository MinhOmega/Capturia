import { describe, expect, it } from 'vitest'

import {
  arraysShallowEqual,
  editorSnapshotsEqual,
  zoomRegionsByAspectShallowEqual,
  type EditorSnapshot,
} from './editorHistory'
import type { AnnotationRegion, AudioEditRegion, VideoSegment, ZoomRegion } from './types'
import type { SubtitleCue } from '@/lib/analysis/types'

const segment: VideoSegment = { id: 'seg-1', startMs: 0, endMs: 1000, deleted: false, speed: 1 }
const zoom: ZoomRegion = {
  id: 'zoom-1',
  startMs: 0,
  endMs: 500,
  depth: 3,
  focus: { cx: 0.5, cy: 0.5 },
}
const annotation = { id: 'annotation-1', startMs: 0, endMs: 500 } as unknown as AnnotationRegion
const audioEdit: AudioEditRegion = {
  id: 'audio-1',
  startMs: 0,
  endMs: 500,
  mode: 'mute',
  gain: 0,
}
const subtitleCue: SubtitleCue = {
  id: 'subtitle-1',
  startMs: 0,
  endMs: 500,
  text: 'hello',
  source: 'asr',
}

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    segments: [segment],
    zoomRegionsByAspect: { '16:9': [zoom] },
    annotationRegions: [annotation],
    audioEditRegions: [audioEdit],
    subtitleCues: [subtitleCue],
    ...overrides,
  }
}

describe('arraysShallowEqual', () => {
  it('is true for the same array and for equal element identities', () => {
    const items = [segment]
    expect(arraysShallowEqual(items, items)).toBe(true)
    expect(arraysShallowEqual(items, [segment])).toBe(true)
    expect(arraysShallowEqual([], [])).toBe(true)
  })

  it('is false for a different length or a replaced element', () => {
    expect(arraysShallowEqual([segment], [])).toBe(false)
    expect(arraysShallowEqual([segment], [{ ...segment }])).toBe(false)
  })
})

describe('zoomRegionsByAspectShallowEqual', () => {
  it('is true when every aspect holds the same regions, however the map was rebuilt', () => {
    const regions = [zoom]
    expect(zoomRegionsByAspectShallowEqual({ '16:9': regions }, { '16:9': regions })).toBe(true)
    expect(zoomRegionsByAspectShallowEqual({ '16:9': [zoom] }, { '16:9': [zoom] })).toBe(true)
  })

  it('is false when an aspect is added, removed or edited', () => {
    expect(zoomRegionsByAspectShallowEqual({ '16:9': [zoom] }, {})).toBe(false)
    expect(
      zoomRegionsByAspectShallowEqual({ '16:9': [zoom] }, { '16:9': [zoom], '9:16': [] }),
    ).toBe(false)
    expect(
      zoomRegionsByAspectShallowEqual({ '16:9': [zoom] }, { '16:9': [{ ...zoom, depth: 5 }] }),
    ).toBe(false)
  })
})

describe('editorSnapshotsEqual', () => {
  it('treats a rebuilt-but-unchanged snapshot as no edit at all', () => {
    // What a `prev.map(region => region)` or a rebuilt per-aspect map produces:
    // fresh containers around the very same region objects.
    expect(editorSnapshotsEqual(snapshot(), snapshot())).toBe(true)
  })

  it('sees an edit in any one of the five tracks', () => {
    expect(editorSnapshotsEqual(snapshot(), snapshot({ segments: [{ ...segment }] }))).toBe(false)
    expect(
      editorSnapshotsEqual(snapshot(), snapshot({ zoomRegionsByAspect: { '16:9': [] } })),
    ).toBe(false)
    expect(editorSnapshotsEqual(snapshot(), snapshot({ annotationRegions: [] }))).toBe(false)
    expect(editorSnapshotsEqual(snapshot(), snapshot({ audioEditRegions: [] }))).toBe(false)
    expect(editorSnapshotsEqual(snapshot(), snapshot({ subtitleCues: [] }))).toBe(false)
    expect(editorSnapshotsEqual(snapshot(), snapshot({ subtitleCues: [{ ...subtitleCue }] }))).toBe(
      false,
    )
  })

  it('handles the first-ever snapshot, when there is nothing to compare against', () => {
    expect(editorSnapshotsEqual(null, snapshot())).toBe(false)
    expect(editorSnapshotsEqual(null, null)).toBe(true)
  })
})
