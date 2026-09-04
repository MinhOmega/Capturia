import { describe, expect, it } from 'vitest'
import type { SubtitleCue } from '@/lib/analysis/types'
import {
  buildSubtitleLineTokens,
  buildSubtitleOverlayStyles,
  resolveSubtitleBox,
  resolveSubtitleLayout,
} from '@/lib/rendering/subtitleLayout'
import { DEFAULT_SUBTITLE_STYLE, type SubtitleStyle } from '@/lib/rendering/subtitleStyle'
import { renderSubtitleCue, subtitleFontShorthand } from './subtitleRenderer'

/**
 * Preview (inline CSS in `SubtitleOverlay`) and export (canvas in
 * `subtitleRenderer`) both derive from `resolveSubtitleLayout`. This test
 * evaluates a set of styles at a fixed frame size and asserts the numbers that
 * reach the DOM style object are the same ones that reach the canvas context —
 * font, colour, box top, box height and per-line baselines.
 */

const GRAPHEME_WIDTH = 10

type Call = { name: string; args: unknown[] }

function createRecordingContext() {
  const calls: Call[] = []
  const fillTexts: Array<{ text: string; x: number; y: number; fillStyle: string }> = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args })
    }
  const ctx = {
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    shadowColor: '',
    shadowBlur: 0,
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arcTo: record('arcTo'),
    stroke: record('stroke'),
    measureText: (text: string) => ({ width: Array.from(text).length * GRAPHEME_WIDTH }),
    fill(...args: unknown[]) {
      calls.push({ name: 'fill', args: [...args, ctx.fillStyle] })
    },
    fillText(text: string, x: number, y: number) {
      fillTexts.push({ text, x, y, fillStyle: String(ctx.fillStyle) })
      calls.push({ name: 'fillText', args: [text, x, y] })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fillTexts, state: ctx }
}

/** The rounded-rect path is emitted as moveTo/lineTo/arcTo; the first two hold x and y. */
function boxOriginFromCalls(calls: Call[]): { x: number; y: number } {
  const moveTo = calls.find((call) => call.name === 'moveTo')
  const lineTo = calls.find((call) => call.name === 'lineTo')
  if (!moveTo || !lineTo) throw new Error('no rounded rect path was drawn')
  // moveTo is (x + radius, y); the third lineTo carries the bottom edge.
  return { x: Number(moveTo.args[0]), y: Number(moveTo.args[1]) }
}

function boxBottomFromCalls(calls: Call[]): number {
  const arcTos = calls.filter((call) => call.name === 'arcTo')
  // arcTo order: top-right, bottom-right, bottom-left, top-left; the second
  // and third corners sit on the bottom edge.
  return Number(arcTos[1].args[1])
}

const CUE: SubtitleCue = {
  id: 'subtitle-1',
  startMs: 1000,
  endMs: 3000,
  text: 'the quick brown fox jumps over the lazy dog',
  source: 'asr',
}

const FRAME = { width: 1920, height: 1080 }

const STYLES: Array<{ name: string; style: SubtitleStyle }> = [
  { name: 'default', style: DEFAULT_SUBTITLE_STYLE },
  { name: 'top anchor', style: { ...DEFAULT_SUBTITLE_STYLE, anchor: 'top', marginRatio: 0.1 } },
  { name: 'centre anchor', style: { ...DEFAULT_SUBTITLE_STYLE, anchor: 'center' } },
  { name: 'large font', style: { ...DEFAULT_SUBTITLE_STYLE, fontScale: 1.6 } },
  { name: 'small font', style: { ...DEFAULT_SUBTITLE_STYLE, fontScale: 0.7 } },
  {
    name: 'no background box',
    style: { ...DEFAULT_SUBTITLE_STYLE, backgroundEnabled: false, textColor: '#FFD166' },
  },
  {
    name: 'half-opaque box',
    style: { ...DEFAULT_SUBTITLE_STYLE, backgroundOpacity: 0.5, textColor: '#22D3EE' },
  },
  {
    name: 'word highlight',
    style: { ...DEFAULT_SUBTITLE_STYLE, highlightCurrentWord: true, highlightColor: '#34B27B' },
  },
]

describe('subtitle style parity between preview and export', () => {
  for (const { name, style } of STYLES) {
    it(`${name}: DOM styles and canvas draws agree`, () => {
      const layout = resolveSubtitleLayout(style, FRAME.width, FRAME.height)
      const lines = buildSubtitleLineTokens(CUE.text, layout.maxCharsPerLine, layout.maxLines)
      const box = resolveSubtitleBox(layout, lines.length, FRAME.height)
      const domStyles = buildSubtitleOverlayStyles(layout, box)

      const { ctx, calls, fillTexts, state } = createRecordingContext()
      renderSubtitleCue(ctx, CUE, 2000, style, FRAME.width, FRAME.height)

      // Font: the shorthand the canvas received names the same family, size and weight.
      expect(state.font).toBe(subtitleFontShorthand(layout))
      expect(domStyles.line['fontSize']).toBe(`${layout.fontSize}px`)
      expect(domStyles.line['fontFamily']).toBe(layout.fontFamily)
      expect(domStyles.line['fontWeight']).toBe(layout.fontWeight)
      expect(state.font).toContain(String(domStyles.line['fontFamily']))
      expect(state.font).toContain(`${layout.fontSize}px`)

      // Vertical placement: the DOM strip's top is the canvas box's top edge,
      // and the drawn box is exactly as tall as the DOM box will be.
      expect(domStyles.container['top']).toBe(`${box.top}px`)
      if (layout.backgroundColor) {
        const origin = boxOriginFromCalls(calls)
        expect(origin.y).toBe(box.top)
        expect(boxBottomFromCalls(calls) - origin.y).toBe(box.height)
        const boxFill = calls.find((call) => call.name === 'fill')
        expect(boxFill?.args.at(-1)).toBe(layout.backgroundColor)
        expect(domStyles.box['backgroundColor']).toBe(layout.backgroundColor)
      } else {
        expect(calls.some((call) => call.name === 'fill')).toBe(false)
        expect(domStyles.box['backgroundColor']).toBe('transparent')
      }

      // Line baselines: the canvas centres each line inside the same padded box
      // the DOM lays out with `padding` + a pixel `line-height`.
      const baselines = fillTexts
        .map((entry) => entry.y)
        .filter((value, index, all) => all.indexOf(value) === index)
      expect(baselines).toEqual(
        lines.map(
          (_line, index) => box.top + layout.verticalPadding + layout.lineHeight * (index + 0.5),
        ),
      )
      expect(domStyles.box['padding']).toBe(
        `${layout.verticalPadding}px ${layout.horizontalPadding}px`,
      )
      expect(domStyles.line['lineHeight']).toBe(`${layout.lineHeight}px`)

      // Colours: the canvas fill styles are exactly the DOM colours.
      const usedColors = new Set(fillTexts.map((entry) => entry.fillStyle))
      expect(domStyles.line['color']).toBe(layout.textColor)
      expect(usedColors.has(layout.textColor)).toBe(true)
      if (layout.highlightColor) {
        expect(usedColors.has(layout.highlightColor)).toBe(true)
      } else {
        expect([...usedColors]).toEqual([layout.textColor])
      }

      // The shadow only appears when the box is off, in both renderers.
      expect(state.shadowBlur).toBe(layout.textShadowBlur)
      expect(domStyles.line['textShadow']).toBe(
        layout.textShadowBlur > 0
          ? `0 0 ${layout.textShadowBlur}px ${layout.textShadowColor}`
          : 'none',
      )
    })
  }

  it('renders the same wrapped lines on both sides', () => {
    const layout = resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, FRAME.width, FRAME.height)
    const lines = buildSubtitleLineTokens(CUE.text, layout.maxCharsPerLine, layout.maxLines)
    const { ctx, fillTexts } = createRecordingContext()
    renderSubtitleCue(ctx, CUE, 2000, DEFAULT_SUBTITLE_STYLE, FRAME.width, FRAME.height)
    expect(fillTexts.map((entry) => entry.text)).toEqual(lines.map((line) => line.text))
  })

  it('draws nothing for a blank cue', () => {
    const { ctx, calls } = createRecordingContext()
    renderSubtitleCue(
      ctx,
      { ...CUE, text: '   ' },
      2000,
      DEFAULT_SUBTITLE_STYLE,
      FRAME.width,
      FRAME.height,
    )
    expect(calls).toEqual([])
  })

  it('keeps the pre-F1 geometry for an untouched style', () => {
    // The numbers the fixed layout used before captions became styleable.
    const layout = resolveSubtitleLayout(DEFAULT_SUBTITLE_STYLE, 1920, 1080)
    expect(layout.fontSize).toBe(35)
    expect(layout.maxCharsPerLine).toBe(41)
    expect(layout.lineHeight).toBe(45)
    expect(layout.horizontalPadding).toBe(25)
    expect(layout.verticalPadding).toBe(15)
    expect(layout.borderRadius).toBe(16)
    expect(layout.marginPx).toBe(65)
    expect(layout.backgroundColor).toBe('rgba(0, 0, 0, 0.72)')
    expect(layout.borderColor).toBe('rgba(255, 255, 255, 0.1)')
    expect(layout.textColor).toBe('#FFFFFF')
    const box = resolveSubtitleBox(layout, 2, 1080)
    expect(box.height).toBe(2 * 45 + 30)
    expect(box.top).toBe(1080 - 65 - box.height)
  })
})
