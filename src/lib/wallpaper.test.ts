import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAssetPath } = vi.hoisted(() => ({ mockGetAssetPath: vi.fn() }));
vi.mock('@/lib/assetPath', () => ({ getAssetPath: mockGetAssetPath, default: mockGetAssetPath }));

import { BackgroundLoadError } from '@/lib/exporter/backgroundErrors';
import {
  classifyWallpaper,
  DEFAULT_WALLPAPER,
  encodeRelativeAssetPath,
  isSameBuiltInWallpaper,
  normalizeWallpaperValue,
  resolveImageWallpaperUrl,
  UnsafeAssetPathError,
  UnsafeImagePrefixError,
  WALLPAPER_COUNT,
  WALLPAPER_PATHS,
} from './wallpaper';

describe('WALLPAPER_PATHS', () => {
  it('contains WALLPAPER_COUNT canonical entries', () => {
    expect(WALLPAPER_PATHS).toHaveLength(WALLPAPER_COUNT);
    expect(WALLPAPER_PATHS[0]).toBe('/wallpapers/wallpaper1.jpg');
    expect(WALLPAPER_PATHS[WALLPAPER_COUNT - 1]).toBe(`/wallpapers/wallpaper${WALLPAPER_COUNT}.jpg`);
  });

  it('DEFAULT_WALLPAPER is WALLPAPER_PATHS[0]', () => {
    expect(DEFAULT_WALLPAPER).toBe(WALLPAPER_PATHS[0]);
  });
});

describe('classifyWallpaper', () => {
  it('hex color', () => {
    expect(classifyWallpaper('#1a1a2e')).toEqual({ kind: 'color', value: '#1a1a2e' });
  });

  it('rgb() color', () => {
    expect(classifyWallpaper('rgb(1, 2, 3)')).toEqual({ kind: 'color', value: 'rgb(1, 2, 3)' });
  });

  it('rgba() color', () => {
    expect(classifyWallpaper('rgba(1, 2, 3, 0.5)')).toEqual({ kind: 'color', value: 'rgba(1, 2, 3, 0.5)' });
  });

  it('hsl() color', () => {
    expect(classifyWallpaper('hsl(180, 50%, 50%)')).toEqual({ kind: 'color', value: 'hsl(180, 50%, 50%)' });
  });

  it('oklch() color', () => {
    expect(classifyWallpaper('oklch(50% 0.1 180)')).toEqual({ kind: 'color', value: 'oklch(50% 0.1 180)' });
  });

  it('linear gradient', () => {
    const v = 'linear-gradient(90deg, red, blue)';
    expect(classifyWallpaper(v)).toEqual({ kind: 'gradient', value: v });
  });

  it('radial gradient', () => {
    const v = 'radial-gradient(circle, red, blue)';
    expect(classifyWallpaper(v)).toEqual({ kind: 'gradient', value: v });
  });

  it('conic gradient', () => {
    const v = 'conic-gradient(red, blue)';
    expect(classifyWallpaper(v)).toEqual({ kind: 'gradient', value: v });
  });

  it('repeating-linear gradient', () => {
    const v = 'repeating-linear-gradient(45deg, red 0 10px, blue 10px 20px)';
    expect(classifyWallpaper(v)).toEqual({ kind: 'gradient', value: v });
  });

  it('repeating-radial gradient', () => {
    const v = 'repeating-radial-gradient(circle, red, blue 20px)';
    expect(classifyWallpaper(v)).toEqual({ kind: 'gradient', value: v });
  });

  it('leading-slash image path', () => {
    expect(classifyWallpaper('/wallpapers/wallpaper1.jpg')).toEqual({
      kind: 'image',
      path: '/wallpapers/wallpaper1.jpg',
    });
  });

  it('http URL as image', () => {
    expect(classifyWallpaper('https://example.com/bg.jpg')).toEqual({
      kind: 'image',
      path: 'https://example.com/bg.jpg',
    });
  });

  it('file:// URL as image', () => {
    expect(classifyWallpaper('file:///tmp/bg.jpg')).toEqual({ kind: 'image', path: 'file:///tmp/bg.jpg' });
  });

  it('data URI as image', () => {
    expect(classifyWallpaper('data:image/png;base64,AAA')).toEqual({
      kind: 'image',
      path: 'data:image/png;base64,AAA',
    });
  });

  it('named color falls back to color', () => {
    expect(classifyWallpaper('red')).toEqual({ kind: 'color', value: 'red' });
  });

  it('empty string falls back to black', () => {
    expect(classifyWallpaper('')).toEqual({ kind: 'color', value: '#000000' });
  });

  it('trims whitespace', () => {
    expect(classifyWallpaper('  #abcdef  ')).toEqual({ kind: 'color', value: '#abcdef' });
  });

  it('DEFAULT_WALLPAPER classifies as image', () => {
    expect(classifyWallpaper(DEFAULT_WALLPAPER)).toEqual({ kind: 'image', path: DEFAULT_WALLPAPER });
  });

  it('strips a leading url() overlay layer and returns the trailing gradient', () => {
    const composite =
      'url("data:image/svg+xml;utf8,<svg/>") repeat, linear-gradient(135deg, rgb(255,0,0) 0%, rgb(0,0,255) 100%)';
    expect(classifyWallpaper(composite)).toEqual({
      kind: 'gradient',
      value: 'linear-gradient(135deg, rgb(255,0,0) 0%, rgb(0,0,255) 100%)',
    });
  });

  it('handles repeating-gradient variants in composite backgrounds', () => {
    const composite = 'url("data:image/svg+xml;utf8,<svg/>") repeat, repeating-linear-gradient(45deg, red, blue)';
    expect(classifyWallpaper(composite)).toEqual({
      kind: 'gradient',
      value: 'repeating-linear-gradient(45deg, red, blue)',
    });
  });

  it('tolerates missing or extra whitespace around the comma in composite backgrounds', () => {
    const noSpace = 'url("data:image/svg+xml;utf8,<svg/>") repeat,linear-gradient(135deg, red, blue)';
    expect(classifyWallpaper(noSpace)).toEqual({ kind: 'gradient', value: 'linear-gradient(135deg, red, blue)' });

    const extraSpace = 'url("data:image/svg+xml;utf8,<svg/>") repeat,   linear-gradient(135deg, red, blue)';
    expect(classifyWallpaper(extraSpace)).toEqual({ kind: 'gradient', value: 'linear-gradient(135deg, red, blue)' });
  });
});

describe('encodeRelativeAssetPath', () => {
  it('encodes each segment and strips leading slashes', () => {
    expect(encodeRelativeAssetPath('/wallpapers/my image.jpg')).toBe('wallpapers/my%20image.jpg');
    expect(encodeRelativeAssetPath('wallpapers/wallpaper1.jpg')).toBe('wallpapers/wallpaper1.jpg');
  });

  it('does not double-encode already encoded segments', () => {
    expect(encodeRelativeAssetPath('/wallpapers/my%20image.jpg')).toBe('wallpapers/my%20image.jpg');
  });

  it('rejects traversal segments, also when percent-encoded', () => {
    expect(() => encodeRelativeAssetPath('/wallpapers/../etc/passwd')).toThrow(UnsafeAssetPathError);
    expect(() => encodeRelativeAssetPath('/wallpapers/./x.jpg')).toThrow(UnsafeAssetPathError);
    expect(() => encodeRelativeAssetPath('/wallpapers/%2e%2e/app.asar')).toThrow(UnsafeAssetPathError);
    expect(() => encodeRelativeAssetPath('/wallpapers//x.jpg')).toThrow(UnsafeAssetPathError);
  });
});

describe('resolveImageWallpaperUrl', () => {
  beforeEach(() => {
    mockGetAssetPath.mockReset();
    mockGetAssetPath.mockImplementation(async (relativePath: string) => `file:///opt/app/resources/assets/${relativePath}`);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes through http, https, file and data URLs without touching getAssetPath', async () => {
    for (const url of [
      'http://example.com/bg.jpg',
      'https://example.com/bg.jpg',
      'file:///tmp/bg.jpg',
      'data:image/png;base64,AAAA',
    ]) {
      await expect(resolveImageWallpaperUrl(url)).resolves.toBe(url);
    }
    expect(mockGetAssetPath).not.toHaveBeenCalled();
  });

  it('resolves canonical wallpaper paths through getAssetPath (leading slash or bare)', async () => {
    await expect(resolveImageWallpaperUrl('/wallpapers/wallpaper1.jpg')).resolves.toBe(
      'file:///opt/app/resources/assets/wallpapers/wallpaper1.jpg',
    );
    await expect(resolveImageWallpaperUrl('wallpapers/wallpaper2.jpg')).resolves.toBe(
      'file:///opt/app/resources/assets/wallpapers/wallpaper2.jpg',
    );
    expect(mockGetAssetPath).toHaveBeenCalledWith('wallpapers/wallpaper1.jpg');
  });

  it('encodes special characters in path segments', async () => {
    await resolveImageWallpaperUrl('/wallpapers/my image.jpg');
    expect(mockGetAssetPath).toHaveBeenCalledWith('wallpapers/my%20image.jpg');
  });

  it('rejects image paths outside /wallpapers/ with UnsafeImagePrefixError as cause', async () => {
    const err = await resolveImageWallpaperUrl('/etc/passwd').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundLoadError);
    expect((err as BackgroundLoadError).cause).toBeInstanceOf(UnsafeImagePrefixError);
    expect(mockGetAssetPath).not.toHaveBeenCalled();
  });

  it('wraps traversal attempts in BackgroundLoadError (preserves UnsafeAssetPathError as cause)', async () => {
    for (const path of ['/wallpapers/../etc/passwd', '/wallpapers/%2e%2e/app.asar']) {
      const err = await resolveImageWallpaperUrl(path).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackgroundLoadError);
      expect((err as BackgroundLoadError).cause).toBeInstanceOf(UnsafeAssetPathError);
    }
    expect(mockGetAssetPath).not.toHaveBeenCalled();
  });

  it('wraps getAssetPath failures in BackgroundLoadError with a path-free message', async () => {
    const inner = new Error('ipc down');
    mockGetAssetPath.mockRejectedValue(inner);
    const err = await resolveImageWallpaperUrl('/wallpapers/wallpaper3.jpg').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundLoadError);
    expect((err as BackgroundLoadError).cause).toBe(inner);
    expect((err as BackgroundLoadError).displayUrl).toBe('wallpaper3.jpg');
  });
});

describe('normalizeWallpaperValue (legacy project migration)', () => {
  it('rewrites packaged file URLs (resources/assets/wallpapers/…)', () => {
    expect(normalizeWallpaperValue('file:///opt/Capturia/resources/assets/wallpapers/wallpaper5.jpg')).toBe(
      '/wallpapers/wallpaper5.jpg',
    );
  });

  it('rewrites the flat packaged layout (resources/wallpapers/…)', () => {
    expect(normalizeWallpaperValue('file:///opt/Capturia/resources/wallpapers/wallpaper3.jpg')).toBe(
      '/wallpapers/wallpaper3.jpg',
    );
  });

  it('rewrites dev-server file URLs (public/wallpapers/…)', () => {
    expect(normalizeWallpaperValue('file:///home/me/Capturia/public/wallpapers/wallpaper1.jpg')).toBe(
      '/wallpapers/wallpaper1.jpg',
    );
    expect(normalizeWallpaperValue('file:///home/me/Capturia/public/assets/wallpapers/wallpaper4.jpg')).toBe(
      '/wallpapers/wallpaper4.jpg',
    );
  });

  it('rewrites Windows-style file URLs with a drive letter', () => {
    expect(normalizeWallpaperValue('file:///C:/Users/me/AppData/Local/Capturia/resources/assets/wallpapers/wallpaper2.jpg')).toBe(
      '/wallpapers/wallpaper2.jpg',
    );
    expect(normalizeWallpaperValue('file://C:/Program%20Files/Capturia/resources/wallpapers/wallpaper7.jpg')).toBe(
      '/wallpapers/wallpaper7.jpg',
    );
  });

  it('rewrites the bare relative fallback the settings panel used to emit', () => {
    expect(normalizeWallpaperValue('wallpapers/wallpaper6.jpg')).toBe('/wallpapers/wallpaper6.jpg');
  });

  it('falls back to DEFAULT_WALLPAPER when the legacy URL points outside the bundled set', () => {
    expect(normalizeWallpaperValue('file:///opt/Capturia/resources/assets/wallpapers/wallpaper99.jpg')).toBe(
      DEFAULT_WALLPAPER,
    );
    expect(normalizeWallpaperValue('')).toBe(DEFAULT_WALLPAPER);
  });

  it('leaves canonical paths, colours, gradients and data URIs untouched', () => {
    for (const value of [
      '/wallpapers/wallpaper2.jpg',
      '#1a1a2e',
      'rgb(1, 2, 3)',
      'linear-gradient(135deg, red, blue)',
      'data:image/png;base64,AAA',
    ]) {
      expect(normalizeWallpaperValue(value)).toBe(value);
    }
  });

  it("keeps a user's own file that merely lives under a wallpapers folder", () => {
    const own = 'file:///home/me/Pictures/wallpapers/wallpaper1.jpg';
    expect(normalizeWallpaperValue(own)).toBe(own);
  });
});

describe('isSameBuiltInWallpaper', () => {
  it('matches canonical and legacy forms of the same bundled image', () => {
    expect(isSameBuiltInWallpaper('/wallpapers/wallpaper2.jpg', '/wallpapers/wallpaper2.jpg')).toBe(true);
    expect(
      isSameBuiltInWallpaper('file:///opt/Capturia/resources/assets/wallpapers/wallpaper2.jpg', '/wallpapers/wallpaper2.jpg'),
    ).toBe(true);
    expect(isSameBuiltInWallpaper('/wallpapers/wallpaper3.jpg', '/wallpapers/wallpaper2.jpg')).toBe(false);
    expect(isSameBuiltInWallpaper(null, '/wallpapers/wallpaper2.jpg')).toBe(false);
    expect(isSameBuiltInWallpaper('#ffffff', '/wallpapers/wallpaper2.jpg')).toBe(false);
  });
});
