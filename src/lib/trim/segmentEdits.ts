/**
 * Pure reducers for the two bulk edits of the segment track: give every
 * segment one speed, and throw every trim and cut away.
 *
 * They live outside the editor component so the rules can be stated once and
 * tested directly: both are called from a single setSegments update, so each
 * costs exactly one undo entry, and both return the array they were given when
 * nothing would change, so a repeat of the same action is not an edit at all.
 */

import { clampPlaybackSpeed, type VideoSegment } from '@/components/video-editor/types'

/**
 * Give every segment the same playback speed. Deleted segments are included:
 * restoring one later should not bring an old speed back with it.
 */
export function applySpeedToAllSegments(segments: VideoSegment[], speed: number): VideoSegment[] {
  const clamped = clampPlaybackSpeed(speed)
  if (segments.every((segment) => segment.speed === clamped)) return segments
  return segments.map((segment) =>
    segment.speed === clamped ? segment : { ...segment, speed: clamped },
  )
}

/** True when `segments` is already the untouched single segment `resetAllSegmentEdits` produces. */
export function isSingleFullLengthSegment(
  segments: VideoSegment[],
  totalDurationMs: number,
): boolean {
  if (segments.length !== 1) return false
  const [only] = segments
  return (
    !only.deleted &&
    only.speed === 1 &&
    only.startMs === 0 &&
    only.endMs === Math.round(totalDurationMs)
  )
}

/**
 * Undo every trim and cut: one segment spanning the whole recording, at normal
 * speed. `id` is the id to give it — the caller owns the segment id counter, so
 * it hands one in rather than the reducer inventing a name that could collide.
 * Returns `segments` untouched when it is already that single segment, so
 * confirming the action twice does not create a second undo entry.
 */
export function resetAllSegmentEdits(
  segments: VideoSegment[],
  totalDurationMs: number,
  id: string,
): VideoSegment[] {
  const endMs = Math.round(totalDurationMs)
  if (!Number.isFinite(endMs) || endMs <= 0) return segments
  if (isSingleFullLengthSegment(segments, endMs)) return segments
  return [{ id, startMs: 0, endMs, deleted: false, speed: 1 }]
}
