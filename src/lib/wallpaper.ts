/**
 * Single source of truth for the editor background ("wallpaper") value.
 *
 * The persisted form is always canonical: `/wallpapers/wallpaperN.jpg` for
 * the bundled images, `#hex` / `rgb(...)` for colours, a CSS gradient string
 * or a `data:` URI for uploads. Bundled images are resolved to a loadable URL
 * (`file://` in the packaged app, `/wallpapers/...` on the dev server) only
 * at render time via `resolveImageWallpaperUrl`, so a project moved between
 * machines or between dev and packaged layouts keeps working.
 *
 * Ported from upstream `src/lib/wallpaper.ts` (adf3855a … 37331980), adapted
 * to Capturia's async `getAssetPath` and `assets/wallpapers` layout.
 */
import { getAssetPath } from '@/lib/assetPath';
import { BackgroundLoadError } from '@/lib/exporter/backgroundErrors';

export { BackgroundLoadError };

export const WALLPAPER_COUNT = 18;

export const WALLPAPER_PATHS: readonly string[] = Array.from(
  { length: WALLPAPER_COUNT },
  (_, i) => `/wallpapers/wallpaper${i + 1}.jpg`,
);

export const DEFAULT_WALLPAPER = WALLPAPER_PATHS[0];

const CANONICAL_WALLPAPERS = new Set(WALLPAPER_PATHS);

export type WallpaperClassification =
  | { kind: 'color'; value: string }
  | { kind: 'gradient'; value: string }
  | { kind: 'image'; path: string };

const GRADIENT_RE = /^(repeating-)?(linear|radial|conic)-gradient\(/;
const COLOR_FUNC_RE = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/;
const IMAGE_URL_RE = /^(\/|https?:\/\/|file:\/\/|data:)/;

export function classifyWallpaper(value: string): WallpaperClassification {
  const trimmed = value.trim();
  if (trimmed === '') {
    return { kind: 'color', value: '#000000' };
  }
  // Multi-background (e.g. "url(noise), linear-gradient(...)") - peel the
  // gradient layer off so the gradient parser can still handle it. Noise/url
  // overlays are lost on export; the live preview paints the full string.
  if (trimmed.startsWith('url(')) {
    const gradient = extractTrailingGradient(trimmed);
    if (gradient) return { kind: 'gradient', value: gradient };
  }
  if (trimmed.startsWith('#') || COLOR_FUNC_RE.test(trimmed)) {
    return { kind: 'color', value: trimmed };
  }
  if (GRADIENT_RE.test(trimmed)) {
    return { kind: 'gradient', value: trimmed };
  }
  if (IMAGE_URL_RE.test(trimmed)) {
    return { kind: 'image', path: trimmed };
  }
  return { kind: 'color', value: trimmed };
}

function extractTrailingGradient(value: string): string | null {
  const match = value.match(/,\s*((?:repeating-)?(?:linear|radial|conic)-gradient\(.*\))\s*$/);
  return match?.[1] ?? null;
}

const ALLOWED_IMAGE_PREFIX = '/wallpapers/';

export class UnsafeImagePrefixError extends Error {
  constructor(prefix: string) {
    super(`Image wallpaper path must live under ${prefix}`);
    this.name = 'UnsafeImagePrefixError';
  }
}

export class UnsafeAssetPathError extends Error {
  constructor(relativePath: string) {
    super(`Asset path must not contain "." or ".." segments: ${relativePath}`);
    this.name = 'UnsafeAssetPathError';
  }
}

/**
 * Percent-encode each segment of a relative asset path, rejecting `.` / `..`
 * segments (also when they arrive percent-encoded) so a stored value can
 * never escape the asset directory.
 */
export function encodeRelativeAssetPath(relativePath: string): string {
  const segments = relativePath.replace(/^\/+/, '').split('/');
  return segments
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not valid percent-encoding: encode the raw segment as-is.
      }
      if (decoded === '' || decoded === '.' || decoded === '..') {
        throw new UnsafeAssetPathError(relativePath);
      }
      return encodeURIComponent(decoded);
    })
    .join('/');
}

/**
 * Resolve an image wallpaper value to a URL the renderer can load. Absolute
 * URLs and data URIs pass through; anything else must be a bundled
 * `/wallpapers/...` path and is resolved through `getAssetPath`. Every
 * failure surfaces as a `BackgroundLoadError` whose message never contains
 * the full local path.
 */
export async function resolveImageWallpaperUrl(imagePath: string): Promise<string> {
  if (
    imagePath.startsWith('http://') ||
    imagePath.startsWith('https://') ||
    imagePath.startsWith('file://') ||
    imagePath.startsWith('data:')
  ) {
    return imagePath;
  }
  const withLeadingSlash = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
  if (!withLeadingSlash.startsWith(ALLOWED_IMAGE_PREFIX)) {
    throw new BackgroundLoadError(imagePath, new UnsafeImagePrefixError(ALLOWED_IMAGE_PREFIX));
  }
  try {
    return await getAssetPath(encodeRelativeAssetPath(withLeadingSlash));
  } catch (cause) {
    if (cause instanceof BackgroundLoadError) throw cause;
    throw new BackgroundLoadError(imagePath, cause);
  }
}

// Old projects persisted machine-specific URLs for bundled wallpapers:
// `file://…/resources/assets/wallpapers/wallpaperN.jpg` (packaged),
// `file://…/public/(assets/)wallpapers/wallpaperN.jpg` (dev) or the bare
// `wallpapers/wallpaperN.jpg` fallback. Only these known layouts are
// rewritten so a user's own file under some "wallpapers" folder is kept.
const LEGACY_FILE_WALLPAPER_RE =
  /^file:\/\/.*?\/(?:resources\/(?:assets\/)?|public\/(?:assets\/)?)wallpapers\/(wallpaper\d+\.jpg)$/i;
const LEGACY_RELATIVE_WALLPAPER_RE = /^wallpapers\/(wallpaper\d+\.jpg)$/i;

/**
 * Map a persisted wallpaper value to its canonical form. Values that are not a
 * legacy bundled-image URL (colours, gradients, data URIs, foreign files) are
 * returned unchanged; a legacy URL that points outside the bundled set falls
 * back to DEFAULT_WALLPAPER.
 */
export function normalizeWallpaperValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_WALLPAPER;
  const match = LEGACY_FILE_WALLPAPER_RE.exec(trimmed) ?? LEGACY_RELATIVE_WALLPAPER_RE.exec(trimmed);
  if (!match) return trimmed;
  const canonical = `/wallpapers/${match[1].toLowerCase()}`;
  return CANONICAL_WALLPAPERS.has(canonical) ? canonical : DEFAULT_WALLPAPER;
}

/** True when `value` (canonical or legacy) refers to the bundled wallpaper `canonicalPath`. */
export function isSameBuiltInWallpaper(value: string | null | undefined, canonicalPath: string): boolean {
  if (!value) return false;
  return normalizeWallpaperValue(value) === canonicalPath;
}
