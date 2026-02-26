/**
 * Shared time mapping utilities for collapsed timeline (True Trim).
 *
 * Provides bidirectional mapping between "source time" (the original video
 * timeline including trimmed regions) and "effective time" (the collapsed
 * timeline where trimmed regions have been removed).
 *
 * Segment-aware variants handle both deletion and per-segment speed.
 */

import type { VideoSegment } from '@/components/video-editor/types';

export interface NormalizedTrimRange {
  startMs: number;
  endMs: number;
}

/**
 * Normalize, sort and merge trim ranges, clamping to video bounds.
 * Overlapping or adjacent ranges are merged into a single range.
 */
export function normalizeTrimRanges(
  trimRegions: { startMs: number; endMs: number }[],
  totalDurationMs: number,
): NormalizedTrimRange[] {
  const ranges = trimRegions
    .map((r) => ({
      startMs: Math.max(0, Math.min(r.startMs, totalDurationMs)),
      endMs: Math.max(0, Math.min(r.endMs, totalDurationMs)),
    }))
    .filter((r) => r.endMs > r.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  // Merge overlapping / adjacent ranges
  const merged: NormalizedTrimRange[] = [];
  for (const range of ranges) {
    if (merged.length > 0 && range.startMs <= merged[merged.length - 1].endMs) {
      merged[merged.length - 1].endMs = Math.max(merged[merged.length - 1].endMs, range.endMs);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/**
 * Convert source time → effective time (collapsing trimmed regions).
 *
 * If sourceMs falls inside a trim region, the result is clamped to the
 * effective position of that trim's start boundary.
 */
export function sourceToEffectiveMs(
  sourceMs: number,
  normalizedTrims: NormalizedTrimRange[],
): number {
  let effectiveMs = sourceMs;

  for (const trim of normalizedTrims) {
    if (sourceMs <= trim.startMs) {
      break;
    }

    if (sourceMs >= trim.endMs) {
      // Past this trim — subtract its full duration
      effectiveMs -= trim.endMs - trim.startMs;
    } else {
      // Inside this trim — clamp to start boundary in effective space
      effectiveMs -= sourceMs - trim.startMs;
      break;
    }
  }

  return Math.max(0, effectiveMs);
}

/**
 * Convert effective time → source time (expanding collapsed timeline).
 *
 * The returned source time always falls in a "kept" (non-trimmed) region.
 */
export function effectiveToSourceMs(
  effectiveMs: number,
  normalizedTrims: NormalizedTrimRange[],
): number {
  let sourceMs = effectiveMs;

  for (const trim of normalizedTrims) {
    if (sourceMs < trim.startMs) {
      break;
    }

    sourceMs += trim.endMs - trim.startMs;
  }

  return sourceMs;
}

/**
 * Calculate effective duration (total minus all trims).
 */
export function getEffectiveDurationMs(
  totalDurationMs: number,
  normalizedTrims: NormalizedTrimRange[],
): number {
  const totalTrimMs = normalizedTrims.reduce((sum, t) => sum + (t.endMs - t.startMs), 0);
  return Math.max(0, totalDurationMs - totalTrimMs);
}

// ---------------------------------------------------------------------------
// Segment-aware variants (handle both deletion + per-segment speed)
// ---------------------------------------------------------------------------

/**
 * Convert source time → effective time using segments.
 * Accounts for deleted segments (removed) and per-segment speed.
 */
export function sourceToEffectiveMsWithSegments(
  sourceMs: number,
  segments: VideoSegment[],
): number {
  let effectiveMs = 0;

  for (const seg of segments) {
    if (seg.deleted) {
      if (sourceMs >= seg.endMs) continue;  // past deleted — skip
      if (sourceMs >= seg.startMs) return effectiveMs; // inside deleted — clamp
      continue;
    }

    if (sourceMs >= seg.endMs) {
      effectiveMs += (seg.endMs - seg.startMs) / seg.speed;
    } else if (sourceMs >= seg.startMs) {
      effectiveMs += (sourceMs - seg.startMs) / seg.speed;
      return effectiveMs;
    }
  }

  return Math.max(0, effectiveMs);
}

/**
 * Convert effective time → source time using segments.
 * The returned source time falls in a kept (non-deleted) segment.
 */
export function effectiveToSourceMsWithSegments(
  effectiveMs: number,
  segments: VideoSegment[],
): number {
  let remaining = effectiveMs;

  for (const seg of segments) {
    if (seg.deleted) continue;

    const segEffDuration = (seg.endMs - seg.startMs) / seg.speed;

    if (remaining <= segEffDuration) {
      return seg.startMs + remaining * seg.speed;
    }

    remaining -= segEffDuration;
  }

  // Past end — return last kept segment's end
  const lastKept = [...segments].reverse().find((s) => !s.deleted);
  return lastKept ? lastKept.endMs : 0;
}

/**
 * Calculate effective duration from segments (sum of kept segments / speed).
 */
export function getEffectiveDurationMsWithSegments(
  segments: VideoSegment[],
): number {
  return segments
    .filter((s) => !s.deleted)
    .reduce((sum, s) => sum + (s.endMs - s.startMs) / s.speed, 0);
}

/**
 * Derive trim regions from deleted segments (backward compatibility).
 */
export function segmentsToTrimRegions(
  segments: VideoSegment[],
): { id: string; startMs: number; endMs: number }[] {
  return segments
    .filter((s) => s.deleted)
    .map((s) => ({ id: s.id, startMs: s.startMs, endMs: s.endMs }));
}

/**
 * Find the segment containing a source-time position.
 */
export function findSegmentAtSourceTime(
  sourceMs: number,
  segments: VideoSegment[],
): VideoSegment | null {
  return segments.find(
    (s) => sourceMs >= s.startMs && sourceMs < s.endMs,
  ) ?? null;
}
