import { describe, expect, it } from 'vitest'
import { isCjkChar, splitGraphemes, tokenizeForWrap, wrapLine, wrapTextLines } from './textWrap'

/** 10 units per grapheme: makes the expected breaks easy to reason about. */
const measure = (text: string) => splitGraphemes(text).length * 10

describe('isCjkChar', () => {
  it('detects Han, Hiragana, Katakana and Hangul', () => {
    expect(isCjkChar('中')).toBe(true)
    expect(isCjkChar('あ')).toBe(true)
    expect(isCjkChar('カ')).toBe(true)
    expect(isCjkChar('한')).toBe(true)
  })

  it('does not match Latin, digits, punctuation or Vietnamese diacritics', () => {
    for (const ch of ['a', 'Z', '1', '.', ' ', 'ế', 'ơ', 'đ']) {
      expect(isCjkChar(ch)).toBe(false)
    }
  })
})

describe('tokenizeForWrap', () => {
  it('splits Latin text on whitespace, keeping the whitespace as tokens', () => {
    expect(tokenizeForWrap('hello world')).toEqual(['hello', ' ', 'world'])
    expect(tokenizeForWrap('a  b\tc')).toEqual(['a', '  ', 'b', '\t', 'c'])
  })

  it('splits CJK runs into single characters', () => {
    expect(tokenizeForWrap('你好世界')).toEqual(['你', '好', '世', '界'])
    expect(tokenizeForWrap('こんにちは')).toEqual(['こ', 'ん', 'に', 'ち', 'は'])
    expect(tokenizeForWrap('안녕하세요')).toEqual(['안', '녕', '하', '세', '요'])
  })

  it('handles mixed scripts, flushing the Latin buffer at each CJK char', () => {
    expect(tokenizeForWrap('Hi 你好 there')).toEqual(['Hi', ' ', '你', '好', ' ', 'there'])
    expect(tokenizeForWrap('abc中def')).toEqual(['abc', '中', 'def'])
  })

  it('round-trips: joining the tokens reproduces the input', () => {
    for (const line of [
      'hello world',
      '你好世界',
      'Hi 你好 there',
      '  leading and trailing  ',
      'Xin chào các bạn',
    ]) {
      expect(tokenizeForWrap(line).join('')).toBe(line)
    }
  })

  it('returns no tokens for an empty line', () => {
    expect(tokenizeForWrap('')).toEqual([])
  })
})

describe('splitGraphemes', () => {
  it('keeps emoji and combining sequences together', () => {
    expect(splitGraphemes('a👍🏽b')).toEqual(['a', '👍🏽', 'b'])
    expect(splitGraphemes('')).toEqual([])
  })
})

describe('wrapLine', () => {
  it('returns a single line when everything fits', () => {
    expect(wrapLine('hello world', 200, measure)).toEqual(['hello world'])
  })

  it('breaks Latin text at whitespace and trims the next line start', () => {
    // "hello world foo" -> 'hello' (50) + ' world' would be 110 > 100
    expect(wrapLine('hello world foo', 100, measure)).toEqual(['hello', 'world foo'])
  })

  it('breaks CJK text at character boundaries', () => {
    expect(wrapLine('你好世界你好', 30, measure)).toEqual(['你好世', '界你好'])
  })

  it('breaks mixed text at CJK char boundaries and Latin word boundaries', () => {
    expect(wrapLine('Hi 你好世界', 40, measure)).toEqual(['Hi 你', '好世界'])
  })

  it('splits an overlong Latin word by grapheme (word-break: break-word)', () => {
    expect(wrapLine('abcdefghij', 30, measure)).toEqual(['abc', 'def', 'ghi', 'j'])
    expect(wrapLine('ab cdefgh ij', 30, measure)).toEqual(['ab', 'cde', 'fgh', 'ij'])
  })

  it('preserves an empty line', () => {
    expect(wrapLine('', 100, measure)).toEqual([''])
  })

  it('does not wrap when maxWidth is not positive', () => {
    expect(wrapLine('hello world', 0, measure)).toEqual(['hello world'])
    expect(wrapLine('hello world', Number.NaN, measure)).toEqual(['hello world'])
  })
})

describe('wrapTextLines', () => {
  it('keeps hard line breaks and soft-wraps each paragraph', () => {
    expect(wrapTextLines('hello world\n\n你好世界', 50, measure)).toEqual([
      'hello',
      'world',
      '',
      '你好世界',
    ])
  })

  it('never yields a line wider than maxWidth when no single grapheme exceeds it', () => {
    const text = 'Xin chào các bạn 你好世界 こんにちは hello_extremely_long_token here'
    const lines = wrapTextLines(text, 60, measure)
    for (const line of lines) {
      expect(measure(line)).toBeLessThanOrEqual(60)
    }
    expect(lines.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })
})
