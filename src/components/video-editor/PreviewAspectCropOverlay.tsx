import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CropRegion } from './types'
import { CROP_RESIZE_HANDLES, type CropResizeHandle, resizeCropRegion } from '@/lib/crop/aspectCrop'

interface PreviewAspectCropOverlayProps {
  cropRegion: CropRegion
  onCropChange: (next: CropRegion) => void
  sourceAspectRatio: number
  /** Output pixel aspect a resize must keep, or null to resize free-form. */
  lockAspectRatio: number | null
  positionHint: string
}

type DragState =
  | {
      mode: 'move'
      pointerId: number
      offsetX: number
      offsetY: number
      width: number
      height: number
    }
  | {
      mode: 'resize'
      pointerId: number
      handle: CropResizeHandle
      startX: number
      startY: number
      origin: CropRegion
      // Captured once per drag so a 'free' lock keeps the shape the drag started with.
      lockRatio: number | null
    }
  | null

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

type PixelRect = { x: number; y: number; width: number; height: number }

function resolveContentRect(bounds: PixelRect, sourceAspectRatio: number): PixelRect {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0, width: 0, height: 0 }
  const safeSourceAspect =
    Number.isFinite(sourceAspectRatio) && sourceAspectRatio > 0 ? sourceAspectRatio : 16 / 9
  const containerAspect = bounds.width / bounds.height

  if (containerAspect > safeSourceAspect) {
    const height = bounds.height
    const width = height * safeSourceAspect
    return {
      x: (bounds.width - width) / 2,
      y: 0,
      width,
      height,
    }
  }

  const width = bounds.width
  const height = width / safeSourceAspect
  return {
    x: 0,
    y: (bounds.height - height) / 2,
    width,
    height,
  }
}

const HANDLE_STYLE: Record<CropResizeHandle, { className: string; cursor: string }> = {
  'top-left': { className: '-left-1.5 -top-1.5 h-3 w-3', cursor: 'cursor-nwse-resize' },
  top: { className: 'left-1/2 -top-1 h-2 w-5 -translate-x-1/2', cursor: 'cursor-ns-resize' },
  'top-right': { className: '-right-1.5 -top-1.5 h-3 w-3', cursor: 'cursor-nesw-resize' },
  right: { className: '-right-1 top-1/2 h-5 w-2 -translate-y-1/2', cursor: 'cursor-ew-resize' },
  'bottom-right': { className: '-right-1.5 -bottom-1.5 h-3 w-3', cursor: 'cursor-nwse-resize' },
  bottom: { className: 'left-1/2 -bottom-1 h-2 w-5 -translate-x-1/2', cursor: 'cursor-ns-resize' },
  'bottom-left': { className: '-left-1.5 -bottom-1.5 h-3 w-3', cursor: 'cursor-nesw-resize' },
  left: { className: '-left-1 top-1/2 h-5 w-2 -translate-y-1/2', cursor: 'cursor-ew-resize' },
}

export function PreviewAspectCropOverlay({
  cropRegion,
  onCropChange,
  sourceAspectRatio,
  lockAspectRatio,
  positionHint,
}: PreviewAspectCropOverlayProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [dragState, setDragState] = useState<DragState>(null)
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = overlayRef.current
    if (!element) return

    const updateSize = () => {
      setOverlaySize({ width: element.clientWidth, height: element.clientHeight })
    }

    updateSize()
    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const containerRect = useMemo<PixelRect>(
    () => ({
      x: 0,
      y: 0,
      width: overlaySize.width,
      height: overlaySize.height,
    }),
    [overlaySize.height, overlaySize.width],
  )

  const contentRect = useMemo(
    () => resolveContentRect(containerRect, sourceAspectRatio),
    [containerRect, sourceAspectRatio],
  )

  const frameRect = useMemo(
    () => ({
      left: contentRect.x + cropRegion.x * contentRect.width,
      top: contentRect.y + cropRegion.y * contentRect.height,
      width: cropRegion.width * contentRect.width,
      height: cropRegion.height * contentRect.height,
    }),
    [
      contentRect.height,
      contentRect.width,
      contentRect.x,
      contentRect.y,
      cropRegion.height,
      cropRegion.width,
      cropRegion.x,
      cropRegion.y,
    ],
  )

  // Pointer position in normalized source coordinates. Unclamped so a resize
  // delta keeps its sign outside the picture; `resizeCropRegion` bounds it.
  const pointToNormalized = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = overlayRef.current?.getBoundingClientRect()
    if (!rect || contentRect.width <= 0 || contentRect.height <= 0) return null

    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top

    return {
      x: (localX - contentRect.x) / contentRect.width,
      y: (localY - contentRect.y) / contentRect.height,
    }
  }

  const handleMoveStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const point = pointToNormalized(event)
    if (!point) return

    setDragState({
      mode: 'move',
      pointerId: event.pointerId,
      offsetX: clamp(point.x, 0, 1) - cropRegion.x,
      offsetY: clamp(point.y, 0, 1) - cropRegion.y,
      width: cropRegion.width,
      height: cropRegion.height,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleResizeStart = (
    event: React.PointerEvent<HTMLDivElement>,
    handle: CropResizeHandle,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const point = pointToNormalized(event)
    if (!point) return
    setDragState({
      mode: 'resize',
      pointerId: event.pointerId,
      handle,
      startX: point.x,
      startY: point.y,
      origin: cropRegion,
      lockRatio: lockAspectRatio,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return
    const point = pointToNormalized(event)
    if (!point) return

    if (dragState.mode === 'move') {
      const nextX = clamp(clamp(point.x, 0, 1) - dragState.offsetX, 0, 1 - dragState.width)
      const nextY = clamp(clamp(point.y, 0, 1) - dragState.offsetY, 0, 1 - dragState.height)
      onCropChange({
        x: nextX,
        y: nextY,
        width: dragState.width,
        height: dragState.height,
      })
      return
    }

    onCropChange(
      resizeCropRegion(
        dragState.origin,
        dragState.handle,
        { dx: point.x - dragState.startX, dy: point.y - dragState.startY },
        { lockRatio: dragState.lockRatio, sourceAspect: sourceAspectRatio },
      ),
    )
  }

  const handlePointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return
    setDragState(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // no-op
    }
  }

  // The root always renders: it carries the ref the size effect measures, so
  // returning null before the first measurement would leave nothing to measure
  // and the overlay would never appear. Only the mask and frame wait for a size.
  const hasContentRect = contentRect.width > 0 && contentRect.height > 0

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-40 touch-none"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onPointerLeave={handlePointerEnd}
    >
      {hasContentRect ? (
        <>
          <div
            className="absolute bg-black/45 pointer-events-none"
            style={{
              left: contentRect.x,
              top: contentRect.y,
              width: contentRect.width,
              height: Math.max(0, frameRect.top - contentRect.y),
            }}
          />
          <div
            className="absolute bg-black/45 pointer-events-none"
            style={{
              left: contentRect.x,
              top: frameRect.top + frameRect.height,
              width: contentRect.width,
              height: Math.max(
                0,
                contentRect.y + contentRect.height - (frameRect.top + frameRect.height),
              ),
            }}
          />
          <div
            className="absolute bg-black/45 pointer-events-none"
            style={{
              left: contentRect.x,
              top: frameRect.top,
              width: Math.max(0, frameRect.left - contentRect.x),
              height: frameRect.height,
            }}
          />
          <div
            className="absolute bg-black/45 pointer-events-none"
            style={{
              left: frameRect.left + frameRect.width,
              top: frameRect.top,
              width: Math.max(
                0,
                contentRect.x + contentRect.width - (frameRect.left + frameRect.width),
              ),
              height: frameRect.height,
            }}
          />

          <div
            className="absolute border-2 border-[#34B27B] rounded-sm cursor-move shadow-[0_0_0_1px_rgba(52,178,123,0.35)]"
            style={{
              left: frameRect.left,
              top: frameRect.top,
              width: frameRect.width,
              height: frameRect.height,
            }}
            onPointerDown={handleMoveStart}
            data-testid="crop-overlay-frame"
            data-locked={lockAspectRatio !== null ? 'true' : 'false'}
          >
            <div className="absolute -top-6 left-0 rounded bg-black/75 px-2 py-0.5 text-[10px] text-slate-200 pointer-events-none whitespace-nowrap">
              {positionHint}
            </div>
            {CROP_RESIZE_HANDLES.map((handle) => (
              <div
                key={handle}
                className={`absolute rounded border border-white/80 bg-[#34B27B] ${HANDLE_STYLE[handle].className} ${HANDLE_STYLE[handle].cursor}`}
                onPointerDown={(event) => handleResizeStart(event, handle)}
                data-testid={`crop-overlay-handle-${handle}`}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}
