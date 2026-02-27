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

export interface AnnotationTextStyle {
  color: string;
  backgroundColor: string;
  fontSize: number; // pixels
  fontFamily: string;
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  textAlign: 'left' | 'center' | 'right';
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
};

export const DEFAULT_FIGURE_DATA: FigureData = {
  arrowDirection: 'right',
  color: '#34B27B',
  strokeWidth: 4,
};



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
}

export const DEFAULT_ZOOM_DEPTH: ZoomDepth = 3;

export function clampFocusToDepth(focus: ZoomFocus, _depth: ZoomDepth): ZoomFocus {
  return {
    cx: clamp(focus.cx, 0, 1),
    cy: clamp(focus.cy, 0, 1),
  };
}

function clamp(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}
