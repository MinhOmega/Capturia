/**
 * User preference for which engine "Generate subtitles" uses.
 *
 * - `auto`    native macOS speech first, in-browser Whisper as fallback (default)
 * - `native`  native only (fails on Windows/Linux)
 * - `whisper` in-browser Whisper only
 *
 * Kept in its own localStorage key rather than `userPreferences.ts` so the
 * caption feature stays self-contained.
 */

export type CaptionEngineSetting = 'auto' | 'native' | 'whisper'

export const CAPTION_ENGINE_STORAGE_KEY = 'capturia.captionsEngine'
export const CAPTION_ENGINE_SETTINGS: readonly CaptionEngineSetting[] = [
  'auto',
  'native',
  'whisper',
]
export const DEFAULT_CAPTION_ENGINE: CaptionEngineSetting = 'auto'

export function isCaptionEngineSetting(value: unknown): value is CaptionEngineSetting {
  return typeof value === 'string' && (CAPTION_ENGINE_SETTINGS as readonly string[]).includes(value)
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function resolveStorage(storage?: StorageLike): StorageLike | null {
  if (storage) return storage
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function loadCaptionEngineSetting(storage?: StorageLike): CaptionEngineSetting {
  const store = resolveStorage(storage)
  if (!store) return DEFAULT_CAPTION_ENGINE
  try {
    const raw = store.getItem(CAPTION_ENGINE_STORAGE_KEY)
    return isCaptionEngineSetting(raw) ? raw : DEFAULT_CAPTION_ENGINE
  } catch {
    return DEFAULT_CAPTION_ENGINE
  }
}

export function saveCaptionEngineSetting(value: CaptionEngineSetting, storage?: StorageLike): void {
  const store = resolveStorage(storage)
  if (!store) return
  try {
    store.setItem(CAPTION_ENGINE_STORAGE_KEY, value)
  } catch {
    // Storage may be full or disabled; the setting simply does not persist.
  }
}
