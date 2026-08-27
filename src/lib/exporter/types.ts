export interface ExportAudioProcessingConfig {
  normalizeLoudness?: boolean;
  targetLufs?: number;
  limiterDb?: number;
  maxBoostDb?: number;
  maxCutDb?: number;
}

export interface ExportConfig {
  width: number;
  height: number;
  frameRate: number;
  bitrate: number;
  codec?: string;
  audioEnabled?: boolean;
  audioGain?: number;
  audioProcessing?: ExportAudioProcessingConfig;
}

/**
 * How the MP4 exporter reads source frames.
 * - `'seek'`: `HTMLVideoElement` seek-only path (`VideoFileDecoder`), the
 *   long-standing default with the silent-playback guard.
 * - `'webcodecs'`: web-demuxer + `VideoDecoder` single forward pass
 *   (`StreamingVideoDecoder`); no media element is involved at all. Falls back
 *   to `'seek'` automatically when the decoder fails before the first frame.
 */
export type ExportDecodePath = 'webcodecs' | 'seek';

/** Default until the WebCodecs path has passed browser tests on all platforms. */
export const DEFAULT_EXPORT_DECODE_PATH: ExportDecodePath = 'seek';

/** `localStorage` key that overrides the decode path (support / QA switch). */
export const EXPORT_DECODE_PATH_STORAGE_KEY = 'capturia.exportDecodePath';

export function isExportDecodePath(value: unknown): value is ExportDecodePath {
  return value === 'webcodecs' || value === 'seek';
}

export interface ExportProgress {
  currentFrame: number;
  totalFrames: number;
  percentage: number;
  estimatedTimeRemaining: number; // in seconds
  phase?: 'preparing' | 'extracting' | 'rendering' | 'finalizing'; // Phase of export ('preparing' = source copy before decode)
  phaseDetailKey?: string; // i18n key for current sub-step
  renderProgress?: number; // 0-100, progress of GIF rendering phase
  updatedAtMs?: number; // wall-clock timestamp for last progress event
  elapsedMs?: number; // elapsed time since export start
  activityTick?: number; // monotonic progress heartbeat counter
  isHeartbeat?: boolean; // true when progress is heartbeat without frame increment
}

export interface ExportResult {
  success: boolean;
  blob?: Blob;
  error?: string;
  /**
   * Set when the failure is a BackgroundLoadError: the editor shows a
   * dedicated, localised toast naming `backgroundUrl` (basename only, never a
   * full local path). The retry loop never retries these.
   */
  errorKind?: 'background-load';
  backgroundUrl?: string;
  warnings?: string[];
}

export interface VideoFrameData {
  frame: VideoFrame;
  timestamp: number; // in microseconds
  duration: number; // in microseconds
}

export type ExportQuality = 'medium' | 'good' | 'source';

// GIF Export Types
export type ExportFormat = 'mp4' | 'gif';

export type GifFrameRate = 15 | 20 | 25 | 30;

export type GifSizePreset = 'medium' | 'large' | 'original';

export interface GifExportConfig {
  frameRate: GifFrameRate;
  loop: boolean;
  sizePreset: GifSizePreset;
  width: number;
  height: number;
}

export interface ExportSettings {
  format: ExportFormat;
  // MP4 settings
  quality?: ExportQuality;
  // GIF settings
  gifConfig?: GifExportConfig;
}

export const GIF_SIZE_PRESETS: Record<GifSizePreset, { maxHeight: number; label: string }> = {
  medium: { maxHeight: 720, label: 'Medium (720p)' },
  large: { maxHeight: 1080, label: 'Large (1080p)' },
  original: { maxHeight: Infinity, label: 'Original' },
};

export const GIF_FRAME_RATES: { value: GifFrameRate; label: string }[] = [
  { value: 15, label: '15 FPS - Balanced' },
  { value: 20, label: '20 FPS - Smooth' },
  { value: 25, label: '25 FPS - Very smooth' },
  { value: 30, label: '30 FPS - Maximum' },
];

// Valid frame rates for validation
export const VALID_GIF_FRAME_RATES: readonly GifFrameRate[] = [15, 20, 25, 30] as const;

export function isValidGifFrameRate(rate: number): rate is GifFrameRate {
  return VALID_GIF_FRAME_RATES.includes(rate as GifFrameRate);
}
