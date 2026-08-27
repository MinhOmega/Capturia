import type { ZoomFocus, ZoomRegion } from "../types";
import { getZoomScale } from "../types";
import { DEFAULT_FOCUS, ZOOM_SPRING_MAX_STEP_MS } from "./constants";
import { findDominantRegion } from "./zoomRegionUtils";
import {
  computeFocusFromTransform,
  computeZoomTransform,
  type ZoomTransform,
} from "./zoomTransform";
import {
  createZoomSpringState,
  resetZoomSpring,
  stepZoomSpring,
  type ZoomSpringState,
} from "./zoomSpring";

/**
 * The zoom camera step shared by the preview ticker (VideoPlayback) and the
 * exporter (frameRenderer.updateAnimationState). Both call
 * resolveZoomCameraTarget + advanceZoomCamera with content time, so preview
 * and export produce the same transform for the same time series by
 * construction; the only divergence is the `animating` flag (preview snaps
 * while paused / seeking / scrubbing, export always steps).
 */

export interface ZoomCameraGeometry {
  stageSize: { width: number; height: number };
  baseMask: { x: number; y: number; width: number; height: number };
}

export interface ZoomCameraTarget {
  /** Full zoom scale of the active region (or the blended scale mid-pan). */
  scale: number;
  /** Stage-normalised focus the camera is heading to (clamped for `scale`). */
  focus: ZoomFocus;
  /** Eased zoom progress 0-1. */
  progress: number;
  /** computeZoomTransform of the above: the target the spring chases. */
  transform: ZoomTransform;
}

export interface ResolveZoomCameraTargetOptions {
  /** Editor-only: a zoom is selected and paused, show the unzoomed stage instead. */
  forceUnzoomed?: boolean;
}

function unzoomedTarget(): ZoomCameraTarget {
  return {
    scale: 1,
    focus: { ...DEFAULT_FOCUS },
    progress: 0,
    transform: { scale: 1, x: 0, y: 0 },
  };
}

export function resolveZoomCameraTarget(
  regions: ZoomRegion[],
  timeMs: number,
  geometry: ZoomCameraGeometry,
  options: ResolveZoomCameraTargetOptions = {},
): ZoomCameraTarget {
  if (options.forceUnzoomed) {
    return unzoomedTarget();
  }

  const { region, strength, blendedScale, transition } = findDominantRegion(regions, timeMs, {
    connectZooms: true,
  });

  if (!region || strength <= 0) {
    return unzoomedTarget();
  }

  let scale = blendedScale ?? getZoomScale(region);
  let focus = region.focus;
  let progress = strength;

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
    });
    const endTransform = computeZoomTransform({
      ...geometry,
      zoomScale: transition.endScale,
      zoomProgress: 1,
      focusX: transition.endFocus.cx,
      focusY: transition.endFocus.cy,
    });
    const interpolated = {
      scale: startTransform.scale + (endTransform.scale - startTransform.scale) * transition.progress,
      x: startTransform.x + (endTransform.x - startTransform.x) * transition.progress,
      y: startTransform.y + (endTransform.y - startTransform.y) * transition.progress,
    };

    scale = interpolated.scale;
    focus = computeFocusFromTransform({ ...geometry, zoomScale: interpolated.scale, x: interpolated.x, y: interpolated.y });
    progress = 1;
  }

  const transform = computeZoomTransform({
    ...geometry,
    zoomScale: scale,
    zoomProgress: progress,
    focusX: focus.cx,
    focusY: focus.cy,
  });

  return { scale, focus, progress, transform };
}

export interface ZoomCameraState {
  spring: ZoomSpringState;
  /** Content time of the previous step; null before the first frame. */
  prevTimeMs: number | null;
  /** Transform actually applied on the previous step. */
  applied: ZoomTransform;
}

export function createZoomCameraState(): ZoomCameraState {
  return {
    spring: createZoomSpringState(),
    prevTimeMs: null,
    applied: { scale: 1, x: 0, y: 0 },
  };
}

export function resetZoomCameraState(state: ZoomCameraState) {
  state.spring = createZoomSpringState();
  state.prevTimeMs = null;
  state.applied = { scale: 1, x: 0, y: 0 };
}

/**
 * Chase `target` with the zoom spring by the content-time delta since the
 * previous step. Snaps straight to the target when not animating, on the
 * first frame, on a backwards / zero step, or on a jump larger than
 * ZOOM_SPRING_MAX_STEP_MS (seek, dropped frames).
 */
export function advanceZoomCamera(
  state: ZoomCameraState,
  target: ZoomTransform,
  timeMs: number,
  animating: boolean,
): ZoomTransform {
  const prevMs = state.prevTimeMs;
  const dtMs = prevMs === null ? 0 : timeMs - prevMs;

  let applied: ZoomTransform;
  if (!animating || prevMs === null || dtMs <= 0 || dtMs > ZOOM_SPRING_MAX_STEP_MS) {
    resetZoomSpring(state.spring, target);
    applied = { scale: target.scale, x: target.x, y: target.y };
  } else {
    applied = stepZoomSpring(state.spring, target, dtMs);
  }

  state.prevTimeMs = timeMs;
  state.applied = applied;
  return applied;
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
  );
}
