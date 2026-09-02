import { parseCssGradient, resolveLinearGradientAngle } from '@/lib/exporter/gradientParser'

/**
 * Pure model behind the gradient editor. A `GradientSpec` is a small, always
 * valid description (kind, angle, 2..8 colour stops) that `buildCssGradient`
 * turns into the CSS string Capturia already persists as the wallpaper and
 * that the exporter's `gradientParser` reads back. `parseGradientSpec` is the
 * inverse so a saved gradient or a preset can be loaded into the editor.
 */

export type GradientKind = 'linear' | 'radial'

export interface GradientStop {
  /** CSS colour. The editor writes `#rrggbb` / `#rrggbbaa`; parsed input may carry any token the parser accepts. */
  color: string
  /** 0..100 along the gradient line. */
  position: number
}

export interface GradientSpec {
  kind: GradientKind
  /** Degrees, 0..359; only meaningful for `linear`. */
  angle: number
  stops: GradientStop[]
}

export const MIN_GRADIENT_STOPS = 2
export const MAX_GRADIENT_STOPS = 8
export const DEFAULT_GRADIENT_ANGLE = 135

export const DEFAULT_GRADIENT_SPEC: GradientSpec = {
  kind: 'linear',
  angle: DEFAULT_GRADIENT_ANGLE,
  stops: [
    { color: '#34b27b', position: 0 },
    { color: '#1e3a8a', position: 100 },
  ],
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function roundPosition(value: number): number {
  return Math.round(clamp(value, 0, 100) * 10) / 10
}

export function normalizeGradientAngle(angle: number): number {
  if (!Number.isFinite(angle)) return DEFAULT_GRADIENT_ANGLE
  const wrapped = Math.round(angle) % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/**
 * Returns a valid spec: angle wrapped to 0..359, positions clamped to one
 * decimal, at most MAX stops; a spec with fewer than MIN stops is padded by
 * repeating the last (or default) colour at 100%. Stop order is preserved
 * (the editor keeps rows stable while a position is typed); `buildCssGradient`
 * sorts.
 */
export function normalizeGradientSpec(
  spec: Partial<GradientSpec> | null | undefined,
): GradientSpec {
  const kind: GradientKind = spec?.kind === 'radial' ? 'radial' : 'linear'
  const angle = normalizeGradientAngle(spec?.angle ?? DEFAULT_GRADIENT_ANGLE)
  const stops = (Array.isArray(spec?.stops) ? spec.stops : [])
    .filter((stop) => stop && typeof stop.color === 'string' && stop.color.trim().length > 0)
    .map((stop) => ({ color: stop.color.trim(), position: roundPosition(stop.position) }))
    .slice(0, MAX_GRADIENT_STOPS)

  while (stops.length < MIN_GRADIENT_STOPS) {
    const last = stops[stops.length - 1] ?? DEFAULT_GRADIENT_SPEC.stops[0]
    stops.push({ color: last.color, position: stops.length === 0 ? 0 : 100 })
  }

  return { kind, angle, stops }
}

/** Stops ordered by position (stable, so equal positions keep their relative order). */
export function sortGradientStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index)
    .map(({ stop }) => stop)
}

function formatPosition(position: number): string {
  return Number.isInteger(position) ? String(position) : position.toFixed(1)
}

/** CSS for a spec; the output is accepted verbatim by `parseCssGradient`. */
export function buildCssGradient(input: GradientSpec): string {
  const spec = normalizeGradientSpec(input)
  const stops = sortGradientStops(spec.stops)
    .map((stop) => `${stop.color} ${formatPosition(stop.position)}%`)
    .join(', ')
  if (spec.kind === 'radial') {
    return `radial-gradient(circle at 50% 50%, ${stops})`
  }
  return `linear-gradient(${spec.angle}deg, ${stops})`
}

/** Loads a CSS gradient (a preset, a saved wallpaper, editor output) into a spec; null when it is not a gradient. */
export function parseGradientSpec(css: string): GradientSpec | null {
  const parsed = parseCssGradient(css.trim())
  if (!parsed) return null
  const stops = parsed.stops.map((stop) => ({
    color: colorToHex(stop.color) ?? stop.color,
    position: roundPosition(stop.offset * 100),
  }))
  return normalizeGradientSpec({
    kind: parsed.type,
    angle:
      parsed.type === 'linear'
        ? resolveLinearGradientAngle(parsed.descriptor)
        : DEFAULT_GRADIENT_ANGLE,
    stops,
  })
}

/** True when the string is a gradient the editor can load. */
export function isEditableGradient(css: string): boolean {
  return parseGradientSpec(css) !== null
}

// ---------------------------------------------------------------------------
// Colour helpers (hex / rgb() / rgba() only; other tokens pass through)
// ---------------------------------------------------------------------------

function channelToHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
}

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` to lowercase
 * `#rrggbb` (or `#rrggbbaa` when the alpha is below 1). Anything else → null.
 */
export function colorToHex(color: string): string | null {
  const value = color.trim().toLowerCase()
  const hexMatch = value.match(/^#([0-9a-f]{3,8})$/)
  if (hexMatch) {
    const digits = hexMatch[1]
    if (digits.length === 3 || digits.length === 4) {
      const expanded = digits
        .split('')
        .map((d) => d + d)
        .join('')
      return `#${expanded.length === 8 && expanded.endsWith('ff') ? expanded.slice(0, 6) : expanded}`
    }
    if (digits.length === 6) return `#${digits}`
    if (digits.length === 8) return digits.endsWith('ff') ? `#${digits.slice(0, 6)}` : `#${digits}`
    return null
  }

  const rgbMatch = value.match(
    /^rgba?\(\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/,
  )
  if (!rgbMatch) return null
  const r = channelToHex(Number.parseFloat(rgbMatch[1]))
  const g = channelToHex(Number.parseFloat(rgbMatch[2]))
  const b = channelToHex(Number.parseFloat(rgbMatch[3]))
  const alpha = rgbMatch[4] === undefined ? 1 : clamp(Number.parseFloat(rgbMatch[4]), 0, 1)
  if (alpha >= 1) return `#${r}${g}${b}`
  return `#${r}${g}${b}${channelToHex(alpha * 255)}`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const normalized = colorToHex(hex)
  if (!normalized) return null
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  }
}

/** Linear mix of two colours (`t` = 0 → a, 1 → b). Falls back to `a` when either colour is not hex/rgb. */
export function mixColors(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  if (!ca || !cb) return a
  const k = clamp(t, 0, 1)
  return `#${channelToHex(ca.r + (cb.r - ca.r) * k)}${channelToHex(ca.g + (cb.g - ca.g) * k)}${channelToHex(ca.b + (cb.b - ca.b) * k)}`
}

// ---------------------------------------------------------------------------
// Stop editing
// ---------------------------------------------------------------------------

/**
 * Inserts a stop in the middle of the widest gap between existing stops (or
 * after the last stop when it sits below 100%), coloured as the mix of its
 * neighbours. Returns the same spec when the maximum is reached.
 */
export function addGradientStop(input: GradientSpec): GradientSpec {
  const spec = normalizeGradientSpec(input)
  if (spec.stops.length >= MAX_GRADIENT_STOPS) return spec

  const sorted = sortGradientStops(spec.stops)
  const last = sorted[sorted.length - 1]
  let bestIndex = -1
  let bestGap = 100 - last.position
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].position - sorted[i].position
    if (gap > bestGap) {
      bestGap = gap
      bestIndex = i
    }
  }

  const stop: GradientStop =
    bestIndex === -1
      ? { color: last.color, position: roundPosition(last.position + bestGap / 2) }
      : {
          color: mixColors(sorted[bestIndex].color, sorted[bestIndex + 1].color, 0.5),
          position: roundPosition(
            (sorted[bestIndex].position + sorted[bestIndex + 1].position) / 2,
          ),
        }

  return normalizeGradientSpec({ ...spec, stops: [...spec.stops, stop] })
}

/** Removes the stop at `index`; refuses to go below the minimum. */
export function removeGradientStop(input: GradientSpec, index: number): GradientSpec {
  const spec = normalizeGradientSpec(input)
  if (spec.stops.length <= MIN_GRADIENT_STOPS || index < 0 || index >= spec.stops.length) {
    return spec
  }
  return normalizeGradientSpec({
    ...spec,
    stops: spec.stops.filter((_, i) => i !== index),
  })
}

/** Replaces fields of one stop; the row order is kept. */
export function updateGradientStop(
  input: GradientSpec,
  index: number,
  patch: Partial<GradientStop>,
): GradientSpec {
  const spec = normalizeGradientSpec(input)
  if (index < 0 || index >= spec.stops.length) return spec
  const stops = spec.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop))
  return normalizeGradientSpec({ ...spec, stops })
}
