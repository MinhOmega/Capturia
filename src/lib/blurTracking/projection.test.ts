import { describe, expect, it } from 'vitest'
import { projectCursorToViewport } from '@/lib/cursor/cursorComposer'
import type { NormRect } from './keyframes'
import {
  projectMaskToStage,
  projectSourcePointToStage,
  projectSourceRectToStage,
  type StageGeometry,
  stageRectToSourceRect,
} from './projection'

/** Export-shaped geometry: the mask fills the stage, no crop, no camera. */
const IDENTITY: StageGeometry = {
  stageSize: { width: 1920, height: 1080 },
  baseOffset: { x: 0, y: 0 },
  maskRect: { width: 1920, height: 1080 },
  cropRegion: { x: 0, y: 0, width: 1, height: 1 },
  camera: { scale: 1, x: 0, y: 0 },
}

/** Preview-shaped geometry: a padded mask inside a larger stage. */
const PADDED: StageGeometry = {
  stageSize: { width: 1000, height: 700 },
  baseOffset: { x: 60, y: 40 },
  maskRect: { width: 880, height: 495 },
  cropRegion: { x: 0, y: 0, width: 1, height: 1 },
  camera: { scale: 1, x: 0, y: 0 },
}

const CROPPED: StageGeometry = {
  ...PADDED,
  cropRegion: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 },
}

const ZOOMED: StageGeometry = {
  ...CROPPED,
  camera: { scale: 1.8, x: -220, y: -130 },
}

const GEOMETRIES: Array<[string, StageGeometry]> = [
  ['identity', IDENTITY],
  ['padded mask', PADDED],
  ['crop', CROPPED],
  ['zoomed camera over a crop', ZOOMED],
]

function expectRectClose(actual: NormRect, expected: NormRect, precision = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, precision)
  expect(actual.y).toBeCloseTo(expected.y, precision)
  expect(actual.w).toBeCloseTo(expected.w, precision)
  expect(actual.h).toBeCloseTo(expected.h, precision)
}

describe('projectSourcePointToStage', () => {
  it('is the arithmetic projectCursorToViewport uses', () => {
    for (const [, geometry] of GEOMETRIES) {
      for (const [nx, ny] of [
        [0, 0],
        [0.3, 0.42],
        [0.5, 0.5],
        [0.99, 0.01],
        [1, 1],
      ]) {
        const shared = {
          normalizedX: nx,
          normalizedY: ny,
          cropRegion: geometry.cropRegion,
          baseOffset: geometry.baseOffset,
          maskRect: geometry.maskRect,
          cameraScale: { x: geometry.camera.scale, y: geometry.camera.scale },
          cameraPosition: { x: geometry.camera.x, y: geometry.camera.y },
        }
        const point = projectSourcePointToStage(shared)
        const cursor = projectCursorToViewport({ ...shared, stageSize: geometry.stageSize })
        expect(point.x).toBe(cursor.x)
        expect(point.y).toBe(cursor.y)
        expect(point.inCrop).toBe(cursor.inCrop)
      }
    }
  })

  it('reports a point outside the crop as not in crop', () => {
    const outside = projectSourcePointToStage({
      normalizedX: 0.05,
      normalizedY: 0.5,
      cropRegion: CROPPED.cropRegion,
      baseOffset: CROPPED.baseOffset,
      maskRect: CROPPED.maskRect,
      cameraScale: { x: 1, y: 1 },
      cameraPosition: { x: 0, y: 0 },
    })
    expect(outside.inCrop).toBe(false)
  })
})

describe('projectSourceRectToStage', () => {
  it('maps a source rect onto the mask under the identity geometry', () => {
    const projected = projectSourceRectToStage({ x: 0.25, y: 0.5, w: 0.1, h: 0.2 }, IDENTITY)!
    expect(projected).toMatchObject({ x: 480, y: 540, width: 192, height: 216, clipped: false })
  })

  it('scales and translates with the camera', () => {
    const rect = { x: 0.4, y: 0.3, w: 0.1, h: 0.1 }
    const unzoomed = projectSourceRectToStage(rect, PADDED)!
    const zoomed = projectSourceRectToStage(rect, {
      ...PADDED,
      camera: { scale: 2, x: 10, y: 20 },
    })!
    expect(zoomed.width).toBeCloseTo(unzoomed.width * 2, 9)
    expect(zoomed.height).toBeCloseTo(unzoomed.height * 2, 9)
    expect(zoomed.x).toBeCloseTo(unzoomed.x * 2 + 10, 9)
    expect(zoomed.y).toBeCloseTo(unzoomed.y * 2 + 20, 9)
  })

  it('clips to the mask so a mosaic never reaches the wallpaper padding', () => {
    const mask = projectMaskToStage(PADDED)
    // A rect that runs off the left and top of the source.
    const projected = projectSourceRectToStage({ x: -0.2, y: -0.1, w: 0.4, h: 0.3 }, PADDED)!
    expect(projected.clipped).toBe(true)
    expect(projected.x).toBeCloseTo(mask.x, 9)
    expect(projected.y).toBeCloseTo(mask.y, 9)
    expect(projected.x).toBeGreaterThanOrEqual(mask.x - 1e-9)
    expect(projected.x + projected.width).toBeLessThanOrEqual(mask.x + mask.width + 1e-9)
  })

  it('returns null for a rect entirely outside the crop', () => {
    expect(projectSourceRectToStage({ x: 0.0, y: 0.0, w: 0.1, h: 0.05 }, CROPPED)).toBeNull()
    expect(projectSourceRectToStage({ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, CROPPED)).toBeNull()
  })

  it('returns null for a degenerate rect', () => {
    expect(projectSourceRectToStage({ x: 0.1, y: 0.1, w: 0, h: 0.1 }, IDENTITY)).toBeNull()
    expect(projectSourceRectToStage({ x: 0.1, y: 0.1, w: 0.1, h: -0.1 }, IDENTITY)).toBeNull()
  })

  it('keeps every corner inside the mask for any rect and geometry', () => {
    for (const [, geometry] of GEOMETRIES) {
      const mask = projectMaskToStage(geometry)
      for (const rect of [
        { x: 0.0, y: 0.0, w: 1, h: 1 },
        { x: 0.3, y: 0.3, w: 0.5, h: 0.5 },
        { x: 0.6, y: 0.05, w: 0.5, h: 0.5 },
      ]) {
        const projected = projectSourceRectToStage(rect, geometry)
        if (!projected) continue
        expect(projected.x).toBeGreaterThanOrEqual(mask.x - 1e-6)
        expect(projected.y).toBeGreaterThanOrEqual(mask.y - 1e-6)
        expect(projected.x + projected.width).toBeLessThanOrEqual(mask.x + mask.width + 1e-6)
        expect(projected.y + projected.height).toBeLessThanOrEqual(mask.y + mask.height + 1e-6)
      }
    }
  })
})

describe('stageRectToSourceRect', () => {
  it('round-trips an unclipped rect through every geometry', () => {
    // Small and centred so the crop never clips it.
    const rects: NormRect[] = [
      { x: 0.3, y: 0.2, w: 0.1, h: 0.15 },
      { x: 0.42, y: 0.35, w: 0.05, h: 0.05 },
      { x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
    ]
    for (const [label, geometry] of GEOMETRIES) {
      for (const rect of rects) {
        const projected = projectSourceRectToStage(rect, geometry)
        expect(projected, `${label} clipped ${JSON.stringify(rect)} away`).not.toBeNull()
        expect(projected!.clipped, label).toBe(false)
        expectRectClose(stageRectToSourceRect(projected!, geometry), rect)
      }
    }
  })

  it('round-trips a stage rect back to itself', () => {
    for (const [, geometry] of GEOMETRIES) {
      const stage = { x: 200, y: 150, width: 120, height: 80 }
      const source = stageRectToSourceRect(stage, geometry)
      const back = projectSourceRectToStage(source, geometry)!
      expect(back.x).toBeCloseTo(stage.x, 6)
      expect(back.y).toBeCloseTo(stage.y, 6)
      expect(back.width).toBeCloseTo(stage.width, 6)
      expect(back.height).toBeCloseTo(stage.height, 6)
    }
  })

  it('does not divide by zero on a degenerate camera or mask', () => {
    const degenerate: StageGeometry = {
      ...IDENTITY,
      maskRect: { width: 0, height: 0 },
      camera: { scale: 0, x: 0, y: 0 },
    }
    const source = stageRectToSourceRect({ x: 10, y: 10, width: 10, height: 10 }, degenerate)
    expect(Number.isFinite(source.x)).toBe(true)
    expect(Number.isFinite(source.w)).toBe(true)
  })
})
