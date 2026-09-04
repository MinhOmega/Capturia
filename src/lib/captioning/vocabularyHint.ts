import type { CaptionSegment } from './transcribe'

/**
 * Vocabulary hint (P2-F4): a short list of product names the model has never
 * seen, applied to the transcript.
 *
 * Whisper proper takes an `initial_prompt` that biases decoding. Transformers.js
 * 2.17 — the runtime the in-browser engine uses — exposes no such option: its
 * ASR pipeline only forwards language and task as forced decoder ids (see
 * `pipelines.js#L1748`). So the hint is applied where it can be: after decoding,
 * by correcting the near-misses the model produces for an unknown name
 * ("capturia" -> "Capturia", "captura" -> "Capturia") while leaving every word
 * it is not confident about untouched.
 *
 * Pure, so the matching rule is testable without a model.
 */

/** Most terms accepted; beyond this the list stops being a hint. */
export const MAX_VOCABULARY_TERMS = 24

/** Terms shorter than this match far too much to be safe. */
export const MIN_VOCABULARY_TERM_LENGTH = 3

/** Split a free-text hint into terms: commas, semicolons and newlines separate. */
export function parseVocabularyHint(input: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of String(input ?? '').split(/[,;\n\r]+/)) {
    const term = raw.trim().replace(/\s+/g, ' ')
    if (term.length < MIN_VOCABULARY_TERM_LENGTH) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= MAX_VOCABULARY_TERMS) break
  }
  return terms
}

/** Levenshtein distance, capped: returns `limit + 1` as soon as it is exceeded. */
export function boundedEditDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  const previous = new Array<number>(right.length + 1)
  const current = new Array<number>(right.length + 1)
  for (let column = 0; column <= right.length; column += 1) previous[column] = column

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row
    let best = current[0]
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + cost,
      )
      if (current[column] < best) best = current[column]
    }
    if (best > limit) return limit + 1
    for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]
  }
  return previous[right.length]
}

/**
 * How far a transcribed word may be from a hinted term and still be treated as
 * that term: one edit, and two only for a long term.
 *
 * The threshold is high on purpose. At two edits an eight-letter hint such as
 * "Capturia" already swallows the ordinary English word "capture", which would
 * corrupt a transcript rather than correct it. A word has to be nearly the hint
 * before this rewrites it.
 */
export const LONG_VOCABULARY_TERM_LENGTH = 12

export function editDistanceBudget(term: string): number {
  return term.length >= LONG_VOCABULARY_TERM_LENGTH ? 2 : 1
}

/** Leading/trailing punctuation is kept and put back around the replacement. */
const WORD_SHAPE = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u

/**
 * The hinted term a transcribed word should be replaced with, or null. An exact
 * case-insensitive match still returns the term, so the user's capitalisation
 * wins over the model's.
 */
export function matchVocabularyTerm(word: string, terms: readonly string[]): string | null {
  const core = WORD_SHAPE.exec(word)?.[2] ?? ''
  if (!core || core.length < MIN_VOCABULARY_TERM_LENGTH) return null
  const lower = core.toLowerCase()

  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const term of terms) {
    if (term.includes(' ')) continue // multi-word terms are handled by the phrase pass
    const budget = editDistanceBudget(term)
    const distance = boundedEditDistance(lower, term.toLowerCase(), budget)
    if (distance > budget) continue
    if (distance < bestDistance) {
      best = term
      bestDistance = distance
    }
  }
  if (best === null) return null
  return best === core ? null : best
}

/** Replace near-misses in one string, preserving spacing and punctuation. */
export function applyVocabularyHintToText(text: string, terms: readonly string[]): string {
  if (terms.length === 0) return text

  // Multi-word terms first: a case-insensitive whole-phrase replacement.
  let output = text
  for (const term of terms) {
    if (!term.includes(' ')) continue
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    output = output.replace(pattern, term)
  }

  // Split on whitespace but keep it: the separators come back as odd-index
  // pieces, so the original spacing survives the rewrite exactly.
  return output
    .split(/(\s+)/)
    .map((piece) => {
      if (piece.length === 0 || /^\s+$/.test(piece)) return piece
      const shape = WORD_SHAPE.exec(piece)
      if (!shape) return piece
      const [, prefix, , suffix] = shape
      const replacement = matchVocabularyTerm(piece, terms)
      return replacement === null ? piece : `${prefix}${replacement}${suffix}`
    })
    .join('')
}

/** Apply the hint to every caption segment's text; times are untouched. */
export function applyVocabularyHint(
  segments: readonly CaptionSegment[],
  terms: readonly string[],
): CaptionSegment[] {
  if (terms.length === 0) return [...segments]
  return segments.map((segment) => ({
    ...segment,
    text: applyVocabularyHintToText(segment.text, terms),
  }))
}
