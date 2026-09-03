import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { TimelineContext, useTimelineContext } from 'dnd-timeline'
import type {
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
  Range,
  ResizeEndEvent,
  ResizeMoveEvent,
  Span,
} from 'dnd-timeline'
import {
  clampSpanToBounds as clampSpanToBoundsPure,
  clampToNeighbours as clampToNeighboursPure,
  collectSnapTargets,
  computeSnapThresholdMs,
  formatTooltipMs,
  type IdentifiedSpan,
  inferResizeMode as inferResizeModePure,
  type SnapMode,
  snapSpanToTargets as snapSpanToTargetsPure,
} from './snapping'

interface TimelineWrapperProps {
  children: ReactNode
  range: Range
  videoDuration: number
  hasOverlap: (newSpan: Span, excludeId?: string) => boolean
  onRangeChange: Dispatch<SetStateAction<Range>>
  minItemDurationMs: number
  minVisibleRangeMs: number
  gridSizeMs: number
  onItemSpanChange: (id: string, span: Span) => void
  /** Hard overlap constraints (zoom regions); used by clampToNeighbours and as snap targets. */
  allRegionSpans?: IdentifiedSpan[]
  /** Snap targets only (annotations); never push other items during overlap resolution. */
  softSnapSpans?: IdentifiedSpan[]
  /** Effective playhead position. */
  currentTimeMs?: number
  keyframeTimesMs?: number[]
  /** Extra snap points (Capturia: segment boundaries / split lines, effective time). */
  extraSnapTimesMs?: number[]
}

interface SnapGuideHandle {
  showAt: (timeMs: number) => void
  hide: () => void
}

// Lives inside TimelineContext to read valueToPixels. Updates the DOM directly via
// an imperative handle (like the drag tooltip) to avoid re-rendering on every pointer move.
const SnapGuide = forwardRef<SnapGuideHandle>((_, ref) => {
  const { sidebarWidth, direction, range, valueToPixels } = useTimelineContext()
  const elRef = useRef<HTMLDivElement>(null)
  const sideProperty = direction === 'rtl' ? 'right' : 'left'

  useImperativeHandle(
    ref,
    () => ({
      showAt(timeMs: number) {
        const el = elRef.current
        if (!el) return
        const offset = valueToPixels(timeMs - range.start) + sidebarWidth
        el.style[sideProperty] = `${offset}px`
        el.style.opacity = '1'
      },
      hide() {
        const el = elRef.current
        if (!el) return
        el.style.opacity = '0'
      },
    }),
    [range.start, sidebarWidth, sideProperty, valueToPixels],
  )

  return (
    <div
      ref={elRef}
      className="absolute top-0 bottom-0 w-[2px] bg-[#fbbf24] shadow-[0_0_10px_rgba(251,191,36,0.85),0_0_2px_rgba(251,191,36,1)] pointer-events-none z-[55]"
      style={{ opacity: 0, transition: 'opacity 0.08s' }}
    >
      <div
        className="absolute -top-[1px] left-1/2 -translate-x-1/2 w-0 h-0"
        style={{
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderTop: '6px solid #fbbf24',
        }}
      />
      <div
        className="absolute -bottom-[1px] left-1/2 -translate-x-1/2 w-0 h-0"
        style={{
          borderLeft: '4px solid transparent',
          borderRight: '4px solid transparent',
          borderBottom: '6px solid #fbbf24',
        }}
      />
    </div>
  )
})
SnapGuide.displayName = 'SnapGuide'

function screenXFromEvent(event: DragMoveEvent | ResizeMoveEvent): number | undefined {
  return event.activatorEvent && 'clientX' in event.activatorEvent
    ? (event.activatorEvent as PointerEvent).clientX + (event.delta?.x ?? 0)
    : undefined
}

const EMPTY_SPANS: IdentifiedSpan[] = []
const EMPTY_TIMES: number[] = []

export default function TimelineWrapper({
  children,
  range,
  videoDuration,
  hasOverlap,
  onRangeChange,
  minItemDurationMs,
  minVisibleRangeMs,
  gridSizeMs: _gridSizeMs,
  onItemSpanChange,
  allRegionSpans = EMPTY_SPANS,
  softSnapSpans = EMPTY_SPANS,
  currentTimeMs,
  keyframeTimesMs = EMPTY_TIMES,
  extraSnapTimesMs = EMPTY_TIMES,
}: TimelineWrapperProps) {
  const totalMs = Math.max(0, Math.round(videoDuration * 1000))

  const clampSpanToBounds = useCallback(
    (span: Span): Span => clampSpanToBoundsPure(span, totalMs, minItemDurationMs),
    [minItemDurationMs, totalMs],
  )

  const clampRange = useCallback(
    (candidate: Range): Range => {
      if (totalMs === 0) {
        const minSpan = Math.max(minVisibleRangeMs, 1)
        const span = Math.max(candidate.end - candidate.start, minSpan)
        const start = Math.max(0, Math.min(candidate.start, candidate.end - span))
        return { start, end: start + span }
      }

      const rawStart = Math.max(0, candidate.start)
      const rawEnd = candidate.end
      const clampedEnd = Math.min(rawEnd, totalMs)

      const minSpan = Math.min(Math.max(minVisibleRangeMs, 1), totalMs)
      const desiredSpan = clampedEnd - rawStart
      const span = Math.min(Math.max(desiredSpan, minSpan), totalMs)

      let finalStart = rawStart
      let finalEnd = finalStart + span

      if (finalEnd > totalMs) {
        finalEnd = totalMs
        finalStart = Math.max(0, finalEnd - span)
      }

      return { start: finalStart, end: finalEnd }
    },
    [minVisibleRangeMs, totalMs],
  )

  // When a span overlaps neighbours, clamp it to the nearest boundary instead of rejecting.
  const clampToNeighbours = useCallback(
    (span: Span, activeItemId: string): Span =>
      clampToNeighboursPure(span, allRegionSpans, activeItemId, minItemDurationMs, totalMs),
    [allRegionSpans, minItemDurationMs, totalMs],
  )

  const snapGuideRef = useRef<SnapGuideHandle>(null)

  // Pull the active span's edges to nearby region boundaries, segment boundaries, timeline
  // bounds, playhead and keyframes. Threshold scales with zoom (~1% of visible range, min 50ms).
  const snapSpanToTargets = useCallback(
    (
      span: Span,
      activeItemId: string,
      mode: SnapMode,
    ): { span: Span; snapPoint: number | null } => {
      if (totalMs === 0) return { span, snapPoint: null }
      const thresholdMs = computeSnapThresholdMs(range.end - range.start)
      const targets = collectSnapTargets({
        totalMs,
        allRegionSpans,
        softSnapSpans,
        activeItemId,
        currentTimeMs,
        keyframeTimesMs,
        extraTimesMs: extraSnapTimesMs,
      })
      return snapSpanToTargetsPure(span, targets, mode, thresholdMs, minItemDurationMs)
    },
    [
      allRegionSpans,
      softSnapSpans,
      currentTimeMs,
      keyframeTimesMs,
      extraSnapTimesMs,
      minItemDurationMs,
      range.end,
      range.start,
      totalMs,
    ],
  )

  // dnd-timeline's resize event doesn't expose direction, so compare the live span to
  // the committed one (committed only updates on commit, so it's the pre-resize state).
  const inferResizeMode = useCallback(
    (activeItemId: string, span: Span) => {
      const committed =
        allRegionSpans.find((r) => r.id === activeItemId) ??
        softSnapSpans.find((r) => r.id === activeItemId)
      return inferResizeModePure(committed, span)
    },
    [allRegionSpans, softSnapSpans],
  )

  const updateSnapGuide = useCallback(
    (snapPoint: number | null) => {
      if (snapPoint === null) {
        snapGuideRef.current?.hide()
        return
      }
      // Hide the amber guide when it would coincide with the green playhead.
      if (currentTimeMs !== undefined && Math.abs(snapPoint - currentTimeMs) < 1) {
        snapGuideRef.current?.hide()
        return
      }
      snapGuideRef.current?.showAt(snapPoint)
    },
    [currentTimeMs],
  )

  const onResizeEnd = useCallback(
    (event: ResizeEndEvent) => {
      const updatedSpan = event.active.data.current.getSpanFromResizeEvent?.(event)
      if (!updatedSpan) return

      const activeItemId = event.active.id as string
      let clampedSpan = clampSpanToBounds(updatedSpan)

      const mode = inferResizeMode(activeItemId, clampedSpan)
      if (mode !== null) {
        clampedSpan = snapSpanToTargets(clampedSpan, activeItemId, mode).span
      }

      if (
        clampedSpan.end - clampedSpan.start <
        Math.min(minItemDurationMs, totalMs || minItemDurationMs)
      ) {
        return
      }

      if (hasOverlap(clampedSpan, activeItemId)) {
        clampedSpan = clampToNeighbours(clampedSpan, activeItemId)
        // Still overlapping after clamping: keep the original position
        if (hasOverlap(clampedSpan, activeItemId)) {
          return
        }
      }

      onItemSpanChange(activeItemId, clampedSpan)
    },
    [
      clampSpanToBounds,
      clampToNeighbours,
      hasOverlap,
      inferResizeMode,
      minItemDurationMs,
      onItemSpanChange,
      snapSpanToTargets,
      totalMs,
    ],
  )

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeRowId = event.over?.id as string
      const updatedSpan = event.active.data.current.getSpanFromDragEvent?.(event)
      if (!updatedSpan || !activeRowId) return

      const activeItemId = event.active.id as string
      let clampedSpan = clampSpanToBounds(updatedSpan)

      clampedSpan = snapSpanToTargets(clampedSpan, activeItemId, 'drag').span

      if (hasOverlap(clampedSpan, activeItemId)) {
        clampedSpan = clampToNeighbours(clampedSpan, activeItemId)
        if (hasOverlap(clampedSpan, activeItemId)) {
          return
        }
      }

      onItemSpanChange(activeItemId, clampedSpan)
    },
    [clampSpanToBounds, clampToNeighbours, hasOverlap, onItemSpanChange, snapSpanToTargets],
  )

  // Drag/resize tooltip (direct DOM updates, no re-renders)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const showTooltip = useCallback((span: Span | null, screenX?: number) => {
    const el = tooltipRef.current
    if (!el) return
    if (!span) {
      el.style.opacity = '0'
      return
    }
    el.textContent = `${formatTooltipMs(span.start)} – ${formatTooltipMs(span.end)}`
    el.style.opacity = '1'
    if (screenX !== undefined) {
      const parent = el.parentElement
      if (parent) {
        const rect = parent.getBoundingClientRect()
        const x = Math.max(0, Math.min(screenX - rect.left, rect.width - 100))
        el.style.left = `${x}px`
      }
    }
  }, [])

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const span = event.active.data.current.getSpanFromDragEvent?.(event)
      if (span) showTooltip(span)
    },
    [showTooltip],
  )

  const onDragMove = useCallback(
    (event: DragMoveEvent) => {
      const rawSpan = event.active.data.current.getSpanFromDragEvent?.(event)
      if (!rawSpan) return
      const activeItemId = event.active.id as string
      const clamped = totalMs > 0 ? clampSpanToBounds(rawSpan) : rawSpan
      const { span, snapPoint } = snapSpanToTargets(clamped, activeItemId, 'drag')
      updateSnapGuide(snapPoint)
      showTooltip(span, screenXFromEvent(event))
    },
    [clampSpanToBounds, showTooltip, snapSpanToTargets, totalMs, updateSnapGuide],
  )

  const onResizeMove = useCallback(
    (event: ResizeMoveEvent) => {
      const rawSpan = event.active.data.current.getSpanFromResizeEvent?.(event)
      if (!rawSpan) return
      const activeItemId = event.active.id as string
      const clamped = totalMs > 0 ? clampSpanToBounds(rawSpan) : rawSpan
      const mode = inferResizeMode(activeItemId, clamped)
      const { span, snapPoint } =
        mode !== null
          ? snapSpanToTargets(clamped, activeItemId, mode)
          : { span: clamped, snapPoint: null }
      updateSnapGuide(snapPoint)
      showTooltip(span, screenXFromEvent(event))
    },
    [clampSpanToBounds, inferResizeMode, showTooltip, snapSpanToTargets, totalMs, updateSnapGuide],
  )

  const hideOverlays = useCallback(() => {
    showTooltip(null)
    snapGuideRef.current?.hide()
  }, [showTooltip])

  const onResizeEndWithOverlays = useCallback(
    (event: ResizeEndEvent) => {
      hideOverlays()
      onResizeEnd(event)
    },
    [hideOverlays, onResizeEnd],
  )

  const onDragEndWithOverlays = useCallback(
    (event: DragEndEvent) => {
      hideOverlays()
      onDragEnd(event)
    },
    [hideOverlays, onDragEnd],
  )

  // Escape during a drag or resize: dnd-kit fires cancel instead of end, so
  // without this the snap guide and the tooltip stay painted over the timeline
  // until the next drag happens to hide them. Nothing is committed — the item
  // keeps the span it had before the drag.
  const onDragCancel = useCallback(() => {
    hideOverlays()
  }, [hideOverlays])

  const handleRangeChange = useCallback(
    (updater: (previous: Range) => Range) => {
      onRangeChange((prev) => {
        const normalized = totalMs > 0 ? clampRange(prev) : prev
        const desired = updater(normalized)

        if (totalMs > 0) {
          const clamped = clampRange(desired)

          if (clamped.end > totalMs) {
            const span = Math.min(clamped.end - clamped.start, totalMs)
            return {
              start: Math.max(0, totalMs - span),
              end: totalMs,
            }
          }

          return clamped
        }

        return desired
      })
    },
    [clampRange, onRangeChange, totalMs],
  )

  return (
    <TimelineContext
      range={range}
      onRangeChanged={handleRangeChange}
      onResizeEnd={onResizeEndWithOverlays}
      onResizeMove={onResizeMove}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEndWithOverlays}
      onDragCancel={onDragCancel}
      autoScroll={{ enabled: false }}
    >
      <div className="relative">
        {children}
        <SnapGuide ref={snapGuideRef} />
        {/* Floating tooltip shown during drag/resize */}
        <div
          ref={tooltipRef}
          className="absolute top-1 pointer-events-none z-[60] px-1.5 py-0.5 rounded bg-black/80 text-[10px] text-white/90 font-medium tabular-nums whitespace-nowrap border border-white/10 shadow-lg"
          style={{ opacity: 0, transition: 'opacity 0.1s' }}
        />
      </div>
    </TimelineContext>
  )
}
