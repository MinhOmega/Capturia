import { describe, expect, it } from 'vitest'
import {
  applyVocabularyHint,
  applyVocabularyHintToText,
  boundedEditDistance,
  editDistanceBudget,
  MAX_VOCABULARY_TERMS,
  matchVocabularyTerm,
  MIN_VOCABULARY_TERM_LENGTH,
  parseVocabularyHint,
} from './vocabularyHint'

describe('parseVocabularyHint', () => {
  it('splits on commas, semicolons and newlines', () => {
    expect(parseVocabularyHint('Capturia, PixiJS; WebCodecs\nElectron')).toEqual([
      'Capturia',
      'PixiJS',
      'WebCodecs',
      'Electron',
    ])
  })

  it('drops blanks, duplicates and terms that are too short', () => {
    expect(parseVocabularyHint('Capturia, , capturia, ok, Capturia')).toEqual(['Capturia'])
    expect(parseVocabularyHint('ab')).toEqual([])
    expect(MIN_VOCABULARY_TERM_LENGTH).toBe(3)
  })

  it('collapses internal whitespace and keeps multi-word terms', () => {
    expect(parseVocabularyHint('Rough   Cut')).toEqual(['Rough Cut'])
  })

  it('stops at the term cap', () => {
    const many = Array.from({ length: 40 }, (_, index) => `term${index}`).join(',')
    expect(parseVocabularyHint(many)).toHaveLength(MAX_VOCABULARY_TERMS)
  })

  it('returns nothing for empty input', () => {
    expect(parseVocabularyHint('')).toEqual([])
    expect(parseVocabularyHint('   ')).toEqual([])
  })
})

describe('boundedEditDistance', () => {
  it('measures the usual distances', () => {
    expect(boundedEditDistance('kitten', 'kitten', 3)).toBe(0)
    expect(boundedEditDistance('kitten', 'sitten', 3)).toBe(1)
    expect(boundedEditDistance('kitten', 'sitting', 3)).toBe(3)
  })

  it('gives up as soon as the limit is passed', () => {
    expect(boundedEditDistance('kitten', 'sitting', 1)).toBe(2)
    expect(boundedEditDistance('abc', 'abcdefghij', 2)).toBe(3)
  })

  it('handles empty strings', () => {
    expect(boundedEditDistance('', '', 1)).toBe(0)
    expect(boundedEditDistance('', 'ab', 3)).toBe(2)
  })
})

describe('editDistanceBudget', () => {
  it('allows one edit for an ordinary term and two only for a long one', () => {
    expect(editDistanceBudget('Pixi')).toBe(1)
    expect(editDistanceBudget('Capturia')).toBe(1)
    expect(editDistanceBudget('WebCodecsEncoder')).toBe(2)
  })
})

describe('matchVocabularyTerm', () => {
  const terms = ['Capturia', 'PixiJS']

  it('corrects a near miss', () => {
    expect(matchVocabularyTerm('captura', terms)).toBe('Capturia')
    expect(matchVocabularyTerm('capturias', terms)).toBe('Capturia')
  })

  it('fixes only the capitalisation of an exact match', () => {
    expect(matchVocabularyTerm('capturia', terms)).toBe('Capturia')
    expect(matchVocabularyTerm('Capturia', terms)).toBe(null)
  })

  it('ignores the punctuation around a word', () => {
    expect(matchVocabularyTerm('"capturia,"', terms)).toBe('Capturia')
  })

  it('leaves an unrelated word alone', () => {
    expect(matchVocabularyTerm('capture', terms)).toBe(null)
    expect(matchVocabularyTerm('recording', terms)).toBe(null)
    expect(matchVocabularyTerm('the', terms)).toBe(null)
  })

  it('picks the closest of several terms', () => {
    expect(matchVocabularyTerm('pixijs', ['Capturia', 'PixiJS'])).toBe('PixiJS')
  })

  it('returns null for punctuation-only and empty input', () => {
    expect(matchVocabularyTerm('...', terms)).toBe(null)
    expect(matchVocabularyTerm('', terms)).toBe(null)
  })
})

describe('applyVocabularyHintToText', () => {
  const terms = ['Capturia', 'PixiJS', 'Rough Cut']

  it('rewrites near misses and keeps the rest of the sentence', () => {
    expect(applyVocabularyHintToText('welcome to captura, built on pixijs', terms)).toBe(
      'welcome to Capturia, built on PixiJS',
    )
  })

  it('preserves the original spacing exactly', () => {
    expect(applyVocabularyHintToText('  captura   here  ', terms)).toBe('  Capturia   here  ')
  })

  it('replaces a multi-word term case-insensitively', () => {
    expect(applyVocabularyHintToText('apply the rough cut now', terms)).toBe(
      'apply the Rough Cut now',
    )
  })

  it('is the identity when there are no terms', () => {
    expect(applyVocabularyHintToText('nothing to do', [])).toBe('nothing to do')
  })

  it('leaves text with no near miss untouched', () => {
    expect(applyVocabularyHintToText('a quiet sentence', terms)).toBe('a quiet sentence')
  })
})

describe('applyVocabularyHint', () => {
  const segments = [
    { startSec: 0, endSec: 1, text: 'this is captura' },
    { startSec: 1, endSec: 2, text: 'and this is not' },
  ]

  it('rewrites the text and leaves the times alone', () => {
    const out = applyVocabularyHint(segments, ['Capturia'])
    expect(out[0]).toEqual({ startSec: 0, endSec: 1, text: 'this is Capturia' })
    expect(out[1]).toEqual(segments[1])
  })

  it('copies the segments rather than mutating them', () => {
    const out = applyVocabularyHint(segments, ['Capturia'])
    expect(out[0]).not.toBe(segments[0])
    expect(segments[0].text).toBe('this is captura')
  })

  it('is a no-op with no terms', () => {
    expect(applyVocabularyHint(segments, [])).toEqual(segments)
  })
})
