export type ZoomDepth = 1 | 2 | 3 | 4 | 5 | 6;

export interface ZoomFocus {
  cx: number; // normalized horizontal center (0-1)
  cy: number; // normalized vertical center (0-1)
}

export interface ZoomRegion {
  id: string;
  startMs: number;
  endMs: number;
  depth: ZoomDepth;
  focus: ZoomFocus;
  /** Continuous zoom scale; when set it overrides the depth preset (see getZoomScale). */
  customScale?: number;
}

export interface TrimRegion {
  id: string;
  startMs: number;
  endMs: number;
}

export interface VideoSegment {
  id: string;
  startMs: number;   // source time
  endMs: number;     // source time
  deleted: boolean;
  speed: number;     // 1.0 = normal
}

export type AudioEditMode = 'mute' | 'duck';

export interface AudioEditRegion {
  id: string;
  startMs: number;
  endMs: number;
  mode: AudioEditMode;
  gain: number;
  source?: 'rough-cut' | 'manual';
  reason?: 'silence' | 'filler';
}

export type AnnotationType = 'text' | 'image' | 'figure';

export type ArrowDirection = 'up' | 'down' | 'left' | 'right' | 'up-right' | 'up-left' | 'down-right' | 'down-left';

export interface FigureData {
  arrowDirection: ArrowDirection;
  color: string;
  strokeWidth: number;
}

export interface AnnotationPosition {
  x: number;
  y: number;
}

export interface AnnotationSize {
  width: number;
  height: number;
}

export type AnnotationTextAnimation =
  | 'none'
  | 'fade'
  | 'rise'
  | 'pop'
  | 'slide-left'
  | 'typewriter'
  | 'pulse';

export interface AnnotationTextStyle {
  color: string;
  backgroundColor: string;
  fontSize: number; // pixels
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  textAlign: 'left' | 'center' | 'right';
  /** Entrance animation (see lib/annotationTextAnimation). Optional for older saves. */
  textAnimation?: AnnotationTextAnimation;
}

export interface AnnotationRegion {
  id: string;
  startMs: number;
  endMs: number;
  type: AnnotationType;
  content: string; // Legacy - still used for current type
  textContent?: string; // Separate storage for text
  imageContent?: string; // Separate storage for image data URL
  position: AnnotationPosition;
  size: AnnotationSize;
  style: AnnotationTextStyle;
  zIndex: number;
  figureData?: FigureData;
}

export const DEFAULT_ANNOTATION_POSITION: AnnotationPosition = {
  x: 50,
  y: 50,
};

export const DEFAULT_ANNOTATION_SIZE: AnnotationSize = {
  width: 30,
  height: 20,
};

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
};

export const DEFAULT_FIGURE_DATA: FigureData = {
  arrowDirection: 'right',
  color: '#34B27B',
  strokeWidth: 4,
};

/**
 * A freshly created text annotation starts with no content: the properties
 * panel's textarea shows a real placeholder for the empty state, so the value
 * must be empty for it to show and for typing to replace rather than append to
 * baked-in text (upstream #127).
 */
export function createTextAnnotationRegion(params: {
  id: string;
  startMs: number;
  endMs: number;
  zIndex: number;
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
  };
}

/**
 * Content for a region whose type is being switched to "text" -- same
 * empty-by-default rule as a freshly created one when no prior text was stored.
 */
export function resolveTextAnnotationContent(existingTextContent?: string): string {
  return existingTextContent || '';
}



export interface CropRegion {
  x: number; 
  y: number; 
  width: number; 
  height: number; 
}

export const DEFAULT_CROP_REGION: CropRegion = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export type PlaybackSpeed = number;

/** Segment speed range shared by the presets, the custom input and handleSegmentSpeedChange. */
export const MIN_PLAYBACK_SPEED = 0.25;
export const MAX_PLAYBACK_SPEED = 40;

export function clampPlaybackSpeed(speed: number): PlaybackSpeed {
  return Math.round(Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, speed)) * 100) / 100;
}

export const ZOOM_DEPTH_SCALES: Record<ZoomDepth, number> = {
  1: 1.25,
  2: 1.5,
  3: 1.8,
  4: 2.2,
  5: 3.5,
  6: 5.0,
};

export interface ProjectState {
  version: 1;
  savedAt: number;
  videoFilePath: string;
  segments: VideoSegment[];
  zoomRegionsByAspect: Record<string, ZoomRegion[]>;
  annotationRegions: AnnotationRegion[];
  audioEditRegions: AudioEditRegion[];
  cropRegionsByAspect: Record<string, CropRegion>;
  aspectRatio: string;
  wallpaper: string;
  shadowIntensity: number;
  showBlur: boolean;
  motionBlurEnabled: boolean;
  borderRadius: number;
  padding: number;
  audioEnabled: boolean;
  audioGain: number;
  audioNormalizeLoudness: boolean;
  audioTargetLufs: number;
  audioLimiterDb: number;
  exportQuality: string;
  exportFormat: string;
  seekStepSeconds: number;
  previewPlaybackRate: number;
  playheadPosition: number;
  // v1.1 additions (optional for backward compat with existing save files)
  cursorStyle?: {
    enabled: boolean;
    size: number;
    highlight: number;
    ripple: number;
    shadow: number;
    smoothingMs: number;
    movementStyle: string;
    autoHideStatic: boolean;
    staticHideDelayMs: number;
    staticHideFadeMs: number;
    loopCursorPosition: boolean;
    loopBlendMs: number;
    offsetX: number;
    offsetY: number;
    timeOffsetMs: number;
    // W2-d additions (optional; older projects fall back to DEFAULT_CURSOR_STYLE)
    clipToBounds?: boolean;
    motionBlur?: number;
  };
  subtitleCues?: Array<{
    id: string;
    startMs: number;
    endMs: number;
    text: string;
    source: string;
    confidence?: number;
  }>;
  gifFrameRate?: number;
  gifLoop?: boolean;
  gifSizePreset?: string;
  exportAspectRatios?: string[];
  timelineZoomVisibleMs?: number;
  /** W2-b: draw the audio waveform behind the AUDIO row (view setting, not edit state). */
  showTimelineWaveform?: boolean;
}

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3;

export const MIN_ZOOM_SCALE = 1.0;
export const MAX_ZOOM_SCALE = 5.0;

/**
 * Effective zoom scale for a region: a finite customScale (clamped to
 * MIN/MAX_ZOOM_SCALE) wins over the depth preset; NaN falls back to the preset.
 */
export function getZoomScale(region: ZoomRegion): number {
  if (region.customScale != null) {
    const clamped = Math.max(MIN_ZOOM_SCALE, Math.min(MAX_ZOOM_SCALE, region.customScale));
    if (Number.isFinite(clamped)) return clamped;
  }
  return ZOOM_DEPTH_SCALES[region.depth];
}

/** Clamp a focus point into the normalized 0-1 stage square (NaN -> centre). */
export function clampFocus(focus: ZoomFocus): ZoomFocus {
  return {
    cx: clamp(focus.cx, 0, 1),
    cy: clamp(focus.cy, 0, 1),
  };
}

export function clampFocusToDepth(focus: ZoomFocus, _depth: ZoomDepth): ZoomFocus {
  return clampFocus(focus);
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
