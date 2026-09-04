import type { SubtitleCue } from '@/lib/analysis/types'
import {
  buildSubtitleLineTokens,
  resolveHighlightedWordIndex,
  resolveSubtitleBox,
  resolveSubtitleLayout,
  splitSubtitleWords,
  type ResolvedSubtitleLayout,
} from '@/lib/rendering/subtitleLayout'
import type { SubtitleStyle } from '@/lib/rendering/subtitleStyle'

/**
 * Canvas half of the caption renderer. Every geometry and colour decision comes
 * out of `resolveSubtitleLayout`, which the DOM preview in `VideoPlayback`
 * reads too — `subtitleStyleParity.test.ts` fails if the two drift apart.
 */

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.max(0, Math.min(radius, Math.min(width, height) / 2))
  ctx.beginPath()
  ctx.moveTo(x + safeRadius, y)
  ctx.lineTo(x + width - safeRadius, y)
  ctx.arcTo(x + width, y, x + width, y + safeRadius, safeRadius)
  ctx.lineTo(x + width, y + height - safeRadius)
  ctx.arcTo(x + width, y + height, x + width - safeRadius, y + height, safeRadius)
  ctx.lineTo(x + safeRadius, y + height)
  ctx.arcTo(x, y + height, x, y + height - safeRadius, safeRadius)
  ctx.lineTo(x, y + safeRadius)
  ctx.arcTo(x, y, x + safeRadius, y, safeRadius)
  ctx.closePath()
}

/** `font` shorthand for a resolved layout; the preview builds the same one. */
export function subtitleFontShorthand(layout: ResolvedSubtitleLayout): string {
  return `${layout.fontWeight} ${layout.fontSize}px ${layout.fontFamily}`
}

/**
 * Draw one cue into `ctx` at export resolution. No-op for an empty cue or a
 * cue that wraps to nothing.
 */
export function renderSubtitleCue(
  ctx: CanvasRenderingContext2D,
  cue: SubtitleCue,
  timeMs: number,
  style: SubtitleStyle,
  frameWidth: number,
  frameHeight: number,
): void {
  if (!cue.text.trim()) return

  const layout = resolveSubtitleLayout(style, frameWidth, frameHeight)
  const lines = buildSubtitleLineTokens(cue.text, layout.maxCharsPerLine, layout.maxLines)
  if (lines.length === 0) return

  const highlightIndex = layout.highlightColor
    ? resolveHighlightedWordIndex(splitSubtitleWords(cue.text), cue.startMs, cue.endMs, timeMs)
    : -1

  ctx.save()
  ctx.font = subtitleFontShorthand(layout)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const textWidth = lines.reduce((max, line) => Math.max(max, ctx.measureText(line.text).width), 0)
  const boxWidth = Math.min(layout.maxBoxWidth, textWidth + layout.horizontalPadding * 2)
  const box = resolveSubtitleBox(layout, lines.length, frameHeight)
  const boxX = (frameWidth - boxWidth) / 2

  if (layout.backgroundColor) {
    drawRoundedRect(ctx, boxX, box.top, boxWidth, box.height, layout.borderRadius)
    ctx.fillStyle = layout.backgroundColor
    ctx.fill()
    if (layout.borderColor) {
      ctx.strokeStyle = layout.borderColor
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  if (layout.textShadowBlur > 0) {
    ctx.shadowColor = layout.textShadowColor
    ctx.shadowBlur = layout.textShadowBlur
  }

  lines.forEach((line, index) => {
    const y = box.top + layout.verticalPadding + layout.lineHeight * (index + 0.5)
    const highlightedToken =
      highlightIndex >= 0 ? line.tokens.find((token) => token.index === highlightIndex) : undefined

    if (!highlightedToken || !layout.highlightColor) {
      ctx.fillStyle = layout.textColor
      ctx.fillText(line.text, frameWidth / 2, y)
      return
    }

    // One token is tinted: lay the tokens out left-to-right from the centred
    // line width, so the un-highlighted run stays exactly where it would be.
    const lineWidth = ctx.measureText(line.text).width
    const separatorWidth = line.separator ? ctx.measureText(line.separator).width : 0
    let cursorX = frameWidth / 2 - lineWidth / 2
    ctx.textAlign = 'left'
    for (const token of line.tokens) {
      ctx.fillStyle = token.index === highlightIndex ? layout.highlightColor : layout.textColor
      ctx.fillText(token.text, cursorX, y)
      cursorX += ctx.measureText(token.text).width + separatorWidth
    }
    ctx.textAlign = 'center'
  })

  ctx.restore()
}
