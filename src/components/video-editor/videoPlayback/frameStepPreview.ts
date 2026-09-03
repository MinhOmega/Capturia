/**
 * Frame-stepped preview for speeds above the media element's playbackRate cap.
 *
 * Browsers cap `HTMLMediaElement.playbackRate` (Chromium: 16, and it throws
 * above that; others clamp silently, some lower). Capturia's segment speeds go
 * up to MAX_PLAYBACK_SPEED, so a 20x or 40x segment used to preview at a
 * silent 16x. Above the cap the preview switches to *frame stepping*: the
 * element is muted and its `currentTime` is driven from the animation-frame
 * loop by a virtual clock that advances at the requested speed. Below the cap
 * the element plays natively, exactly as before.
 *
 * This module is the DOM-free planner: which mode a speed calls for, and where
 * the virtual clock lands after one tick. Time is advanced in *effective*
 * (collapsed) time through `timeMapping.ts`, so deleted segments are skipped
 * and a tick that crosses a segment boundary spends the remaining wall time
 * in the next segment at that segment's own speed. The mapping is the same one
 * the timeline and the exporter use, so the preview clock stays exact.
 */

import {
  effectiveToSourceMsWithSegments,
  findSegmentAtSourceTime,
  getEffectiveDurationMsWithSegments,
  sourceToEffectiveMsWithSegments,
} from '@/lib/trim/timeMapping'
import type { VideoSegment } from '../types'

/** Chromium's `playbackRate` ceiling; the default when no probe has run. */
export const MAX_NATIVE_PLAYBACK_RATE = 16
/** Chromium's `playbackRate` floor (setting less throws). */
export const MIN_NATIVE_PLAYBACK_RATE = 0.0625
/** i18n key of the hint the speed UI shows while a segment previews frame-stepped. */
export const FRAME_STEP_PREVIEW_HINT_KEY = 'settings.speedPreviewFrameSteppingHint' as const
/**
 * Longest wall-clock interval one tick may account for. Animation frames stop
 * in a hidden tab; on return the clock must not leap across the timeline.
 */
export const MAX_FRAME_STEP_TICK_SEC = 0.25

export type PreviewSpeedMode = 'native' | 'frame-step'

/** Effective preview speed at a source position: segment speed x preview rate. */
export function resolvePreviewSpeed(
  sourceMs: number,
  segments: VideoSegment[],
  previewRate: number,
): number {
  const rate = Number.isFinite(previewRate) && previewRate > 0 ? previewRate : 1
  const seg = findSegmentAtSourceTime(sourceMs, segments)
  return (seg && !seg.deleted ? seg.speed : 1) * rate
}

/** Native playback up to the element's cap; frame stepping above it. */
export function resolvePreviewSpeedMode(
  speed: number,
  nativeCap: number = MAX_NATIVE_PLAYBACK_RATE,
): PreviewSpeedMode {
  return Number.isFinite(speed) && speed > nativeCap + 1e-9 ? 'frame-step' : 'native'
}

/** A `playbackRate` the element accepts for `speed` (never above the cap, never below the floor). */
export function clampNativePlaybackRate(
  speed: number,
  nativeCap: number = MAX_NATIVE_PLAYBACK_RATE,
): number {
  if (!Number.isFinite(speed) || speed <= 0) return 1
  return Math.max(MIN_NATIVE_PLAYBACK_RATE, Math.min(nativeCap, speed))
}

export interface FrameStepPlanInput {
  /** Virtual clock position (source seconds) before the tick. */
  fromSec: number
  /** Wall-clock seconds since the previous tick. */
  dtSec: number
  segments: VideoSegment[]
  /** Global preview rate multiplier on top of the segment speeds. */
  previewRate: number
  /** Media duration in seconds; a non-finite value means "unknown, keep going". */
  durationSec: number
  nativeCap?: number
  /** Source frame length; reserved for callers that quantise seeks. */
  frameDurationSec?: number
}

export type FrameStepPlan =
  /** Keep stepping: seek the muted element toward `toSec`. */
  | { kind: 'advance'; toSec: number; speed: number }
  /** The clock entered a stretch at or below the cap: seek once and let the element play. */
  | { kind: 'hand-back'; toSec: number; speed: number }
  /** The clock reached the end of the kept timeline. */
  | { kind: 'end'; toSec: number }

function nextKeptSegmentFrom(segments: VideoSegment[], sourceMs: number): VideoSegment | null {
  for (const seg of segments) {
    if (!seg.deleted && seg.startMs >= sourceMs) return seg
  }
  return null
}

/**
 * Where the virtual clock lands after one animation frame and whether the
 * preview should stay frame-stepped there.
 */
export function planFrameStep(input: FrameStepPlanInput): FrameStepPlan {
  const nativeCap = input.nativeCap ?? MAX_NATIVE_PLAYBACK_RATE
  const dtSec =
    Number.isFinite(input.dtSec) && input.dtSec > 0
      ? Math.min(input.dtSec, MAX_FRAME_STEP_TICK_SEC)
      : 0
  const rate = Number.isFinite(input.previewRate) && input.previewRate > 0 ? input.previewRate : 1
  const endSec =
    Number.isFinite(input.durationSec) && input.durationSec > 0
      ? input.durationSec
      : Number.POSITIVE_INFINITY
  const fromSec = Number.isFinite(input.fromSec) && input.fromSec > 0 ? input.fromSec : 0
  const segments = input.segments

  const finish = (toSec: number, speed: number): FrameStepPlan => {
    if (toSec >= endSec) return { kind: 'end', toSec: endSec }
    return resolvePreviewSpeedMode(speed, nativeCap) === 'native'
      ? { kind: 'hand-back', toSec, speed }
      : { kind: 'advance', toSec, speed }
  }

  if (segments.length === 0) {
    // No segment model: the timeline is the raw source at the preview rate.
    return finish(fromSec + rate * dtSec, rate)
  }

  // Advance in effective time: wall time x preview rate. The mapping back to
  // source time applies each segment's own speed and skips deleted stretches.
  const effectiveMs = sourceToEffectiveMsWithSegments(fromSec * 1000, segments)
  const totalEffectiveMs = getEffectiveDurationMsWithSegments(segments)
  const nextEffectiveMs = effectiveMs + dtSec * 1000 * rate
  if (nextEffectiveMs >= totalEffectiveMs) {
    const lastKeptEndMs = effectiveToSourceMsWithSegments(totalEffectiveMs, segments)
    return { kind: 'end', toSec: Math.min(lastKeptEndMs / 1000, endSec) }
  }

  let toMs = effectiveToSourceMsWithSegments(nextEffectiveMs, segments)
  let seg = findSegmentAtSourceTime(toMs, segments)
  if (seg?.deleted) {
    // Landed exactly on a boundary into a deleted stretch (round trip through
    // the mapping): continue from the next kept segment.
    const next = nextKeptSegmentFrom(segments, seg.endMs)
    if (!next) return { kind: 'end', toSec: Math.min(seg.startMs / 1000, endSec) }
    toMs = next.startMs
    seg = next
  }

  const speed = (seg?.speed ?? 1) * rate
  return finish(toMs / 1000, speed)
}

/**
 * Highest `playbackRate` this element accepts. Tries the candidates from the
 * top: a browser that throws moves to the next candidate, a browser that
 * clamps silently reveals its cap in the read-back value. The original rate
 * is restored afterwards.
 */
export function probeNativePlaybackRateCap(
  element: { playbackRate: number },
  candidates: readonly number[] = [MAX_NATIVE_PLAYBACK_RATE, 8, 4, 2],
): number {
  const original = element.playbackRate
  let cap = 1
  for (const rate of candidates) {
    try {
      element.playbackRate = rate
    } catch {
      continue
    }
    const accepted = element.playbackRate
    if (Number.isFinite(accepted) && accepted > 0) {
      cap = Math.min(accepted, rate)
      break
    }
  }
  try {
    element.playbackRate = original
  } catch {
    // The original rate was set by us earlier, so this cannot really fail.
  }
  return cap
}
