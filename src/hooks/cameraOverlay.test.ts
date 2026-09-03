import { describe, expect, it } from 'vitest'
import { computeCameraOverlayRect } from './cameraOverlay'

describe('computeCameraOverlayRect', () => {
  it('positions overlay in bottom-right with stable bounds', () => {
    const rect = computeCameraOverlayRect(1920, 1080)
    expect(rect.width).toBeGreaterThanOrEqual(180)
    expect(rect.width).toBeLessThanOrEqual(560)
    expect(rect.height).toBe(Math.round((rect.width * 9) / 16))
    expect(rect.x + rect.width).toBeLessThanOrEqual(1920)
    expect(rect.y + rect.height).toBeLessThanOrEqual(1080)
    expect(rect.cornerRadius).toBeGreaterThanOrEqual(12)
  })

  it('supports square and circle overlays with 1:1 ratio', () => {
    const square = computeCameraOverlayRect(1920, 1080, { shape: 'square', sizePercent: 26 })
    const circle = computeCameraOverlayRect(1920, 1080, { shape: 'circle', sizePercent: 26 })
    expect(square.width).toBe(square.height)
    expect(square.cornerRadius).toBe(0)
    expect(circle.width).toBe(circle.height)
    expect(circle.cornerRadius).toBe(0)
  })

  it('clamps overlay size percent to valid range', () => {
    const tooSmall = computeCameraOverlayRect(1920, 1080, { sizePercent: 1 })
    const tooLarge = computeCameraOverlayRect(1920, 1080, { sizePercent: 99 })
    expect(tooSmall.width).toBe(269)
    expect(tooLarge.width).toBe(560)
  })

  it('keeps the overlay inside a portrait canvas (rotated display or window) for every shape', () => {
    for (const shape of ['rounded', 'square', 'circle'] as const) {
      for (const sizePercent of [14, 22, 40]) {
        const rect = computeCameraOverlayRect(1080, 1920, { shape, sizePercent })
        expect(rect.x).toBeGreaterThanOrEqual(0)
        expect(rect.y).toBeGreaterThanOrEqual(0)
        expect(rect.x + rect.width).toBeLessThanOrEqual(1080)
        expect(rect.y + rect.height).toBeLessThanOrEqual(1920)
        // The box scales with the canvas width, so a narrow portrait canvas never
        // gets a wider overlay than the same percentage on a landscape one.
        expect(rect.width).toBeLessThanOrEqual(
          computeCameraOverlayRect(1920, 1080, { shape, sizePercent }).width,
        )
      }
    }
  })

  it('stays within a very small canvas even at the minimum overlay size', () => {
    const rect = computeCameraOverlayRect(320, 240, { sizePercent: 14 })
    // Minimum overlay width (180) plus its margin still fits a 320 px wide frame.
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(320)
    expect(rect.y + rect.height).toBeLessThanOrEqual(240)
  })
})
