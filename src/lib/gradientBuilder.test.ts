import { describe, expect, it } from 'vitest'
import { BACKGROUND_GRADIENT_PRESETS } from '@/components/video-editor/backgroundPresets'
import { parseCssGradient } from '@/lib/exporter/gradientParser'
import {
  addGradientStop,
  buildCssGradient,
  colorToHex,
  DEFAULT_GRADIENT_SPEC,
  type GradientSpec,
  isEditableGradient,
  MAX_GRADIENT_STOPS,
  MIN_GRADIENT_STOPS,
  mixColors,
  normalizeGradientAngle,
  normalizeGradientSpec,
  parseGradientSpec,
  removeGradientStop,
  sortGradientStops,
  updateGradientStop,
} from './gradientBuilder'

const threeStops: GradientSpec = {
  kind: 'linear',
  angle: 45,
  stops: [
    { color: '#ff0000', position: 0 },
    { color: '#00ff00', position: 40 },
    { color: '#0000ff', position: 100 },
  ],
}

describe('buildCssGradient', () => {
  it('emits a linear gradient with angle and percentage stops', () => {
    expect(buildCssGradient(threeStops)).toBe(
      'linear-gradient(45deg, #ff0000 0%, #00ff00 40%, #0000ff 100%)',
    )
  })

  it('emits a centred circle for radial specs and ignores the angle', () => {
    expect(buildCssGradient({ ...threeStops, kind: 'radial', angle: 90 })).toBe(
      'radial-gradient(circle at 50% 50%, #ff0000 0%, #00ff00 40%, #0000ff 100%)',
    )
  })

  it('sorts stops by position and keeps one decimal', () => {
    const css = buildCssGradient({
      kind: 'linear',
      angle: 0,
      stops: [
        { color: '#222222', position: 66.66 },
        { color: '#111111', position: 12.34 },
      ],
    })
    expect(css).toBe('linear-gradient(0deg, #111111 12.3%, #222222 66.7%)')
  })
})

describe('round trip through the exporter parser', () => {
  it('parses back to the same kind, angle and stops (linear)', () => {
    const css = buildCssGradient(threeStops)
    const parsed = parseCssGradient(css)
    expect(parsed).not.toBeNull()
    expect(parsed?.type).toBe('linear')
    expect(parsed?.descriptor).toBe('45deg')
    expect(parsed?.stops).toEqual([
      { color: '#ff0000', offset: 0 },
      { color: '#00ff00', offset: 0.4 },
      { color: '#0000ff', offset: 1 },
    ])
    expect(parseGradientSpec(css)).toEqual(threeStops)
  })

  it('parses back to the same stops (radial)', () => {
    const radial: GradientSpec = { ...threeStops, kind: 'radial', angle: 135 }
    const css = buildCssGradient(radial)
    const parsed = parseCssGradient(css)
    expect(parsed?.type).toBe('radial')
    expect(parsed?.stops.map((s) => s.offset)).toEqual([0, 0.4, 1])
    expect(parseGradientSpec(css)).toEqual(radial)
  })

  it('survives six stops with fractional positions', () => {
    const spec: GradientSpec = {
      kind: 'linear',
      angle: 300,
      stops: [0, 17.5, 33.3, 50, 82.1, 100].map((position, index) => ({
        color: `#${(index * 40).toString(16).padStart(2, '0')}80ff`,
        position,
      })),
    }
    expect(parseGradientSpec(buildCssGradient(spec))).toEqual(spec)
  })

  it('loads every preset, and rebuilding a loaded preset is idempotent', () => {
    for (const preset of BACKGROUND_GRADIENT_PRESETS) {
      const spec = parseGradientSpec(preset)
      expect(spec, preset).not.toBeNull()
      expect(spec?.stops.length ?? 0).toBeGreaterThanOrEqual(MIN_GRADIENT_STOPS)
      const rebuilt = buildCssGradient(spec as GradientSpec)
      expect(parseGradientSpec(rebuilt)).toEqual(spec)
      // The exporter reads the rebuilt string with the same stop offsets as the preset.
      const originalStops = parseCssGradient(preset)?.stops.map((s) => s.offset)
      const rebuiltStops = parseCssGradient(rebuilt)?.stops.map((s) => s.offset)
      expect(rebuiltStops?.map((o) => Math.round(o * 1000))).toEqual(
        originalStops?.map((o) => Math.round(o * 1000)),
      )
    }
  })

  it('reads `to <side>` descriptors as angles', () => {
    expect(parseGradientSpec('linear-gradient(to right, #000 0%, #fff 100%)')?.angle).toBe(90)
    expect(parseGradientSpec('linear-gradient(#000, #fff)')?.angle).toBe(180)
  })

  it('rejects non-gradients', () => {
    expect(parseGradientSpec('#ff00ff')).toBeNull()
    expect(parseGradientSpec('/wallpapers/wallpaper1.jpg')).toBeNull()
    expect(isEditableGradient('linear-gradient(90deg, red, blue)')).toBe(true)
    expect(isEditableGradient('url(x.png)')).toBe(false)
  })
})

describe('normalizeGradientSpec', () => {
  it('wraps the angle and clamps positions', () => {
    expect(normalizeGradientAngle(-90)).toBe(270)
    expect(normalizeGradientAngle(360)).toBe(0)
    expect(normalizeGradientAngle(Number.NaN)).toBe(DEFAULT_GRADIENT_SPEC.angle)
    const spec = normalizeGradientSpec({
      kind: 'linear',
      angle: 725,
      stops: [
        { color: '#000000', position: -5 },
        { color: '#ffffff', position: 140 },
      ],
    })
    expect(spec.angle).toBe(5)
    expect(spec.stops.map((s) => s.position)).toEqual([0, 100])
  })

  it('pads to the minimum and trims to the maximum stop count', () => {
    expect(normalizeGradientSpec({ stops: [{ color: '#123456', position: 30 }] }).stops).toEqual([
      { color: '#123456', position: 30 },
      { color: '#123456', position: 100 },
    ])
    expect(normalizeGradientSpec(null).stops).toHaveLength(MIN_GRADIENT_STOPS)
    const many = Array.from({ length: 9 }, (_, i) => ({ color: '#000000', position: i * 10 }))
    expect(normalizeGradientSpec({ stops: many }).stops).toHaveLength(MAX_GRADIENT_STOPS)
  })

  it('sorts stably', () => {
    const sorted = sortGradientStops([
      { color: '#b', position: 50 },
      { color: '#a', position: 50 },
      { color: '#c', position: 10 },
    ])
    expect(sorted.map((s) => s.color)).toEqual(['#c', '#b', '#a'])
  })
})

describe('stop editing', () => {
  it('adds a stop in the widest gap with the mixed colour and caps at the maximum', () => {
    const added = addGradientStop(threeStops)
    expect(added.stops).toHaveLength(4)
    expect(added.stops[3]).toEqual({ color: '#008080', position: 70 })

    let spec = threeStops
    for (let i = 0; i < 10; i++) spec = addGradientStop(spec)
    expect(spec.stops).toHaveLength(MAX_GRADIENT_STOPS)
  })

  it('adds after the last stop when it sits below 100%', () => {
    const spec = addGradientStop({
      kind: 'linear',
      angle: 0,
      stops: [
        { color: '#000000', position: 0 },
        { color: '#ffffff', position: 20 },
      ],
    })
    expect(spec.stops[2]).toEqual({ color: '#ffffff', position: 60 })
  })

  it('removes a stop but never below the minimum', () => {
    expect(removeGradientStop(threeStops, 1).stops.map((s) => s.color)).toEqual([
      '#ff0000',
      '#0000ff',
    ])
    const two = removeGradientStop(threeStops, 1)
    expect(removeGradientStop(two, 0)).toEqual(two)
    expect(removeGradientStop(threeStops, 7)).toEqual(threeStops)
  })

  it('updates a stop in place without reordering rows', () => {
    const updated = updateGradientStop(threeStops, 0, { position: 90, color: '#abcdef' })
    expect(updated.stops[0]).toEqual({ color: '#abcdef', position: 90 })
    expect(updated.stops[1]).toEqual(threeStops.stops[1])
    expect(buildCssGradient(updated)).toBe(
      'linear-gradient(45deg, #00ff00 40%, #abcdef 90%, #0000ff 100%)',
    )
  })
})

describe('colour helpers', () => {
  it('normalises hex and rgb() forms', () => {
    expect(colorToHex('#ABC')).toBe('#aabbcc')
    expect(colorToHex('#abcd')).toBe('#aabbccdd')
    expect(colorToHex('#aabbccff')).toBe('#aabbcc')
    expect(colorToHex('rgb(114, 167, 232)')).toBe('#72a7e8')
    expect(colorToHex('rgba(114,167,232,1)')).toBe('#72a7e8')
    expect(colorToHex('rgba(235,230,44,0.55)')).toBe('#ebe62c8c')
    expect(colorToHex('hsl(10, 50%, 50%)')).toBeNull()
    expect(colorToHex('red')).toBeNull()
  })

  it('mixes colours linearly', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColors('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(mixColors('red', '#0000ff', 0.5)).toBe('red')
  })
})
