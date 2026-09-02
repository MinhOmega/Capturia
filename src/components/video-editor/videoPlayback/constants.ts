import type { ZoomFocus } from '../types'

export const DEFAULT_FOCUS: ZoomFocus = { cx: 0.5, cy: 0.5 }
/**
 * Zoom-out ease length. Upstream #373 ("adjust zoom speed") was reverted in
 * e1c67c4e, so 1015.05 ms is the final value.
 */
export const TRANSITION_WINDOW_MS = 1015.05
/** Zoom-in ease is 1.5x longer than zoom-out; ZOOM_IN_OVERLAP_MS of it lands inside the region. */
export const ZOOM_IN_TRANSITION_WINDOW_MS = TRANSITION_WINDOW_MS * 1.5
export const ZOOM_IN_OVERLAP_MS = 500
/** Regions closer than this pan between each other instead of zooming out and back in. */
export const CONNECTED_ZOOM_GAP_MS = 1500
export const CONNECTED_ZOOM_PAN_DURATION_MS = 1000
/**
 * Largest content-time step the zoom spring integrates; a bigger jump (seek,
 * dropped frames, sub-13 fps export) snaps to the target instead.
 */
export const ZOOM_SPRING_MAX_STEP_MS = 80
/**
 * Auto-follow focus (focusMode 'auto'): distance-adaptive exponential
 * smoothing of the cursor position, reframed in content time (see
 * cursorFollowUtils.advanceFollowFocus). Shared by preview and export so the
 * camera follows the cursor identically in both.
 */
export const AUTO_FOLLOW_SMOOTHING_FACTOR = 0.1
export const AUTO_FOLLOW_SMOOTHING_FACTOR_MAX = 0.25
export const AUTO_FOLLOW_RAMP_DISTANCE = 0.15
/** Reference frame interval the per-frame factors are tuned at (40 fps live-preview feel). */
export const AUTO_FOLLOW_REFERENCE_MS = 1000 / 40
export const AUTO_FOLLOW_PARAMS = {
  minFactor: AUTO_FOLLOW_SMOOTHING_FACTOR,
  maxFactor: AUTO_FOLLOW_SMOOTHING_FACTOR_MAX,
  rampDistance: AUTO_FOLLOW_RAMP_DISTANCE,
  referenceMs: AUTO_FOLLOW_REFERENCE_MS,
} as const
export const SMOOTHING_FACTOR = 0.12
export const MIN_DELTA = 0.0001
export const VIEWPORT_SCALE = 0.8

/** Legacy exponential low-pass (pre-spring ticker); kept for callers outside the zoom camera. */
export function resolveAdaptiveSmoothingAlpha(deltaMs: number): number {
  const baseFps = 60
  const baseStepMs = 1000 / baseFps
  const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0
  if (safeDeltaMs <= 0.0001) {
    return SMOOTHING_FACTOR
  }

  const baseRetention = Math.max(0.0001, 1 - SMOOTHING_FACTOR)
  const alpha = 1 - Math.pow(baseRetention, safeDeltaMs / baseStepMs)
  return Math.max(0.01, Math.min(1, alpha))
}
