import { useEffect, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import type { AnnotationRegion } from './types'
import { cn } from '@/lib/utils'
import { getTextAnimationState, textAnimationToCss } from '@/lib/annotationTextAnimation'
import { getNormalizedMosaicBlockSize, renderMosaicRegion } from '@/lib/blurEffects'
import { getArrowComponent } from './ArrowSvgs'
import { BLUR_REGIONS_ENABLED } from './featureFlags'

interface AnnotationOverlayProps {
  annotation: AnnotationRegion
  isSelected: boolean
  containerWidth: number
  containerHeight: number
  /** Source-time playhead in ms; drives the text entrance animation. */
  currentTimeMs?: number
  /**
   * Snapshot of the composited preview frame (same CSS size as the overlay
   * container, or scaled uniformly). Blur regions copy the pixels under their
   * box from it; other annotation kinds ignore it.
   */
  previewSourceCanvas?: HTMLCanvasElement | null
  /** Bumped whenever `previewSourceCanvas` holds a new frame so the mosaic is resampled. */
  previewFrameVersion?: number
  onPositionChange: (id: string, position: { x: number; y: number }) => void
  onSizeChange: (id: string, size: { width: number; height: number }) => void
  onClick: (id: string) => void
  zIndex: number
}

export function AnnotationOverlay({
  annotation,
  isSelected,
  containerWidth,
  containerHeight,
  currentTimeMs,
  previewSourceCanvas,
  previewFrameVersion,
  onPositionChange,
  onSizeChange,
  onClick,
  zIndex,
}: AnnotationOverlayProps) {
  const committedX = (annotation.position.x / 100) * containerWidth
  const committedY = (annotation.position.y / 100) * containerHeight
  const committedWidth = (annotation.size.width / 100) * containerWidth
  const committedHeight = (annotation.size.height / 100) * containerHeight

  const isDraggingRef = useRef(false)
  const isBlur = annotation.type === 'blur'
  const blurShape = annotation.blurData?.shape ?? 'rectangle'
  const mosaicCanvasRef = useRef<HTMLCanvasElement | null>(null)

  // Blur regions resample the frame while they are dragged/resized (Rnd only
  // commits on drop), so the live box is tracked separately from the props.
  const [liveRect, setLiveRect] = useState({
    x: committedX,
    y: committedY,
    width: committedWidth,
    height: committedHeight,
  })
  useEffect(() => {
    setLiveRect({
      x: committedX,
      y: committedY,
      width: committedWidth,
      height: committedHeight,
    })
  }, [committedX, committedY, committedWidth, committedHeight])

  const x = isBlur ? liveRect.x : committedX
  const y = isBlur ? liveRect.y : committedY
  const width = isBlur ? liveRect.width : committedWidth
  const height = isBlur ? liveRect.height : committedHeight

  const blurData = annotation.blurData
  useEffect(() => {
    if (!isBlur || !BLUR_REGIONS_ENABLED) return
    void previewFrameVersion

    const canvas = mosaicCanvasRef.current
    const source = previewSourceCanvas
    if (!canvas || !source || source.width <= 0 || source.height <= 0) return
    if (containerWidth <= 0 || containerHeight <= 0) return

    const drawWidth = Math.max(1, Math.round(width))
    const drawHeight = Math.max(1, Math.round(height))
    canvas.width = drawWidth
    canvas.height = drawHeight

    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return

    // The snapshot may be a scaled copy of the overlay box (device pixel ratio).
    const scaleX = source.width / containerWidth
    const scaleY = source.height / containerHeight
    const sourceX = Math.max(0, Math.min(source.width - 1, Math.round(x * scaleX)))
    const sourceY = Math.max(0, Math.min(source.height - 1, Math.round(y * scaleY)))
    const sourceWidth = Math.max(
      1,
      Math.min(source.width - sourceX, Math.round(drawWidth * scaleX)),
    )
    const sourceHeight = Math.max(
      1,
      Math.min(source.height - sourceY, Math.round(drawHeight * scaleY)),
    )

    context.clearRect(0, 0, drawWidth, drawHeight)
    context.imageSmoothingEnabled = true
    context.drawImage(
      source,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      drawWidth,
      drawHeight,
    )

    const imageData = context.getImageData(0, 0, drawWidth, drawHeight)
    renderMosaicRegion(imageData, blurData, getNormalizedMosaicBlockSize(blurData))
    context.putImageData(imageData, 0, 0)
  }, [
    isBlur,
    blurData,
    containerWidth,
    containerHeight,
    height,
    previewFrameVersion,
    previewSourceCanvas,
    width,
    x,
    y,
  ])

  const renderArrow = () => {
    const direction = annotation.figureData?.arrowDirection || 'right'
    const color = annotation.figureData?.color || '#34B27B'
    const strokeWidth = annotation.figureData?.strokeWidth || 4

    const ArrowComponent = getArrowComponent(direction)
    return <ArrowComponent color={color} strokeWidth={strokeWidth} />
  }

  const renderContent = () => {
    switch (annotation.type) {
      case 'text': {
        // When no playhead is supplied (static previews) the animation is
        // evaluated at its end state.
        const animationCss = textAnimationToCss(
          getTextAnimationState(annotation, currentTimeMs ?? Number.POSITIVE_INFINITY),
        )
        return (
          <div
            className="w-full h-full flex items-center p-2 overflow-hidden"
            style={{
              justifyContent:
                annotation.style.textAlign === 'left'
                  ? 'flex-start'
                  : annotation.style.textAlign === 'right'
                    ? 'flex-end'
                    : 'center',
              alignItems: 'center',
            }}
          >
            <span
              style={{
                color: annotation.style.color,
                backgroundColor: annotation.style.backgroundColor,
                fontSize: `${annotation.style.fontSize}px`,
                fontFamily: annotation.style.fontFamily,
                fontWeight: annotation.style.fontWeight,
                fontStyle: annotation.style.fontStyle,
                textDecoration: annotation.style.textDecoration,
                textAlign: annotation.style.textAlign,
                opacity: animationCss.opacity,
                transform: animationCss.transform,
                transformOrigin: animationCss.transformOrigin,
                clipPath: animationCss.clipPath,
                WebkitClipPath: animationCss.clipPath,
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
                padding: '0.1em 0.2em',
                borderRadius: '4px',
                lineHeight: '1.4',
              }}
            >
              {annotation.content}
            </span>
          </div>
        )
      }

      case 'image':
        if (annotation.content && annotation.content.startsWith('data:image')) {
          return (
            <img
              src={annotation.content}
              alt="Annotation"
              className="w-full h-full object-contain"
              draggable={false}
            />
          )
        }
        return (
          <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
            No image
          </div>
        )

      case 'figure':
        if (!annotation.figureData) {
          return (
            <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
              No arrow data
            </div>
          )
        }

        return (
          <div className="w-full h-full flex items-center justify-center p-2">{renderArrow()}</div>
        )

      case 'blur':
        if (!BLUR_REGIONS_ENABLED) return null
        return (
          <div
            className="w-full h-full relative overflow-hidden"
            data-testid="blur-region"
            style={{
              // The pixel routine already keeps the frame outside the ellipse,
              // but clipping keeps the selection tint and any DPR seam inside it too.
              clipPath: blurShape === 'oval' ? 'ellipse(50% 50% at 50% 50%)' : undefined,
              WebkitClipPath: blurShape === 'oval' ? 'ellipse(50% 50% at 50% 50%)' : undefined,
            }}
          >
            <canvas
              ref={mosaicCanvasRef}
              className="absolute inset-0 w-full h-full"
              style={{ imageRendering: 'pixelated' }}
            />
            {!previewSourceCanvas && (
              <div
                className="absolute inset-0"
                style={{
                  backgroundColor:
                    annotation.blurData?.color === 'black'
                      ? 'rgba(0, 0, 0, 0.55)'
                      : 'rgba(255, 255, 255, 0.35)',
                }}
              />
            )}
          </div>
        )

      default:
        return null
    }
  }

  if (isBlur && !BLUR_REGIONS_ENABLED) return null

  return (
    <Rnd
      position={{ x: committedX, y: committedY }}
      size={{ width: committedWidth, height: committedHeight }}
      onDragStart={() => {
        isDraggingRef.current = true
      }}
      onDrag={(_e, d) => {
        if (!isBlur) return
        setLiveRect((prev) => ({ ...prev, x: d.x, y: d.y }))
      }}
      onDragStop={(_e, d) => {
        const xPercent = (d.x / containerWidth) * 100
        const yPercent = (d.y / containerHeight) * 100
        onPositionChange(annotation.id, { x: xPercent, y: yPercent })

        // Reset dragging flag after a short delay to prevent click event
        setTimeout(() => {
          isDraggingRef.current = false
        }, 100)
      }}
      onResize={(_e, _direction, ref, _delta, position) => {
        if (!isBlur) return
        setLiveRect({
          x: position.x,
          y: position.y,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        })
      }}
      onResizeStop={(_e, _direction, ref, _delta, position) => {
        const xPercent = (position.x / containerWidth) * 100
        const yPercent = (position.y / containerHeight) * 100
        const widthPercent = (ref.offsetWidth / containerWidth) * 100
        const heightPercent = (ref.offsetHeight / containerHeight) * 100
        onPositionChange(annotation.id, { x: xPercent, y: yPercent })
        onSizeChange(annotation.id, { width: widthPercent, height: heightPercent })
      }}
      onClick={() => {
        if (isDraggingRef.current) return
        onClick(annotation.id)
      }}
      bounds="parent"
      className={cn(
        'cursor-move transition-all',
        isSelected && 'ring-2 ring-[#34B27B] ring-offset-2 ring-offset-transparent',
      )}
      style={{
        zIndex,
        pointerEvents: isSelected ? 'auto' : 'none',
        border: isSelected ? '2px solid rgba(52, 178, 123, 0.8)' : 'none',
        backgroundColor: isSelected && !isBlur ? 'rgba(52, 178, 123, 0.1)' : 'transparent',
        boxShadow: isSelected ? '0 0 0 1px rgba(52, 178, 123, 0.35)' : 'none',
      }}
      enableResizing={isSelected}
      disableDragging={!isSelected}
      resizeHandleStyles={{
        topLeft: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          left: '-6px',
          top: '-6px',
          cursor: 'nwse-resize',
        },
        topRight: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          right: '-6px',
          top: '-6px',
          cursor: 'nesw-resize',
        },
        bottomLeft: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          left: '-6px',
          bottom: '-6px',
          cursor: 'nesw-resize',
        },
        bottomRight: {
          width: '12px',
          height: '12px',
          backgroundColor: isSelected ? 'white' : 'transparent',
          border: isSelected ? '2px solid #34B27B' : 'none',
          borderRadius: '50%',
          right: '-6px',
          bottom: '-6px',
          cursor: 'nwse-resize',
        },
      }}
    >
      <div
        className={cn(
          'w-full h-full',
          !isBlur && 'rounded-lg',
          annotation.type === 'text' && 'bg-transparent',
          annotation.type === 'image' && 'bg-transparent',
          annotation.type === 'figure' && 'bg-transparent',
          annotation.type === 'blur' && 'bg-transparent',
          isSelected && !isBlur && 'shadow-lg',
        )}
      >
        {renderContent()}
      </div>
    </Rnd>
  )
}
