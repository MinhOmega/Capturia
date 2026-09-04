import type { CSSProperties } from 'react'
import type { SubtitleCue } from '@/lib/analysis/types'
import {
  buildSubtitleLineTokens,
  buildSubtitleOverlayStyles,
  resolveHighlightedWordIndex,
  resolveSubtitleBox,
  resolveSubtitleLayout,
  splitSubtitleWords,
} from '@/lib/rendering/subtitleLayout'
import type { SubtitleStyle } from '@/lib/rendering/subtitleStyle'

/**
 * DOM half of the caption renderer. Every number and colour comes from
 * `resolveSubtitleLayout` at the preview's CSS size, which is what the canvas
 * exporter reads at the export size — see `subtitleStyleParity.test.ts`.
 */

interface SubtitleOverlayProps {
  cue: SubtitleCue
  timeMs: number
  style: SubtitleStyle
  frameWidth: number
  frameHeight: number
}

export function SubtitleOverlay({
  cue,
  timeMs,
  style,
  frameWidth,
  frameHeight,
}: SubtitleOverlayProps) {
  if (!cue.text.trim()) return null

  const layout = resolveSubtitleLayout(style, frameWidth, frameHeight)
  const lines = buildSubtitleLineTokens(cue.text, layout.maxCharsPerLine, layout.maxLines)
  if (lines.length === 0) return null

  const box = resolveSubtitleBox(layout, lines.length, frameHeight)
  const styles = buildSubtitleOverlayStyles(layout, box)
  const highlightIndex = layout.highlightColor
    ? resolveHighlightedWordIndex(splitSubtitleWords(cue.text), cue.startMs, cue.endMs, timeMs)
    : -1

  return (
    <div data-testid="subtitle-overlay" style={styles.container as CSSProperties}>
      <div style={styles.box as CSSProperties}>
        {lines.map((line) => (
          <p key={line.text} style={styles.line as CSSProperties}>
            {line.tokens.map((token, tokenIndex) => (
              <span
                key={`${token.index}-${token.text}`}
                style={
                  token.index === highlightIndex && layout.highlightColor
                    ? { color: layout.highlightColor }
                    : undefined
                }
              >
                {tokenIndex > 0 ? line.separator : ''}
                {token.text}
              </span>
            ))}
          </p>
        ))}
      </div>
    </div>
  )
}
