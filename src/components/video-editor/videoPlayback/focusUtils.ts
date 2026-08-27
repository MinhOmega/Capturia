import { ZOOM_DEPTH_SCALES, clampFocus, type ZoomFocus, type ZoomDepth } from "../types";

interface StageSize {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Allowed focus range for a zoom scale: the zoom window (stage / zoomScale)
 * must stay inside the stage, so the centre can't get closer than half a
 * window to any edge. Stage-normalised, so it's independent of stage size.
 */
export function getFocusBoundsForScale(zoomScale: number) {
  const safeScale = Number.isFinite(zoomScale) && zoomScale > 0 ? zoomScale : 1;
  const margin = Math.min(0.5, 1 / (2 * safeScale));

  return {
    minX: margin,
    maxX: 1 - margin,
    minY: margin,
    maxY: 1 - margin,
  };
}

/**
 * Clamp a focus point so the zoom window (stage / zoomScale) stays inside the
 * stage. Takes the effective scale so custom zoom scales are honoured. The
 * stage size argument is kept for call-site compatibility; the bounds are
 * stage-normalised so it does not change the result.
 */
export function clampFocusToScale(
  focus: ZoomFocus,
  zoomScale: number,
  _stageSize?: StageSize
): ZoomFocus {
  const baseFocus = clampFocus(focus);
  const bounds = getFocusBoundsForScale(zoomScale);

  return {
    cx: clamp(baseFocus.cx, bounds.minX, bounds.maxX),
    cy: clamp(baseFocus.cy, bounds.minY, bounds.maxY),
  };
}

/** Depth-preset wrapper around clampFocusToScale. */
export function clampFocusToStage(
  focus: ZoomFocus,
  depth: ZoomDepth,
  stageSize: StageSize
): ZoomFocus {
  return clampFocusToScale(focus, ZOOM_DEPTH_SCALES[depth], stageSize);
}

export function stageFocusToVideoSpace(
  focus: ZoomFocus,
  stageSize: StageSize,
  videoSize: { width: number; height: number },
  baseScale: number,
  baseOffset: { x: number; y: number }
): ZoomFocus {
  if (!stageSize.width || !stageSize.height || !videoSize.width || !videoSize.height || baseScale <= 0) {
    return focus;
  }

  const stageX = focus.cx * stageSize.width;
  const stageY = focus.cy * stageSize.height;

  const videoNormX = (stageX - baseOffset.x) / (videoSize.width * baseScale);
  const videoNormY = (stageY - baseOffset.y) / (videoSize.height * baseScale);

  return {
    cx: videoNormX,
    cy: videoNormY,
  };
}
