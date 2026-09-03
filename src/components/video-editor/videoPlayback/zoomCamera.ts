import type { Rotation3D, ZoomFocus, ZoomFocusMode, ZoomRegion } from '../types'
import {
  DEFAULT_ROTATION_3D,
  getZoomFocusMode,
  getZoomScale,
  getZoomTransition,
  lerpRotation3D,
} from '../types'
import { AUTO_FOLLOW_PARAMS, DEFAULT_FOCUS, ZOOM_SPRING_MAX_STEP_MS } from './constants'
import { advanceFollowFocus, type CursorTelemetryPoint } from './cursorFollowUtils'
import { findDominantRegion } from './zoomRegionUtils'
import {
  computeFocusFromTransform,
  computeZoomTransform,
  type ZoomTransform,
} from './zoomTransform'
import {
  createZoomSpringState,
  resetZoomSpring,
  stepZoomSpring,
  type ZoomSpringState,
} from './zoomSpring'

/**
 * The zoom camera step shared by the preview ticker (VideoPlayback) and the
 * exporter (frameRenderer.updateAnimationState). Both call stepZoomCamera
 * with content time, so preview and export produce the same transform for
 * the same time series by construction; the only divergence is the
 * `animating` flag (preview snaps while paused / seeking / scrubbing, export
 * always steps).
 *
 * Pipeline per frame:
 *   resolveZoomCameraTarget  - eased target from the regions (+ raw cursor
 *                              focus for focusMode 'auto')
 *   advanceAutoFollowFocus   - content-time smoothing of that cursor focus
 *   advanceZoomCamera        - spring-chase the resulting transform
 */

export interface ZoomCameraGeometry {
  stageSize: { width: number; height: number }
  baseMask: { x: number; y: number; width: number; height: number }
}

export interface ZoomCameraTarget {
  /** Full zoom scale of the active region (or the blended scale mid-pan). */
  scale: number
  /** Stage-normalised focus the camera is heading to (clamped for `scale`). */
  focus: ZoomFocus
  /** Eased zoom progress 0-1. */
  progress: number
  /** computeZoomTransform of the above: the target the spring chases. */
  transform: ZoomTransform
  /** Focus mode of the region the camera is heading to; null when unzoomed. */
  focusMode: ZoomFocusMode | null
  /** Id of the region the camera is heading to; null when unzoomed. Drives the auto-follow freeze reset. */
  regionId: string | null
  /** True while panning between two connected regions (the pan owns the focus). */
  transition: boolean
  /** True when the active region cuts instead of easing (ZoomRegion.transition === 'instant'). */
  instant: boolean
  /**
   * Effective 3D tilt for this frame: the region preset ramped in/out by
   * `progress` (identity when flat / unzoomed). Preview (CSS transform) and
   * export (WebGL pass) both read this, so they tilt identically.
   */
  rotation3D: Rotation3D
}

export interface ResolveZoomCameraTargetOptions {
  /** Editor-only: a zoom is selected and paused, show the unzoomed stage instead. */
  forceUnzoomed?: boolean
  /** Cursor telemetry (buildCursorTelemetry) read by focusMode 'auto' regions. */
  cursorTelemetry?: CursorTelemetryPoint[]
}

function unzoomedTarget(): ZoomCameraTarget {
  return {
    scale: 1,
    focus: { ...DEFAULT_FOCUS },
    progress: 0,
    transform: { scale: 1, x: 0, y: 0 },
    focusMode: null,
    regionId: null,
    transition: false,
    instant: false,
    rotation3D: DEFAULT_ROTATION_3D,
  }
}

export function resolveZoomCameraTarget(
  regions: ZoomRegion[],
  timeMs: number,
  geometry: ZoomCameraGeometry,
  options: ResolveZoomCameraTargetOptions = {},
): ZoomCameraTarget {
  if (options.forceUnzoomed) {
    return unzoomedTarget()
  }

  const { region, strength, blendedScale, rotation3D, transition } = findDominantRegion(
    regions,
    timeMs,
    {
      connectZooms: true,
      cursorTelemetry: options.cursorTelemetry,
    },
  )

  if (!region || strength <= 0) {
    return unzoomedTarget()
  }

  let scale = blendedScale ?? getZoomScale(region)
  let focus = region.focus
  let progress = strength

  if (transition) {
    // Connected pan: interpolate the two full transforms (scale and translation
    // together) and read the focus back, so the camera travels in a straight
    // line in transform space.
    const startTransform = computeZoomTransform({
      ...geometry,
      zoomScale: transition.startScale,
      zoomProgress: 1,
      focusX: transition.startFocus.cx,
      focusY: transition.startFocus.cy,
    })
    const endTransform = computeZoomTransform({
      ...geometry,
      zoomScale: transition.endScale,
      zoomProgress: 1,
      focusX: transition.endFocus.cx,
      focusY: transition.endFocus.cy,
    })
    const interpolated = {
      scale:
        startTransform.scale + (endTransform.scale - startTransform.scale) * transition.progress,
      x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
      y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
    }

    scale = interpolated.scale
    focus = computeFocusFromTransform({
      ...geometry,
      zoomScale: interpolated.scale,
      x: interpolated.x,
      y: interpolated.y,
    })
    progress = 1
  }

  const transform = computeZoomTransform({
    ...geometry,
    zoomScale: scale,
    zoomProgress: progress,
    focusX: focus.cx,
    focusY: focus.cy,
  })

  return {
    scale,
    focus,
    progress,
    transform,
    focusMode: getZoomFocusMode(region),
    regionId: region.id,
    transition: transition !== null,
    instant: getZoomTransition(region) === 'instant',
    // Tilt ramps with the same eased progress as the scale; mid-pan
    // (progress 1) rotation3D is already the lerp between the two regions.
    rotation3D: lerpRotation3D(DEFAULT_ROTATION_3D, rotation3D, progress),
  }
}

export interface ZoomCameraState {
  spring: ZoomSpringState
  /** Content time of the previous step; null before the first frame. */
  prevTimeMs: number | null
  /** Transform actually applied on the previous step. */
  applied: ZoomTransform
  /** Smoothed cursor focus of the current auto-follow region; null while a manual region is active. */
  smoothedAutoFocus: ZoomFocus | null
  /** Eased progress of the previous step (tells zoom-in from zoom-out). */
  prevTargetProgress: number
  /** Region the previous step was heading to; a change resets the zoom-out focus freeze. */
  prevRegionId: string | null
  /** True once the current region reached full zoom, so its zoom-out must not pan. */
  reachedFullZoom: boolean
  /** Focus held for the whole zoom-out; null while the camera is free to follow. */
  frozenAutoFocus: ZoomFocus | null
  /** Id of the instant region active on the previous step; null when none was. */
  prevInstantRegionId: string | null
}

export function createZoomCameraState(): ZoomCameraState {
  return {
    spring: createZoomSpringState(),
    prevTimeMs: null,
    applied: { scale: 1, x: 0, y: 0 },
    smoothedAutoFocus: null,
    prevTargetProgress: 0,
    prevRegionId: null,
    reachedFullZoom: false,
    frozenAutoFocus: null,
    prevInstantRegionId: null,
  }
}

export function resetZoomCameraState(state: ZoomCameraState) {
  state.spring = createZoomSpringState()
  state.prevTimeMs = null
  state.applied = { scale: 1, x: 0, y: 0 }
  state.smoothedAutoFocus = null
  state.prevTargetProgress = 0
  state.prevRegionId = null
  state.reachedFullZoom = false
  state.frozenAutoFocus = null
  state.prevInstantRegionId = null
}

/**
 * Auto-follow focus for one step. `raw` is the (clamped) cursor focus the
 * dominant region resolved at `timeMs`; the camera eases toward it by the
 * content-time delta since the previous step (frame-rate independent):
 *   - full zoom: distance-adaptive smoothing (faster when far, decelerating
 *     when close);
 *   - zooming in: track the raw cursor so the zoom always aims at the current
 *     position, keeping the smoothed value in sync to avoid a snap when full
 *     zoom begins;
 *   - zooming out after full zoom was reached: the focus is frozen at the
 *     value it had when the ease-out began, so the frame only shrinks. Left
 *     free it would keep chasing the cursor and the picture would slide
 *     sideways while it shrank, which reads as an unrequested pan.
 *   - zooming out without ever reaching full zoom (a region cut short by the
 *     next one): keep smoothing, there is no settled focus to hold.
 * The freeze is released when the camera moves to another region or when
 * content time goes backwards (a scrub), so a fresh pass re-follows the cursor.
 * When not `animating` (paused / seek / scrub) the focus snaps to `raw`,
 * matching the zoom spring's snap; the exporter always animates.
 * Manual regions reset the smoothed value so the next auto region starts
 * from the live cursor.
 */
export function advanceAutoFollowFocus(
  state: ZoomCameraState,
  target: ZoomCameraTarget,
  timeMs: number,
  animating: boolean,
): ZoomFocus {
  const raw = target.focus
  const progress = target.progress

  const wentBackwards = state.prevTimeMs !== null && timeMs < state.prevTimeMs
  if (target.regionId !== state.prevRegionId || wentBackwards) {
    state.reachedFullZoom = false
    state.frozenAutoFocus = null
  }
  state.prevRegionId = target.regionId

  if (target.focusMode !== 'auto' || target.transition) {
    if (target.focusMode === 'manual') {
      state.smoothedAutoFocus = null
    }
    state.prevTargetProgress = progress
    return raw
  }

  const atFullZoom = progress >= 0.999
  const isZoomingIn = !atFullZoom && progress >= state.prevTargetProgress
  const dtMs = state.prevTimeMs === null ? 0 : timeMs - state.prevTimeMs
  let focus = raw

  if (atFullZoom) {
    state.reachedFullZoom = true
    state.frozenAutoFocus = null
    const prev = state.smoothedAutoFocus ?? raw
    const smoothed = animating ? advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS) : raw
    state.smoothedAutoFocus = smoothed
    focus = smoothed
  } else if (isZoomingIn) {
    state.smoothedAutoFocus = raw
  } else if (state.reachedFullZoom) {
    const frozen = state.frozenAutoFocus ?? state.smoothedAutoFocus ?? raw
    state.frozenAutoFocus = frozen
    state.smoothedAutoFocus = frozen
    focus = frozen
  } else {
    const prev = state.smoothedAutoFocus ?? raw
    const smoothed = animating ? advanceFollowFocus(prev, raw, dtMs, AUTO_FOLLOW_PARAMS) : raw
    state.smoothedAutoFocus = smoothed
    focus = smoothed
  }

  state.prevTargetProgress = progress
  return focus
}

/**
 * Chase `target` with the zoom spring by the content-time delta since the
 * previous step. Snaps straight to the target when not animating, on the
 * first frame, on a backwards / zero step, on a jump larger than
 * ZOOM_SPRING_MAX_STEP_MS (seek, dropped frames), or when `cut` asks for a
 * hard step (an instant region starting or ending).
 */
export function advanceZoomCamera(
  state: ZoomCameraState,
  target: ZoomTransform,
  timeMs: number,
  animating: boolean,
  cut = false,
): ZoomTransform {
  const prevMs = state.prevTimeMs
  const dtMs = prevMs === null ? 0 : timeMs - prevMs

  let applied: ZoomTransform
  if (cut || !animating || prevMs === null || dtMs <= 0 || dtMs > ZOOM_SPRING_MAX_STEP_MS) {
    resetZoomSpring(state.spring, target)
    applied = { scale: target.scale, x: target.x, y: target.y }
  } else {
    applied = stepZoomSpring(state.spring, target, dtMs)
  }

  state.prevTimeMs = timeMs
  state.applied = applied
  return applied
}

export interface StepZoomCameraOptions extends ResolveZoomCameraTargetOptions {
  /** False snaps focus and spring to the target (preview paused / seek / scrub). */
  animating: boolean
}

export interface ZoomCameraStep {
  /** Target after auto-follow smoothing (what the spring chases). */
  target: ZoomCameraTarget
  /** Transform actually applied this frame. */
  applied: ZoomTransform
}

/**
 * One full camera step: resolve the target for `timeMs`, smooth the
 * auto-follow focus, spring-chase the transform. The single entry point of
 * the preview ticker and the exporter.
 */
export function stepZoomCamera(
  state: ZoomCameraState,
  regions: ZoomRegion[],
  timeMs: number,
  geometry: ZoomCameraGeometry,
  options: StepZoomCameraOptions,
): ZoomCameraStep {
  const resolved = resolveZoomCameraTarget(regions, timeMs, geometry, options)
  const focus = advanceAutoFollowFocus(state, resolved, timeMs, options.animating)

  let target = resolved
  if (focus !== resolved.focus) {
    target = {
      ...resolved,
      focus,
      transform: computeZoomTransform({
        ...geometry,
        zoomScale: resolved.scale,
        zoomProgress: resolved.progress,
        focusX: focus.cx,
        focusY: focus.cy,
      }),
    }
  }

  // An instant region must not be smoothed by the spring at either end, so the
  // frame it takes over and the frame it hands back both cut straight to the
  // target. Two adjacent instant regions cut between each other too.
  const instantKey = target.instant ? target.regionId : null
  const cut = instantKey !== state.prevInstantRegionId
  state.prevInstantRegionId = instantKey

  const applied = advanceZoomCamera(state, target.transform, timeMs, options.animating, cut)
  return { target, applied }
}

/** Largest normalised per-step change of the applied transform (drives the legacy motion blur). */
export function measureZoomMotionIntensity(
  previous: ZoomTransform,
  next: ZoomTransform,
  stageSize: { width: number; height: number },
): number {
  return Math.max(
    Math.abs(next.scale - previous.scale),
    Math.abs(next.x - previous.x) / Math.max(1, stageSize.width),
    Math.abs(next.y - previous.y) / Math.max(1, stageSize.height),
  )
}
