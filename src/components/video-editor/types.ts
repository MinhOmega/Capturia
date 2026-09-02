export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6

export interface ZoomFocus {
  cx: number // normalized horizontal center (0-1)
  cy: number // normalized vertical center (0-1)
}

export interface ZoomRegion {
  id: string
  startMs: number
  endMs: number
  depth: ZoomDepth
  focus: ZoomFocus
  /** Continuous zoom scale; when set it overrides the depth preset (see getZoomScale). */
  customScale?: number
  /**
   * 'auto' = placed by the auto-zoom suggestion pass and untouched since; the
   * wand toggle removes only these. Any edit promotes the region to 'manual'.
   * Missing (older saves / hand-placed regions) means 'manual'.
   */
  source?: ZoomRegionSource
  /**
   * 'auto' = the camera follows the recorded cursor for the whole span instead
   * of the static `focus` (see videoPlayback/cursorFollowUtils.ts). Missing
   * (older saves / hand-placed regions) means 'manual'.
   */
  focusMode?: ZoomFocusMode
  /**
   * 3D tilt preset applied while the region is active (see ROTATION_3D_PRESETS).
   * Missing = flat. Ramps in/out with the region's zoom progress.
   */
  rotationPreset?: Rotation3DPreset
}

export type ZoomRegionSource = 'auto' | 'manual'
export type ZoomFocusMode = 'manual' | 'auto'

// --- 3D iso / tilt presets -------------------------------------------------

export interface Rotation3D {
  rotationX: number
  rotationY: number
  rotationZ: number
}

export const DEFAULT_ROTATION_3D: Rotation3D = {
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
}

export type Rotation3DPreset = 'iso' | 'left' | 'right'

// Every preset rotates about all three axes on purpose. A single-axis tilt leaves
// an edge of the projected quad exactly parallel to the frame (both vertical edges
// for a pure Y rotation), and a perfectly vertical edge cutting through text reads
// as `overflow: hidden` even though the whole plane is drawn — that is the
// "recording looks truncated" report. A small X and Z component breaks the parallel.
export const ROTATION_3D_PRESETS: Record<Rotation3DPreset, Rotation3D> = {
  iso: { rotationX: -12, rotationY: -18, rotationZ: -2 },
  left: { rotationX: -8, rotationY: -16, rotationZ: -1 },
  right: { rotationX: -8, rotationY: 16, rotationZ: 1 },
}

export const ROTATION_3D_PRESET_ORDER: readonly Rotation3DPreset[] = ['iso', 'left', 'right']

/**
 * Perspective distance in CSS px is this factor times min(viewport w, h). The
 * same factor drives the preview (CSS `perspective`) and the export (WebGL
 * fov), so the look matches at any canvas resolution. Lower = camera closer =
 * edges converge more visibly; at 2.6 the convergence was so flat that the
 * tilt stopped reading as a tilt (iso's top edge came out ~0.08° off level).
 */
export const ROTATION_3D_PERSPECTIVE_FACTOR = 1.6

export function rotation3DPerspective(width: number, height: number): number {
  return Math.min(width, height) * ROTATION_3D_PERSPECTIVE_FACTOR
}

/** Saved-project normaliser: only the three known presets survive; anything else reads as flat. */
export function normalizeRotationPreset(value: unknown): Rotation3DPreset | undefined {
  return value === 'iso' || value === 'left' || value === 'right' ? value : undefined
}

export function getRotation3D(region: Pick<ZoomRegion, 'rotationPreset'>): Rotation3D {
  if (!region.rotationPreset) return DEFAULT_ROTATION_3D
  return ROTATION_3D_PRESETS[region.rotationPreset] ?? DEFAULT_ROTATION_3D
}

export function isRotation3DIdentity(r: Rotation3D, eps = 0.01): boolean {
  return Math.abs(r.rotationX) < eps && Math.abs(r.rotationY) < eps && Math.abs(r.rotationZ) < eps
}

export function lerpRotation3D(a: Rotation3D, b: Rotation3D, t: number): Rotation3D {
  return {
    rotationX: a.rotationX + (b.rotationX - a.rotationX) * t,
    rotationY: a.rotationY + (b.rotationY - a.rotationY) * t,
    rotationZ: a.rotationZ + (b.rotationZ - a.rotationZ) * t,
  }
}

/**
 * Max uniform scale that, with `rot` and a perspective of `perspective` CSS px,
 * keeps the projected bounding box of a width x height element inside its
 * original rectangle. Returns 1 when no scaling is needed. Projects each
 * rotated corner (x' = x * P / (P - z)) and returns the limiting half-extent
 * ratio so the tilted recording stays inside the zoom window.
 */
export function computeRotation3DContainScale(
  rot: Rotation3D,
  width: number,
  height: number,
  perspective: number,
): number {
  const a = (rot.rotationX * Math.PI) / 180
  const b = (rot.rotationY * Math.PI) / 180
  const g = (rot.rotationZ * Math.PI) / 180
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const cb = Math.cos(b)
  const sb = Math.sin(b)
  const cg = Math.cos(g)
  const sg = Math.sin(g)
  const halfW = width / 2
  const halfH = height / 2
  const corners: Array<[number, number]> = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ]

  let maxAbsX = 0
  let maxAbsY = 0

  for (const [x0, y0] of corners) {
    // CSS "rotateX rotateY rotateZ" applies right-to-left: Z first, then Y, then X.
    let px = x0
    let py = y0
    let pz = 0

    // rotateZ
    const zx = px * cg - py * sg
    const zy = px * sg + py * cg
    px = zx
    py = zy

    // rotateY
    const yx = px * cb + pz * sb
    const yz = -px * sb + pz * cb
    px = yx
    pz = yz

    // rotateX
    const xy = py * ca - pz * sa
    const xz = py * sa + pz * ca
    py = xy
    pz = xz

    // Viewer at (0, 0, P) looking toward -z; a point at z = pz scales by P / (P - pz).
    // perspective <= 0 means orthographic.
    if (perspective > 0) {
      const denom = perspective - pz
      if (denom <= 0) return 1 // pathological, skip scaling rather than crash
      const f = perspective / denom
      px *= f
      py *= f
    }

    if (Math.abs(px) > maxAbsX) maxAbsX = Math.abs(px)
    if (Math.abs(py) > maxAbsY) maxAbsY = Math.abs(py)
  }

  if (maxAbsX === 0 || maxAbsY === 0) return 1
  const sx = halfW / maxAbsX
  const sy = halfH / maxAbsY
  return Math.min(sx, sy, 1)
}

/** Effective focus mode of a region (missing -> manual). */
export function getZoomFocusMode(region: Pick<ZoomRegion, 'focusMode'>): ZoomFocusMode {
  return region.focusMode === 'auto' ? 'auto' : 'manual'
}

export interface TrimRegion {
  id: string
  startMs: number
  endMs: number
}

export interface VideoSegment {
  id: string
  startMs: number // source time
  endMs: number // source time
  deleted: boolean
  speed: number // 1.0 = normal
}

export type AudioEditMode = 'mute' | 'duck'

export interface AudioEditRegion {
  id: string
  startMs: number
  endMs: number
  mode: AudioEditMode
  gain: number
  source?: 'rough-cut' | 'manual'
  reason?: 'silence' | 'filler'
}

export type AnnotationType = 'text' | 'image' | 'figure'

export type ArrowDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'up-right'
  | 'up-left'
  | 'down-right'
  | 'down-left'

export interface FigureData {
  arrowDirection: ArrowDirection
  color: string
  strokeWidth: number
}

export interface AnnotationPosition {
  x: number
  y: number
}

export interface AnnotationSize {
  width: number
  height: number
}

export type AnnotationTextAnimation =
  | 'none'
  | 'fade'
  | 'rise'
  | 'pop'
  | 'slide-left'
  | 'typewriter'
  | 'pulse'

export interface AnnotationTextStyle {
  color: string
  backgroundColor: string
  fontSize: number // pixels
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
  textDecoration: 'none' | 'underline'
  textAlign: 'left' | 'center' | 'right'
  /** Entrance animation (see lib/annotationTextAnimation). Optional for older saves. */
  textAnimation?: AnnotationTextAnimation
}

export interface AnnotationRegion {
  id: string
  startMs: number
  endMs: number
  type: AnnotationType
  content: string // Legacy - still used for current type
  textContent?: string // Separate storage for text
  imageContent?: string // Separate storage for image data URL
  position: AnnotationPosition
  size: AnnotationSize
  style: AnnotationTextStyle
  zIndex: number
  figureData?: FigureData
}

export const DEFAULT_ANNOTATION_POSITION: AnnotationPosition = {
  x: 50,
  y: 50,
}

export const DEFAULT_ANNOTATION_SIZE: AnnotationSize = {
  width: 30,
  height: 20,
}

export const DEFAULT_ANNOTATION_STYLE: AnnotationTextStyle = {
  color: '#ffffff',
  backgroundColor: 'transparent',
  fontSize: 32,
  fontFamily: 'Inter',
  fontWeight: 'bold',
  fontStyle: 'normal',
  textDecoration: 'none',
  textAlign: 'center',
  textAnimation: 'none',
}

export const DEFAULT_FIGURE_DATA: FigureData = {
  arrowDirection: 'right',
  color: '#34B27B',
  strokeWidth: 4,
}

/**
 * A freshly created text annotation starts with no content: the properties
 * panel's textarea shows a real placeholder for the empty state, so the value
 * must be empty for it to show and for typing to replace rather than append to
 * baked-in text (upstream #127).
 */
export function createTextAnnotationRegion(params: {
  id: string
  startMs: number
  endMs: number
  zIndex: number
}): AnnotationRegion {
  return {
    id: params.id,
    startMs: params.startMs,
    endMs: params.endMs,
    type: 'text',
    content: '',
    position: { ...DEFAULT_ANNOTATION_POSITION },
    size: { ...DEFAULT_ANNOTATION_SIZE },
    style: { ...DEFAULT_ANNOTATION_STYLE },
    zIndex: params.zIndex,
  }
}

/**
 * Content for a region whose type is being switched to "text" -- same
 * empty-by-default rule as a freshly created one when no prior text was stored.
 */
export function resolveTextAnnotationContent(existingTextContent?: string): string {
  return existingTextContent || ''
}

export interface CropRegion {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_CROP_REGION: CropRegion = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
}

export type PlaybackSpeed = number

/** Segment speed range shared by the presets, the custom input and handleSegmentSpeedChange. */
export const MIN_PLAYBACK_SPEED = 0.25
export const MAX_PLAYBACK_SPEED = 40

export function clampPlaybackSpeed(speed: number): PlaybackSpeed {
  return Math.round(Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, speed)) * 100) / 100
}

export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
  1: 1.25,
  2: 1.5,
  3: 1.8,
  4: 2.2,
  5: 3.5,
  6: 5.0,
}

export interface ProjectState {
  version: 1
  savedAt: number
  videoFilePath: string
  segments: VideoSegment[]
  zoomRegionsByAspect: Record<string, ZoomRegion[]>
  annotationRegions: AnnotationRegion[]
  audioEditRegions: AudioEditRegion[]
  cropRegionsByAspect: Record<string, CropRegion>
  aspectRatio: string
  wallpaper: string
  shadowIntensity: number
  showBlur: boolean
  /**
   * Legacy toggle (pre motion-blur slider). Still written as `motionBlurAmount > 0`
   * for one release so a downgrade reads something sensible; on load it only
   * matters when `motionBlurAmount` is absent (see resolveProjectMotionBlurAmount).
   */
  motionBlurEnabled: boolean
  /** Zoom motion blur amount 0..1 (0 = off). Missing in older saves. */
  motionBlurAmount?: number
  borderRadius: number
  padding: number
  audioEnabled: boolean
  audioGain: number
  audioNormalizeLoudness: boolean
  audioTargetLufs: number
  audioLimiterDb: number
  exportQuality: string
  exportFormat: string
  seekStepSeconds: number
  previewPlaybackRate: number
  playheadPosition: number
  // v1.1 additions (optional for backward compat with existing save files)
  cursorStyle?: {
    enabled: boolean
    size: number
    highlight: number
    ripple: number
    shadow: number
    smoothingMs: number
    movementStyle: string
    autoHideStatic: boolean
    staticHideDelayMs: number
    staticHideFadeMs: number
    loopCursorPosition: boolean
    loopBlendMs: number
    offsetX: number
    offsetY: number
    timeOffsetMs: number
    // W2-d additions (optional; older projects fall back to DEFAULT_CURSOR_STYLE)
    clipToBounds?: boolean
    motionBlur?: number
  }
  subtitleCues?: Array<{
    id: string
    startMs: number
    endMs: number
    text: string
    source: string
    confidence?: number
  }>
  gifFrameRate?: number
  gifLoop?: boolean
  gifSizePreset?: string
  exportAspectRatios?: string[]
  timelineZoomVisibleMs?: number
  /** W2-b: draw the audio waveform behind the AUDIO row (view setting, not edit state). */
  showTimelineWaveform?: boolean
  /** Auto-zoom wand state (v1.2). Missing in older saves -> treated as enabled. */
  autoZoomEnabled?: boolean
  /** Global "Auto-Focus all" toggle (W3-f). Missing in older saves -> off. */
  autoFocusAll?: boolean
}

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3

/** Motion blur amount a legacy `motionBlurEnabled: true` project maps to. */
export const DEFAULT_ZOOM_MOTION_BLUR = 0.35

/**
 * Motion blur amount for a saved project: `motionBlurAmount` when it is a
 * finite number (clamped to 0..1), otherwise the legacy boolean mapped to
 * DEFAULT_ZOOM_MOTION_BLUR / 0, otherwise 0.
 */
export function resolveProjectMotionBlurAmount(
  state: Pick<Partial<ProjectState>, 'motionBlurAmount' | 'motionBlurEnabled'>,
): number {
  const amount = state.motionBlurAmount
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return Math.min(1, Math.max(0, amount))
  }
  if (typeof state.motionBlurEnabled === 'boolean') {
    return state.motionBlurEnabled ? DEFAULT_ZOOM_MOTION_BLUR : 0
  }
  return 0
}

export const MIN_ZOOM_SCALE = 1.0
export const MAX_ZOOM_SCALE = 5.0

/**
 * Effective zoom scale for a region: a finite customScale (clamped to
 * MIN/MAX_ZOOM_SCALE) wins over the depth preset; NaN falls back to the preset.
 */
export function getZoomScale(region: ZoomRegion): number {
  if (region.customScale != null) {
    const clamped = Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, region.customScale))
    if (Number.isFinite(clamped)) return clamped
  }
  return ZOOM_DEPTH_SCALES[region.depth]
}

/** Clamp a focus point into the normalized 0-1 stage square (NaN -> centre). */
export function clampFocus(focus: ZoomFocus): ZoomFocus {
  return {
    cx: clamp(focus.cx, 0, 1),
    cy: clamp(focus.cy, 0, 1),
  }
}

export function clampFocusToDepth(focus: ZoomFocus, _depth: ZoomDepth): ZoomFocus {
  return clampFocus(focus)
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return (min + max) / 2
  return Math.min(max, Math.max(min, value))
}
