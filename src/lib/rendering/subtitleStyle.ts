/**
 * User-facing caption style: the values the captions section of the settings
 * panel writes and the project file stores.
 *
 * Kept apart from `subtitleLayout.ts` (which turns a style plus a frame size
 * into concrete pixels) so the persisted shape has no rendering concerns in it.
 * Every field is optional in a project file: `normalizeSubtitleStyle` fills the
 * defaults, and the defaults reproduce the fixed layout captions had before
 * this control existed.
 */

export const SUBTITLE_ANCHORS = ['top', 'center', 'bottom'] as const
export type SubtitleAnchor = (typeof SUBTITLE_ANCHORS)[number]

export interface SubtitleStyle {
  /** Multiplier on the frame-height-derived base font size. */
  fontScale: number
  /** Which edge the caption box is pinned to. */
  anchor: SubtitleAnchor
  /** Distance from the anchored edge as a fraction of frame height; ignored for `center`. */
  marginRatio: number
  /** Text colour as `#RRGGBB`. */
  textColor: string
  /** Draw the rounded box behind the text. */
  backgroundEnabled: boolean
  /** Opacity of that box, 0..1. */
  backgroundOpacity: number
  /** Tint the word currently being spoken. */
  highlightCurrentWord: boolean
  /** Colour of the highlighted word as `#RRGGBB`. */
  highlightColor: string
}

/** Exactly the layout captions had before F1, so an untouched project renders identically. */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontScale: 1,
  anchor: 'bottom',
  marginRatio: 0.06,
  textColor: '#FFFFFF',
  backgroundEnabled: true,
  backgroundOpacity: 0.72,
  highlightCurrentWord: false,
  highlightColor: '#34B27B',
}

export const MIN_SUBTITLE_FONT_SCALE = 0.6
export const MAX_SUBTITLE_FONT_SCALE = 2
export const MAX_SUBTITLE_MARGIN_RATIO = 0.4

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return clamp(parsed, min, max)
}

/** `#RGB` and `#RRGGBB` (case-insensitive) are accepted; anything else falls back. */
export function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toUpperCase()
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [, r, g, b] = trimmed
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase()
  }
  return fallback
}

export function isSubtitleAnchor(value: unknown): value is SubtitleAnchor {
  return typeof value === 'string' && (SUBTITLE_ANCHORS as readonly string[]).includes(value)
}

/** Fill a partial / hand-edited / older style with the defaults, clamping every range. */
export function normalizeSubtitleStyle(input: unknown): SubtitleStyle {
  const source = (input ?? {}) as Partial<SubtitleStyle>
  return {
    fontScale: normalizeNumber(
      source.fontScale,
      DEFAULT_SUBTITLE_STYLE.fontScale,
      MIN_SUBTITLE_FONT_SCALE,
      MAX_SUBTITLE_FONT_SCALE,
    ),
    anchor: isSubtitleAnchor(source.anchor) ? source.anchor : DEFAULT_SUBTITLE_STYLE.anchor,
    marginRatio: normalizeNumber(
      source.marginRatio,
      DEFAULT_SUBTITLE_STYLE.marginRatio,
      0,
      MAX_SUBTITLE_MARGIN_RATIO,
    ),
    textColor: normalizeHexColor(source.textColor, DEFAULT_SUBTITLE_STYLE.textColor),
    backgroundEnabled:
      typeof source.backgroundEnabled === 'boolean'
        ? source.backgroundEnabled
        : DEFAULT_SUBTITLE_STYLE.backgroundEnabled,
    backgroundOpacity: normalizeNumber(
      source.backgroundOpacity,
      DEFAULT_SUBTITLE_STYLE.backgroundOpacity,
      0,
      1,
    ),
    highlightCurrentWord:
      typeof source.highlightCurrentWord === 'boolean'
        ? source.highlightCurrentWord
        : DEFAULT_SUBTITLE_STYLE.highlightCurrentWord,
    highlightColor: normalizeHexColor(source.highlightColor, DEFAULT_SUBTITLE_STYLE.highlightColor),
  }
}

/** True when every field still equals the default; used to keep it out of the project file. */
export function isDefaultSubtitleStyle(style: SubtitleStyle): boolean {
  return (
    style.fontScale === DEFAULT_SUBTITLE_STYLE.fontScale &&
    style.anchor === DEFAULT_SUBTITLE_STYLE.anchor &&
    style.marginRatio === DEFAULT_SUBTITLE_STYLE.marginRatio &&
    style.textColor === DEFAULT_SUBTITLE_STYLE.textColor &&
    style.backgroundEnabled === DEFAULT_SUBTITLE_STYLE.backgroundEnabled &&
    style.backgroundOpacity === DEFAULT_SUBTITLE_STYLE.backgroundOpacity &&
    style.highlightCurrentWord === DEFAULT_SUBTITLE_STYLE.highlightCurrentWord &&
    style.highlightColor === DEFAULT_SUBTITLE_STYLE.highlightColor
  )
}
