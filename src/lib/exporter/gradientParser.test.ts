import { describe, expect, it } from 'vitest'
import { BACKGROUND_GRADIENT_PRESETS } from '@/components/video-editor/backgroundPresets'
import {
  getLinearGradientPoints,
  getRadialGradientShape,
  parseCssGradient,
  resolveLinearGradientAngle,
} from './gradientParser'

describe('parseCssGradient', () => {
  it('parses rgba-based gradient presets without splitting inside color functions', () => {
    const parsed = parseCssGradient(
      'linear-gradient( 111.6deg,  rgba(114,167,232,1) 9.4%, rgba(253,129,82,1) 43.9%, rgba(253,129,82,1) 54.8%, rgba(249,202,86,1) 86.3% )',
    )

    expect(parsed?.type).toBe('linear')
    expect(parsed?.descriptor).toBe('111.6deg')
    expect(parsed?.stops).toHaveLength(4)
    expect(parsed?.stops.map((stop) => stop.color)).toEqual([
      'rgba(114,167,232,1)',
      'rgba(253,129,82,1)',
      'rgba(253,129,82,1)',
      'rgba(249,202,86,1)',
    ])
    expect(parsed?.stops[0]?.offset).toBeCloseTo(0.094)
    expect(parsed?.stops[1]?.offset).toBeCloseTo(0.439)
    expect(parsed?.stops[2]?.offset).toBeCloseTo(0.548)
    expect(parsed?.stops[3]?.offset).toBeCloseTo(0.863)
  })

  it('fills missing stop positions for simple hex gradients', () => {
    const parsed = parseCssGradient('linear-gradient(135deg, #FBC8B4, #2447B1)')

    expect(parsed?.stops).toEqual([
      { color: '#FBC8B4', offset: 0 },
      { color: '#2447B1', offset: 1 },
    ])
  })

  it('returns null for non-gradient input', () => {
    expect(parseCssGradient('#ffffff')).toBeNull()
    expect(parseCssGradient('linear-gradient()')).toBeNull()
  })
})

describe('gradient geometry', () => {
  it('maps linear directions to canvas endpoints', () => {
    const angle = resolveLinearGradientAngle('to right')
    const points = getLinearGradientPoints(angle, 1920, 1080)

    expect(points.x0).toBeCloseTo(0)
    expect(points.y0).toBeCloseTo(540)
    expect(points.x1).toBeCloseTo(1920)
    expect(points.y1).toBeCloseTo(540)
  })

  it('defaults to top-to-bottom when there is no descriptor', () => {
    expect(resolveLinearGradientAngle(null)).toBe(180)
    const points = getLinearGradientPoints(180, 100, 200)
    expect(points.y0).toBeCloseTo(0)
    expect(points.y1).toBeCloseTo(200)
  })

  it('uses radial positions from the descriptor', () => {
    const shape = getRadialGradientShape('circle farthest-corner at 10% 20%', 1000, 500)

    expect(shape.cx).toBe(100)
    expect(shape.cy).toBe(100)
    expect(shape.radius).toBeCloseTo(Math.hypot(900, 400))
  })
})

// Regression: every preset offered in SettingsPanel must survive the parser.
// The previous renderer split on ',' and tore every rgba(...) stop apart.
describe('Capturia gradient presets', () => {
  it.each(BACKGROUND_GRADIENT_PRESETS)('parses preset %s', (preset) => {
    const parsed = parseCssGradient(preset)
    expect(parsed).not.toBeNull()
    expect(parsed!.stops.length).toBeGreaterThanOrEqual(2)
    for (const stop of parsed!.stops) {
      expect(stop.color).toMatch(/^(#[0-9a-fA-F]{3,8}|rgba?\(.*\))$/)
      expect(stop.offset).toBeGreaterThanOrEqual(0)
      expect(stop.offset).toBeLessThanOrEqual(1)
    }
    for (let i = 1; i < parsed!.stops.length; i += 1) {
      expect(parsed!.stops[i].offset).toBeGreaterThanOrEqual(parsed!.stops[i - 1].offset)
    }
  })

  it('keeps the angle of the first rgba preset', () => {
    const parsed = parseCssGradient(BACKGROUND_GRADIENT_PRESETS[0])
    expect(parsed?.type).toBe('linear')
    expect(resolveLinearGradientAngle(parsed!.descriptor)).toBeCloseTo(111.6)
    expect(parsed?.stops).toHaveLength(4)
  })

  it('keeps the radial centre of the farthest-corner preset', () => {
    const parsed = parseCssGradient(BACKGROUND_GRADIENT_PRESETS[2])
    expect(parsed?.type).toBe('radial')
    expect(parsed?.stops.map((stop) => stop.color)).toEqual([
      'rgba(80,12,139,0.87)',
      'rgba(161,10,144,0.72)',
    ])
    expect(parsed?.stops.map((stop) => stop.offset)).toEqual([0, 0.836])
    const shape = getRadialGradientShape(parsed!.descriptor, 1000, 1000)
    expect(shape.cx).toBeCloseTo(32)
    expect(shape.cy).toBeCloseTo(496)
  })
})
