import { CAPTION_MODEL_IDS, DEFAULT_CAPTION_MODEL_ID } from './captionConstants'

/**
 * Transcription-quality preferences (P2-F4): which Whisper weights to run,
 * which language to force, and a short vocabulary hint for names the model has
 * never seen.
 *
 * Kept in their own localStorage keys next to `captionEngineSetting.ts` rather
 * than in the project file: they describe how *this machine* transcribes, not
 * what a particular recording contains.
 */

export const CAPTION_MODEL_STORAGE_KEY = 'capturia.captionsModel'
export const CAPTION_LANGUAGE_STORAGE_KEY = 'capturia.captionsLanguage'
export const CAPTION_VOCABULARY_STORAGE_KEY = 'capturia.captionsVocabulary'

/** `auto` lets Whisper detect the language; anything else is a Whisper code. */
export const CAPTION_LANGUAGE_AUTO = 'auto'

/**
 * Languages offered in the picker, as `[whisper code, autonym]`. Autonyms are
 * deliberately not translated: a speaker looking for their own language reads
 * it in that language. Kept to what Whisper transcribes well at tiny/base.
 */
export const CAPTION_LANGUAGES: ReadonlyArray<readonly [string, string]> = [
  ['en', 'English'],
  ['zh', '中文'],
  ['vi', 'Tiếng Việt'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['pt', 'Português'],
  ['it', 'Italiano'],
  ['ru', 'Русский'],
  ['ar', 'العربية'],
  ['hi', 'हिन्दी'],
  ['id', 'Bahasa Indonesia'],
  ['th', 'ไทย'],
  ['tr', 'Türkçe'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
]

const LANGUAGE_CODES: ReadonlySet<string> = new Set(CAPTION_LANGUAGES.map(([code]) => code))

/** Longest vocabulary hint kept; beyond this it stops being a hint. */
export const MAX_CAPTION_VOCABULARY_LENGTH = 500

export function isCaptionLanguageChoice(value: unknown): value is string {
  return typeof value === 'string' && (value === CAPTION_LANGUAGE_AUTO || LANGUAGE_CODES.has(value))
}

export function isCaptionModelId(value: unknown): value is string {
  return typeof value === 'string' && (CAPTION_MODEL_IDS as readonly string[]).includes(value)
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

function read(key: string, storage?: StorageLike): string | null {
  const store = resolveStorage(storage)
  if (!store) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string, storage?: StorageLike): void {
  const store = resolveStorage(storage)
  if (!store) return
  try {
    store.setItem(key, value)
  } catch {
    // Storage may be full or disabled; the setting simply does not persist.
  }
}

export function loadCaptionModelId(storage?: StorageLike): string {
  const raw = read(CAPTION_MODEL_STORAGE_KEY, storage)
  return isCaptionModelId(raw) ? raw : DEFAULT_CAPTION_MODEL_ID
}

export function saveCaptionModelId(value: string, storage?: StorageLike): void {
  if (!isCaptionModelId(value)) return
  write(CAPTION_MODEL_STORAGE_KEY, value, storage)
}

export function loadCaptionLanguage(storage?: StorageLike): string {
  const raw = read(CAPTION_LANGUAGE_STORAGE_KEY, storage)
  return isCaptionLanguageChoice(raw) ? raw : CAPTION_LANGUAGE_AUTO
}

export function saveCaptionLanguage(value: string, storage?: StorageLike): void {
  if (!isCaptionLanguageChoice(value)) return
  write(CAPTION_LANGUAGE_STORAGE_KEY, value, storage)
}

/**
 * One canonical form for the hint: terms separated by ", ", whitespace
 * collapsed, empties dropped, capped in length. Newlines and semicolons are
 * accepted as separators because that is how a list gets pasted in.
 */
export function normalizeCaptionVocabulary(value: unknown): string {
  return String(value ?? '')
    .split(/[\r\n,;]+/)
    .map((term) => term.replace(/\s+/g, ' ').trim())
    .filter((term) => term.length > 0)
    .join(', ')
    .slice(0, MAX_CAPTION_VOCABULARY_LENGTH)
}

export function loadCaptionVocabulary(storage?: StorageLike): string {
  return normalizeCaptionVocabulary(read(CAPTION_VOCABULARY_STORAGE_KEY, storage))
}

export function saveCaptionVocabulary(value: string, storage?: StorageLike): void {
  write(CAPTION_VOCABULARY_STORAGE_KEY, normalizeCaptionVocabulary(value), storage)
}
