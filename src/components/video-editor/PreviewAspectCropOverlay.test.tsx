// @vitest-environment jsdom
//
// Drag behaviour of the crop overlay. The arithmetic lives in
// `resizeCropRegion` (see aspectCrop.test.ts); what is checked here is the
// wiring: pixel pointer coordinates become normalized deltas, and the lock
// ratio captured when the drag starts is the one the whole drag uses.
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PreviewAspectCropOverlay } from './PreviewAspectCropOverlay'
import type { CropRegion } from './types'

// The overlay sizes itself from its own box. jsdom lays nothing out, so the
// content rect is pinned here: 800x450 at the origin, exactly 16:9, which
// makes the whole overlay the picture and keeps the pixel maths readable.
const OVERLAY_WIDTH = 800
const OVERLAY_HEIGHT = 450
const SOURCE_ASPECT = 16 / 9

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return OVERLAY_WIDTH
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return OVERLAY_HEIGHT
    },
  })
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: OVERLAY_WIDTH,
      bottom: OVERLAY_HEIGHT,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect
  }
  // Pointer capture is not implemented in jsdom; the overlay only needs it to
  // keep receiving moves after the pointer leaves the handle.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
})

const BASE: CropRegion = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }

function renderOverlay(lockAspectRatio: number | null, cropRegion: CropRegion = BASE) {
  const onCropChange = vi.fn()
  render(
    <PreviewAspectCropOverlay
      cropRegion={cropRegion}
      onCropChange={onCropChange}
      sourceAspectRatio={SOURCE_ASPECT}
      lockAspectRatio={lockAspectRatio}
      positionHint="drag to move"
    />,
  )
  return { onCropChange }
}

/** Press a handle, drag by a pixel delta, release. Returns the last region emitted. */
function dragHandle(
  handle: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  onCropChange: ReturnType<typeof vi.fn>,
): CropRegion | undefined {
  const target = screen.getByTestId(`crop-overlay-handle-${handle}`)
  fireEvent.pointerDown(target, { pointerId: 1, clientX: from.x, clientY: from.y })
  fireEvent.pointerMove(target, { pointerId: 1, clientX: to.x, clientY: to.y })
  fireEvent.pointerUp(target, { pointerId: 1, clientX: to.x, clientY: to.y })
  const last = onCropChange.mock.calls.at(-1)
  return last?.[0] as CropRegion | undefined
}

const pixelAspect = (region: CropRegion) => (region.width / region.height) * SOURCE_ASPECT

describe('PreviewAspectCropOverlay', () => {
  it('reports the lock state on the frame', () => {
    const { onCropChange } = renderOverlay(null)
    expect(screen.getByTestId('crop-overlay-frame')).toHaveAttribute('data-locked', 'false')
    expect(onCropChange).not.toHaveBeenCalled()

    cleanup()
    renderOverlay(1)
    expect(screen.getByTestId('crop-overlay-frame')).toHaveAttribute('data-locked', 'true')
  })

  describe('unlocked', () => {
    it('resizes free-form: an edge drag moves only that edge', () => {
      const { onCropChange } = renderOverlay(null)
      // The right edge sits at 0.6 of 800px; +80px is +0.1 normalized.
      const next = dragHandle('right', { x: 480, y: 180 }, { x: 560, y: 180 }, onCropChange)
      expect(next).toBeDefined()
      expect(next?.x).toBeCloseTo(0.2, 6)
      expect(next?.y).toBeCloseTo(0.2, 6)
      expect(next?.width).toBeCloseTo(0.5, 6)
      expect(next?.height).toBeCloseTo(0.4, 6)
    })

    it('resizes free-form: a corner drag moves both axes independently', () => {
      const { onCropChange } = renderOverlay(null)
      // +80px across (0.1) and -45px down (-0.1) on a 450px tall picture.
      const next = dragHandle('bottom-right', { x: 480, y: 270 }, { x: 560, y: 225 }, onCropChange)
      expect(next?.width).toBeCloseTo(0.5, 6)
      expect(next?.height).toBeCloseTo(0.3, 6)
      expect(pixelAspect(next as CropRegion)).not.toBeCloseTo(1, 2)
    })

    it('never emits a crop that leaves the source', () => {
      const { onCropChange } = renderOverlay(null)
      const next = dragHandle(
        'bottom-right',
        { x: 480, y: 270 },
        { x: 4000, y: 4000 },
        onCropChange,
      )
      expect((next as CropRegion).x + (next as CropRegion).width).toBeLessThanOrEqual(1 + 1e-9)
      expect((next as CropRegion).y + (next as CropRegion).height).toBeLessThanOrEqual(1 + 1e-9)
    })
  })

  describe('locked', () => {
    it('snaps an edge drag to the locked ratio', () => {
      const { onCropChange } = renderOverlay(1)
      const next = dragHandle('right', { x: 480, y: 180 }, { x: 560, y: 180 }, onCropChange)
      expect(next?.width).toBeCloseTo(0.5, 6)
      expect(pixelAspect(next as CropRegion)).toBeCloseTo(1, 6)
    })

    it('keeps a portrait lock through a corner drag', () => {
      const { onCropChange } = renderOverlay(9 / 16)
      const next = dragHandle('bottom-right', { x: 480, y: 270 }, { x: 560, y: 360 }, onCropChange)
      expect(next?.x).toBeCloseTo(0.2, 6)
      expect(next?.y).toBeCloseTo(0.2, 6)
      expect(pixelAspect(next as CropRegion)).toBeCloseTo(9 / 16, 6)
    })

    it('uses the ratio captured at pointer-down for the whole drag', () => {
      const onCropChange = vi.fn()
      const { rerender } = render(
        <PreviewAspectCropOverlay
          cropRegion={BASE}
          onCropChange={onCropChange}
          sourceAspectRatio={SOURCE_ASPECT}
          lockAspectRatio={1}
          positionHint="drag to move"
        />,
      )
      const target = screen.getByTestId('crop-overlay-handle-right')
      fireEvent.pointerDown(target, { pointerId: 1, clientX: 480, clientY: 180 })
      // The lock is released mid-drag; the drag in flight keeps its ratio.
      rerender(
        <PreviewAspectCropOverlay
          cropRegion={BASE}
          onCropChange={onCropChange}
          sourceAspectRatio={SOURCE_ASPECT}
          lockAspectRatio={null}
          positionHint="drag to move"
        />,
      )
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 560, clientY: 180 })
      const next = onCropChange.mock.calls.at(-1)?.[0] as CropRegion
      expect(pixelAspect(next)).toBeCloseTo(1, 6)
    })
  })

  describe('move', () => {
    it('translates the crop without changing its shape, clamped to the source', () => {
      const { onCropChange } = renderOverlay(null)
      const frame = screen.getByTestId('crop-overlay-frame')
      fireEvent.pointerDown(frame, { pointerId: 2, clientX: 400, clientY: 225 })
      fireEvent.pointerMove(frame, { pointerId: 2, clientX: 480, clientY: 225 })
      const moved = onCropChange.mock.calls.at(-1)?.[0] as CropRegion
      expect(moved.x).toBeCloseTo(0.3, 6)
      expect(moved.y).toBeCloseTo(0.2, 6)
      expect(moved.width).toBeCloseTo(0.4, 6)
      expect(moved.height).toBeCloseTo(0.4, 6)

      fireEvent.pointerMove(frame, { pointerId: 2, clientX: 4000, clientY: 225 })
      const clamped = onCropChange.mock.calls.at(-1)?.[0] as CropRegion
      expect(clamped.x).toBeCloseTo(0.6, 6)
      expect(clamped.width).toBeCloseTo(0.4, 6)
    })

    it('ignores moves from a pointer that did not start the drag', () => {
      const { onCropChange } = renderOverlay(null)
      const frame = screen.getByTestId('crop-overlay-frame')
      fireEvent.pointerDown(frame, { pointerId: 2, clientX: 400, clientY: 225 })
      fireEvent.pointerMove(frame, { pointerId: 7, clientX: 480, clientY: 225 })
      expect(onCropChange).not.toHaveBeenCalled()
    })
  })
})
