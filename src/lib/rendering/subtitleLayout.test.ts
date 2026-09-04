import { describe, expect, it } from 'vitest'
import {
  buildSubtitleLines,
  buildSubtitleLineTokens,
  buildSubtitleOverlayStyles,
  resolveHighlightedWordIndex,
  resolveSubtitleBox,
  resolveSubtitleLayout,
  splitSubtitleWords,
  withAlpha,
} from './subtitleLayout'
import { DEFAULT_SUBTITLE_STYLE } from './subtitleStyle'

describe('subtitleLayout', () => {
  it('keeps short text in one line', () => {
    expect(buildSubtitleLines('hello world', 20, 2)).toEqual(['hello world'])
  })

  it('wraps by words for latin text', () => {
    expect(buildSubtitleLines('this is a subtitle example', 10, 2)).toEqual([
      'this is a',
      'subtitle…',
    ])
  })

  it('wraps by grapheme for cjk text', () => {
    expect(buildSubtitleLines('这是一个用于测试自动换行的字幕样例', 8, 2)).toEqual([
      '这是一个用于测试',
      '自动换行的字幕…',
    ])
  })
})

describe('resolveSubtitleLayout', () => {
  it('scales the font and the characters that fit together', () => {
    const base = resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 1920, 1080)
    const big = resolveSubtitleLayout({ ...DEFAULT_SUBTITLE_STYLE, fontScale: 2 }, 1920, 1080)
    expect(big.fontSize).toBe(base.fontSize * 2)
    expect(big.maxCharsPerLine).toBeLessThan(base.maxCharsPerLine)
    expect(big.lineHeight).toBeGreaterThan(base.lineHeight)
  })

  it('clamps the base font size for very small and very large frames', () => {
    expect(resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 320, 240).fontSize).toBe(16)
    expect(resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 7680, 4320).fontSize).toBe(52)
  })

  it('drops the box and adds a shadow when the background is off', () => {
    const layout = resolveSubtitleLayout(
      { ...DEFAULT_SUBTITLE_STYLE, backgroundEnabled: false },
      1920,
      1080,
    )
    expect(layout.backgroundColor).toBeNull()
    expect(layout.borderColor).toBeNull()
    expect(layout.textShadowBlur).toBeGreaterThan(0)
  })

  it('treats a fully transparent box as no box', () => {
    const layout = resolveSubtitleLayout(
      { ...DEFAULT_SUBTITLE_STYLE, backgroundOpacity: 0 },
      1920,
      1080,
    )
    expect(layout.backgroundColor).toBeNull()
  })

  it('exposes the highlight colour only when highlighting is on', () => {
    expect(resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 1920, 1080).highlightColor).toBeNull()
    expect(
      resolveSubtitleLayout({ ...DEFAULT_SUBTITLE_STYLE, highlightCurrentWord: true }, 1920, 1080)
        .highlightColor,
    ).toBe(DEFAULT_SUBTITLE_STYLE.highlightColor)
  })

  it('normalizes a hand-edited style before resolving', () => {
    const layout = resolveSubtitleLayout(
      { ...DEFAULT_SUBTITLE_STYLE, fontScale: Number.NaN, textColor: '#0f0' },
      1920,
      1080,
    )
    expect(layout.fontSize).toBe(35)
    expect(layout.textColor).toBe('#00FF00')
  })
})

describe('resolveSubtitleBox', () => {
  const layout = resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 1920, 1080)

  it('anchors to the bottom by default', () => {
    const box = resolveSubtitleBox(layout, 2, 1080)
    expect(box.top + box.height).toBe(1080 - layout.marginPx)
  })

  it('anchors to the top with the same margin', () => {
    const top = resolveSubtitleLayout({ ...DEFAULT_SUBTITLE_STYLE, anchor: 'top' }, 1920, 1080)
    expect(resolveSubtitleBox(top, 2, 1080).top).toBe(top.marginPx)
  })

  it('ignores the margin when centred', () => {
    const centred = resolveSubtitleLayout(
      { ...DEFAULT_SUBTITLE_STYLE, anchor: 'center', marginRatio: 0.3 },
      1920,
      1080,
    )
    const box = resolveSubtitleBox(centred, 2, 1080)
    expect(box.top).toBe(Math.round((1080 - box.height) / 2))
  })

  it('grows by exactly one line height per line', () => {
    const one = resolveSubtitleBox(layout, 1, 1080)
    const two = resolveSubtitleBox(layout, 2, 1080)
    expect(two.height - one.height).toBe(layout.lineHeight)
  })
})

describe('withAlpha', () => {
  it('renders an rgba string with a two-decimal alpha', () => {
    expect(withAlpha('#000000', 0.72)).toBe('rgba(0, 0, 0, 0.72)')
    expect(withAlpha('#34B27B', 1)).toBe('rgba(52, 178, 123, 1)')
  })

  it('clamps the alpha', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)')
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)')
  })
})

describe('splitSubtitleWords', () => {
  it('splits latin text on whitespace', () => {
    expect(splitSubtitleWords(' hello   brave  world ')).toEqual(['hello', 'brave', 'world'])
  })

  it('splits whitespace-free cjk text per grapheme', () => {
    expect(splitSubtitleWords('你好世界')).toEqual(['你', '好', '世', '界'])
  })

  it('returns nothing for blank text', () => {
    expect(splitSubtitleWords('   ')).toEqual([])
  })
})

describe('resolveHighlightedWordIndex', () => {
  const words = ['aa', 'bb', 'cc', 'dd']

  it('walks the words across the cue', () => {
    expect(resolveHighlightedWordIndex(words, 0, 4000, 0)).toBe(0)
    expect(resolveHighlightedWordIndex(words, 0, 4000, 1500)).toBe(1)
    expect(resolveHighlightedWordIndex(words, 0, 4000, 2500)).toBe(2)
    expect(resolveHighlightedWordIndex(words, 0, 4000, 3999)).toBe(3)
  })

  it('gives a longer word a longer turn', () => {
    const uneven = ['a', 'bbbbbbbbb']
    expect(resolveHighlightedWordIndex(uneven, 0, 1000, 50)).toBe(0)
    expect(resolveHighlightedWordIndex(uneven, 0, 1000, 200)).toBe(1)
  })

  it('returns -1 outside the cue and for degenerate input', () => {
    expect(resolveHighlightedWordIndex(words, 1000, 2000, 999)).toBe(-1)
    expect(resolveHighlightedWordIndex(words, 1000, 2000, 2000)).toBe(-1)
    expect(resolveHighlightedWordIndex([], 0, 1000, 500)).toBe(-1)
    expect(resolveHighlightedWordIndex(words, 1000, 1000, 1000)).toBe(-1)
    expect(resolveHighlightedWordIndex(words, 0, 1000, Number.NaN)).toBe(-1)
  })
})

describe('buildSubtitleLineTokens', () => {
  it('numbers tokens continuously across lines', () => {
    const lines = buildSubtitleLineTokens('this is a subtitle example', 10, 2)
    expect(lines.map((line) => line.text)).toEqual(['this is a', 'subtitle…'])
    expect(lines.flatMap((line) => line.tokens.map((token) => token.index))).toEqual([0, 1, 2, 3])
    expect(lines[0].separator).toBe(' ')
  })

  it('uses an empty separator for cjk text', () => {
    const lines = buildSubtitleLineTokens('你好世界', 8, 2)
    expect(lines[0].separator).toBe('')
    expect(lines[0].tokens.map((token) => token.text)).toEqual(['你', '好', '世', '界'])
  })

  it('returns nothing for blank text', () => {
    expect(buildSubtitleLineTokens('  ', 10, 2)).toEqual([])
  })
})

describe('buildSubtitleOverlayStyles', () => {
  it('emits the box height implied by the line height and padding', () => {
    const layout = resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 1920, 1080)
    const box = resolveSubtitleBox(layout, 2, 1080)
    const styles = buildSubtitleOverlayStyles(layout, box)
    expect(styles.container['top']).toBe(`${box.top}px`)
    expect(styles.line['lineHeight']).toBe(`${layout.lineHeight}px`)
    expect(styles.box['padding']).toBe(`${layout.verticalPadding}px ${layout.horizontalPadding}px`)
    expect(styles.box['border']).toBe(`1px solid ${layout.borderColor}`)
  })

  it('drops the border with the box', () => {
    const layout = resolveSubtitleLayout(
      { ...DEFAULT_SUBTITLE_STYLE, backgroundEnabled: false },
      1920,
      1080,
    )
    const styles = buildSubtitleOverlayStyles(layout, resolveSubtitleBox(layout, 1, 1080))
    expect(styles.box['border']).toBe('none')
    expect(styles.box['backgroundColor']).toBe('transparent')
  })
})
