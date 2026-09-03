import type { MotionBlurFilter } from 'pixi-filters/motion-blur'
import type { Container } from 'pixi.js'

// Motion blur is keyed on camera velocity in stage px/s. The constants are
// calibrated for a REFERENCE_STAGE_HEIGHT-px tall stage; speeds and the
// resulting blur length are normalised to it so preview (small canvas) and
// export (full resolution) blur the same fraction of the frame at a given
// camera speed.
const REFERENCE_STAGE_HEIGHT = 1080
const PEAK_VELOCITY_PPS = 1400
const MAX_BLUR_PX = 14
const VELOCITY_THRESHOLD_PPS = 12
const MAX_AMOUNT_BOOST = 2.2
/** Blur direction vector is scaled by this relative to the blur length. */
const VELOCITY_SCALE = 2.4
const MAX_FRAME_DT_MS = 80
const IDLE_KERNEL_SIZE = 5

/**
 * Slider amount (0..1) -> blur response. Keeps the low end usable while
 * giving the top of the slider more headroom: response(1) = MAX_AMOUNT_BOOST.
 */
export function getMotionBlurAmountResponse(motionBlurAmount: number): number {
  const clampedAmount = Number.isFinite(motionBlurAmount)
    ? Math.min(1, Math.max(0, motionBlurAmount))
    : 0
  return clampedAmount * (1 + (MAX_AMOUNT_BOOST - 1) * clampedAmount)
}

export interface MotionBlurState {
  lastFrameTimeMs: number
  prevCamX: number
  prevCamY: number
  prevCamScale: number
  initialized: boolean
}

export function createMotionBlurState(): MotionBlurState {
  return {
    lastFrameTimeMs: 0,
    prevCamX: 0,
    prevCamY: 0,
    prevCamScale: 1,
    initialized: false,
  }
}

export function resetMotionBlurState(state: MotionBlurState): void {
  state.initialized = false
}

/** The subset of MotionBlurFilter the transform drives (duck-typed for tests). */
export type MotionBlurFilterLike = Pick<MotionBlurFilter, 'velocity' | 'kernelSize' | 'offset'>

interface MotionBlurSample {
  /** Blur length in stage px along the motion direction (0 = idle). */
  blurPx: number
  velocity: { x: number; y: number }
  kernelSize: number
  offset: number
}

const IDLE_MOTION_BLUR: MotionBlurSample = {
  blurPx: 0,
  velocity: { x: 0, y: 0 },
  kernelSize: IDLE_KERNEL_SIZE,
  offset: 0,
}

/**
 * Advance the motion-blur state by one frame and return the filter params for
 * it. Pure apart from the state mutation, so preview and export share it.
 */
export function stepMotionBlur(
  state: MotionBlurState,
  transform: ZoomTransform,
  stageSize: StageSize,
  motionBlurAmount: number,
  frameTimeMs: number,
): MotionBlurSample {
  if (!state.initialized) {
    state.prevCamX = transform.x
    state.prevCamY = transform.y
    state.prevCamScale = transform.scale
    state.lastFrameTimeMs = frameTimeMs
    state.initialized = true
    return IDLE_MOTION_BLUR
  }

  const dtMs = Math.min(MAX_FRAME_DT_MS, Math.max(1, frameTimeMs - state.lastFrameTimeMs))
  const dtSeconds = dtMs / 1000
  state.lastFrameTimeMs = frameTimeMs

  const dx = transform.x - state.prevCamX
  const dy = transform.y - state.prevCamY
  const dScale = transform.scale - state.prevCamScale
  state.prevCamX = transform.x
  state.prevCamY = transform.y
  state.prevCamScale = transform.scale

  const stageHeight = stageSize.height > 0 ? stageSize.height : REFERENCE_STAGE_HEIGHT
  const toReference = REFERENCE_STAGE_HEIGHT / stageHeight

  // Velocity in reference px/s (translation + scale-change contribution).
  const velocityX = (dx / dtSeconds) * toReference
  const velocityY = (dy / dtSeconds) * toReference
  const scaleVelocity =
    Math.abs(dScale / dtSeconds) * Math.max(stageSize.width, stageSize.height) * toReference * 0.5
  const translationSpeed = Math.sqrt(velocityX * velocityX + velocityY * velocityY)
  const speed = translationSpeed + scaleVelocity

  const normalised = Math.min(1, speed / PEAK_VELOCITY_PPS)
  const amountResponse = getMotionBlurAmountResponse(motionBlurAmount)
  const referenceBlur =
    speed < VELOCITY_THRESHOLD_PPS ? 0 : normalised * normalised * MAX_BLUR_PX * amountResponse
  if (referenceBlur <= 0) {
    return IDLE_MOTION_BLUR
  }

  // Back to this stage's px so the blur covers the same fraction of the frame.
  const blurPx = referenceBlur / toReference
  const dirMag = translationSpeed || 1
  const velocityScale = blurPx * VELOCITY_SCALE
  return {
    blurPx,
    velocity: {
      x: (velocityX / dirMag) * velocityScale,
      y: (velocityY / dirMag) * velocityScale,
    },
    kernelSize: referenceBlur > 8 ? 15 : referenceBlur > 4 ? 11 : 7,
    offset: referenceBlur > 0.5 ? -0.2 : 0,
  }
}

function applyMotionBlurSample(filter: MotionBlurFilterLike, sample: MotionBlurSample): void {
  filter.velocity = { x: sample.velocity.x, y: sample.velocity.y }
  filter.kernelSize = sample.kernelSize
  filter.offset = sample.offset
}

export interface ZoomTransform {
  scale: number
  x: number
  y: number
}

interface StageSize {
  width: number
  height: number
}

interface BaseMask {
  x: number
  y: number
  width: number
  height: number
}

interface ZoomTransformGeometry {
  stageSize: StageSize
  baseMask: BaseMask
  zoomScale: number
  /** 0 = unzoomed, 1 = fully at zoomScale/focus; the eased region strength. */
  zoomProgress?: number
  focusX: number
  focusY: number
}

interface FocusFromTransformGeometry {
  stageSize: StageSize
  baseMask: BaseMask
  zoomScale: number
  x: number
  y: number
}

interface TransformParams {
  cameraContainer: Container
  /** Directional blur driven by camera velocity; null disables blur. */
  motionBlurFilter?: MotionBlurFilterLike | null
  /** Per-renderer velocity memory; required for the filter to do anything. */
  motionBlurState?: MotionBlurState | null
  stageSize: StageSize
  baseMask: BaseMask
  zoomScale: number
  zoomProgress?: number
  focusX: number
  focusY: number
  isPlaying: boolean
  /** 0 = off .. 1 = strongest; see getMotionBlurAmountResponse. */
  motionBlurAmount?: number
  /** Pre-computed camera transform (e.g. the spring output); skips computeZoomTransform. */
  transformOverride?: ZoomTransform
  /**
   * Content time of this frame in ms. Drives the velocity (px/s) estimate so
   * preview and export blur identically for the same camera path.
   */
  frameTimeMs?: number
}

const IDENTITY: ZoomTransform = { scale: 1, x: 0, y: 0 }

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
    return { ...IDENTITY }
  }

  const progress = Math.min(1, Math.max(0, zoomProgress))
  // Focus coords are stage-normalised (0-1 of the full canvas), so map straight to stage pixels.
  const focusStagePxX = focusX * stageSize.width
  const focusStagePxY = focusY * stageSize.height
  const stageCenterX = stageSize.width / 2
  const stageCenterY = stageSize.height / 2
  const scale = 1 + (zoomScale - 1) * progress
  const finalX = stageCenterX - focusStagePxX * zoomScale
  const finalY = stageCenterY - focusStagePxY * zoomScale

  return {
    scale,
    x: finalX * progress,
    y: finalY * progress,
  }
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
    return { cx: 0.5, cy: 0.5 }
  }

  const stageCenterX = stageSize.width / 2
  const stageCenterY = stageSize.height / 2
  const focusStagePxX = (stageCenterX - x) / zoomScale
  const focusStagePxY = (stageCenterY - y) / zoomScale

  return {
    cx: focusStagePxX / stageSize.width,
    cy: focusStagePxY / stageSize.height,
  }
}

export function applyZoomTransform({
  cameraContainer,
  motionBlurFilter,
  motionBlurState,
  stageSize,
  baseMask,
  zoomScale,
  zoomProgress = 1,
  focusX,
  focusY,
  isPlaying,
  motionBlurAmount = 0,
  transformOverride,
  frameTimeMs,
}: TransformParams): ZoomTransform {
  if (
    stageSize.width <= 0 ||
    stageSize.height <= 0 ||
    baseMask.width <= 0 ||
    baseMask.height <= 0
  ) {
    return { ...IDENTITY }
  }

  const transform =
    transformOverride ??
    computeZoomTransform({ stageSize, baseMask, zoomScale, zoomProgress, focusX, focusY })

  cameraContainer.scale.set(transform.scale)
  cameraContainer.position.set(transform.x, transform.y)

  const blurActive = Boolean(
    motionBlurFilter && motionBlurState && motionBlurAmount > 0 && isPlaying,
  )
  if (blurActive && motionBlurFilter && motionBlurState) {
    const now = frameTimeMs ?? performance.now()
    applyMotionBlurSample(
      motionBlurFilter,
      stepMotionBlur(motionBlurState, transform, stageSize, motionBlurAmount, now),
    )
  } else {
    if (motionBlurFilter) applyMotionBlurSample(motionBlurFilter, IDLE_MOTION_BLUR)
    if (motionBlurState) resetMotionBlurState(motionBlurState)
  }

  return { scale: transform.scale, x: transform.x, y: transform.y }
}
