import { describe, expect, it } from 'vitest'
import { CAPTION_MODEL_CHOICES, DEFAULT_CAPTION_MODEL_ID } from './captionConstants'
import {
  CAPTION_LANGUAGE_AUTO,
  CAPTION_LANGUAGES,
  isCaptionLanguageChoice,
  isCaptionModelId,
  loadCaptionLanguage,
  loadCaptionModelId,
  loadCaptionVocabulary,
  MAX_CAPTION_VOCABULARY_LENGTH,
  normalizeCaptionVocabulary,
  saveCaptionLanguage,
  saveCaptionModelId,
  saveCaptionVocabulary,
} from './captionTranscriptionSettings'

/** In-memory stand-in for `localStorage`, plus a variant that always throws. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    entries: () => Object.fromEntries(map),
  }
}

const brokenStorage = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
}

describe('isCaptionModelId', () => {
  it('accepts the offered models and nothing else', () => {
    for (const choice of CAPTION_MODEL_CHOICES) {
      expect(isCaptionModelId(choice.id)).toBe(true)
    }
    expect(isCaptionModelId('Xenova/whisper-large')).toBe(false)
    expect(isCaptionModelId(null)).toBe(false)
  })
})

describe('isCaptionLanguageChoice', () => {
  it('accepts auto and every offered code', () => {
    expect(isCaptionLanguageChoice(CAPTION_LANGUAGE_AUTO)).toBe(true)
    for (const [code] of CAPTION_LANGUAGES) expect(isCaptionLanguageChoice(code)).toBe(true)
  })

  it('rejects an unoffered code', () => {
    expect(isCaptionLanguageChoice('xx')).toBe(false)
    expect(isCaptionLanguageChoice('')).toBe(false)
    expect(isCaptionLanguageChoice(7)).toBe(false)
  })
})

describe('model id storage', () => {
  it('round-trips a valid choice', () => {
    const storage = memoryStorage()
    saveCaptionModelId('Xenova/whisper-base', storage)
    expect(loadCaptionModelId(storage)).toBe('Xenova/whisper-base')
  })

  it('falls back to the default for an empty or unknown value', () => {
    expect(loadCaptionModelId(memoryStorage())).toBe(DEFAULT_CAPTION_MODEL_ID)
    expect(loadCaptionModelId(memoryStorage({ 'capturia.captionsModel': 'nonsense' }))).toBe(
      DEFAULT_CAPTION_MODEL_ID,
    )
  })

  it('refuses to store an unknown model', () => {
    const storage = memoryStorage()
    saveCaptionModelId('Xenova/whisper-large', storage)
    expect(storage.entries()).toEqual({})
  })

  it('survives storage that throws', () => {
    expect(loadCaptionModelId(brokenStorage)).toBe(DEFAULT_CAPTION_MODEL_ID)
    expect(() => saveCaptionModelId('Xenova/whisper-base', brokenStorage)).not.toThrow()
  })
})

describe('language storage', () => {
  it('round-trips a valid choice and defaults to auto', () => {
    const storage = memoryStorage()
    expect(loadCaptionLanguage(storage)).toBe(CAPTION_LANGUAGE_AUTO)
    saveCaptionLanguage('vi', storage)
    expect(loadCaptionLanguage(storage)).toBe('vi')
  })

  it('ignores an unoffered code on the way in and on the way out', () => {
    const storage = memoryStorage({ 'capturia.captionsLanguage': 'xx' })
    expect(loadCaptionLanguage(storage)).toBe(CAPTION_LANGUAGE_AUTO)
    saveCaptionLanguage('xx', storage)
    expect(storage.entries()['capturia.captionsLanguage']).toBe('xx')
  })
})

describe('normalizeCaptionVocabulary', () => {
  it('flattens newlines into a comma-separated list', () => {
    expect(normalizeCaptionVocabulary('Capturia\nPixiJS')).toBe('Capturia, PixiJS')
  })

  it('collapses whitespace and trims', () => {
    expect(normalizeCaptionVocabulary('  a   b  ')).toBe('a b')
  })

  it('caps the length', () => {
    const long = 'x'.repeat(MAX_CAPTION_VOCABULARY_LENGTH + 50)
    expect(normalizeCaptionVocabulary(long)).toHaveLength(MAX_CAPTION_VOCABULARY_LENGTH)
  })

  it('turns nullish input into an empty string', () => {
    expect(normalizeCaptionVocabulary(undefined)).toBe('')
    expect(normalizeCaptionVocabulary(null)).toBe('')
  })
})

describe('vocabulary storage', () => {
  it('round-trips a normalized hint', () => {
    const storage = memoryStorage()
    expect(loadCaptionVocabulary(storage)).toBe('')
    saveCaptionVocabulary(' Capturia,\n PixiJS ', storage)
    expect(loadCaptionVocabulary(storage)).toBe('Capturia, PixiJS')
  })

  it('survives storage that throws', () => {
    expect(loadCaptionVocabulary(brokenStorage)).toBe('')
    expect(() => saveCaptionVocabulary('x', brokenStorage)).not.toThrow()
  })
})
