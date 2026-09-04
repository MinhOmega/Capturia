import { type SubtitleAnchor, type SubtitleStyle, normalizeSubtitleStyle } from './subtitleStyle'

function countChars(value: string): number {
  return Array.from(value).length
}

function trimToChars(value: string, maxChars: number): string {
  return Array.from(value).slice(0, Math.max(0, maxChars)).join('')
}

function withEllipsis(value: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  if (maxChars === 1) return '…'
  const trimmed = trimToChars(value, maxChars - 1).trim()
  return `${trimmed}…`
}

function tokenize(text: string): { tokens: string[]; separator: string } {
  if (/\s/.test(text)) {
    return {
      tokens: text.split(/\s+/).filter(Boolean),
      separator: ' ',
    }
  }

  return {
    tokens: Array.from(text),
    separator: '',
  }
}

export function buildSubtitleLines(
  inputText: string,
  maxCharsPerLine: number,
  maxLines: number,
): string[] {
  const text = String(inputText ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  const safeMaxCharsPerLine = Math.max(1, Math.round(maxCharsPerLine))
  const safeMaxLines = Math.max(1, Math.round(maxLines))

  if (!text) return []
  if (countChars(text) <= safeMaxCharsPerLine) return [text]

  const { tokens, separator } = tokenize(text)
  const lines: string[] = []

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    let line = token

    if (countChars(line) > safeMaxCharsPerLine) {
      line = trimToChars(line, safeMaxCharsPerLine)
    }

    index += 1

    while (index < tokens.length) {
      const candidate = `${line}${separator}${tokens[index]}`.trim()
      if (countChars(candidate) > safeMaxCharsPerLine) {
        break
      }
      line = candidate
      index += 1
    }

    const hasMore = index < tokens.length
    const isLastLine = lines.length === safeMaxLines - 1

    if (hasMore && isLastLine) {
      lines.push(withEllipsis(line, safeMaxCharsPerLine))
      return lines
    }

    lines.push(line)

    if (lines.length >= safeMaxLines) {
      return lines
    }
  }

  return lines
}

// ---------------------------------------------------------------------------
// Resolved layout: the single source of truth shared by the DOM preview
// (VideoPlayback) and the canvas export (subtitleRenderer). Both read the same
// numbers out of `resolveSubtitleLayout`, so a style change cannot move the
// caption in one and not the other. `subtitleStyleParity.test.ts` pins that.
// ---------------------------------------------------------------------------

/** Same stack in both renderers; the canvas has no stylesheet to inherit from. */
export const SUBTITLE_FONT_FAMILY =
  '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif'

export const SUBTITLE_FONT_WEIGHT = 700
export const SUBTITLE_MAX_LINES = 2
/** Widest the caption box may get, as a fraction of the frame width. */
export const SUBTITLE_MAX_BOX_WIDTH_RATIO = 0.9
/** Fraction of the frame width the wrapper fits text into. */
export const SUBTITLE_TEXT_WIDTH_RATIO = 0.82
/** Readability fallback when the background box is switched off. */
export const SUBTITLE_TEXT_SHADOW_COLOR = 'rgba(0, 0, 0, 0.85)'

export interface ResolvedSubtitleLayout {
  fontSize: number
  fontFamily: string
  fontWeight: number
  lineHeight: number
  maxCharsPerLine: number
  maxLines: number
  horizontalPadding: number
  verticalPadding: number
  borderRadius: number
  maxBoxWidth: number
  textColor: string
  /** null when the current word is not highlighted. */
  highlightColor: string | null
  /** null when the background box is switched off. */
  backgroundColor: string | null
  /** null when the background box is switched off. */
  borderColor: string | null
  /** Blur radius of the readability shadow; 0 when the box carries the contrast. */
  textShadowBlur: number
  textShadowColor: string
  anchor: SubtitleAnchor
  marginPx: number
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '')
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

/** `rgba(...)` for a `#RRGGBB` colour plus an alpha, rounded so both renderers emit one string. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1))
  return `rgba(${r}, ${g}, ${b}, ${Math.round(safeAlpha * 100) / 100})`
}

/**
 * Turn a caption style plus the frame it is drawn into into pixels. `frameWidth`
 * / `frameHeight` are the encoder dimensions on export and the preview
 * overlay's CSS size in the editor, which is why every number here is derived
 * from them rather than hard-coded.
 */
export function resolveSubtitleLayout(
  styleInput: SubtitleStyle,
  frameWidth: number,
  frameHeight: number,
): ResolvedSubtitleLayout {
  const style = normalizeSubtitleStyle(styleInput)
  const width = Math.max(1, Math.round(frameWidth))
  const height = Math.max(1, Math.round(frameHeight))
  const baseFontSize = Math.max(16, Math.min(52, Math.round(height * 0.032)))
  const fontSize = Math.max(8, Math.round(baseFontSize * style.fontScale))
  const showBox = style.backgroundEnabled && style.backgroundOpacity > 0

  return {
    fontSize,
    fontFamily: SUBTITLE_FONT_FAMILY,
    fontWeight: SUBTITLE_FONT_WEIGHT,
    lineHeight: Math.round(fontSize * 1.28),
    maxCharsPerLine: Math.max(
      4,
      Math.round((width * SUBTITLE_TEXT_WIDTH_RATIO) / (38 * style.fontScale)),
    ),
    maxLines: SUBTITLE_MAX_LINES,
    horizontalPadding: Math.round(fontSize * 0.72),
    verticalPadding: Math.round(fontSize * 0.42),
    borderRadius: Math.max(8, Math.round(fontSize * 0.45)),
    maxBoxWidth: width * SUBTITLE_MAX_BOX_WIDTH_RATIO,
    textColor: style.textColor,
    highlightColor: style.highlightCurrentWord ? style.highlightColor : null,
    backgroundColor: showBox ? withAlpha('#000000', style.backgroundOpacity) : null,
    borderColor: showBox ? 'rgba(255, 255, 255, 0.1)' : null,
    textShadowBlur: showBox ? 0 : Math.max(2, Math.round(fontSize * 0.25)),
    textShadowColor: SUBTITLE_TEXT_SHADOW_COLOR,
    anchor: style.anchor,
    marginPx: Math.round(height * style.marginRatio),
  }
}

export interface SubtitleBoxGeometry {
  /** Distance from the top of the frame to the top of the caption box. */
  top: number
  height: number
}

/**
 * Vertical placement of the caption box. The height only depends on the line
 * count, so preview and export agree without either having to measure text.
 */
export function resolveSubtitleBox(
  layout: ResolvedSubtitleLayout,
  lineCount: number,
  frameHeight: number,
): SubtitleBoxGeometry {
  const lines = Math.max(0, Math.round(lineCount))
  const height = lines * layout.lineHeight + layout.verticalPadding * 2
  const frame = Math.max(1, Math.round(frameHeight))
  if (layout.anchor === 'top') {
    return { top: layout.marginPx, height }
  }
  if (layout.anchor === 'center') {
    return { top: Math.round((frame - height) / 2), height }
  }
  return { top: frame - layout.marginPx - height, height }
}

/** Plain CSS declarations; typed loosely so this module stays free of React. */
export type SubtitleCssProperties = Record<string, string | number>

export interface SubtitleOverlayStyles {
  /** Full-width strip pinned at the box's top edge; centres the box inside it. */
  container: SubtitleCssProperties
  /** The rounded caption box itself. */
  box: SubtitleCssProperties
  /** One wrapped line. */
  line: SubtitleCssProperties
}

/**
 * The DOM preview's inline styles, derived from the very same resolved layout
 * the canvas renderer draws from. `line-height` is emitted in pixels so the
 * rendered box height equals `resolveSubtitleBox(...).height` exactly.
 */
export function buildSubtitleOverlayStyles(
  layout: ResolvedSubtitleLayout,
  box: SubtitleBoxGeometry,
): SubtitleOverlayStyles {
  return {
    container: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: `${box.top}px`,
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'none',
    },
    box: {
      boxSizing: 'border-box',
      maxWidth: `${layout.maxBoxWidth}px`,
      padding: `${layout.verticalPadding}px ${layout.horizontalPadding}px`,
      borderRadius: `${layout.borderRadius}px`,
      backgroundColor: layout.backgroundColor ?? 'transparent',
      border: layout.borderColor ? `1px solid ${layout.borderColor}` : 'none',
    },
    line: {
      fontFamily: layout.fontFamily,
      fontSize: `${layout.fontSize}px`,
      fontWeight: layout.fontWeight,
      lineHeight: `${layout.lineHeight}px`,
      color: layout.textColor,
      textAlign: 'center',
      whiteSpace: 'nowrap',
      textShadow:
        layout.textShadowBlur > 0
          ? `0 0 ${layout.textShadowBlur}px ${layout.textShadowColor}`
          : 'none',
    },
  }
}

// ---------------------------------------------------------------------------
// Word highlighting
// ---------------------------------------------------------------------------

/**
 * Cue text as highlightable units: whitespace-separated words for latin-script
 * text, single graphemes for text without whitespace (CJK). Same rule as the
 * line wrapper above, so a token never straddles two lines.
 */
export function splitSubtitleWords(inputText: string): string[] {
  const text = String(inputText ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!text) return []
  return tokenize(text).tokens
}

/**
 * Index of the word being spoken at `timeMs`, or -1 outside the cue.
 *
 * Cues carry no per-word timings once they are materialised, so the cue's
 * duration is shared out over its words in proportion to their length — longer
 * words hold the highlight longer, which tracks speech closely enough to read.
 */
export function resolveHighlightedWordIndex(
  words: readonly string[],
  startMs: number,
  endMs: number,
  timeMs: number,
): number {
  if (words.length === 0) return -1
  const start = Number(startMs)
  const end = Number(endMs)
  const time = Number(timeMs)
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(time)) return -1
  if (end <= start) return -1
  if (time < start || time >= end) return -1

  const weights = words.map((word) => Math.max(1, Array.from(word).length))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const elapsed = (time - start) / (end - start)
  let consumed = 0
  for (let index = 0; index < words.length; index += 1) {
    consumed += weights[index]
    if (elapsed < consumed / total) return index
  }
  return words.length - 1
}

export interface SubtitleLineToken {
  text: string
  /** Position in `splitSubtitleWords(cue.text)`. */
  index: number
}

export interface SubtitleLineTokens {
  text: string
  tokens: SubtitleLineToken[]
  /** Joins the tokens back into `text` (a space for latin, empty for CJK). */
  separator: string
}

/**
 * The wrapped lines, each split back into the tokens `splitSubtitleWords`
 * produced, so a renderer can colour one of them. Purely derived from
 * `buildSubtitleLines`, which stays the one wrapping rule.
 */
export function buildSubtitleLineTokens(
  inputText: string,
  maxCharsPerLine: number,
  maxLines: number,
): SubtitleLineTokens[] {
  const lines = buildSubtitleLines(inputText, maxCharsPerLine, maxLines)
  const text = String(inputText ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  const separator = tokenize(text).separator
  let nextIndex = 0
  return lines.map((line) => {
    const tokens = (separator === ' ' ? line.split(' ') : Array.from(line)).filter(
      (token) => token.length > 0,
    )
    return {
      text: line,
      separator,
      tokens: tokens.map((token) => ({ text: token, index: nextIndex++ })),
    }
  })
}
