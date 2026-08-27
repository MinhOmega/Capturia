import type { ExportFormat, ExportQuality, GifFrameRate, GifSizePreset } from '@/lib/exporter/types';
import type { AspectRatio } from '@/utils/aspectRatioUtils';
import { DEFAULT_CROP_REGION, type CropRegion } from './types';

/**
 * Single source of truth for the editor's initial values (the `useState`
 * initialisers in VideoEditor, project-file fallbacks and user preferences
 * should all read from here). Slimmed to Capturia's ProjectState fields.
 */

export const DEFAULT_SOURCE_DIMENSIONS = {
  width: 1920,
  height: 1080,
} as const;

export const WALLPAPER_COUNT = 18;

/** Canonical (unresolved) wallpaper path; resolved via getAssetPath at render time. */
export const DEFAULT_WALLPAPER = '/wallpapers/wallpaper1.jpg';

export const DEFAULT_EDITOR_APPEARANCE_SETTINGS: {
  shadowIntensity: number;
  showBlur: boolean;
  /** Zoom motion blur amount 0..1; 0 = off. */
  motionBlurAmount: number;
  borderRadius: number;
} = {
  shadowIntensity: 0,
  showBlur: false,
  motionBlurAmount: 0,
  borderRadius: 0,
};

export const DEFAULT_EDITOR_LAYOUT_SETTINGS: {
  padding: number;
  aspectRatio: AspectRatio;
  cropRegion: CropRegion;
  wallpaper: string;
} = {
  padding: 50,
  aspectRatio: '16:9',
  cropRegion: DEFAULT_CROP_REGION,
  wallpaper: DEFAULT_WALLPAPER,
};

export const DEFAULT_EXPORT_SETTINGS: {
  quality: ExportQuality;
  format: ExportFormat;
} = {
  quality: 'source',
  format: 'mp4',
};

export const DEFAULT_GIF_SETTINGS: {
  frameRate: GifFrameRate;
  loop: boolean;
  sizePreset: GifSizePreset;
} = {
  frameRate: 15,
  loop: true,
  sizePreset: 'medium',
};

export const DEFAULT_AUDIO_SETTINGS: {
  enabled: boolean;
  gain: number;
  normalizeLoudness: boolean;
  targetLufs: number;
  limiterDb: number;
} = {
  enabled: true,
  gain: 1,
  normalizeLoudness: true,
  targetLufs: -16,
  limiterDb: -1,
};

export const DEFAULT_TIMELINE_SETTINGS: {
  /** Waveform decoding costs a full audio decode; off until the user opts in. */
  showWaveform: boolean;
} = {
  showWaveform: false,
};

export const DEFAULT_PLAYBACK_SETTINGS: {
  seekStepSeconds: number;
  previewPlaybackRate: number;
} = {
  seekStepSeconds: 5,
  previewPlaybackRate: 1,
};
