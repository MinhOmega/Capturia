import { describe, expect, it } from 'vitest'
import {
  ASPECT_RATIOS,
  formatAspectRatioForCSS,
  getAspectRatioLabel,
  getAspectRatioValue,
  getNativeAspectRatioValue,
  isAspectRatio,
  resolveAspectRatioValue,
} from './aspectRatioUtils'

const FALLBACK_RATIO = 16 / 9

describe('getNativeAspectRatioValue', () => {
  it('returns the video ratio when no crop region is provided', () => {
    expect(getNativeAspectRatioValue(1920, 1080)).toBe(16 / 9)
  })

  it('applies crop width and height to the video ratio', () => {
    expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 0.5, height: 1 })).toBe(8 / 9)
  })

  it('falls back when video metadata is zero or non-finite', () => {
    expect(getNativeAspectRatioValue(0, 1080)).toBe(FALLBACK_RATIO)
    expect(getNativeAspectRatioValue(1920, 0)).toBe(FALLBACK_RATIO)
    expect(getNativeAspectRatioValue(Number.NaN, 1080)).toBe(FALLBACK_RATIO)
    expect(getNativeAspectRatioValue(1920, Number.POSITIVE_INFINITY)).toBe(FALLBACK_RATIO)
  })

  it('falls back when crop dimensions are non-positive or non-finite', () => {
    expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 0, height: 1 })).toBe(
      FALLBACK_RATIO,
    )
    expect(getNativeAspectRatioValue(1920, 1080, { x: 0, y: 0, width: 1, height: -1 })).toBe(
      FALLBACK_RATIO,
    )
    expect(
      getNativeAspectRatioValue(1920, 1080, {
        x: 0,
        y: 0,
        width: Number.POSITIVE_INFINITY,
        height: 1,
      }),
    ).toBe(FALLBACK_RATIO)
  })
})

describe('native aspect ratio', () => {
  it('is part of the selectable list, after the fixed ratios', () => {
    expect(ASPECT_RATIOS[ASPECT_RATIOS.length - 1]).toBe('native')
    expect(isAspectRatio('native')).toBe(true)
    expect(isAspectRatio('3:2')).toBe(false)
    expect(isAspectRatio(undefined)).toBe(false)
  })

  it('resolves to the cropped source ratio, fixed ratios stay fixed', () => {
    const crop = { x: 0.25, y: 0, width: 0.5, height: 1 }
    expect(resolveAspectRatioValue('native', 1920, 1080, crop)).toBe(8 / 9)
    expect(resolveAspectRatioValue('16:9', 1920, 1080, crop)).toBe(16 / 9)
    expect(resolveAspectRatioValue('1:1', 1920, 1080)).toBe(1)
  })

  it('uses the 16:9 fallback without source context', () => {
    expect(getAspectRatioValue('native')).toBe(FALLBACK_RATIO)
    expect(resolveAspectRatioValue('native', 0, 0)).toBe(FALLBACK_RATIO)
  })

  it('is labelled Original and formats to a numeric CSS ratio', () => {
    expect(getAspectRatioLabel('native')).toBe('Original')
    expect(getAspectRatioLabel('16:9')).toBe('16:9')
    expect(formatAspectRatioForCSS('16:9')).toBe('16/9')
    expect(formatAspectRatioForCSS('native', 1.25)).toBe('1.25')
    expect(formatAspectRatioForCSS('native')).toBe(String(FALLBACK_RATIO))
    expect(formatAspectRatioForCSS('native', 0)).toBe(String(FALLBACK_RATIO))
  })
})
