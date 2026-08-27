import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '@/lib/userPreferences';
import { ASPECT_RATIOS } from '@/utils/aspectRatioUtils';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_EDITOR_APPEARANCE_SETTINGS,
  DEFAULT_EDITOR_LAYOUT_SETTINGS,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_GIF_SETTINGS,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_WALLPAPER,
  WALLPAPER_COUNT,
} from './editorDefaults';
import { DEFAULT_CROP_REGION } from './types';

describe('editor defaults SSOT', () => {
  it('keeps user preference defaults aligned with editor and export defaults', () => {
    expect(DEFAULT_PREFS).toMatchObject({
      padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
      aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
      exportQuality: DEFAULT_EXPORT_SETTINGS.quality,
      exportFormat: DEFAULT_EXPORT_SETTINGS.format,
      seekStepSeconds: DEFAULT_PLAYBACK_SETTINGS.seekStepSeconds,
      previewPlaybackRate: DEFAULT_PLAYBACK_SETTINGS.previewPlaybackRate,
    });
  });

  it('uses a canonical wallpaper path inside the bundled set', () => {
    const match = DEFAULT_WALLPAPER.match(/^\/wallpapers\/wallpaper(\d+)\.jpg$/);
    expect(match).not.toBeNull();
    const index = Number(match![1]);
    expect(index).toBeGreaterThanOrEqual(1);
    expect(index).toBeLessThanOrEqual(WALLPAPER_COUNT);
    expect(DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper).toBe(DEFAULT_WALLPAPER);
  });

  it('uses a supported aspect ratio and the full-frame crop', () => {
    expect(ASPECT_RATIOS).toContain(DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio);
    expect(DEFAULT_EDITOR_LAYOUT_SETTINGS.cropRegion).toEqual(DEFAULT_CROP_REGION);
    expect(DEFAULT_EDITOR_LAYOUT_SETTINGS.padding).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_EDITOR_LAYOUT_SETTINGS.padding).toBeLessThanOrEqual(100);
  });

  it('starts with effects off', () => {
    expect(DEFAULT_EDITOR_APPEARANCE_SETTINGS).toEqual({
      shadowIntensity: 0,
      showBlur: false,
      motionBlurEnabled: false,
      borderRadius: 0,
    });
  });

  it('keeps gif and audio defaults within their valid ranges', () => {
    expect([15, 20, 25, 30]).toContain(DEFAULT_GIF_SETTINGS.frameRate);
    expect(['medium', 'large', 'original']).toContain(DEFAULT_GIF_SETTINGS.sizePreset);
    expect(DEFAULT_AUDIO_SETTINGS.gain).toBeGreaterThan(0);
    expect(DEFAULT_AUDIO_SETTINGS.limiterDb).toBeLessThanOrEqual(0);
    expect(DEFAULT_AUDIO_SETTINGS.targetLufs).toBeLessThan(0);
  });
});
