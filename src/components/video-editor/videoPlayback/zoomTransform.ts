import type { BlurFilter, Container } from 'pixi.js';

export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

interface StageSize {
  width: number;
  height: number;
}

interface BaseMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ZoomTransformGeometry {
  stageSize: StageSize;
  baseMask: BaseMask;
  zoomScale: number;
  /** 0 = unzoomed, 1 = fully at zoomScale/focus; the eased region strength. */
  zoomProgress?: number;
  focusX: number;
  focusY: number;
}

interface FocusFromTransformGeometry {
  stageSize: StageSize;
  baseMask: BaseMask;
  zoomScale: number;
  x: number;
  y: number;
}

interface TransformParams {
  cameraContainer: Container;
  blurFilter: BlurFilter | null;
  stageSize: StageSize;
  baseMask: BaseMask;
  zoomScale: number;
  zoomProgress?: number;
  focusX: number;
  focusY: number;
  motionIntensity: number;
  isPlaying: boolean;
  motionBlurEnabled?: boolean;
  /** Pre-computed camera transform (e.g. the spring output); skips computeZoomTransform. */
  transformOverride?: ZoomTransform;
  /**
   * Content time of this frame in ms. Not consumed by the isotropic blur yet;
   * exposed so a velocity-based (px/s) motion blur can be keyed on content
   * time in both preview and export.
   */
  frameTimeMs?: number;
}

const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 };

/**
 * Camera transform that centres a stage-normalised focus at zoomScale, faded
 * in by zoomProgress. Translation and scale are both linear in progress, so
 * lerping two full transforms in this space is the same as easing here.
 */
export function computeZoomTransform({
  stageSize,
  baseMask,
  zoomScale,
  zoomProgress = 1,
  focusX,
  focusY,
}: ZoomTransformGeometry): ZoomTransform {
  if (
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    baseMask.width <= 0 ||
    baseMask.height <= 0
  ) {
    return { ...IDENTITY };
  }

  const progress = Math.min(1, Math.max(0, zoomProgress));
  // Focus coords are stage-normalised (0-1 of the full canvas), so map straight to stage pixels.
  const focusStagePxX = focusX * stageSize.width;
  const focusStagePxY = focusY * stageSize.height;
  const stageCenterX = stageSize.width / 2;
  const stageCenterY = stageSize.height / 2;
  const scale = 1 + (zoomScale - 1) * progress;
  const finalX = stageCenterX - focusStagePxX * zoomScale;
  const finalY = stageCenterY - focusStagePxY * zoomScale;

  return {
    scale,
    x: finalX * progress,
    y: finalY * progress,
  };
}

/** Inverse of computeZoomTransform at full progress: which focus a transform is centred on. */
export function computeFocusFromTransform({
  stageSize,
  baseMask,
  zoomScale,
  x,
  y,
}: FocusFromTransformGeometry) {
  if (
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    baseMask.width <= 0 ||
    baseMask.height <= 0 ||
    zoomScale <= 0
  ) {
    return { cx: 0.5, cy: 0.5 };
  }

  const stageCenterX = stageSize.width / 2;
  const stageCenterY = stageSize.height / 2;
  const focusStagePxX = (stageCenterX - x) / zoomScale;
  const focusStagePxY = (stageCenterY - y) / zoomScale;

  return {
    cx: focusStagePxX / stageSize.width,
    cy: focusStagePxY / stageSize.height,
  };
}

export function applyZoomTransform({
  cameraContainer,
  blurFilter,
  stageSize,
  baseMask,
  zoomScale,
  zoomProgress = 1,
  focusX,
  focusY,
  motionIntensity,
  isPlaying,
  motionBlurEnabled = false,
  transformOverride,
}: TransformParams): ZoomTransform {
  if (
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    baseMask.width <= 0 ||
    baseMask.height <= 0
  ) {
    return { ...IDENTITY };
  }

  const transform =
    transformOverride ??
    computeZoomTransform({ stageSize, baseMask, zoomScale, zoomProgress, focusX, focusY });

  cameraContainer.scale.set(transform.scale);
  cameraContainer.position.set(transform.x, transform.y);

  if (blurFilter) {
    const shouldBlur = motionBlurEnabled && isPlaying && motionIntensity > 0.0005;
    const motionBlur = shouldBlur ? Math.min(6, motionIntensity * 120) : 0;
    blurFilter.strength = motionBlur;
  }

  return { scale: transform.scale, x: transform.x, y: transform.y };
}
