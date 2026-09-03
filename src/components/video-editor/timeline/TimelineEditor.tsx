import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTimelineContext } from 'dnd-timeline'
import { Button } from '@/components/ui/button'
import {
  Plus,
  Scissors,
  ZoomIn,
  MessageSquare,
  ChevronDown,
  Check,
  EyeOff,
  MoreHorizontal,
  RotateCcw,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { findFreeGapAt } from '../regionPlacement'
import { cn } from '@/lib/utils'
import TimelineWrapper from './TimelineWrapper'
import Row from './Row'
import Item from './Item'
import KeyframeMarkers from './KeyframeMarkers'
import RecordingMarkers from './RecordingMarkers'
import type { Range, Span } from 'dnd-timeline'
import type {
  ZoomDepth,
  ZoomRegion,
  TrimRegion,
  VideoSegment,
  AnnotationRegion,
  AudioEditRegion,
} from '../types'
import { getZoomScale } from '../types'
import type { SubtitleCue } from '@/lib/analysis/types'
import { sourceToEffectiveMsWithSegments } from '@/lib/trim/timeMapping'
import {
  clampVisibleRange,
  normaliseSpansToDuration,
  normaliseWheelDeltaPx,
  spansIntersect,
} from './snapping'
import { shouldStartTimelineScrub, TIMELINE_SCRUB_OPT_OUT_ATTR } from './timelineScrub'
import { v4 as uuidv4 } from 'uuid'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { type AspectRatio, getAspectRatioLabel, ASPECT_RATIOS } from '@/utils/aspectRatioUtils'
import { formatShortcut } from '@/utils/platformUtils'
import { useShortcuts } from '@/contexts/ShortcutsContext'
import {
  formatBinding,
  isTextEditingTarget,
  matchesShortcut,
  ZOOM_DEPTH_SHORTCUT_KEYS,
} from '@/lib/shortcuts'
import { isModalDialogOpen } from '@/lib/modalDialog'
import { getSelectionCycleAnnotations } from '@/lib/annotations/renderOrder'
import { BLUR_REGIONS_ENABLED } from '../featureFlags'
import { useAudioPeaks } from '@/hooks/useAudioPeaks'
import BackgroundWaveform from './BackgroundWaveform'
import { TutorialHelp } from '../TutorialHelp'
import { useI18n } from '@/i18n'

const ZOOM_ROW_ID = 'row-zoom'
const TRIM_ROW_ID = 'row-trim'
const ANNOTATION_ROW_ID = 'row-annotation'
const BLUR_ROW_ID = 'row-blur'
const SUBTITLE_ROW_ID = 'row-subtitle'
const AUDIO_ROW_ID = 'row-audio'
const FALLBACK_RANGE_MS = 1000
const TARGET_MARKER_COUNT = 12

interface TimelineEditorProps {
  videoDuration: number
  currentTime: number
  onSeek?: (time: number) => void
  zoomRegions: ZoomRegion[]
  onZoomAdded: (span: Span) => void
  onZoomSpanChange: (id: string, span: Span) => void
  onZoomDelete: (id: string) => void
  /** Number keys 1-6 set the selected zoom's depth; omitted disables the shortcut. */
  onZoomDepthChange?: (depth: ZoomDepth) => void
  selectedZoomId: string | null
  onSelectZoom: (id: string | null) => void
  segments?: VideoSegment[]
  onSplitAtTime?: (effectiveMs: number) => void
  /** Restore one full-length segment at speed 1; omitted hides the action. */
  onResetAllSegmentEdits?: () => void
  onDeleteSegment?: () => void
  selectedSegmentId?: string | null
  onSelectSegment?: (id: string | null) => void
  annotationRegions?: AnnotationRegion[]
  onAnnotationAdded?: (span: Span) => void
  /** Blur regions live in `annotationRegions` (type 'blur') and get their own row. */
  onBlurAdded?: (span: Span) => void
  onAnnotationSpanChange?: (id: string, span: Span) => void
  onAnnotationDelete?: (id: string) => void
  selectedAnnotationId?: string | null
  onSelectAnnotation?: (id: string | null) => void
  subtitleCues?: SubtitleCue[]
  aspectRatio: AspectRatio
  onAspectRatioChange: (aspectRatio: AspectRatio) => void
  hasAudioTrack?: boolean
  audioEnabled?: boolean
  audioGain?: number
  audioEditRegions?: AudioEditRegion[]
  /** Refit an audio edit to a shortened timeline (same effective-time contract as the annotation handlers). */
  onAudioEditSpanChange?: (id: string, span: Span) => void
  onAudioEditDelete?: (id: string) => void
  onHoverPreview?: (effectiveMs: number | null) => void
  onHoverCommit?: () => void
  isPlaying?: boolean
  onVisibleRangeChange?: (info: {
    visibleMs: number
    totalMs: number
    minVisibleMs: number
  }) => void
  zoomStepRef?: React.MutableRefObject<((direction: 1 | -1) => void) | null>
  zoomSetRef?: React.MutableRefObject<((visibleMs: number) => void) | null>
  /** Raw path of the loaded video (read through the approved-file IPC for the waveform). */
  videoFilePath?: string | null
  /** `local-media://` URL of the loaded video (fetch fallback for the waveform). */
  videoUrl?: string | null
  /** Draw the audio waveform behind the AUDIO row. */
  showWaveform?: boolean
  /**
   * D2: moments flagged during the recording, already in effective (timeline)
   * ms. Read-only: they are drawn on the ruler and seek on click.
   */
  recordingMarkersMs?: number[]
}

interface RowHints {
  zoom: string
  annotation: string
  blur: string
  subtitle: string
}

interface TimelineScaleConfig {
  intervalMs: number
  gridMs: number
  minItemDurationMs: number
  defaultItemDurationMs: number
  minVisibleRangeMs: number
}

interface TimelineRenderItem {
  id: string
  rowId: string
  span: Span
  label: string
  zoomDepth?: number
  zoomScale?: number
  zoomAutoFocus?: boolean
  variant: 'zoom' | 'trim' | 'annotation' | 'blur' | 'subtitle' | 'audio-edit'
}

const SCALE_CANDIDATES = [
  { intervalSeconds: 0.001, gridSeconds: 0.001 },
  { intervalSeconds: 0.002, gridSeconds: 0.001 },
  { intervalSeconds: 0.005, gridSeconds: 0.001 },
  { intervalSeconds: 0.01, gridSeconds: 0.002 },
  { intervalSeconds: 0.02, gridSeconds: 0.005 },
  { intervalSeconds: 0.05, gridSeconds: 0.01 },
  { intervalSeconds: 0.1, gridSeconds: 0.02 },
  { intervalSeconds: 0.25, gridSeconds: 0.05 },
  { intervalSeconds: 0.5, gridSeconds: 0.1 },
  { intervalSeconds: 1, gridSeconds: 0.25 },
  { intervalSeconds: 2, gridSeconds: 0.5 },
  { intervalSeconds: 5, gridSeconds: 1 },
  { intervalSeconds: 10, gridSeconds: 2 },
  { intervalSeconds: 15, gridSeconds: 3 },
  { intervalSeconds: 30, gridSeconds: 5 },
  { intervalSeconds: 60, gridSeconds: 10 },
  { intervalSeconds: 120, gridSeconds: 20 },
  { intervalSeconds: 300, gridSeconds: 30 },
  { intervalSeconds: 600, gridSeconds: 60 },
  { intervalSeconds: 900, gridSeconds: 120 },
  { intervalSeconds: 1800, gridSeconds: 180 },
  { intervalSeconds: 3600, gridSeconds: 300 },
]

function calculateTimelineScale(durationSeconds: number): TimelineScaleConfig {
  const totalMs = Math.max(0, Math.round(durationSeconds * 1000))

  const selectedCandidate =
    SCALE_CANDIDATES.find((candidate) => {
      if (durationSeconds <= 0) {
        return true
      }
      const markers = durationSeconds / candidate.intervalSeconds
      return markers <= TARGET_MARKER_COUNT
    }) ?? SCALE_CANDIDATES[SCALE_CANDIDATES.length - 1]

  const intervalMs = Math.round(selectedCandidate.intervalSeconds * 1000)
  const gridMs = Math.round(selectedCandidate.gridSeconds * 1000)

  // Set minItemDurationMs to 1ms for maximum granularity
  const minItemDurationMs = 1
  const defaultItemDurationMs = Math.min(
    Math.max(minItemDurationMs, intervalMs * 2),
    totalMs > 0 ? totalMs : intervalMs * 2,
  )

  // Dynamic max zoom based on video length:
  //   ≤ 5s  → down to 50ms visible  (up to ~100x)
  //   ≤ 30s → down to 50ms visible  (up to ~600x)
  //   ≤ 5m  → down to 100ms visible (up to ~3000x)
  //   > 5m  → down to 200ms visible
  // This lets users zoom to individual milliseconds on any video length.
  const minVisibleRangeMs =
    totalMs > 0
      ? Math.max(50, totalMs <= 5000 ? 50 : totalMs <= 30000 ? 50 : totalMs <= 300000 ? 100 : 200)
      : 1000

  return {
    intervalMs,
    gridMs,
    minItemDurationMs,
    defaultItemDurationMs,
    minVisibleRangeMs,
  }
}

function createInitialRange(totalMs: number): Range {
  if (totalMs > 0) {
    return { start: 0, end: totalMs }
  }

  return { start: 0, end: FALLBACK_RANGE_MS }
}

/** Compute axis interval & grid dynamically from the currently visible range */
function calculateDisplayInterval(visibleRangeMs: number): { intervalMs: number; gridMs: number } {
  const visibleSeconds = Math.max(visibleRangeMs, 1) / 1000
  const candidate =
    SCALE_CANDIDATES.find((c) => visibleSeconds / c.intervalSeconds <= TARGET_MARKER_COUNT) ??
    SCALE_CANDIDATES[SCALE_CANDIDATES.length - 1]
  return {
    intervalMs: Math.round(candidate.intervalSeconds * 1000),
    gridMs: Math.round(candidate.gridSeconds * 1000),
  }
}

function formatTimeLabel(milliseconds: number, intervalMs: number) {
  const totalSeconds = milliseconds / 1000
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const fractionalDigits = intervalMs < 10 ? 3 : intervalMs < 250 ? 2 : intervalMs < 1000 ? 1 : 0

  if (hours > 0) {
    const minutesString = minutes.toString().padStart(2, '0')
    const secondsString = Math.floor(seconds).toString().padStart(2, '0')
    return `${hours}:${minutesString}:${secondsString}`
  }

  if (fractionalDigits > 0) {
    const secondsWithFraction = seconds.toFixed(fractionalDigits)
    const [wholeSeconds, fraction] = secondsWithFraction.split('.')
    return `${minutes}:${wholeSeconds.padStart(2, '0')}.${fraction}`
  }

  return `${minutes}:${Math.floor(seconds).toString().padStart(2, '0')}`
}

function PlaybackCursor({
  currentTimeMs,
  videoDurationMs,
  onSeek,
  timelineRef,
  keyframes = [],
  onDragStateChange,
  onRangeChange,
}: {
  currentTimeMs: number
  videoDurationMs: number
  onSeek?: (time: number) => void
  timelineRef: React.RefObject<HTMLDivElement>
  keyframes?: { id: string; time: number }[]
  onDragStateChange?: (dragging: boolean) => void
  /** Pans the visible range when the playhead is dragged past either edge. */
  onRangeChange?: (updater: (previous: Range) => Range) => void
}) {
  const { sidebarWidth, direction, range, valueToPixels, pixelsToValue } = useTimelineContext()
  const sideProperty = direction === 'rtl' ? 'right' : 'left'
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current || !onSeek) return

      const rect = timelineRef.current.getBoundingClientRect()
      const clickX = e.clientX - rect.left - sidebarWidth
      const contentWidth = Math.max(1, rect.width - sidebarWidth)

      // Allow dragging outside to 0 or max, but clamp the value
      const relativeMs = pixelsToValue(clickX)
      let absoluteMs = Math.max(0, Math.min(range.start + relativeMs, videoDurationMs))

      // Snap to nearby keyframe if within threshold (150ms)
      const snapThresholdMs = 150
      const nearbyKeyframe = keyframes.find(
        (kf) =>
          Math.abs(kf.time - absoluteMs) <= snapThresholdMs &&
          kf.time >= range.start &&
          kf.time <= range.end,
      )

      if (nearbyKeyframe) {
        absoluteMs = nearbyKeyframe.time
      }

      // Pan the viewport by the overflow when dragging past the visible edges
      const visibleMs = range.end - range.start
      if (onRangeChange && visibleMs > 0 && videoDurationMs > visibleMs) {
        const msPerPixel = visibleMs / contentWidth
        const overflowLeftPx = Math.max(0, -clickX)
        const overflowRightPx = Math.max(0, clickX - contentWidth)
        const shiftMs =
          overflowLeftPx > 0 && range.start > 0
            ? -overflowLeftPx * msPerPixel
            : overflowRightPx > 0 && range.end < videoDurationMs
              ? overflowRightPx * msPerPixel
              : 0
        if (shiftMs !== 0) {
          onRangeChange((previous) => {
            const nextRange = clampVisibleRange(
              { start: previous.start + shiftMs, end: previous.end + shiftMs },
              videoDurationMs,
            )
            return nextRange.start === previous.start && nextRange.end === previous.end
              ? previous
              : nextRange
          })
        }
      }

      onSeek(absoluteMs / 1000)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onDragStateChange?.(false)
      document.body.style.cursor = ''
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'ew-resize'

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
    }
  }, [
    isDragging,
    onSeek,
    onRangeChange,
    timelineRef,
    sidebarWidth,
    range.start,
    range.end,
    videoDurationMs,
    pixelsToValue,
    keyframes,
    onDragStateChange,
  ])

  if (videoDurationMs <= 0 || currentTimeMs < 0) {
    return null
  }

  const clampedTime = Math.min(currentTimeMs, videoDurationMs)

  if (clampedTime < range.start || clampedTime > range.end) {
    return null
  }

  const offset = valueToPixels(clampedTime - range.start)

  return (
    <div
      className="absolute top-0 bottom-0 z-50 group/cursor"
      style={{
        [sideProperty === 'right' ? 'marginRight' : 'marginLeft']: `${sidebarWidth - 1}px`,
        pointerEvents: 'none', // Allow clicks to pass through to timeline, but we'll enable pointer events on the handle
      }}
    >
      {/* Invisible wider hit area for easier grabbing */}
      <div
        className="absolute top-0 bottom-0 w-[12px] cursor-ew-resize pointer-events-auto"
        style={{
          [sideProperty]: `${offset - 5}px`,
        }}
        onMouseDown={(e) => {
          e.stopPropagation() // Prevent timeline click
          setIsDragging(true)
          onDragStateChange?.(true)
        }}
      >
        {/* Visible 2px line centered in the hit area */}
        <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-[#34B27B] shadow-[0_0_10px_rgba(52,178,123,0.5)] hover:shadow-[0_0_15px_rgba(52,178,123,0.7)] transition-shadow" />
        <div
          className="absolute -top-1 left-1/2 -translate-x-1/2 hover:scale-125 transition-transform"
          style={{ width: '16px', height: '16px' }}
        >
          <div className="w-3 h-3 mx-auto mt-[2px] bg-[#34B27B] rotate-45 rounded-sm shadow-lg border border-white/20" />
        </div>
      </div>
    </div>
  )
}

/** Imperatively-positioned ghost cursor — updates via ref, zero React re-renders. */
function GhostCursor({
  ghostRef,
  scissorsMode,
}: {
  ghostRef: React.RefObject<HTMLDivElement>
  scissorsMode: boolean
}) {
  const { sidebarWidth, direction } = useTimelineContext()
  const sideProperty = direction === 'rtl' ? 'right' : 'left'

  return (
    <div
      className="absolute top-0 bottom-0 z-40 pointer-events-none"
      style={{
        [sideProperty === 'right' ? 'marginRight' : 'marginLeft']: `${sidebarWidth - 1}px`,
        display: 'none', // hidden by default; shown imperatively
      }}
      ref={ghostRef}
    >
      <div
        className="absolute top-0 bottom-0 w-[1px]"
        style={{
          left: '0px',
          backgroundColor: scissorsMode ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.25)',
        }}
      >
        {scissorsMode && (
          <div
            className="absolute -top-1 left-1/2 -translate-x-1/2"
            style={{ width: '14px', height: '14px' }}
          >
            <div className="w-2.5 h-2.5 mx-auto mt-[2px] bg-red-500/60 rotate-45 rounded-sm" />
          </div>
        )}
      </div>
    </div>
  )
}

function TimelineAxis({
  intervalMs,
  videoDurationMs,
  currentTimeMs,
}: {
  intervalMs: number
  videoDurationMs: number
  currentTimeMs: number
}) {
  const { sidebarWidth, direction, range, valueToPixels } = useTimelineContext()
  const sideProperty = direction === 'rtl' ? 'right' : 'left'

  const markers = useMemo(() => {
    if (intervalMs <= 0) {
      return { markers: [], minorTicks: [] }
    }

    const maxTime = videoDurationMs > 0 ? videoDurationMs : range.end
    const visibleStart = Math.max(0, Math.min(range.start, maxTime))
    const visibleEnd = Math.min(range.end, maxTime)
    const markerTimes = new Set<number>()

    const firstMarker = Math.ceil(visibleStart / intervalMs) * intervalMs

    for (let time = firstMarker; time <= maxTime; time += intervalMs) {
      if (time >= visibleStart && time <= visibleEnd) {
        markerTimes.add(Math.round(time))
      }
    }

    if (visibleStart <= maxTime) {
      markerTimes.add(Math.round(visibleStart))
    }

    if (videoDurationMs > 0) {
      markerTimes.add(Math.round(videoDurationMs))
    }

    const sorted = Array.from(markerTimes)
      .filter((time) => time <= maxTime)
      .sort((a, b) => a - b)

    // Generate minor ticks (4 ticks between major intervals)
    const minorTicks = []
    const minorInterval = intervalMs / 5

    for (let time = firstMarker; time <= maxTime; time += minorInterval) {
      if (time >= visibleStart && time <= visibleEnd) {
        // Skip if it's close to a major marker
        const isMajor = Math.abs(time % intervalMs) < 1
        if (!isMajor) {
          minorTicks.push(time)
        }
      }
    }

    return {
      markers: sorted.map((time) => ({
        time,
        label: formatTimeLabel(time, intervalMs),
      })),
      minorTicks,
    }
  }, [intervalMs, range.end, range.start, videoDurationMs])

  return (
    <div
      className="h-8 bg-[#09090b] border-b border-white/5 relative overflow-hidden select-none"
      style={{
        [sideProperty === 'right' ? 'marginRight' : 'marginLeft']: `${sidebarWidth}px`,
      }}
    >
      {/* Minor Ticks */}
      {markers.minorTicks.map((time) => {
        const offset = valueToPixels(time - range.start)
        return (
          <div
            key={`minor-${time}`}
            className="absolute bottom-0 h-1 w-[1px] bg-white/5"
            style={{ [sideProperty]: `${offset}px` }}
          />
        )
      })}

      {/* Major Markers */}
      {markers.markers.map((marker) => {
        const offset = valueToPixels(marker.time - range.start)
        const markerStyle: React.CSSProperties = {
          position: 'absolute',
          bottom: 0,
          height: '100%',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-end',
          [sideProperty]: `${offset}px`,
        }

        return (
          <div key={marker.time} style={markerStyle}>
            <div className="flex flex-col items-center pb-1">
              <div className="h-2 w-[1px] bg-white/20 mb-1" />
              <span
                className={cn(
                  'text-[10px] font-medium tabular-nums tracking-tight',
                  marker.time === currentTimeMs ? 'text-[#34B27B]' : 'text-slate-500',
                )}
              >
                {marker.label}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Timeline({
  items,
  videoDurationMs,
  intervalMs,
  currentTimeMs,
  onSeek,
  onSelectZoom,
  onSelectSegment,
  onSelectAnnotation,
  selectedZoomId,
  selectedSegmentId,
  selectedAnnotationId,
  hasAudioTrack,
  audioEnabled,
  audioGain,
  keyframes = [],
  segments = [],
  scissorsMode,
  onSplitAtTime,
  onScissorsDone,
  onHoverPreview,
  onHoverCommit,
  isPlaying = false,
  onRangeChange,
  rowHints,
  waveform,
  waveformHint,
}: {
  items: TimelineRenderItem[]
  videoDurationMs: number
  intervalMs: number
  currentTimeMs: number
  onSeek?: (time: number) => void
  onSelectZoom?: (id: string | null) => void
  onSelectSegment?: (id: string | null) => void
  onSelectAnnotation?: (id: string | null) => void
  selectedZoomId: string | null
  selectedSegmentId?: string | null
  selectedAnnotationId?: string | null
  hasAudioTrack: boolean
  audioEnabled: boolean
  audioGain: number
  keyframes?: { id: string; time: number }[]
  segments?: VideoSegment[]
  scissorsMode?: boolean
  onSplitAtTime?: (effectiveMs: number) => void
  onScissorsDone?: () => void
  onHoverPreview?: (effectiveMs: number | null) => void
  onHoverCommit?: () => void
  isPlaying?: boolean
  onRangeChange?: (updater: (previous: Range) => Range) => void
  rowHints?: RowHints
  /** Decoded peaks in source time; null while loading / disabled. */
  waveform?: { peaks: Float32Array; durationMs: number } | null
  /** Shown in the audio row when no waveform could be decoded. */
  waveformHint?: string | null
}) {
  const { t } = useI18n()
  const { setTimelineRef, style, sidebarWidth, range, pixelsToValue, valueToPixels } =
    useTimelineContext()
  const localTimelineRef = useRef<HTMLDivElement | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const isDraggingCursorRef = useRef(false)
  // Press-drag scrubbing on empty lane space (T5); pointer id guards multi-touch
  const isScrubbingTimelineRef = useRef(false)
  const scrubPointerIdRef = useRef<number | null>(null)
  const onHoverPreviewRef = useRef(onHoverPreview)
  onHoverPreviewRef.current = onHoverPreview
  const onHoverCommitRef = useRef(onHoverCommit)
  onHoverCommitRef.current = onHoverCommit

  // Hide ghost cursor immediately when playback starts
  useEffect(() => {
    if (isPlaying) {
      const el = ghostRef.current
      if (el) el.style.display = 'none'
    }
  }, [isPlaying])

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setTimelineRef(node)
      localTimelineRef.current = node
    },
    [setTimelineRef],
  )

  const getTimeFromClientX = useCallback(
    (timelineElement: HTMLElement, clientX: number) => {
      const rect = timelineElement.getBoundingClientRect()
      const clickX = clientX - rect.left - sidebarWidth
      if (clickX < 0) return null
      const relativeMs = pixelsToValue(clickX)
      return Math.max(0, Math.min(range.start + relativeMs, videoDurationMs))
    },
    [sidebarWidth, range.start, pixelsToValue, videoDurationMs],
  )

  const getTimeFromMouseEvent = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => getTimeFromClientX(e.currentTarget, e.clientX),
    [getTimeFromClientX],
  )

  const hideGhostCursor = useCallback(() => {
    const el = ghostRef.current
    if (el) el.style.display = 'none'
    if (hoverRafRef.current !== null) {
      cancelAnimationFrame(hoverRafRef.current)
      hoverRafRef.current = null
    }
  }, [])

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (videoDurationMs <= 0) return

      // Commit hover preview so the playhead accepts the new position
      onHoverCommitRef.current?.()
      // Hide ghost cursor
      const el = ghostRef.current
      if (el) el.style.display = 'none'
      if (hoverRafRef.current !== null) {
        cancelAnimationFrame(hoverRafRef.current)
        hoverRafRef.current = null
      }

      if (scissorsMode && onSplitAtTime) {
        const timeMs = getTimeFromMouseEvent(e)
        if (timeMs !== null) {
          onSplitAtTime(timeMs)
          onScissorsDone?.()
        }
        return
      }

      if (!onSeek) return

      onSelectZoom?.(null)
      onSelectSegment?.(null)
      onSelectAnnotation?.(null)

      const timeMs = getTimeFromMouseEvent(e)
      if (timeMs !== null) {
        onSeek(timeMs / 1000)
      }
    },
    [
      onSeek,
      onSelectZoom,
      onSelectSegment,
      onSelectAnnotation,
      videoDurationMs,
      scissorsMode,
      onSplitAtTime,
      onScissorsDone,
      getTimeFromMouseEvent,
    ],
  )

  // Imperatively position ghost cursor & trigger hover preview — no React state, no re-renders
  const hoverRafRef = useRef<number | null>(null)
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Skip ghost cursor + hover preview while dragging, scrubbing or playing
      if (isDraggingCursorRef.current || isScrubbingTimelineRef.current || isPlaying) return
      const el = ghostRef.current
      if (!el) return
      const rect = e.currentTarget.getBoundingClientRect()
      const clickX = e.clientX - rect.left - sidebarWidth
      if (clickX < 0 || videoDurationMs <= 0) {
        el.style.display = 'none'
        return
      }
      const relativeMs = pixelsToValue(clickX)
      const timeMs = Math.max(0, Math.min(range.start + relativeMs, videoDurationMs))
      const clamped = Math.max(0, Math.min(timeMs, videoDurationMs))
      if (clamped < range.start || clamped > range.end) {
        el.style.display = 'none'
        return
      }
      const offset = valueToPixels(clamped - range.start)
      el.style.display = ''
      const line = el.firstElementChild as HTMLElement | null
      if (line) line.style.left = `${offset}px`

      // Throttled hover preview via rAF — avoids flooding seeks
      if (hoverRafRef.current !== null) cancelAnimationFrame(hoverRafRef.current)
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = null
        onHoverPreviewRef.current?.(timeMs)
      })
    },
    [
      sidebarWidth,
      range.start,
      range.end,
      pixelsToValue,
      valueToPixels,
      videoDurationMs,
      isPlaying,
    ],
  )

  const handleCursorDragStateChange = useCallback((dragging: boolean) => {
    isDraggingCursorRef.current = dragging
    if (dragging) {
      // Commit hover preview so seek updates flow through to setCurrentTime
      onHoverCommitRef.current?.()
      // Hide ghost cursor during drag
      const el = ghostRef.current
      if (el) el.style.display = 'none'
      if (hoverRafRef.current !== null) {
        cancelAnimationFrame(hoverRafRef.current)
        hoverRafRef.current = null
      }
    }
  }, [])

  const handleMouseLeave = useCallback(() => {
    hideGhostCursor()
    // Don't restore hover preview during cursor drag / scrub — it's already committed
    if (!isDraggingCursorRef.current && !isScrubbingTimelineRef.current) {
      onHoverPreviewRef.current?.(null)
    }
  }, [hideGhostCursor])

  // Press-drag scrubbing on empty lane space. Gated so it never fights with
  // scissors mode (click-to-split), items/handles, the playhead or segment blocks.
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
      if (scissorsMode || !onSeek || videoDurationMs <= 0) return
      if (!shouldStartTimelineScrub(e.target, e.currentTarget)) return

      const timeMs = getTimeFromClientX(e.currentTarget, e.clientX)
      if (timeMs === null) return

      // Commit hover preview so seeks flow through to the real playhead
      onHoverCommitRef.current?.()
      hideGhostCursor()
      onSelectZoom?.(null)
      onSelectSegment?.(null)
      onSelectAnnotation?.(null)

      isScrubbingTimelineRef.current = true
      scrubPointerIdRef.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      onSeek(timeMs / 1000)
      e.preventDefault()
    },
    [
      scissorsMode,
      onSeek,
      videoDurationMs,
      getTimeFromClientX,
      hideGhostCursor,
      onSelectZoom,
      onSelectSegment,
      onSelectAnnotation,
    ],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isScrubbingTimelineRef.current || scrubPointerIdRef.current !== e.pointerId) return
      const timeMs = getTimeFromClientX(e.currentTarget, e.clientX)
      // Past the left edge: keep the playhead at 0 instead of ignoring the move
      onSeek?.((timeMs ?? 0) / 1000)
      e.preventDefault()
    },
    [getTimeFromClientX, onSeek],
  )

  const stopScrub = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!isScrubbingTimelineRef.current || scrubPointerIdRef.current !== e.pointerId) return
    isScrubbingTimelineRef.current = false
    scrubPointerIdRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const handleLostPointerCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubPointerIdRef.current === e.pointerId) {
      isScrubbingTimelineRef.current = false
      scrubPointerIdRef.current = null
    }
  }, [])

  const zoomItems = items.filter((item) => item.rowId === ZOOM_ROW_ID)
  const annotationItems = items.filter((item) => item.rowId === ANNOTATION_ROW_ID)
  const blurItems = items.filter((item) => item.rowId === BLUR_ROW_ID)
  const subtitleItems = items.filter((item) => item.rowId === SUBTITLE_ROW_ID)
  const audioEditItems = items.filter((item) => item.rowId === AUDIO_ROW_ID)

  const timelineStyle = useMemo(() => {
    if (!scissorsMode) return { ...style, cursor: 'pointer', touchAction: 'none' as const }
    // Scissors SVG cursor (white, 24x24, hotspot at center)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 512 512"><path d="M193.117 345.188a88.7 88.7 0 0 0-41.172-10.125 88.16 88.16 0 0 0-48.938 14.797c-12.75 8.484-22.688 19.828-29.344 32.547a88.8 88.8 0 0 0-10.141 41.188c-.016 16.797 4.828 33.922 14.813 48.922 8.469 12.75 19.813 22.703 32.547 29.359A88.8 88.8 0 0 0 152.07 512a88.04 88.04 0 0 0 48.922-14.813c12.75-8.469 22.703-19.813 29.344-32.547a88.5 88.5 0 0 0 10.141-41.172 88.3 88.3 0 0 0-14.813-48.938 88.1 88.1 0 0 0-32.547-29.342m-1.547 99.14c-3.359 6.422-8.297 12.078-14.813 16.422-7.688 5.094-16.172 7.469-24.688 7.484-7.25 0-14.453-1.766-20.875-5.141s-12.078-8.281-16.422-14.813c-5.094-7.688-7.469-16.172-7.484-24.688a45.1 45.1 0 0 1 5.141-20.875c3.375-6.422 8.281-12.063 14.813-16.406 7.688-5.094 16.172-7.484 24.703-7.5 7.234 0 14.438 1.766 20.859 5.141s12.063 8.297 16.422 14.828c5.094 7.672 7.469 16.156 7.484 24.688a44.96 44.96 0 0 1-5.14 20.86m242.094-69.797a88.16 88.16 0 0 0-32.531-29.344 88.8 88.8 0 0 0-41.188-10.125 88.1 88.1 0 0 0-48.922 14.797c-12.766 8.484-22.703 19.828-29.359 32.547a88.8 88.8 0 0 0-10.141 41.188c-.016 16.797 4.828 33.922 14.813 48.922 8.484 12.75 19.813 22.703 32.547 29.359A88.8 88.8 0 0 0 360.07 512a88.04 88.04 0 0 0 48.922-14.813c12.75-8.469 22.703-19.813 29.359-32.547a88.7 88.7 0 0 0 10.125-41.172c.016-16.812-4.828-33.937-14.812-48.937m-34.078 69.797c-3.375 6.422-8.297 12.078-14.828 16.422-7.688 5.094-16.172 7.469-24.688 7.484-7.25 0-14.453-1.766-20.875-5.141s-12.078-8.281-16.422-14.813c-5.094-7.688-7.469-16.172-7.484-24.688a45.1 45.1 0 0 1 5.141-20.875c3.375-6.422 8.297-12.063 14.828-16.406 7.672-5.094 16.156-7.484 24.688-7.5a45.15 45.15 0 0 1 20.859 5.141c6.438 3.375 12.078 8.297 16.422 14.828 5.094 7.672 7.469 16.156 7.484 24.688a45.15 45.15 0 0 1-5.125 20.86M429.164 0 256.008 256.766 82.852 0C46.914 245.094 256.008 329.719 256.008 329.719S465.102 245.094 429.164 0" fill="%23fff"/></svg>`
    return { ...style, cursor: `url('data:image/svg+xml,${svg}') 12 12, crosshair` }
  }, [style, scissorsMode])

  return (
    <div
      ref={setRefs}
      style={timelineStyle}
      className="select-none bg-[#09090b] min-h-[140px] relative group"
      onClick={handleTimelineClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopScrub}
      onPointerCancel={stopScrub}
      onLostPointerCapture={handleLostPointerCapture}
    >
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px)] bg-[length:20px_100%] pointer-events-none" />
      <TimelineAxis
        intervalMs={intervalMs}
        videoDurationMs={videoDurationMs}
        currentTimeMs={currentTimeMs}
      />
      <GhostCursor ghostRef={ghostRef} scissorsMode={!!scissorsMode} />
      <PlaybackCursor
        currentTimeMs={currentTimeMs}
        videoDurationMs={videoDurationMs}
        onSeek={onSeek}
        timelineRef={localTimelineRef}
        keyframes={keyframes}
        onDragStateChange={handleCursorDragStateChange}
        onRangeChange={onRangeChange}
      />

      <Row id={ZOOM_ROW_ID} isEmpty={zoomItems.length === 0} hint={rowHints?.zoom}>
        {zoomItems.map((item) => (
          <Item
            id={item.id}
            key={item.id}
            rowId={item.rowId}
            span={item.span}
            isSelected={item.id === selectedZoomId}
            onSelect={() => onSelectZoom?.(item.id)}
            zoomDepth={item.zoomDepth}
            zoomScale={item.zoomScale}
            zoomAutoFocus={item.zoomAutoFocus}
            variant="zoom"
          >
            {item.label}
          </Item>
        ))}
      </Row>

      <Row id={TRIM_ROW_ID}>
        {/* Segment blocks */}
        {segments
          .filter((s) => !s.deleted)
          .map((segment) => {
            const effStart = sourceToEffectiveMsWithSegments(segment.startMs, segments)
            const effEnd = sourceToEffectiveMsWithSegments(segment.endMs, segments)
            const offsetPx = valueToPixels(effStart - range.start)
            const widthPx = valueToPixels(effEnd - range.start) - offsetPx
            if (widthPx < 1) return null
            return (
              <div
                key={segment.id}
                className={cn(
                  'absolute top-1 bottom-1 rounded cursor-pointer transition-all border',
                  selectedSegmentId === segment.id
                    ? 'bg-sky-500/25 border-sky-400/80'
                    : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.07]',
                )}
                style={{ left: `${offsetPx}px`, width: `${widthPx}px` }}
                {...{ [TIMELINE_SCRUB_OPT_OUT_ATTR]: 'off' }}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectSegment?.(selectedSegmentId === segment.id ? null : segment.id)
                }}
              >
                {segment.speed !== 1 && widthPx > 28 && (
                  <span className="absolute top-0.5 right-1 text-[9px] text-sky-300 font-mono leading-none">
                    {segment.speed}x
                  </span>
                )}
              </div>
            )
          })}
        {/* Split lines at segment boundaries (between adjacent kept segments) */}
        {segments.slice(1).map((segment, i) => {
          const prev = segments[i]
          // Only show split line between two non-deleted adjacent segments
          if (prev.deleted && segment.deleted) return null
          if (prev.deleted || segment.deleted) return null
          const effPos = sourceToEffectiveMsWithSegments(segment.startMs, segments)
          const offsetPx = valueToPixels(effPos - range.start)
          return (
            <div
              key={`split-${segment.id}`}
              className="absolute top-0 bottom-0 w-[2px] bg-orange-400/60 z-10 pointer-events-none"
              style={{ left: `${offsetPx}px`, transform: 'translateX(-1px)' }}
            />
          )
        })}
      </Row>

      <Row
        id={ANNOTATION_ROW_ID}
        isEmpty={annotationItems.length === 0}
        hint={rowHints?.annotation}
      >
        {annotationItems.map((item) => (
          <Item
            id={item.id}
            key={item.id}
            rowId={item.rowId}
            span={item.span}
            isSelected={item.id === selectedAnnotationId}
            onSelect={() => onSelectAnnotation?.(item.id)}
            variant="annotation"
          >
            {item.label}
          </Item>
        ))}
      </Row>

      {BLUR_REGIONS_ENABLED && (
        <Row id={BLUR_ROW_ID} isEmpty={blurItems.length === 0} hint={rowHints?.blur}>
          {blurItems.map((item) => (
            <Item
              id={item.id}
              key={item.id}
              rowId={item.rowId}
              span={item.span}
              isSelected={item.id === selectedAnnotationId}
              onSelect={() => onSelectAnnotation?.(item.id)}
              variant="blur"
            >
              {item.label}
            </Item>
          ))}
        </Row>
      )}

      <Row id={SUBTITLE_ROW_ID} isEmpty={subtitleItems.length === 0} hint={rowHints?.subtitle}>
        {subtitleItems.map((item) => (
          <Item
            id={item.id}
            key={item.id}
            rowId={item.rowId}
            span={item.span}
            isSelected={false}
            variant="subtitle"
            editable={false}
          >
            {item.label}
          </Item>
        ))}
      </Row>

      <Row
        id={AUDIO_ROW_ID}
        background={
          waveform || waveformHint ? (
            <BackgroundWaveform
              peaks={waveform?.peaks ?? null}
              sourceDurationMs={waveform?.durationMs ?? 0}
              segments={segments}
              topInset={4}
              bottomInset={4}
              hint={waveformHint}
            />
          ) : undefined
        }
      >
        <div className="h-10 w-full px-2 flex items-center pointer-events-none">
          <div
            className={cn(
              'w-full h-8 rounded-lg border px-3 flex items-center justify-between',
              !hasAudioTrack
                ? 'border-white/10 bg-white/5'
                : waveform
                  ? 'border-[#34B27B]/20 bg-transparent'
                  : 'border-[#34B27B]/30 bg-[linear-gradient(90deg,rgba(52,178,123,0.18),rgba(52,178,123,0.06))]',
            )}
          >
            <span className="text-[10px] font-medium text-slate-300 uppercase tracking-wide">
              {t('timeline.audio')}
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {!hasAudioTrack
                ? t('timeline.audioUnavailable')
                : audioEnabled
                  ? audioEditItems.length > 0
                    ? `${Math.round(audioGain * 100)}% · ${t('timeline.audioAutoEdits', { count: audioEditItems.length })}`
                    : `${Math.round(audioGain * 100)}%`
                  : t('timeline.audioMuted')}
            </span>
          </div>
        </div>
        {audioEditItems.map((item) => (
          <Item
            id={item.id}
            key={item.id}
            rowId={item.rowId}
            span={item.span}
            isSelected={false}
            variant="audio-edit"
            editable={false}
          >
            {item.label}
          </Item>
        ))}
      </Row>
    </div>
  )
}

export default function TimelineEditor({
  videoDuration,
  currentTime,
  onSeek,
  zoomRegions,
  onZoomAdded,
  onZoomSpanChange,
  onZoomDelete,
  onZoomDepthChange,
  selectedZoomId,
  onSelectZoom,
  segments = [],
  onSplitAtTime,
  onResetAllSegmentEdits,
  onDeleteSegment,
  selectedSegmentId,
  onSelectSegment,
  annotationRegions = [],
  onAnnotationAdded,
  onBlurAdded,
  onAnnotationSpanChange,
  onAnnotationDelete,
  selectedAnnotationId,
  onSelectAnnotation,
  subtitleCues = [],
  aspectRatio,
  onAspectRatioChange,
  hasAudioTrack = true,
  audioEnabled = true,
  audioGain = 1,
  audioEditRegions = [],
  onAudioEditSpanChange,
  onAudioEditDelete,
  onHoverPreview,
  onHoverCommit,
  isPlaying = false,
  onVisibleRangeChange,
  zoomStepRef,
  zoomSetRef,
  videoFilePath,
  videoUrl,
  showWaveform = false,
  recordingMarkersMs = [],
}: TimelineEditorProps) {
  const { t } = useI18n()
  const totalMs = useMemo(() => Math.max(0, Math.round(videoDuration * 1000)), [videoDuration])
  const currentTimeMs = useMemo(() => Math.round(currentTime * 1000), [currentTime])
  const timelineScale = useMemo(() => calculateTimelineScale(videoDuration), [videoDuration])
  const safeMinDurationMs = useMemo(
    () =>
      totalMs > 0
        ? Math.min(timelineScale.minItemDurationMs, totalMs)
        : timelineScale.minItemDurationMs,
    [timelineScale.minItemDurationMs, totalMs],
  )

  const [range, setRange] = useState<Range>(() => createInitialRange(totalMs))
  const [keyframes, setKeyframes] = useState<{ id: string; time: number }[]>([])
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(null)
  const [scrollLabels, setScrollLabels] = useState({
    pan: 'Shift + Ctrl + Scroll',
    zoom: 'Ctrl + Scroll',
  })
  const { shortcuts: keyShortcuts, isMac: isMacPlatform } = useShortcuts()
  const [scissorsMode, setScissorsMode] = useState(false)
  // "Reset all trims and cuts" throws away every split, deletion and speed in
  // one go, so it asks first. The dialog carries aria-modal, which is how the
  // editor's global shortcuts (lib/modalDialog.isModalDialogOpen) know to stand
  // down while it is open.
  const [resetEditsConfirmOpen, setResetEditsConfirmOpen] = useState(false)

  // Waveform peaks (source time). Only decoded when the toggle is on and the
  // source has audio; the hook drops stale peaks as soon as the source changes.
  const waveformSource = useMemo(
    () =>
      showWaveform && hasAudioTrack && (videoFilePath || videoUrl)
        ? { filePath: videoFilePath ?? null, url: videoUrl ?? null }
        : undefined,
    [showWaveform, hasAudioTrack, videoFilePath, videoUrl],
  )
  const audioPeaks = useAudioPeaks(waveformSource)
  const waveform =
    showWaveform && audioPeaks.data && audioPeaks.data.peaks.length > 0 ? audioPeaks.data : null
  // Neither decode path could read this recording's audio: say so quietly in the
  // row instead of leaving an empty strip that looks like a silent track.
  const waveformHint =
    showWaveform && !waveform && audioPeaks.status === 'unavailable'
      ? t('editor.waveformUnavailable')
      : null

  const rowHints = useMemo<RowHints>(
    () => ({
      zoom: t('timeline.hints.pressZoom', {
        key: formatBinding(keyShortcuts.addZoom, isMacPlatform),
      }),
      annotation: t('timeline.hints.pressAnnotation', {
        key: formatBinding(keyShortcuts.addAnnotation, isMacPlatform),
      }),
      blur: t('timeline.hints.pressBlur', {
        key: formatBinding(keyShortcuts.addBlur, isMacPlatform),
      }),
      subtitle: t('timeline.hints.noSubtitles'),
    }),
    [t, keyShortcuts.addZoom, keyShortcuts.addAnnotation, keyShortcuts.addBlur, isMacPlatform],
  )
  const timelineContainerRef = useRef<HTMLDivElement>(null)
  const currentTimeMsRef = useRef(currentTimeMs)
  currentTimeMsRef.current = currentTimeMs

  // Report visible range changes to parent
  useEffect(() => {
    onVisibleRangeChange?.({
      visibleMs: range.end - range.start,
      totalMs,
      minVisibleMs: timelineScale.minVisibleRangeMs,
    })
  }, [range, totalMs, timelineScale.minVisibleRangeMs, onVisibleRangeChange])

  // Expose programmatic zoom step function
  useEffect(() => {
    if (!zoomStepRef) return
    zoomStepRef.current = (direction: 1 | -1) => {
      setRange((prev) => {
        const dur = prev.end - prev.start
        const factor = direction > 0 ? 0.7 : 1.4 // zoom in = shrink range, zoom out = grow range
        const newDur = Math.max(timelineScale.minVisibleRangeMs, Math.min(totalMs, dur * factor))
        const phead = Math.max(0, Math.min(currentTimeMsRef.current, totalMs))
        let ratio: number
        if (phead >= prev.start && phead <= prev.end && dur > 0) {
          ratio = (phead - prev.start) / dur
        } else {
          ratio = 0.5
        }
        let start = phead - newDur * ratio
        let end = start + newDur
        if (start < 0) {
          start = 0
          end = start + newDur
        }
        if (end > totalMs) {
          end = totalMs
          start = end - newDur
        }
        start = Math.max(0, start)
        end = Math.min(totalMs, end)
        return { start, end }
      })
    }
    return () => {
      zoomStepRef.current = null
    }
  }, [zoomStepRef, totalMs, timelineScale.minVisibleRangeMs, setRange])

  // Expose programmatic zoom-to-level function (sets visible range to exact ms)
  useEffect(() => {
    if (!zoomSetRef) return
    zoomSetRef.current = (targetVisibleMs: number) => {
      setRange((prev) => {
        const newDur = Math.max(timelineScale.minVisibleRangeMs, Math.min(totalMs, targetVisibleMs))
        const dur = prev.end - prev.start
        const phead = Math.max(0, Math.min(currentTimeMsRef.current, totalMs))
        let ratio: number
        if (phead >= prev.start && phead <= prev.end && dur > 0) {
          ratio = (phead - prev.start) / dur
        } else {
          ratio = 0.5
        }
        let start = phead - newDur * ratio
        let end = start + newDur
        if (start < 0) {
          start = 0
          end = start + newDur
        }
        if (end > totalMs) {
          end = totalMs
          start = end - newDur
        }
        start = Math.max(0, start)
        end = Math.min(totalMs, end)
        return { start, end }
      })
    }
    return () => {
      zoomSetRef.current = null
    }
  }, [zoomSetRef, totalMs, timelineScale.minVisibleRangeMs, setRange])

  useEffect(() => {
    formatShortcut(['shift', 'mod', 'Scroll']).then((pan) => {
      formatShortcut(['mod', 'Scroll']).then((zoom) => {
        setScrollLabels({ pan, zoom })
      })
    })
  }, [])

  // Add keyframe at current playhead position
  const addKeyframe = useCallback(() => {
    if (totalMs === 0) return
    const time = Math.max(0, Math.min(currentTimeMs, totalMs))
    if (keyframes.some((kf) => Math.abs(kf.time - time) < 1)) return
    setKeyframes((prev) => [...prev, { id: uuidv4(), time }])
  }, [currentTimeMs, totalMs, keyframes])

  // Delete selected keyframe
  const deleteSelectedKeyframe = useCallback(() => {
    if (!selectedKeyframeId) return
    setKeyframes((prev) => prev.filter((kf) => kf.id !== selectedKeyframeId))
    setSelectedKeyframeId(null)
  }, [selectedKeyframeId])

  // Move keyframe to new time position
  const handleKeyframeMove = useCallback(
    (id: string, newTime: number) => {
      setKeyframes((prev) =>
        prev.map((kf) =>
          kf.id === id ? { ...kf, time: Math.max(0, Math.min(newTime, totalMs)) } : kf,
        ),
      )
    },
    [totalMs],
  )

  // Delete selected zoom item
  const deleteSelectedZoom = useCallback(() => {
    if (!selectedZoomId) return
    onZoomDelete(selectedZoomId)
    onSelectZoom(null)
  }, [selectedZoomId, onZoomDelete, onSelectZoom])

  // Delete selected segment
  const deleteSelectedSegment = useCallback(() => {
    if (!selectedSegmentId || !onDeleteSegment) return
    onDeleteSegment()
  }, [selectedSegmentId, onDeleteSegment])

  const deleteSelectedAnnotation = useCallback(() => {
    if (!selectedAnnotationId || !onAnnotationDelete || !onSelectAnnotation) return
    onAnnotationDelete(selectedAnnotationId)
    onSelectAnnotation(null)
  }, [selectedAnnotationId, onAnnotationDelete, onSelectAnnotation])

  // Scale the visible range proportionally when totalMs changes (e.g. segment speed edit),
  // instead of resetting to the full timeline. Only reset on initial load (prevTotalMs === 0).
  const prevTotalMsRef = useRef(0)
  useEffect(() => {
    const prevTotal = prevTotalMsRef.current
    prevTotalMsRef.current = totalMs
    if (totalMs <= 0) return
    if (prevTotal <= 0) {
      // First load — show full timeline
      setRange(createInitialRange(totalMs))
      return
    }
    // Proportional scale: keep the same relative viewport centered on playhead
    const ratio = totalMs / prevTotal
    setRange((prev) => {
      const dur = prev.end - prev.start
      const newDur = Math.max(timelineScale.minVisibleRangeMs, Math.min(totalMs, dur * ratio))
      const phead = Math.max(0, Math.min(currentTimeMsRef.current, totalMs))
      const oldRatio =
        dur > 0 && phead >= prev.start && phead <= prev.end ? (phead - prev.start) / dur : 0.5
      let start = phead - newDur * oldRatio
      let end = start + newDur
      if (start < 0) {
        start = 0
        end = start + newDur
      }
      if (end > totalMs) {
        end = totalMs
        start = end - newDur
      }
      start = Math.max(0, start)
      end = Math.min(totalMs, end)
      return { start, end }
    })
  }, [totalMs, timelineScale.minVisibleRangeMs])

  // Auto-follow playhead: pan viewport when playhead exits visible range during playback
  useEffect(() => {
    if (!isPlaying || totalMs <= 0) return
    setRange((prev) => {
      if (currentTimeMs >= prev.start && currentTimeMs <= prev.end) return prev
      // Playhead outside viewport — pan so playhead is at ~15% from left edge
      const dur = prev.end - prev.start
      let start = currentTimeMs - dur * 0.15
      let end = start + dur
      if (start < 0) {
        start = 0
        end = dur
      }
      if (end > totalMs) {
        end = totalMs
        start = Math.max(0, end - dur)
      }
      return { start, end }
    })
  }, [currentTimeMs, isPlaying, totalMs])

  // Trimming shortens the effective timeline, so every track has to be refitted
  // to it, not just the zooms: an annotation, blur or audio edit left pointing
  // past the new end would render nowhere and export nothing. Regions with no
  // room left are dropped rather than squashed into a sliver.
  // (Trims themselves are derived from the deleted segments and need no pass.)
  useEffect(() => {
    if (totalMs === 0 || safeMinDurationMs <= 0) {
      return
    }

    const toSpans = (regions: ReadonlyArray<{ id: string; startMs: number; endMs: number }>) =>
      regions.map((region) => ({ id: region.id, start: region.startMs, end: region.endMs }))

    const zooms = normaliseSpansToDuration(toSpans(zoomRegions), totalMs, safeMinDurationMs)
    for (const span of zooms.clamped) onZoomSpanChange(span.id, span)
    for (const id of zooms.dropped) onZoomDelete(id)

    if (onAnnotationSpanChange || onAnnotationDelete) {
      // Blur regions live in annotationRegions, so this covers both rows.
      const annotations = normaliseSpansToDuration(
        toSpans(annotationRegions),
        totalMs,
        safeMinDurationMs,
      )
      for (const span of annotations.clamped) onAnnotationSpanChange?.(span.id, span)
      for (const id of annotations.dropped) onAnnotationDelete?.(id)
    }

    if (onAudioEditSpanChange || onAudioEditDelete) {
      const audio = normaliseSpansToDuration(toSpans(audioEditRegions), totalMs, safeMinDurationMs)
      for (const span of audio.clamped) onAudioEditSpanChange?.(span.id, span)
      for (const id of audio.dropped) onAudioEditDelete?.(id)
    }
  }, [
    zoomRegions,
    annotationRegions,
    audioEditRegions,
    totalMs,
    safeMinDurationMs,
    onZoomSpanChange,
    onZoomDelete,
    onAnnotationSpanChange,
    onAnnotationDelete,
    onAudioEditSpanChange,
    onAudioEditDelete,
  ])

  const hasOverlap = useCallback(
    (newSpan: Span, excludeId?: string): boolean => {
      // Determine which row the item belongs to
      const isZoomItem = zoomRegions.some((r) => r.id === excludeId)
      const isAnnotationItem = annotationRegions.some((r) => r.id === excludeId)

      if (isAnnotationItem) {
        return false
      }

      // Strict intersection: snapped items land exactly adjacent and must be accepted.
      const checkOverlap = (regions: (ZoomRegion | TrimRegion)[]) => {
        return regions.some((region) => {
          if (region.id === excludeId) return false
          return spansIntersect(newSpan, { start: region.startMs, end: region.endMs })
        })
      }

      if (isZoomItem) {
        return checkOverlap(zoomRegions)
      }

      return false
    },
    [zoomRegions, annotationRegions],
  )

  const handleAddZoom = useCallback(() => {
    if (!videoDuration || videoDuration === 0 || totalMs === 0) {
      return
    }

    const defaultDuration = Math.min(1000, totalMs)
    if (defaultDuration <= 0) {
      return
    }

    // Always place zoom at playhead; reject if it lands inside an existing
    // region or there is no room before the next one.
    const startPos = Math.max(0, Math.min(currentTimeMs, totalMs))
    const { ok, gapMs } = findFreeGapAt(zoomRegions, startPos, totalMs)
    if (!ok) {
      toast.error(t('timeline.cannotPlaceZoom'), {
        description: t('timeline.cannotPlaceZoomDesc'),
      })
      return
    }

    const actualDuration = Math.min(1000, gapMs)
    onZoomAdded({ start: startPos, end: startPos + actualDuration })
  }, [videoDuration, totalMs, currentTimeMs, zoomRegions, onZoomAdded, t])

  const toggleScissorsMode = useCallback(() => {
    setScissorsMode((prev) => !prev)
  }, [])

  const handleAddAnnotation = useCallback(() => {
    if (!videoDuration || videoDuration === 0 || totalMs === 0 || !onAnnotationAdded) {
      return
    }

    const defaultDuration = Math.min(1000, totalMs)
    if (defaultDuration <= 0) {
      return
    }

    // Multiple annotations can exist at the same timestamp
    const startPos = Math.max(0, Math.min(currentTimeMs, totalMs))
    const endPos = Math.min(startPos + defaultDuration, totalMs)

    onAnnotationAdded({ start: startPos, end: endPos })
  }, [videoDuration, totalMs, currentTimeMs, onAnnotationAdded])

  const handleAddBlur = useCallback(() => {
    if (!BLUR_REGIONS_ENABLED || !onBlurAdded) return
    if (!videoDuration || videoDuration === 0 || totalMs === 0) return

    const defaultDuration = Math.min(1000, totalMs)
    if (defaultDuration <= 0) return

    // Like annotations, blur regions may overlap each other.
    const startPos = Math.max(0, Math.min(currentTimeMs, totalMs))
    const endPos = Math.min(startPos + defaultDuration, totalMs)
    onBlurAdded({ start: startPos, end: endPos })
  }, [videoDuration, totalMs, currentTimeMs, onBlurAdded])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      // Number keys set the selected zoom's level. Guarded like every other
      // editor shortcut: not while a dialog owns the screen, not in a text
      // field, and not when the digit carries a modifier (Ctrl+Shift+2 is the
      // global stop-recording accelerator).
      if (
        onZoomDepthChange &&
        selectedZoomId &&
        !isModalDialogOpen() &&
        !isTextEditingTarget(e.target) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        const depthIndex = ZOOM_DEPTH_SHORTCUT_KEYS.indexOf(
          e.key as (typeof ZOOM_DEPTH_SHORTCUT_KEYS)[number],
        )
        if (depthIndex !== -1) {
          e.preventDefault()
          onZoomDepthChange((depthIndex + 1) as ZoomDepth)
          return
        }
      }

      if (matchesShortcut(e, keyShortcuts.addKeyframe, isMacPlatform)) {
        addKeyframe()
      }
      if (matchesShortcut(e, keyShortcuts.addZoom, isMacPlatform)) {
        handleAddZoom()
      }
      if (matchesShortcut(e, keyShortcuts.toggleScissors, isMacPlatform)) {
        toggleScissorsMode()
      }
      if (e.key === 'Escape') {
        setScissorsMode(false)
      }
      if (matchesShortcut(e, keyShortcuts.addAnnotation, isMacPlatform)) {
        handleAddAnnotation()
      }
      if (BLUR_REGIONS_ENABLED && matchesShortcut(e, keyShortcuts.addBlur, isMacPlatform)) {
        handleAddBlur()
      }

      // Tab: Cycle through overlapping annotations at current time (blur
      // regions are left out; they are picked from their own row).
      if (e.key === 'Tab' && annotationRegions.length > 0) {
        const currentTimeMs = Math.round(currentTime * 1000)
        const overlapping = getSelectionCycleAnnotations(annotationRegions, currentTimeMs)

        if (overlapping.length > 0) {
          e.preventDefault()

          if (!selectedAnnotationId || !overlapping.some((a) => a.id === selectedAnnotationId)) {
            onSelectAnnotation?.(overlapping[0].id)
          } else {
            // Cycle to next annotation
            const currentIndex = overlapping.findIndex((a) => a.id === selectedAnnotationId)
            const nextIndex = e.shiftKey
              ? (currentIndex - 1 + overlapping.length) % overlapping.length // Shift+Tab = backward
              : (currentIndex + 1) % overlapping.length // Tab = forward
            onSelectAnnotation?.(overlapping[nextIndex].id)
          }
        }
      }
      // Delete key, Backspace, or configurable delete shortcut
      if (
        e.key === 'Delete' ||
        e.key === 'Backspace' ||
        matchesShortcut(e, keyShortcuts.deleteSelected, isMacPlatform)
      ) {
        if (selectedKeyframeId) {
          deleteSelectedKeyframe()
        } else if (selectedZoomId) {
          deleteSelectedZoom()
        } else if (selectedSegmentId) {
          deleteSelectedSegment()
        } else if (selectedAnnotationId) {
          deleteSelectedAnnotation()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    addKeyframe,
    handleAddZoom,
    toggleScissorsMode,
    handleAddAnnotation,
    handleAddBlur,
    deleteSelectedKeyframe,
    deleteSelectedZoom,
    deleteSelectedSegment,
    deleteSelectedAnnotation,
    onZoomDepthChange,
    selectedKeyframeId,
    selectedZoomId,
    selectedSegmentId,
    selectedAnnotationId,
    annotationRegions,
    currentTime,
    onSelectAnnotation,
    keyShortcuts,
    isMacPlatform,
  ])

  // Custom smooth zoom (centered on playhead) and pan handler
  // Intercepts Ctrl+Scroll before dnd-timeline's default handler via capture phase
  useEffect(() => {
    const container = timelineContainerRef.current
    if (!container || totalMs <= 0) return

    let rafId: number | null = null
    let accZoom = 0
    let accPan = 0

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()

      // Firefox reports lines and some devices report pages; the maths below
      // is tuned for pixels, so convert first.
      const deltaX = normaliseWheelDeltaPx(e.deltaX, e.deltaMode)
      const deltaY = normaliseWheelDeltaPx(e.deltaY, e.deltaMode)

      if (e.shiftKey) {
        accPan += deltaX || deltaY
      } else {
        accZoom += deltaY
      }

      if (rafId !== null) return

      rafId = requestAnimationFrame(() => {
        const zd = accZoom
        const pd = accPan
        accZoom = 0
        accPan = 0
        rafId = null

        setRange((prev) => {
          let start = prev.start
          let end = prev.end
          const dur = end - start

          // Pan (Shift + Ctrl/Cmd + Scroll)
          if (pd !== 0) {
            const w = container.clientWidth
            const shift = w > 0 ? (pd / w) * dur : 0
            start += shift
            end += shift
          }

          // Zoom centered on playhead (Ctrl/Cmd + Scroll)
          if (zd !== 0) {
            const factor = Math.pow(1.0015, zd)
            const newDur = Math.max(
              timelineScale.minVisibleRangeMs,
              Math.min(totalMs, dur * factor),
            )

            const phead = Math.max(0, Math.min(currentTimeMsRef.current, totalMs))
            let ratio: number
            if (phead >= start && phead <= end && dur > 0) {
              // Playhead visible — keep it at same screen position
              ratio = (phead - start) / dur
            } else {
              // Playhead off-screen — center view on it
              ratio = 0.5
            }

            start = phead - newDur * ratio
            end = start + newDur
          }

          // Clamp to video bounds
          let finalDur = end - start
          if (start < 0) {
            start = 0
            end = start + finalDur
          }
          if (end > totalMs) {
            end = totalMs
            start = end - finalDur
          }
          start = Math.max(0, start)
          end = Math.min(totalMs, end)

          // Enforce minimum visible range
          finalDur = end - start
          if (finalDur < timelineScale.minVisibleRangeMs) {
            const mid = (start + end) / 2
            const half = timelineScale.minVisibleRangeMs / 2
            start = Math.max(0, mid - half)
            end = start + timelineScale.minVisibleRangeMs
            if (end > totalMs) {
              end = totalMs
              start = Math.max(0, end - timelineScale.minVisibleRangeMs)
            }
          }

          return { start, end }
        })
      })
    }

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true })
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [totalMs, timelineScale.minVisibleRangeMs, setRange])

  const clampedRange = useMemo<Range>(() => {
    if (totalMs === 0) {
      return range
    }

    return {
      start: Math.max(0, Math.min(range.start, totalMs)),
      end: Math.min(range.end, totalMs),
    }
  }, [range, totalMs])

  // Dynamic axis scale — adapts markers/grid to the current zoom level
  const displayInterval = useMemo(
    () => calculateDisplayInterval(clampedRange.end - clampedRange.start),
    [clampedRange],
  )

  const timelineItems = useMemo<TimelineRenderItem[]>(() => {
    const zooms: TimelineRenderItem[] = zoomRegions.map((region, index) => ({
      id: region.id,
      rowId: ZOOM_ROW_ID,
      span: { start: region.startMs, end: region.endMs },
      label: `${t('timeline.zoom')} ${index + 1}`,
      zoomDepth: region.depth,
      zoomScale: getZoomScale(region),
      zoomAutoFocus: region.focusMode === 'auto',
      variant: 'zoom',
    }))

    // Segments are rendered directly in the row — no draggable trim items

    const annotations: TimelineRenderItem[] = annotationRegions.map((region) => {
      let label: string

      if (region.type === 'blur') {
        return {
          id: region.id,
          rowId: BLUR_ROW_ID,
          span: { start: region.startMs, end: region.endMs },
          label: t('timeline.blur'),
          variant: 'blur',
        }
      }

      if (region.type === 'text') {
        // Show text preview
        const preview = region.content.trim() || t('timeline.emptyText')
        label = preview.length > 20 ? `${preview.substring(0, 20)}...` : preview
      } else if (region.type === 'image') {
        label = t('timeline.image')
      } else {
        label = t('timeline.annotation')
      }

      return {
        id: region.id,
        rowId: ANNOTATION_ROW_ID,
        span: { start: region.startMs, end: region.endMs },
        label,
        variant: 'annotation',
      }
    })

    const subtitles: TimelineRenderItem[] = subtitleCues.map((cue, index) => ({
      id: cue.id || `subtitle-${index + 1}`,
      rowId: SUBTITLE_ROW_ID,
      span: { start: cue.startMs, end: cue.endMs },
      label: cue.text.length > 28 ? `${cue.text.slice(0, 28)}...` : cue.text,
      variant: 'subtitle',
    }))

    const audioEdits: TimelineRenderItem[] = audioEditRegions.map((region, index) => ({
      id: region.id || `audio-edit-${index + 1}`,
      rowId: AUDIO_ROW_ID,
      span: { start: region.startMs, end: region.endMs },
      label: t('timeline.audioMutedSegment'),
      variant: 'audio-edit',
    }))

    return [...zooms, ...annotations, ...subtitles, ...audioEdits]
  }, [zoomRegions, annotationRegions, subtitleCues, audioEditRegions, t])

  // Snap sources for TimelineWrapper (all in effective time)
  const zoomSnapSpans = useMemo(
    () => zoomRegions.map((r) => ({ id: r.id, start: r.startMs, end: r.endMs })),
    [zoomRegions],
  )
  const annotationSnapSpans = useMemo(
    () => annotationRegions.map((r) => ({ id: r.id, start: r.startMs, end: r.endMs })),
    [annotationRegions],
  )
  const keyframeTimesMs = useMemo(() => keyframes.map((kf) => kf.time), [keyframes])
  // Segment boundaries (the orange split lines) between two kept segments
  const segmentBoundaryTimesMs = useMemo(() => {
    const times: number[] = []
    for (let i = 1; i < segments.length; i++) {
      const prev = segments[i - 1]
      const seg = segments[i]
      if (prev.deleted || seg.deleted) continue
      times.push(Math.round(sourceToEffectiveMsWithSegments(seg.startMs, segments)))
    }
    return times
  }, [segments])

  const handleItemSpanChange = useCallback(
    (id: string, span: Span) => {
      if (zoomRegions.some((r) => r.id === id)) {
        onZoomSpanChange(id, span)
      } else if (annotationRegions.some((r) => r.id === id)) {
        onAnnotationSpanChange?.(id, span)
      }
    },
    [zoomRegions, annotationRegions, onZoomSpanChange, onAnnotationSpanChange],
  )

  if (!videoDuration || videoDuration === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center rounded-lg bg-[#09090b] gap-3">
        <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center">
          <Plus className="w-6 h-6 text-slate-600" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-slate-300">{t('timeline.noVideoLoaded')}</p>
          <p className="text-xs text-slate-500 mt-1">{t('timeline.dragDropToStart')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-[#09090b] overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-[#09090b]">
        <div className="flex items-center gap-1">
          <Button
            onClick={handleAddZoom}
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-slate-400 hover:text-[#34B27B] hover:bg-[#34B27B]/10 transition-all"
            title={t('timeline.addZoom')}
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button
            onClick={toggleScissorsMode}
            variant="ghost"
            size="icon"
            className={cn(
              'h-7 w-7 transition-all',
              scissorsMode
                ? 'text-[#ef4444] bg-[#ef4444]/20 ring-1 ring-[#ef4444]/40'
                : 'text-slate-400 hover:text-[#ef4444] hover:bg-[#ef4444]/10',
            )}
            title={scissorsMode ? t('timeline.split') + ' (Esc)' : t('timeline.split') + ' (S)'}
          >
            <Scissors className="w-4 h-4" />
          </Button>
          <Button
            onClick={handleAddAnnotation}
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-slate-400 hover:text-[#B4A046] hover:bg-[#B4A046]/10 transition-all"
            title={t('timeline.addAnnotation')}
          >
            <MessageSquare className="w-4 h-4" />
          </Button>
          {BLUR_REGIONS_ENABLED && (
            <Button
              onClick={handleAddBlur}
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-slate-400 hover:text-[#8B5CF6] hover:bg-[#8B5CF6]/10 transition-all"
              title={t('timeline.addBlur')}
            >
              <EyeOff className="w-4 h-4" />
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-all gap-1"
              >
                <span className="font-medium">
                  {aspectRatio === 'native'
                    ? t('settings.aspectRatioNative')
                    : getAspectRatioLabel(aspectRatio)}
                </span>
                <ChevronDown className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-[#1a1a1a] border-white/10">
              {ASPECT_RATIOS.map((ratio) => (
                <DropdownMenuItem
                  key={ratio}
                  onClick={() => onAspectRatioChange(ratio)}
                  className="text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3"
                >
                  <span>
                    {ratio === 'native'
                      ? t('settings.aspectRatioNative')
                      : getAspectRatioLabel(ratio)}
                  </span>
                  {aspectRatio === ratio && <Check className="w-3 h-3 text-[#34B27B]" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="w-[1px] h-4 bg-white/10" />
          <TutorialHelp />
          {onResetAllSegmentEdits && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-all"
                  title={t('timeline.moreActions')}
                  aria-label={t('timeline.moreActions')}
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-[#1a1a1a] border-white/10">
                <DropdownMenuItem
                  onClick={() => setResetEditsConfirmOpen(true)}
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10 cursor-pointer gap-2"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>{t('timeline.resetAllEdits')}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-4 text-[10px] text-slate-500 font-medium">
          <span className="flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-sans">
              {scrollLabels.pan}
            </kbd>
            <span>{t('timeline.pan')}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[#34B27B] font-sans">
              {scrollLabels.zoom}
            </kbd>
            <span>{t('timeline.zoomAction')}</span>
          </span>
        </div>
      </div>
      <div
        ref={timelineContainerRef}
        className="flex-1 overflow-x-hidden overflow-y-auto themed-scrollbar bg-[#09090b] relative"
        onClick={() => setSelectedKeyframeId(null)}
      >
        <TimelineWrapper
          range={clampedRange}
          videoDuration={videoDuration}
          hasOverlap={hasOverlap}
          onRangeChange={setRange}
          minItemDurationMs={timelineScale.minItemDurationMs}
          minVisibleRangeMs={timelineScale.minVisibleRangeMs}
          gridSizeMs={displayInterval.gridMs}
          onItemSpanChange={handleItemSpanChange}
          allRegionSpans={zoomSnapSpans}
          softSnapSpans={annotationSnapSpans}
          currentTimeMs={currentTimeMs}
          keyframeTimesMs={keyframeTimesMs}
          extraSnapTimesMs={segmentBoundaryTimesMs}
        >
          <RecordingMarkers
            markersMs={recordingMarkersMs}
            videoDurationMs={totalMs}
            onSeek={onSeek}
          />
          <KeyframeMarkers
            keyframes={keyframes}
            selectedKeyframeId={selectedKeyframeId}
            setSelectedKeyframeId={setSelectedKeyframeId}
            onKeyframeMove={handleKeyframeMove}
            videoDurationMs={totalMs}
            timelineRef={timelineContainerRef}
          />
          <Timeline
            items={timelineItems}
            videoDurationMs={totalMs}
            intervalMs={displayInterval.intervalMs}
            currentTimeMs={currentTimeMs}
            onSeek={onSeek}
            onSelectZoom={onSelectZoom}
            onSelectSegment={onSelectSegment}
            onSelectAnnotation={onSelectAnnotation}
            selectedZoomId={selectedZoomId}
            selectedSegmentId={selectedSegmentId}
            selectedAnnotationId={selectedAnnotationId}
            hasAudioTrack={hasAudioTrack}
            audioEnabled={audioEnabled}
            audioGain={audioGain}
            keyframes={keyframes}
            segments={segments}
            scissorsMode={scissorsMode}
            onSplitAtTime={onSplitAtTime}
            onScissorsDone={() => setScissorsMode(false)}
            onHoverPreview={onHoverPreview}
            onHoverCommit={onHoverCommit}
            isPlaying={isPlaying}
            onRangeChange={setRange}
            rowHints={rowHints}
            waveform={waveform}
            waveformHint={waveformHint}
          />
        </TimelineWrapper>
      </div>
      <Dialog open={resetEditsConfirmOpen} onOpenChange={setResetEditsConfirmOpen}>
        <DialogContent className="bg-[#09090b] border-white/10 text-white max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('timeline.resetAllEdits')}</DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              {t('timeline.resetAllEditsConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setResetEditsConfirmOpen(false)}
              className="h-8 text-xs text-slate-300 hover:bg-white/10"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                setResetEditsConfirmOpen(false)
                onResetAllSegmentEdits?.()
              }}
              className="h-8 gap-2 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/30 text-xs"
            >
              <RotateCcw className="w-3 h-3" />
              {t('timeline.resetAllEditsConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
