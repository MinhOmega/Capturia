import { describe, expect, it } from 'vitest'
import {
  calculateEffectiveSourceDimensions,
  calculateMp4ExportPlan,
  getAvailableExportFrameRates,
  isSupportedExportFrameRate,
  resolveExportFrameRate,
} from './mp4ExportPlan'

describe('mp4ExportPlan', () => {
  it('keeps source frame rate for source quality', () => {
    expect(resolveExportFrameRate(120, 'source')).toBe(120)
    expect(resolveExportFrameRate(15, 'source')).toBe(24)
  })

  it('caps non-source quality frame rate to 60fps', () => {
    expect(resolveExportFrameRate(120, 'good')).toBe(60)
    expect(resolveExportFrameRate(144, 'medium')).toBe(60)
  })

  it('uses preset resolution when source is sufficient', () => {
    const plan = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceFrameRate: 60,
    })

    expect(plan.width).toBe(1920)
    expect(plan.height).toBe(1080)
    expect(plan.limitedBySource).toBe(false)
  })

  it('never upscales when source is below quality preset target', () => {
    const plan = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 992,
      sourceHeight: 558,
      sourceFrameRate: 120,
    })

    expect(plan.width).toBeLessThanOrEqual(992)
    expect(plan.height).toBeLessThanOrEqual(558)
    expect(plan.limitedBySource).toBe(true)
    expect(plan.frameRate).toBe(60)
  })

  it('matches source-bounded dimensions for source quality', () => {
    const plan = calculateMp4ExportPlan({
      quality: 'source',
      aspectRatio: 16 / 9,
      sourceWidth: 1919,
      sourceHeight: 1081,
      sourceFrameRate: 120,
    })

    expect(plan.width % 2).toBe(0)
    expect(plan.height % 2).toBe(0)
    expect(plan.width).toBeLessThanOrEqual(1918)
    expect(plan.height).toBeLessThanOrEqual(1080)
    expect(plan.limitedBySource).toBe(false)
    expect(plan.frameRate).toBe(120)
  })

  it('increases bitrate with higher frame rate under same quality and resolution', () => {
    const lowFps = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceFrameRate: 30,
    })
    const highFps = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceFrameRate: 60,
    })

    expect(highFps.bitrate).toBeGreaterThan(lowFps.bitrate)
  })
})

describe('calculateEffectiveSourceDimensions', () => {
  it('uses the cropped area as the effective source size', () => {
    expect(
      calculateEffectiveSourceDimensions(3840, 2160, { width: 854 / 3840, height: 480 / 2160 }),
    ).toEqual({
      width: 854,
      height: 480,
    })
  })

  it('is the full source without a crop, rounded down to even', () => {
    expect(calculateEffectiveSourceDimensions(1919, 1081)).toEqual({ width: 1918, height: 1080 })
    expect(
      calculateEffectiveSourceDimensions(1920, 1080, { width: Number.NaN, height: 0 }),
    ).toEqual({ width: 1920, height: 1080 })
  })

  it('exports the native aspect at the cropped source size with source quality and never upscales it', () => {
    const effective = calculateEffectiveSourceDimensions(1920, 1080, { width: 0.5, height: 1 })
    const plan = calculateMp4ExportPlan({
      quality: 'source',
      aspectRatio: effective.width / effective.height,
      sourceWidth: effective.width,
      sourceHeight: effective.height,
      sourceFrameRate: 30,
    })
    expect({ width: plan.width, height: plan.height }).toEqual({ width: 960, height: 1080 })

    const good = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: effective.width / effective.height,
      sourceWidth: effective.width,
      sourceHeight: effective.height,
      sourceFrameRate: 30,
    })
    expect(good.width).toBeLessThanOrEqual(960)
    expect(good.height).toBeLessThanOrEqual(1080)
  })
})

describe('export frame-rate choices', () => {
  it('offers only the preset rates at or below the source', () => {
    expect(getAvailableExportFrameRates(60)).toEqual([24, 30, 60])
    expect(getAvailableExportFrameRates(30)).toEqual([24, 30])
    // Clamped up to 24 first, so there is always something to pick.
    expect(getAvailableExportFrameRates(15)).toEqual([24])
    expect(getAvailableExportFrameRates(undefined)).toEqual([24, 30, 60])
  })

  it('adds the source rate itself when it is not one of the presets', () => {
    expect(getAvailableExportFrameRates(50)).toEqual([24, 30, 50])
    expect(getAvailableExportFrameRates(120)).toEqual([24, 30, 60, 120])
  })

  it('rejects a rate the source cannot deliver', () => {
    expect(isSupportedExportFrameRate(60, 30)).toBe(false)
    expect(isSupportedExportFrameRate(30, 30)).toBe(true)
    expect(isSupportedExportFrameRate(24, 30)).toBe(true)
    expect(isSupportedExportFrameRate(undefined, 30)).toBe(false)
    expect(isSupportedExportFrameRate(Number.NaN, 30)).toBe(false)
  })

  it('honours a requested rate that the source can deliver, whatever the quality', () => {
    expect(resolveExportFrameRate(60, 'good', 24)).toBe(24)
    expect(resolveExportFrameRate(60, 'source', 30)).toBe(30)
  })

  it('ignores a request above the source and keeps the preset behaviour', () => {
    // A 60 fps preference carried over from another recording must not make a
    // 30 fps source duplicate frames.
    expect(resolveExportFrameRate(30, 'good', 60)).toBe(30)
    expect(resolveExportFrameRate(120, 'good')).toBe(60)
    expect(resolveExportFrameRate(120, 'source')).toBe(120)
  })

  it('reports on the plan when a request was dropped, and when the rate differs from source', () => {
    const dropped = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFrameRate: 30,
      requestedFrameRate: 60,
    })
    expect(dropped.frameRate).toBe(30)
    expect(dropped.frameRateLimitedBySource).toBe(true)
    expect(dropped.frameRateDiffersFromSource).toBe(false)

    const honoured = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFrameRate: 60,
      requestedFrameRate: 24,
    })
    expect(honoured.frameRate).toBe(24)
    expect(honoured.frameRateLimitedBySource).toBe(false)
    expect(honoured.frameRateDiffersFromSource).toBe(true)
  })

  it('prices the bitrate off the rate actually exported', () => {
    const at24 = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFrameRate: 60,
      requestedFrameRate: 24,
    })
    const at60 = calculateMp4ExportPlan({
      quality: 'good',
      aspectRatio: 16 / 9,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceFrameRate: 60,
      requestedFrameRate: 60,
    })
    expect(at24.bitrate).toBeLessThan(at60.bitrate)
  })
})
