/**
 * D2: the moments a user flagged while recording, as the editor timeline needs
 * them.
 *
 * The sidecar stores markers in *source* time (the recorded video's own clock,
 * pauses already compacted out). The timeline draws *effective* time, which
 * trims and per-segment speed have already reshaped, so a marker has to travel
 * the same conversion every zoom and annotation region does - and a marker
 * inside a deleted segment has to disappear rather than pile up on the cut.
 *
 * Pure so both conversions are testable without the editor.
 */

import type { VideoSegment } from '@/components/video-editor/types'
import {
  type NormalizedTrimRange,
  sourceToEffectiveMs,
  sourceToEffectiveMsWithSegments,
} from '@/lib/trim/timeMapping'

/**
 * Source-time markers in effective (timeline) time, ordered and deduplicated.
 *
 * A marker landing inside a deleted segment is dropped: `sourceToEffective*`
 * clamps it to the cut, so keeping it would stack every flagged moment from the
 * removed stretch on one pixel of a frame the user never sees.
 */
export function markersToEffectiveMs(
  markers: readonly number[] | undefined,
  segments: readonly VideoSegment[],
  trims: readonly NormalizedTrimRange[],
): number[] {
  if (!markers || markers.length === 0) return []

  const converted: number[] = []
  for (const sourceMs of markers) {
    if (!Number.isFinite(sourceMs) || sourceMs < 0) continue
    if (segments.length > 0) {
      const segment = segments.find((s) => sourceMs >= s.startMs && sourceMs < s.endMs)
      if (segment?.deleted) continue
      converted.push(sourceToEffectiveMsWithSegments(sourceMs, segments as VideoSegment[]))
      continue
    }
    if (trims.length > 0) {
      if (trims.some((trim) => sourceMs >= trim.startMs && sourceMs < trim.endMs)) continue
      converted.push(sourceToEffectiveMs(sourceMs, trims as NormalizedTrimRange[]))
      continue
    }
    converted.push(sourceMs)
  }

  return [...new Set(converted.map((ms) => Math.max(0, Math.round(ms))))].sort((a, b) => a - b)
}

/**
 * The marker to jump to from `fromMs`, or null when there is none in that
 * direction. `epsilonMs` keeps a jump from landing back on the marker the
 * playhead is already sitting on after a seek rounds the time.
 */
export function adjacentMarkerMs(
  markers: readonly number[],
  fromMs: number,
  direction: 'next' | 'previous',
  epsilonMs = 5,
): number | null {
  if (markers.length === 0 || !Number.isFinite(fromMs)) return null

  if (direction === 'next') {
    let best: number | null = null
    for (const marker of markers) {
      if (marker > fromMs + epsilonMs && (best === null || marker < best)) best = marker
    }
    return best
  }

  let best: number | null = null
  for (const marker of markers) {
    if (marker < fromMs - epsilonMs && (best === null || marker > best)) best = marker
  }
  return best
}
