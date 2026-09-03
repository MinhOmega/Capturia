import type { Rotation3D, ZoomFocus, ZoomRegion } from '../types'
import { DEFAULT_ROTATION_3D, getRotation3D, getZoomScale, lerpRotation3D } from '../types'
import {
  CONNECTED_ZOOM_GAP_MS,
  CONNECTED_ZOOM_PAN_DURATION_MS,
  TRANSITION_WINDOW_MS,
  ZOOM_IN_OVERLAP_MS,
  ZOOM_IN_TRANSITION_WINDOW_MS,
} from './constants'
import { type CursorTelemetryPoint, interpolateCursorAt } from './cursorFollowUtils'
import { clampFocusToScale } from './focusUtils'
import { clamp01, cubicBezier, easeOutScreenStudio } from './mathUtils'

export interface DominantRegionOptions {
  /** Pan between regions closer than CONNECTED_ZOOM_GAP_MS instead of zooming out and back in. */
  connectZooms?: boolean
  /**
   * Sorted cursor positions (buildCursorTelemetry). Regions with
   * focusMode 'auto' resolve their focus from the cursor at `timeMs` instead
   * of their static focus; without telemetry they behave as manual.
   */
  cursorTelemetry?: CursorTelemetryPoint[]
}

interface ConnectedRegionPair {
  currentRegion: ZoomRegion
  nextRegion: ZoomRegion
  transitionStart: number
  transitionEnd: number
}

/**
 * Pan between two connected regions. Consumers lerp the two full camera
 * transforms by `progress` (transform space, so scale and translation move
 * together) and read the focus back with computeFocusFromTransform.
 */
export interface ConnectedPanTransition {
  progress: number
  startFocus: ZoomFocus
  endFocus: ZoomFocus
  startScale: number
  endScale: number
}

export interface DominantRegionResult {
  /** The active region with its focus already clamped for its scale; null when unzoomed. */
  region: ZoomRegion | null
  /** Eased zoom progress 0-1. */
  strength: number
  /** Scale to use instead of getZoomScale(region) during a connected pan. */
  blendedScale: number | null
  /**
   * Full 3D tilt of the region the camera is heading to (identity when flat
   * or unzoomed); mid-pan it is already lerped between the two regions.
   * Consumers ramp it in/out with `strength`, the same eased progress the
   * scale uses (zoomCamera.resolveZoomCameraTarget does this).
   */
  rotation3D: Rotation3D
  transition: ConnectedPanTransition | null
}

const EMPTY_RESULT: DominantRegionResult = {
  region: null,
  strength: 0,
  blendedScale: null,
  rotation3D: DEFAULT_ROTATION_3D,
  transition: null,
}

function lerp(start: number, end: number, amount: number) {
  return start + (end - start) * amount
}

function easeConnectedPan(value: number) {
  return cubicBezier(0.1, 0.0, 0.2, 1.0, value)
}

/**
 * Screen Studio-style strength curve: the zoom-in ease starts
 * ZOOM_IN_TRANSITION_WINDOW_MS - ZOOM_IN_OVERLAP_MS before startMs and lands
 * ZOOM_IN_OVERLAP_MS inside the region; holds at 1; eases out over
 * TRANSITION_WINDOW_MS after endMs.
 */
export function computeRegionStrength(region: ZoomRegion, timeMs: number) {
  const zoomInEnd = region.startMs + ZOOM_IN_OVERLAP_MS
  const leadInStart = zoomInEnd - ZOOM_IN_TRANSITION_WINDOW_MS
  const leadOutEnd = region.endMs + TRANSITION_WINDOW_MS

  if (timeMs < leadInStart || timeMs > leadOutEnd) {
    return 0
  }

  if (timeMs < zoomInEnd) {
    const progress = (timeMs - leadInStart) / ZOOM_IN_TRANSITION_WINDOW_MS
    return easeOutScreenStudio(progress)
  }

  if (timeMs <= region.endMs) {
    return 1
  }

  const progress = clamp01((timeMs - region.endMs) / TRANSITION_WINDOW_MS)
  return 1 - easeOutScreenStudio(progress)
}

function getLinearFocus(start: ZoomFocus, end: ZoomFocus, amount: number): ZoomFocus {
  return {
    cx: lerp(start.cx, end.cx, amount),
    cy: lerp(start.cy, end.cy, amount),
  }
}

/**
 * Focus the camera aims at for `region` at `timeMs`: the live cursor position
 * for focusMode 'auto' (when telemetry is available), otherwise the static
 * focus. Always clamped for the effective scale.
 */
function getResolvedFocus(
  region: ZoomRegion,
  zoomScale: number,
  timeMs: number,
  cursorTelemetry?: CursorTelemetryPoint[],
  cursorFocus?: ZoomFocus | null,
): ZoomFocus {
  let focus = region.focus

  if (region.focusMode === 'auto') {
    const resolved =
      cursorFocus !== undefined
        ? cursorFocus
        : cursorTelemetry && cursorTelemetry.length > 0
          ? interpolateCursorAt(cursorTelemetry, timeMs)
          : null
    if (resolved) {
      focus = resolved
    }
  }

  return clampFocusToScale(focus, zoomScale)
}

export function getConnectedRegionPairs(regions: ZoomRegion[]): ConnectedRegionPair[] {
  const sortedRegions = [...regions].sort((a, b) => a.startMs - b.startMs)
  const pairs: ConnectedRegionPair[] = []

  for (let index = 0; index < sortedRegions.length - 1; index += 1) {
    const currentRegion = sortedRegions[index]
    const nextRegion = sortedRegions[index + 1]
    const gapMs = nextRegion.startMs - currentRegion.endMs

    if (gapMs > CONNECTED_ZOOM_GAP_MS) {
      continue
    }

    pairs.push({
      currentRegion,
      nextRegion,
      transitionStart: currentRegion.endMs,
      transitionEnd: currentRegion.endMs + CONNECTED_ZOOM_PAN_DURATION_MS,
    })
  }

  return pairs
}

function getActiveRegion(
  regions: ZoomRegion[],
  timeMs: number,
  connectedPairs: ConnectedRegionPair[],
  cursorTelemetry?: CursorTelemetryPoint[],
): DominantRegionResult | null {
  let bestRegion: ZoomRegion | null = null
  let bestStrength = 0

  for (const region of regions) {
    // A connected pair owns the time between the first region's end and the
    // second region's start: the first must not ease out, the second must
    // not ease in (the pan / hold replace both).
    const outgoingPair = connectedPairs.find((pair) => pair.currentRegion.id === region.id)
    if (outgoingPair && timeMs > outgoingPair.currentRegion.endMs) {
      continue
    }

    const incomingPair = connectedPairs.find((pair) => pair.nextRegion.id === region.id)
    if (incomingPair && timeMs < incomingPair.transitionEnd) {
      continue
    }

    // The camera arrived through the pan, so the incoming region is already at
    // full zoom: don't replay the tail of its own zoom-in ease, which would
    // otherwise let the strength dip to ~0.99 between transitionEnd and
    // startMs + overlap.
    const strength =
      incomingPair && timeMs <= region.endMs ? 1 : computeRegionStrength(region, timeMs)
    if (strength <= 0) continue
    // Ties go to the later-starting region (the one the camera is heading to).
    if (
      strength > bestStrength ||
      (strength === bestStrength && bestRegion !== null && region.startMs > bestRegion.startMs)
    ) {
      bestStrength = strength
      bestRegion = region
    }
  }

  if (!bestRegion) {
    return null
  }

  const activeScale = getZoomScale(bestRegion)

  return {
    region: {
      ...bestRegion,
      focus: getResolvedFocus(bestRegion, activeScale, timeMs, cursorTelemetry),
    },
    strength: bestStrength,
    blendedScale: null,
    rotation3D: getRotation3D(bestRegion),
    transition: null,
  }
}

function getConnectedRegionHold(
  timeMs: number,
  connectedPairs: ConnectedRegionPair[],
  cursorTelemetry?: CursorTelemetryPoint[],
): DominantRegionResult | null {
  for (const pair of connectedPairs) {
    if (timeMs > pair.transitionEnd && timeMs < pair.nextRegion.startMs) {
      const nextScale = getZoomScale(pair.nextRegion)
      return {
        region: {
          ...pair.nextRegion,
          focus: getResolvedFocus(pair.nextRegion, nextScale, timeMs, cursorTelemetry),
        },
        strength: 1,
        blendedScale: null,
        rotation3D: getRotation3D(pair.nextRegion),
        transition: null,
      }
    }
  }

  return null
}

function getConnectedRegionTransition(
  connectedPairs: ConnectedRegionPair[],
  timeMs: number,
  cursorTelemetry?: CursorTelemetryPoint[],
): DominantRegionResult | null {
  for (const pair of connectedPairs) {
    const { currentRegion, nextRegion, transitionStart, transitionEnd } = pair

    if (timeMs < transitionStart || timeMs > transitionEnd) {
      continue
    }

    const transitionProgress = easeConnectedPan(
      clamp01((timeMs - transitionStart) / Math.max(1, transitionEnd - transitionStart)),
    )
    const currentScale = getZoomScale(currentRegion)
    const nextScale = getZoomScale(nextRegion)
    const transitionScale = lerp(currentScale, nextScale, transitionProgress)
    // Both regions share the same timeMs, so interpolate the cursor once and reuse.
    const sharedCursorFocus =
      cursorTelemetry && cursorTelemetry.length > 0
        ? interpolateCursorAt(cursorTelemetry, timeMs)
        : null
    const currentFocus = getResolvedFocus(
      currentRegion,
      currentScale,
      timeMs,
      cursorTelemetry,
      sharedCursorFocus,
    )
    const nextFocus = getResolvedFocus(
      nextRegion,
      nextScale,
      timeMs,
      cursorTelemetry,
      sharedCursorFocus,
    )
    const transitionFocus = getLinearFocus(currentFocus, nextFocus, transitionProgress)
    // The tilt pans with the same eased progress as the scale / focus.
    const transitionRotation = lerpRotation3D(
      getRotation3D(currentRegion),
      getRotation3D(nextRegion),
      transitionProgress,
    )

    return {
      region: { ...nextRegion, focus: transitionFocus },
      strength: 1,
      blendedScale: transitionScale,
      rotation3D: transitionRotation,
      transition: {
        progress: transitionProgress,
        startFocus: currentFocus,
        endFocus: nextFocus,
        startScale: currentScale,
        endScale: nextScale,
      },
    }
  }

  return null
}

// Single-slot cache: the ticker calls findDominantRegion at 60 fps with mostly
// unchanged inputs (especially while paused), so reusing the last result skips
// the per-frame O(N) scan and allocations.
let dominantRegionCache: {
  regions: ZoomRegion[]
  timeMsKey: number
  connectZooms: boolean
  telemetry: CursorTelemetryPoint[] | undefined
  result: DominantRegionResult
} | null = null

/** Test hook: drop the memoised result. */
export function resetDominantRegionCache() {
  dominantRegionCache = null
}

export function findDominantRegion(
  regions: ZoomRegion[],
  timeMs: number,
  options: DominantRegionOptions = {},
): DominantRegionResult {
  const connectZooms = !!options.connectZooms
  const telemetry = options.cursorTelemetry
  const timeMsKey = Math.round(timeMs)

  if (
    dominantRegionCache &&
    dominantRegionCache.regions === regions &&
    dominantRegionCache.timeMsKey === timeMsKey &&
    dominantRegionCache.connectZooms === connectZooms &&
    dominantRegionCache.telemetry === telemetry
  ) {
    return dominantRegionCache.result
  }

  const connectedPairs = connectZooms ? getConnectedRegionPairs(regions) : []

  let result: DominantRegionResult | null = null
  if (connectZooms) {
    result =
      getConnectedRegionTransition(connectedPairs, timeMs, telemetry) ??
      getConnectedRegionHold(timeMs, connectedPairs, telemetry)
  }
  if (!result) {
    result = getActiveRegion(regions, timeMs, connectedPairs, telemetry) ?? EMPTY_RESULT
  }

  dominantRegionCache = { regions, timeMsKey, connectZooms, telemetry, result }

  return result
}
