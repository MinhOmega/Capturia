/**
 * Pure text-wrapping helpers shared by the export annotation renderer.
 *
 * The preview overlay wraps text with CSS (`white-space: pre-wrap;
 * word-break: break-word`). Canvas has no line breaking, so the exporter
 * re-implements the same rules here:
 *  - Latin text breaks at whitespace (the whitespace itself stays a token so
 *    it can hang at the end of a line or be trimmed from the start of the next).
 *  - CJK runs (Han / Hiragana / Katakana / Hangul) break at every character,
 *    since those scripts have no word-separating whitespace.
 *  - A single token wider than the box is broken at grapheme boundaries,
 *    matching `word-break: break-word`.
 *
 * Unicode script escapes need ES2018+; tsconfig targets ES2020.
 */

export const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

export function isCjkChar(ch: string): boolean {
  return CJK_CHAR.test(ch)
}

type GraphemeSegmenter = {
  segment(value: string): Iterable<{ segment: string }>
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity?: 'grapheme' },
  ) => GraphemeSegmenter
}

const Segmenter = (Intl as IntlWithSegmenter).Segmenter
const graphemeSegmenter =
  typeof Segmenter === 'function' ? new Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Split into user-perceived characters (emoji + combining marks stay together). */
export function splitGraphemes(value: string): string[] {
  if (!value) return []
  if (!graphemeSegmenter) return Array.from(value)
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
}

/**
 * Split one line (no `\n`) into wrap tokens: whitespace runs, non-CJK words
 * and single CJK characters. Joining the tokens reproduces the input.
 */
export function tokenizeForWrap(line: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  const flushBuffer = () => {
    if (buffer) {
      tokens.push(...buffer.split(/(\s+)/).filter((s) => s.length > 0))
      buffer = ''
    }
  }
  for (const ch of Array.from(line)) {
    if (CJK_CHAR.test(ch)) {
      flushBuffer()
      tokens.push(ch)
    } else {
      buffer += ch
    }
  }
  flushBuffer()
  return tokens
}

export type MeasureText = (text: string) => number

/** Break one overlong token at grapheme boundaries so every piece fits. */
function breakToken(token: string, maxWidth: number, measure: MeasureText): string[] {
  const pieces: string[] = []
  let current = ''
  for (const grapheme of splitGraphemes(token)) {
    const test = current + grapheme
    if (current && measure(test) > maxWidth) {
      pieces.push(current)
      current = grapheme
    } else {
      current = test
    }
  }
  if (current) pieces.push(current)
  return pieces
}

/**
 * Wrap a single line to `maxWidth`. Blank input yields `['']` so callers keep
 * the empty line's vertical space, like the preview's `pre-wrap` does.
 */
export function wrapLine(line: string, maxWidth: number, measure: MeasureText): string[] {
  if (!line) return ['']
  if (!(maxWidth > 0)) return [line]

  const lines: string[] = []
  let current = ''
  // Trailing whitespace hangs in CSS (pre-wrap) and never affects alignment,
  // so it is dropped from every emitted line.
  const emit = (value: string) => lines.push(value.trimEnd())

  const pushToken = (token: string) => {
    const test = current + token
    if (current && measure(test) > maxWidth) {
      emit(current)
      current = token.trimStart()
      return
    }
    current = test
  }

  for (const token of tokenizeForWrap(line)) {
    const isWhitespace = /^\s+$/.test(token)
    if (!isWhitespace && measure(token) > maxWidth) {
      // Overlong word: flush what we have, then split it by grapheme so the
      // pieces fill successive lines (CSS word-break: break-word behaviour).
      if (current.trim()) {
        emit(current)
        current = ''
      }
      const pieces = breakToken(token, maxWidth, measure)
      for (let i = 0; i < pieces.length - 1; i++) emit(pieces[i])
      current = pieces[pieces.length - 1] ?? ''
      continue
    }
    pushToken(token)
  }

  if (current || lines.length === 0) emit(current)
  return lines
}

/**
 * Wrap multi-line content: hard `\n` breaks are kept, each paragraph is then
 * soft-wrapped to `maxWidth` using `measure` (canvas `measureText().width`).
 */
export function wrapTextLines(content: string, maxWidth: number, measure: MeasureText): string[] {
  const lines: string[] = []
  for (const rawLine of content.split('\n')) {
    lines.push(...wrapLine(rawLine, maxWidth, measure))
  }
  return lines
}
