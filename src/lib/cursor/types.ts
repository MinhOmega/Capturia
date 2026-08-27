import type { ZoomFocus, ZoomRegion } from '@/components/video-editor/types';

export type CursorKind = 'arrow' | 'ibeam';
export type CursorMovementStyle = 'rapid' | 'quick' | 'default' | 'slow' | 'custom';

export interface CursorSample {
  timeMs: number;
  x: number; // normalized 0..1 relative to original capture frame
  y: number; // normalized 0..1 relative to original capture frame
  click?: boolean;
  visible?: boolean;
  cursorKind?: CursorKind;
}

export type CursorTrackEventType = 'click' | 'selection';

export interface CursorTrackEventBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface CursorTrackEvent {
  type: CursorTrackEventType;
  startMs: number;
  endMs: number;
  point: { x: number; y: number };
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  bounds?: CursorTrackEventBounds;
}

export interface CursorTrack {
  samples: CursorSample[];
  events?: CursorTrackEvent[];
  source?: 'recorded' | 'synthetic';
  space?: {
    mode?: 'source-display' | 'virtual-desktop';
    displayId?: string;
    bounds?: { x: number; y: number; width: number; height: number };
  };
  stats?: {
    sampleCount?: number;
    clickCount?: number;
  };
  capture?: {
    sourceId?: string;
    width?: number;
    height?: number;
  };
}

export interface CursorStyleConfig {
  enabled: boolean;
  size: number;
  highlight: number;
  ripple: number;
  shadow: number;
  smoothingMs: number;
  movementStyle: CursorMovementStyle;
  autoHideStatic: boolean;
  staticHideDelayMs: number;
  staticHideFadeMs: number;
  loopCursorPosition: boolean;
  loopBlendMs: number;
  offsetX: number;
  offsetY: number;
  timeOffsetMs: number;
  /** Clip the cursor (glyph, highlight, ripple) to the rounded video mask instead of letting it overflow. */
  clipToBounds: boolean;
}

export interface CursorClipRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface CursorDrawOptions {
  /** Camera-aware rounded mask rect (canvas px) to clip the cursor to; `null` = no clipping. */
  clipRect?: CursorClipRect | null;
}

export interface CursorResolveParams {
  timeMs: number;
  track?: CursorTrack | null;
  zoomRegions?: ZoomRegion[];
  fallbackFocus?: ZoomFocus;
  style?: Partial<CursorStyleConfig>;
}

export interface CursorResolvedState {
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  highlightAlpha: number;
  rippleScale: number;
  rippleAlpha: number;
  cursorKind: CursorKind;
}

export interface ProjectedCursorPoint {
  x: number;
  y: number;
  /** Inside the visible crop and within the stage (+ tolerance); false = hide the cursor. */
  inViewport: boolean;
  /** Crop re-normalised coordinate is within [0,1] on both axes. */
  inCrop: boolean;
}

export const DEFAULT_CURSOR_STYLE: CursorStyleConfig = {
  enabled: true,
  size: 2.2,
  highlight: 0.75,
  ripple: 0.7,
  shadow: 0.45,
  smoothingMs: 0,
  movementStyle: 'default',
  autoHideStatic: false,
  staticHideDelayMs: 1200,
  staticHideFadeMs: 240,
  loopCursorPosition: false,
  loopBlendMs: 900,
  offsetX: 0,
  offsetY: 0,
  timeOffsetMs: 0,
  clipToBounds: false,
};
