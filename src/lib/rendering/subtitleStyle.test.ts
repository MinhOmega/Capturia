import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBTITLE_STYLE,
  isDefaultSubtitleStyle,
  isSubtitleAnchor,
  MAX_SUBTITLE_FONT_SCALE,
  MAX_SUBTITLE_MARGIN_RATIO,
  MIN_SUBTITLE_FONT_SCALE,
  normalizeHexColor,
  normalizeSubtitleStyle,
} from './subtitleStyle'

describe('normalizeSubtitleStyle', () => {
  it('fills every field from the defaults for an empty input', () => {
    expect(normalizeSubtitleStyle(undefined)).toEqual(DEFAULT_SUBTITLE_STYLE)
    expect(normalizeSubtitleStyle({})).toEqual(DEFAULT_SUBTITLE_STYLE)
    expect(normalizeSubtitleStyle(null)).toEqual(DEFAULT_SUBTITLE_STYLE)
  })

  it('keeps a valid style untouched', () => {
    const style = {
      fontScale: 1.4,
      anchor: 'top' as const,
      marginRatio: 0.12,
      textColor: '#FFD166',
      backgroundEnabled: false,
      backgroundOpacity: 0.3,
      highlightCurrentWord: true,
      highlightColor: '#34B27B',
    }
    expect(normalizeSubtitleStyle(style)).toEqual(style)
  })

  it('clamps out-of-range numbers instead of dropping them', () => {
    const wide = normalizeSubtitleStyle({ fontScale: 99, marginRatio: 5, backgroundOpacity: 9 })
    expect(wide.fontScale).toBe(MAX_SUBTITLE_FONT_SCALE)
    expect(wide.marginRatio).toBe(MAX_SUBTITLE_MARGIN_RATIO)
    expect(wide.backgroundOpacity).toBe(1)

    const narrow = normalizeSubtitleStyle({ fontScale: -3, marginRatio: -1, backgroundOpacity: -1 })
    expect(narrow.fontScale).toBe(MIN_SUBTITLE_FONT_SCALE)
    expect(narrow.marginRatio).toBe(0)
    expect(narrow.backgroundOpacity).toBe(0)
  })

  it('falls back for non-finite numbers and unknown anchors', () => {
    const style = normalizeSubtitleStyle({
      fontScale: Number.NaN,
      marginRatio: Number.POSITIVE_INFINITY,
      anchor: 'middle',
    })
    expect(style.fontScale).toBe(DEFAULT_SUBTITLE_STYLE.fontScale)
    expect(style.marginRatio).toBe(DEFAULT_SUBTITLE_STYLE.marginRatio)
    expect(style.anchor).toBe(DEFAULT_SUBTITLE_STYLE.anchor)
  })

  it('expands and upper-cases short hex colours, rejecting anything else', () => {
    expect(normalizeSubtitleStyle({ textColor: '#abc' }).textColor).toBe('#AABBCC')
    expect(normalizeSubtitleStyle({ textColor: '#ffd166' }).textColor).toBe('#FFD166')
    expect(normalizeSubtitleStyle({ textColor: 'red' }).textColor).toBe(
      DEFAULT_SUBTITLE_STYLE.textColor,
    )
    expect(normalizeSubtitleStyle({ textColor: 'rgba(0,0,0,1)' }).textColor).toBe(
      DEFAULT_SUBTITLE_STYLE.textColor,
    )
  })
})

describe('normalizeHexColor', () => {
  it('returns the fallback for a non-string', () => {
    expect(normalizeHexColor(42, '#000000')).toBe('#000000')
    expect(normalizeHexColor(undefined, '#000000')).toBe('#000000')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHexColor('  #34b27b  ', '#000000')).toBe('#34B27B')
  })
})

describe('isSubtitleAnchor', () => {
  it('accepts the three anchors and nothing else', () => {
    expect(isSubtitleAnchor('top')).toBe(true)
    expect(isSubtitleAnchor('center')).toBe(true)
    expect(isSubtitleAnchor('bottom')).toBe(true)
    expect(isSubtitleAnchor('centre')).toBe(false)
    expect(isSubtitleAnchor(null)).toBe(false)
  })
})

describe('isDefaultSubtitleStyle', () => {
  it('is true for the default and for a normalized empty style', () => {
    expect(isDefaultSubtitleStyle(DEFAULT_SUBTITLE_STYLE)).toBe(true)
    expect(isDefaultSubtitleStyle(normalizeSubtitleStyle({}))).toBe(true)
  })

  it('is false once any single field moves', () => {
    expect(isDefaultSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, fontScale: 1.1 })).toBe(false)
    expect(isDefaultSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, anchor: 'top' })).toBe(false)
    expect(isDefaultSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, backgroundEnabled: false })).toBe(
      false,
    )
    expect(isDefaultSubtitleStyle({ ...DEFAULT_SUBTITLE_STYLE, highlightCurrentWord: true })).toBe(
      false,
    )
  })
})
