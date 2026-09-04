/**
 * Snapshot comparison behind the editor's undo stack.
 *
 * The history effect fires on any *reference* change to the tracked state, and
 * several code paths rebuild an array without changing anything in it — a
 * `map` that returns every element untouched, a per-aspect object rebuilt
 * around the same arrays. Each of those used to cost an undo entry, so Ctrl+Z
 * appeared to do nothing until it had been pressed several times.
 *
 * Comparing by shallow identity is enough and stays cheap: every editor
 * reducer creates a new object for a region it actually changes, so two
 * snapshots holding the same region objects in the same order describe the same
 * edit state. Nothing here walks into a region.
 */

import type { AnnotationRegion, AudioEditRegion, VideoSegment } from './types'
import type { SubtitleCue } from '@/lib/analysis/types'
import type { ZoomRegionsByAspect } from '@/lib/zoom/aspectZoomState'

export interface EditorSnapshot {
  segments: VideoSegment[]
  zoomRegionsByAspect: ZoomRegionsByAspect
  annotationRegions: AnnotationRegion[]
  audioEditRegions: AudioEditRegion[]
  /** P2-F2: caption edits are undoable like any other region edit. */
  subtitleCues: SubtitleCue[]
}

/** Same length and the same element identities, in order. */
export function arraysShallowEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/** Same aspect keys, each holding a shallow-equal list of zoom regions. */
export function zoomRegionsByAspectShallowEqual(
  a: ZoomRegionsByAspect,
  b: ZoomRegionsByAspect,
): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys as Array<keyof ZoomRegionsByAspect>) {
    const left = a[key]
    const right = b[key]
    if (left === right) continue
    if (!left || !right) return false
    if (!arraysShallowEqual(left, right)) return false
  }
  return true
}

/** True when the two snapshots describe the same edit state and no undo entry is owed. */
export function editorSnapshotsEqual(a: EditorSnapshot | null, b: EditorSnapshot | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    arraysShallowEqual(a.segments, b.segments) &&
    arraysShallowEqual(a.annotationRegions, b.annotationRegions) &&
    arraysShallowEqual(a.audioEditRegions, b.audioEditRegions) &&
    arraysShallowEqual(a.subtitleCues, b.subtitleCues) &&
    zoomRegionsByAspectShallowEqual(a.zoomRegionsByAspect, b.zoomRegionsByAspect)
  )
}
