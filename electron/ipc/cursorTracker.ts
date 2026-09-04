import { screen } from 'electron'
import {
  isPointInsideBounds,
  normalizePointToBounds,
  resolveCursorBoundsForSource,
  type CaptureBounds,
  type CaptureBoundsResolution,
  type CaptureBoundsMode,
  type CaptureSourceRef,
} from '../../src/lib/cursor/captureSpace'
import {
  getNativeCursorKind,
  startNativeCursorKindMonitor,
  stopNativeCursorKindMonitor,
} from '../native/cursorKindMonitor'
import {
  drainNativeMouseButtonTransitions,
  startNativeMouseButtonMonitor,
  stopNativeMouseButtonMonitor,
} from '../native/mouseButtonMonitor'
import type { CursorKind } from '../../src/lib/cursor/cursorKinds'
import type { IpcContext, SelectedSource } from './context'
import {
  type CursorTrackEventPayload,
  type CursorTrackPauseRange,
  type CursorTrackPayload,
  compactCursorTrackPauseRanges,
  compactCursorTrackSamples,
  isCursorTrackMarkerEvent,
  isCursorTrackPointerEvent,
  MAX_CURSOR_TRACK_MARKERS,
  sanitizeCursorTrack,
} from './cursorTrack'
import { getWindowBoundsById, parseWindowIdFromSourceId } from './windowBounds'

/**
 * Live cursor tracker for a recording: samples the pointer at ~60 Hz, folds
 * native mouse-button transitions into click / selection gestures, and maps
 * points into the capture space of the selected source. Moved verbatim from
 * `handlers.ts`; the algorithm is owned by the cursor/zoom streams, not here.
 */

type CursorTrackerStartOptions = {
  source?: CaptureSourceRef | null
  captureSize?: {
    width?: number
    height?: number
  } | null
}

type CursorTrackerRuntime = {
  timer: NodeJS.Timeout
  boundsRefreshTimer: NodeJS.Timeout | null
  refreshingBounds: boolean
  startedAt: number
  samples: CursorTrackPayload['samples']
  events: NonNullable<CursorTrackPayload['events']>
  bounds: CaptureBounds
  boundsMode: CaptureBoundsMode
  displayId?: string
  sourceRef?: CaptureSourceRef
  windowId?: number
  captureSize?: { width: number; height: number }
  lastPoint: { x: number; y: number } | null
  lastTickAt: number
  lastSampleAt: number
  lastSpeed: number
  stillFrames: number
  lastClickAt: number
  useHeuristicClick: boolean
  leftButtonDown: boolean
  activeGesture: ActiveSelectionGesture | null
  clickCount: number
  /**
   * Pause bookkeeping (A5): wall-clock `Date.now()` of the open pause, plus the
   * closed ranges relative to `startedAt`. Sampling continues while paused; the
   * ranges are compacted out of the track on stop.
   */
  pauseStartedAt: number | null
  pauseRanges: CursorTrackPauseRange[]
}

type ActiveSelectionGesture = {
  startMs: number
  startPoint: { x: number; y: number }
  endPoint: { x: number; y: number }
  minX: number
  minY: number
  maxX: number
  maxY: number
  maxDistance: number
  hasVisiblePoint: boolean
}

const GESTURE_EVENT_BUFFER_LIMIT = 20_000
const SELECTION_MIN_DISTANCE_NORM = 0.022
const SELECTION_MIN_DIMENSION_NORM = 0.012

/**
 * Live-buffer ceiling. The tracker stores up to ~60 samples a second, so this is
 * a bit over an hour of raw sampling; reaching it compacts the buffer in place
 * (30 Hz decimation around the clicks, then a uniform thin) instead of dropping
 * the oldest samples, which is what used to end the cursor track a couple of
 * minutes into a recording.
 */
const RUNTIME_SAMPLE_LIMIT = 240_000
/** Compaction thins to this, so the next compaction is a full buffer-refill away. */
const RUNTIME_SAMPLE_TARGET = 180_000

function compactTrackerSampleBuffer(tracker: CursorTrackerRuntime): void {
  const before = tracker.samples.length
  // Markers are instants with no span, so they never guard samples.
  tracker.samples = compactCursorTrackSamples(
    tracker.samples,
    tracker.events.filter(isCursorTrackPointerEvent),
    {
      // Already the live buffer: the count is the binding limit here, and the
      // serialized-size guard runs once on the way out through `sanitizeCursorTrack`.
      compactAboveSamples: 0,
      maxSamples: RUNTIME_SAMPLE_TARGET,
      maxSampleBytes: Number.POSITIVE_INFINITY,
    },
  )
  console.info(
    `[cursor-tracker] live buffer compacted: ${before} -> ${tracker.samples.length} samples`,
  )
}

function pushCursorSample(
  tracker: CursorTrackerRuntime,
  now: number,
  point: { x: number; y: number },
  cursorKind: CursorKind,
  click = false,
): void {
  const timeMs = Math.max(0, now - tracker.startedAt)
  const normalized = normalizePointToBounds(point, tracker.bounds)
  const inCaptureBounds = isPointInsideBounds(point, tracker.bounds, 0.5)
  const visible = tracker.boundsMode === 'virtual-desktop' ? true : inCaptureBounds

  tracker.samples.push({
    timeMs,
    x: normalized.x,
    y: normalized.y,
    click: click && visible,
    visible,
    cursorKind,
  })

  if (click && visible) {
    tracker.clickCount += 1
  }

  if (tracker.samples.length > RUNTIME_SAMPLE_LIMIT) {
    compactTrackerSampleBuffer(tracker)
  }

  tracker.lastSampleAt = now
}

function openPauseRange(tracker: CursorTrackerRuntime, now: number): boolean {
  if (tracker.pauseStartedAt !== null) return false
  tracker.pauseStartedAt = now
  return true
}

function closePauseRange(tracker: CursorTrackerRuntime, now: number): boolean {
  if (tracker.pauseStartedAt === null) return false
  tracker.pauseRanges.push({
    startMs: Math.max(0, tracker.pauseStartedAt - tracker.startedAt),
    endMs: Math.max(0, now - tracker.startedAt),
  })
  tracker.pauseStartedAt = null
  return true
}

function normalizeEventPoint(point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, Number.isFinite(point.x) ? point.x : 0)),
    y: Math.max(0, Math.min(1, Number.isFinite(point.y) ? point.y : 0)),
  }
}

function appendCursorEvent(tracker: CursorTrackerRuntime, event: CursorTrackEventPayload): void {
  tracker.events.push(event)
  if (tracker.events.length > GESTURE_EVENT_BUFFER_LIMIT) {
    tracker.events.splice(0, 500)
  }
}

function startSelectionGesture(
  tracker: CursorTrackerRuntime,
  now: number,
  point: { x: number; y: number },
): void {
  const normalized = normalizeEventPoint(normalizePointToBounds(point, tracker.bounds))
  const hasVisiblePoint =
    tracker.boundsMode === 'virtual-desktop' || isPointInsideBounds(point, tracker.bounds, 0.5)
  tracker.activeGesture = {
    startMs: Math.max(0, now - tracker.startedAt),
    startPoint: normalized,
    endPoint: normalized,
    minX: normalized.x,
    minY: normalized.y,
    maxX: normalized.x,
    maxY: normalized.y,
    maxDistance: 0,
    hasVisiblePoint,
  }
}

function updateSelectionGesture(
  tracker: CursorTrackerRuntime,
  point: { x: number; y: number },
): void {
  if (!tracker.activeGesture) return
  const gesture = tracker.activeGesture
  const normalized = normalizeEventPoint(normalizePointToBounds(point, tracker.bounds))
  gesture.endPoint = normalized
  gesture.minX = Math.min(gesture.minX, normalized.x)
  gesture.minY = Math.min(gesture.minY, normalized.y)
  gesture.maxX = Math.max(gesture.maxX, normalized.x)
  gesture.maxY = Math.max(gesture.maxY, normalized.y)
  const distanceFromStart = Math.hypot(
    normalized.x - gesture.startPoint.x,
    normalized.y - gesture.startPoint.y,
  )
  gesture.maxDistance = Math.max(gesture.maxDistance, distanceFromStart)
  if (!gesture.hasVisiblePoint) {
    gesture.hasVisiblePoint =
      tracker.boundsMode === 'virtual-desktop' || isPointInsideBounds(point, tracker.bounds, 0.5)
  }
}

function finalizeSelectionGesture(
  tracker: CursorTrackerRuntime,
  now: number,
  point: { x: number; y: number },
  cursorKind: CursorKind,
): void {
  if (!tracker.activeGesture) return
  updateSelectionGesture(tracker, point)
  const gesture = tracker.activeGesture
  tracker.activeGesture = null

  if (!gesture.hasVisiblePoint) return

  const endMs = Math.max(gesture.startMs, now - tracker.startedAt)
  const width = Math.max(0, gesture.maxX - gesture.minX)
  const height = Math.max(0, gesture.maxY - gesture.minY)
  const isSelection =
    gesture.maxDistance >= SELECTION_MIN_DISTANCE_NORM ||
    width >= SELECTION_MIN_DIMENSION_NORM ||
    height >= SELECTION_MIN_DIMENSION_NORM

  if (!isSelection) {
    appendCursorEvent(tracker, {
      type: 'click',
      startMs: gesture.startMs,
      endMs,
      point: gesture.endPoint,
      startPoint: gesture.startPoint,
      endPoint: gesture.endPoint,
    })
    pushCursorSample(tracker, now, point, cursorKind, true)
    return
  }

  const centerPoint = normalizeEventPoint({
    x: (gesture.minX + gesture.maxX) / 2,
    y: (gesture.minY + gesture.maxY) / 2,
  })

  appendCursorEvent(tracker, {
    type: 'selection',
    startMs: gesture.startMs,
    endMs,
    point: centerPoint,
    startPoint: gesture.startPoint,
    endPoint: gesture.endPoint,
    bounds: {
      minX: gesture.minX,
      minY: gesture.minY,
      maxX: gesture.maxX,
      maxY: gesture.maxY,
      width,
      height,
    },
  })
}

export function normalizeSourceRef(
  input?: CaptureSourceRef | SelectedSource | null,
): CaptureSourceRef | undefined {
  if (!input) return undefined
  const sourceId = typeof input.id === 'string' ? input.id : ''
  const displayId =
    input.display_id === null || input.display_id === undefined
      ? undefined
      : String(input.display_id)
  if (!sourceId && !displayId) return undefined
  return {
    id: sourceId || undefined,
    display_id: displayId,
  }
}

function normalizeCaptureSize(
  input?: CursorTrackerStartOptions['captureSize'],
): { width: number; height: number } | undefined {
  if (!input) return undefined
  const width = Math.floor(Number(input.width))
  const height = Math.floor(Number(input.height))
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    return undefined
  }
  return { width, height }
}

function resolveWindowCaptureFallbackBounds(args: {
  displays: Electron.Display[]
  initialResolution: CaptureBoundsResolution
  captureSize?: { width: number; height: number }
  point: { x: number; y: number }
}): { bounds: CaptureBounds; mode: CaptureBoundsMode; displayId?: string } {
  const matchedDisplay = args.initialResolution.displayId
    ? args.displays.find((display) => String(display.id) === args.initialResolution.displayId)
    : undefined
  const nearestDisplay = screen.getDisplayNearestPoint(args.point)
  const displayForScale = matchedDisplay ?? nearestDisplay
  const displayBounds = displayForScale?.bounds ?? args.initialResolution.bounds

  if (!args.captureSize) {
    return {
      bounds: {
        x: displayBounds.x,
        y: displayBounds.y,
        width: Math.max(1, displayBounds.width),
        height: Math.max(1, displayBounds.height),
      },
      mode: 'source-display',
      displayId: displayForScale ? String(displayForScale.id) : args.initialResolution.displayId,
    }
  }

  const scaleFactor = Math.max(1, Number(displayForScale?.scaleFactor) || 1)
  const width = Math.max(1, args.captureSize.width / scaleFactor)
  const height = Math.max(1, args.captureSize.height / scaleFactor)
  const normalizedOnDisplay = normalizePointToBounds(args.point, displayBounds)

  return {
    bounds: {
      x: args.point.x - normalizedOnDisplay.x * width,
      y: args.point.y - normalizedOnDisplay.y * height,
      width,
      height,
    },
    mode: 'source-display',
    displayId: displayForScale ? String(displayForScale.id) : args.initialResolution.displayId,
  }
}

/** Outcome of flagging a moment: the recording-relative time, or why nothing happened. */
export type RecordingMarkerResult =
  | { added: true; timeMs: number; count: number }
  | { added: false; reason: 'not-recording' | 'paused' | 'limit' }

export type CursorTrackerRegistration = {
  /** Stops the tracker (if any) and returns the sanitized track; used at shutdown. */
  stopCursorTracker: () => CursorTrackPayload | undefined
  /**
   * D2: flag the current moment. Called from the global shortcut and from the
   * `cursor-tracker-marker` channel the HUD button uses, so both write the same
   * event on the same clock the samples use.
   */
  addRecordingMarker: () => RecordingMarkerResult
}

export function registerCursorTrackerHandlers(ctx: IpcContext): CursorTrackerRegistration {
  const { ipcMain } = ctx
  let cursorTracker: CursorTrackerRuntime | null = null

  const stopCursorTracker = (): CursorTrackPayload | undefined => {
    if (!cursorTracker) return undefined
    globalThis.clearInterval(cursorTracker.timer)
    if (cursorTracker.boundsRefreshTimer) {
      globalThis.clearInterval(cursorTracker.boundsRefreshTimer)
      cursorTracker.boundsRefreshTimer = null
    }
    if (cursorTracker.activeGesture) {
      const point = cursorTracker.lastPoint ?? screen.getCursorScreenPoint()
      finalizeSelectionGesture(cursorTracker, Date.now(), point, getNativeCursorKind())
      cursorTracker.leftButtonDown = false
    }
    stopNativeCursorKindMonitor()
    stopNativeMouseButtonMonitor()
    // A stop while paused closes the open range at the stop instant.
    closePauseRange(cursorTracker, Date.now())
    const compacted = compactCursorTrackPauseRanges(
      { samples: cursorTracker.samples, events: cursorTracker.events },
      cursorTracker.pauseRanges,
    )
    const payload = sanitizeCursorTrack({
      source: 'recorded',
      samples: compacted.samples,
      events: compacted.events,
      space: {
        mode: cursorTracker.boundsMode,
        displayId: cursorTracker.displayId,
        bounds: cursorTracker.bounds,
      },
      stats: {
        sampleCount: compacted.samples.length,
        clickCount: cursorTracker.clickCount,
      },
      capture: {
        sourceId: cursorTracker.sourceRef?.id ?? undefined,
        width: cursorTracker.captureSize?.width,
        height: cursorTracker.captureSize?.height,
      },
    })
    cursorTracker = null
    return payload
  }

  ipcMain.handle('cursor-tracker-start', async (_, options?: CursorTrackerStartOptions) => {
    // On Linux/Wayland, screen.getCursorScreenPoint() returns stale/frozen
    // values because Wayland's security model prevents apps from querying
    // the global cursor position. Skip cursor tracking entirely and let the
    // video stream's embedded cursor be used instead.
    if (process.platform === 'linux') {
      const sessionType = process.env['XDG_SESSION_TYPE'] || ''
      if (sessionType === 'wayland') {
        console.warn(
          '[cursor-tracker] Wayland detected — cursor position tracking is not supported. The cursor embedded in the video stream will be used instead.',
        )
        return {
          success: false,
          warningCode: 'WAYLAND_UNSUPPORTED',
          warningMessage:
            'Cursor position tracking is not available on Wayland. The cursor will be captured directly in the video stream.',
        }
      }
    }

    stopCursorTracker()
    await startNativeCursorKindMonitor()
    const nativeMouseMonitorReady = await startNativeMouseButtonMonitor()

    const startedAt = Date.now()
    const initialPoint = screen.getCursorScreenPoint()
    const sourceRef =
      normalizeSourceRef(options?.source) ?? normalizeSourceRef(ctx.session.selectedSource)
    const captureSize = normalizeCaptureSize(options?.captureSize)
    const windowId = parseWindowIdFromSourceId(sourceRef?.id)
    console.log('[cursor-tracker] starting:', {
      sourceId: sourceRef?.id,
      windowId,
      captureSize,
      initialPoint,
      platform: process.platform,
    })
    const displayObjects = screen.getAllDisplays()
    const displaySnapshot = displayObjects.map((display) => ({
      id: display.id,
      bounds: display.bounds,
    }))
    const initialResolution = resolveCursorBoundsForSource({
      displays: displaySnapshot,
      source: sourceRef,
      pointHint: initialPoint,
    })
    let captureBounds = initialResolution.bounds
    let captureMode = initialResolution.mode
    let captureDisplayId = initialResolution.displayId
    let hasNativeWindowBounds = false
    let usingWindowBoundsFallback = false

    if (windowId) {
      const nativeWindowBounds = await getWindowBoundsById(windowId)
      if (nativeWindowBounds) {
        hasNativeWindowBounds = true
        captureBounds = nativeWindowBounds
        captureMode = 'source-display'
        const displayForWindow = screen.getDisplayNearestPoint({
          x: Math.round(nativeWindowBounds.x + nativeWindowBounds.width / 2),
          y: Math.round(nativeWindowBounds.y + nativeWindowBounds.height / 2),
        })
        captureDisplayId = displayForWindow ? String(displayForWindow.id) : captureDisplayId
      }
    }

    if (windowId && !hasNativeWindowBounds) {
      const fallback = resolveWindowCaptureFallbackBounds({
        displays: displayObjects,
        initialResolution,
        captureSize,
        point: initialPoint,
      })
      captureBounds = fallback.bounds
      captureMode = fallback.mode
      captureDisplayId = fallback.displayId
      usingWindowBoundsFallback = true
      console.warn(
        'Native window bounds are unavailable for cursor tracking; using fallback bounds mapping for this recording.',
      )
    }

    console.log('[cursor-tracker] resolved bounds:', {
      captureBounds,
      captureMode,
      captureDisplayId,
      hasNativeWindowBounds,
      usingWindowBoundsFallback,
    })

    const tracker: CursorTrackerRuntime = {
      timer: globalThis.setInterval(() => {
        if (!cursorTracker) return

        const now = Date.now()
        const point = screen.getCursorScreenPoint()
        const cursorKind = getNativeCursorKind()

        const transitions = drainNativeMouseButtonTransitions()
        for (const transition of transitions) {
          if (transition.pressed) {
            if (!cursorTracker.leftButtonDown) {
              cursorTracker.leftButtonDown = true
              startSelectionGesture(cursorTracker, now, point)
            }
            continue
          }

          if (cursorTracker.leftButtonDown) {
            cursorTracker.leftButtonDown = false
            finalizeSelectionGesture(cursorTracker, now, point, cursorKind)
          }
        }

        if (cursorTracker.leftButtonDown) {
          updateSelectionGesture(cursorTracker, point)
        }

        if (!cursorTracker.lastPoint) {
          cursorTracker.lastPoint = { x: point.x, y: point.y }
          cursorTracker.lastTickAt = now
          pushCursorSample(cursorTracker, now, point, cursorKind, false)
          return
        }

        const dt = Math.max(1, now - cursorTracker.lastTickAt)
        const dx = point.x - cursorTracker.lastPoint.x
        const dy = point.y - cursorTracker.lastPoint.y
        const distance = Math.hypot(dx, dy)
        const speed = (distance * 1000) / dt

        if (distance <= 1) {
          cursorTracker.stillFrames += 1
        } else {
          cursorTracker.stillFrames = 0
        }

        let click = false
        if (cursorTracker.useHeuristicClick) {
          if (
            cursorTracker.stillFrames >= 2 &&
            cursorTracker.lastSpeed > 950 &&
            now - cursorTracker.lastClickAt > 240
          ) {
            click = true
            cursorTracker.lastClickAt = now
            cursorTracker.stillFrames = 0
            appendCursorEvent(cursorTracker, {
              type: 'click',
              startMs: Math.max(0, now - cursorTracker.startedAt),
              endMs: Math.max(0, now - cursorTracker.startedAt),
              point: normalizeEventPoint(normalizePointToBounds(point, cursorTracker.bounds)),
            })
          }
        }

        const shouldStore = click || distance >= 0.2 || now - cursorTracker.lastSampleAt >= 33
        if (shouldStore) {
          pushCursorSample(cursorTracker, now, point, cursorKind, click)
        }

        cursorTracker.lastSpeed = speed
        cursorTracker.lastPoint = { x: point.x, y: point.y }
        cursorTracker.lastTickAt = now
      }, 16),
      boundsRefreshTimer: null,
      refreshingBounds: false,
      startedAt,
      samples: [],
      events: [],
      bounds: captureBounds,
      boundsMode: captureMode,
      displayId: captureDisplayId,
      sourceRef,
      windowId,
      captureSize,
      lastPoint: null,
      lastTickAt: startedAt,
      lastSampleAt: startedAt,
      lastSpeed: 0,
      stillFrames: 0,
      lastClickAt: 0,
      useHeuristicClick: !nativeMouseMonitorReady,
      leftButtonDown: false,
      activeGesture: null,
      clickCount: 0,
      pauseStartedAt: null,
      pauseRanges: [],
    }

    cursorTracker = tracker
    if (windowId) {
      tracker.boundsRefreshTimer = globalThis.setInterval(() => {
        void (async () => {
          if (
            !cursorTracker ||
            cursorTracker !== tracker ||
            !tracker.windowId ||
            tracker.refreshingBounds
          ) {
            return
          }

          tracker.refreshingBounds = true
          try {
            const nextBounds = await getWindowBoundsById(tracker.windowId)
            if (!cursorTracker || cursorTracker !== tracker) return

            if (!nextBounds) {
              const point = screen.getCursorScreenPoint()
              const displaySnapshot = screen.getAllDisplays()
              const fallbackResolution = resolveCursorBoundsForSource({
                displays: displaySnapshot.map((display) => ({
                  id: display.id,
                  bounds: display.bounds,
                })),
                source: tracker.sourceRef,
                pointHint: point,
              })
              const fallback = resolveWindowCaptureFallbackBounds({
                displays: displaySnapshot,
                initialResolution: fallbackResolution,
                captureSize: tracker.captureSize,
                point,
              })
              tracker.bounds = fallback.bounds
              tracker.boundsMode = fallback.mode
              tracker.displayId = fallback.displayId
              return
            }

            tracker.bounds = nextBounds
            tracker.boundsMode = 'source-display'
            const displayForWindow = screen.getDisplayNearestPoint({
              x: Math.round(nextBounds.x + nextBounds.width / 2),
              y: Math.round(nextBounds.y + nextBounds.height / 2),
            })
            if (displayForWindow) {
              tracker.displayId = String(displayForWindow.id)
            }
          } finally {
            tracker.refreshingBounds = false
          }
        })()
      }, 120)
    }
    pushCursorSample(tracker, startedAt, initialPoint, getNativeCursorKind(), false)

    const warningMessages: string[] = []
    const warningCodes: string[] = []
    if (usingWindowBoundsFallback) {
      warningCodes.push('window_bounds_fallback')
      warningMessages.push(
        'Window capture is using fallback bounds mapping. Cursor alignment may be less accurate.',
      )
    }
    if (!nativeMouseMonitorReady) {
      warningCodes.push('mouse_button_fallback')
      warningMessages.push(
        'Native mouse button monitor is unavailable. Selection-aware auto zoom will fall back to click heuristics.',
      )
    }

    return {
      success: true,
      warningCode: warningCodes.length > 0 ? warningCodes.join('+') : undefined,
      warningMessage: warningMessages.length > 0 ? warningMessages.join(' ') : undefined,
    }
  })

  // A5: the renderer tells the tracker when the recording is paused / resumed
  // (both the MediaRecorder and the native path) so the wall-clock samples can
  // be compacted onto the gap-free video timeline on stop.
  ipcMain.handle('cursor-tracker-pause', () => {
    if (!cursorTracker) return { success: false, message: 'Cursor tracker is not active.' }
    const changed = openPauseRange(cursorTracker, Date.now())
    return { success: true, changed }
  })

  ipcMain.handle('cursor-tracker-resume', () => {
    if (!cursorTracker) return { success: false, message: 'Cursor tracker is not active.' }
    const changed = closePauseRange(cursorTracker, Date.now())
    return { success: true, changed }
  })

  /**
   * D2: a moment the user flagged. `startedAt` is the same wall clock the
   * samples use, so the marker lands on the video timeline once the pause
   * ranges are compacted out on stop. Flagging while paused is refused rather
   * than silently recorded on a frame the video will not contain.
   */
  const addRecordingMarker = (): RecordingMarkerResult => {
    if (!cursorTracker) return { added: false, reason: 'not-recording' }
    if (cursorTracker.pauseStartedAt !== null) return { added: false, reason: 'paused' }
    const markerCount = cursorTracker.events.filter(isCursorTrackMarkerEvent).length
    if (markerCount >= MAX_CURSOR_TRACK_MARKERS) return { added: false, reason: 'limit' }

    const timeMs = Math.max(0, Math.round(Date.now() - cursorTracker.startedAt))
    // Straight onto the buffer, not through `appendCursorEvent`: that helper
    // drops the oldest 500 entries when the gesture buffer overflows, and a
    // flagged moment must never be one of them.
    cursorTracker.events.push({ type: 'marker', timeMs })
    return { added: true, timeMs, count: markerCount + 1 }
  }

  ipcMain.handle('cursor-tracker-marker', () => addRecordingMarker())

  ipcMain.handle('cursor-tracker-stop', () => {
    const track = stopCursorTracker()
    console.log('[cursor-tracker] stopped:', {
      sampleCount: track?.samples?.length ?? 0,
      eventCount: track?.events?.length ?? 0,
      firstSample: track?.samples?.[0],
      lastSample: track?.samples?.[track.samples.length - 1],
      bounds: track?.space?.bounds,
    })
    return { success: true, track }
  })

  return { stopCursorTracker, addRecordingMarker }
}
