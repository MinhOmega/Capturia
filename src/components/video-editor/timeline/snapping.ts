/**
 * Pure helpers behind the timeline's drag/resize behaviour (snap guides,
 * neighbour clamping, bounds clamping). Kept out of `TimelineWrapper.tsx` so
 * they can be unit-tested without standing up dnd-timeline.
 *
 * All times are in the timeline's own space (Capturia: EFFECTIVE milliseconds).
 */

export interface TimeSpan {
  start: number
  end: number
}

export interface IdentifiedSpan extends TimeSpan {
  id: string
}

export type SnapMode = 'drag' | 'resize-left' | 'resize-right'
export type ResizeMode = Exclude<SnapMode, 'drag'>

export interface SnapResult {
  span: TimeSpan
  /** The target the span was pulled to, or null when nothing was within threshold. */
  snapPoint: number | null
}

/** Snap threshold scales with zoom: ~1% of the visible range, never below 50 ms. */
export function computeSnapThresholdMs(visibleRangeMs: number): number {
  const visibleMs = Math.max(visibleRangeMs, 1)
  return Math.max(50, Math.round(visibleMs / 100))
}

export interface SnapTargetSources {
  totalMs: number
  /** Hard overlap constraints (zoom regions); their edges are snap targets. */
  allRegionSpans?: IdentifiedSpan[]
  /** Snap-only spans (annotations); never used for overlap resolution. */
  softSnapSpans?: IdentifiedSpan[]
  /** Item being dragged; its own edges are excluded. */
  activeItemId?: string
  currentTimeMs?: number
  keyframeTimesMs?: number[]
  /** Any additional points (Capturia: segment boundaries / split lines). */
  extraTimesMs?: number[]
}

/** Collect the de-duplicated set of snap targets: bounds, region edges, playhead, keyframes, extras. */
export function collectSnapTargets(sources: SnapTargetSources): number[] {
  const {
    totalMs,
    allRegionSpans = [],
    softSnapSpans = [],
    activeItemId,
    currentTimeMs,
    keyframeTimesMs = [],
    extraTimesMs = [],
  } = sources

  const targetSet = new Set<number>()
  targetSet.add(0)
  targetSet.add(totalMs)
  for (const r of allRegionSpans) {
    if (r.id === activeItemId) continue
    targetSet.add(r.start)
    targetSet.add(r.end)
  }
  for (const r of softSnapSpans) {
    if (r.id === activeItemId) continue
    targetSet.add(r.start)
    targetSet.add(r.end)
  }
  if (currentTimeMs !== undefined && Number.isFinite(currentTimeMs)) {
    targetSet.add(currentTimeMs)
  }
  for (const kf of keyframeTimesMs) targetSet.add(kf)
  for (const extra of extraTimesMs) {
    if (Number.isFinite(extra)) targetSet.add(extra)
  }
  return Array.from(targetSet)
}

function findNearest(targets: number[], value: number, thresholdMs: number): number | null {
  let best: number | null = null
  let bestDistance = thresholdMs
  for (const target of targets) {
    const distance = Math.abs(target - value)
    if (distance <= bestDistance) {
      best = target
      bestDistance = distance
    }
  }
  return best
}

/**
 * Pull the active span's edges to nearby targets.
 * - resize-left / resize-right: snap the moving edge only, keeping the other fixed;
 *   a snap that would violate `minItemDurationMs` is ignored.
 * - drag: preserve duration; whichever edge is closer to a target wins.
 */
export function snapSpanToTargets(
  span: TimeSpan,
  targets: number[],
  mode: SnapMode,
  thresholdMs: number,
  minItemDurationMs: number,
): SnapResult {
  if (targets.length === 0 || thresholdMs <= 0) return { span, snapPoint: null }

  if (mode === 'resize-left') {
    const snap = findNearest(targets, span.start, thresholdMs)
    if (snap === null || span.end - snap < minItemDurationMs) {
      return { span, snapPoint: null }
    }
    return { span: { start: snap, end: span.end }, snapPoint: snap }
  }

  if (mode === 'resize-right') {
    const snap = findNearest(targets, span.end, thresholdMs)
    if (snap === null || snap - span.start < minItemDurationMs) {
      return { span, snapPoint: null }
    }
    return { span: { start: span.start, end: snap }, snapPoint: snap }
  }

  const startSnap = findNearest(targets, span.start, thresholdMs)
  const endSnap = findNearest(targets, span.end, thresholdMs)
  const startDelta = startSnap !== null ? Math.abs(startSnap - span.start) : Infinity
  const endDelta = endSnap !== null ? Math.abs(endSnap - span.end) : Infinity

  if (startDelta === Infinity && endDelta === Infinity) {
    return { span, snapPoint: null }
  }

  const duration = span.end - span.start
  if (startDelta <= endDelta && startSnap !== null) {
    return { span: { start: startSnap, end: startSnap + duration }, snapPoint: startSnap }
  }
  if (endSnap !== null) {
    return { span: { start: endSnap - duration, end: endSnap }, snapPoint: endSnap }
  }
  return { span, snapPoint: null }
}

/**
 * When a span crosses into neighbouring regions, pull the offending edge back to
 * the neighbour's boundary instead of rejecting the edit. Guarantees the minimum
 * duration afterwards where the timeline has room for it.
 */
export function clampToNeighbours(
  span: TimeSpan,
  siblings: IdentifiedSpan[],
  activeItemId: string,
  minItemDurationMs: number,
  totalMs: number,
): TimeSpan {
  let { start, end } = span

  for (const r of siblings) {
    if (r.id === activeItemId) continue
    // Right edge crossed into a region to the right
    if (end > r.start && start < r.start) {
      end = r.start
    }
    // Left edge crossed into a region to the left
    if (start < r.end && end > r.end) {
      start = r.end
    }
  }

  const minDur = Math.min(minItemDurationMs, totalMs || minItemDurationMs)
  if (end - start < minDur) {
    if (end + minDur - (end - start) <= totalMs) {
      end = start + minDur
    } else {
      start = end - minDur
    }
  }

  return { start: Math.max(0, start), end: Math.min(end, totalMs || end) }
}

/**
 * Clamp a span inside [0, totalMs], enforcing the minimum duration. `end` can
 * never exceed `totalMs`, so dragging a resize handle past the end of the
 * timeline stops at the end instead of extending it.
 */
export function clampSpanToBounds(
  span: TimeSpan,
  totalMs: number,
  minItemDurationMs: number,
): TimeSpan {
  const rawDuration = Math.max(span.end - span.start, 0)
  const normalizedStart = Number.isFinite(span.start) ? span.start : 0

  if (totalMs === 0) {
    const minDuration = Math.max(minItemDurationMs, 1)
    const duration = Math.max(rawDuration, minDuration)
    const start = Math.max(0, normalizedStart)
    return { start, end: start + duration }
  }

  const minDuration = Math.min(Math.max(minItemDurationMs, 1), totalMs)
  const duration = Math.min(Math.max(rawDuration, minDuration), totalMs)

  const start = Math.max(0, Math.min(normalizedStart, totalMs - duration))
  const end = Math.min(start + duration, totalMs)

  return { start, end }
}

/**
 * dnd-timeline's resize event carries no direction, so compare the live span to
 * the committed one. Returns null when both edges moved by the same amount
 * (including the clamped both-0 case) because guessing wrong would snap the
 * wrong edge. Unknown items default to resize-right.
 */
export function inferResizeMode(
  committed: TimeSpan | undefined,
  live: TimeSpan,
): ResizeMode | null {
  if (!committed) return 'resize-right'
  const startDelta = Math.abs(committed.start - live.start)
  const endDelta = Math.abs(committed.end - live.end)
  if (startDelta === endDelta) return null
  return startDelta > endDelta ? 'resize-left' : 'resize-right'
}

/** Strict intersection: adjacent spans (end === start) do not overlap. */
export function spansIntersect(a: TimeSpan, b: TimeSpan): boolean {
  return a.end > b.start && a.start < b.end
}

/** Keep the visible window inside [0, totalMs] while preserving its width. */
export function clampVisibleRange(candidate: TimeSpan, totalMs: number): TimeSpan {
  if (totalMs <= 0) {
    return candidate
  }

  const span = Math.max(candidate.end - candidate.start, 1)

  if (span >= totalMs) {
    return { start: 0, end: totalMs }
  }

  const start = Math.max(0, Math.min(candidate.start, totalMs - span))
  return { start, end: start + span }
}

/**
 * Wheel deltas in "line" and "page" units, converted to pixels.
 *
 * `WheelEvent.delta*` is only in pixels when `deltaMode` is 0. Firefox reports
 * lines (`deltaMode` 1) for a mouse wheel, and a Page Up/Down-style device
 * reports pages (`deltaMode` 2). Feeding those numbers to a handler tuned for
 * pixels makes the timeline barely move on one browser and jump a whole
 * viewport on another. 16 px is the usual line height and 240 px a screenful
 * of scroll — the same figures browsers use internally.
 */
export const WHEEL_LINE_HEIGHT_PX = 16
export const WHEEL_PAGE_HEIGHT_PX = 240

export function normaliseWheelDeltaPx(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta)) return 0
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT_PX
  if (deltaMode === 2) return delta * WHEEL_PAGE_HEIGHT_PX
  return delta
}

/** What a region has to do to survive a change in the timeline's length. */
export type SpanNormalisation =
  | { action: 'keep' }
  | { action: 'clamp'; start: number; end: number }
  | { action: 'drop' }

/**
 * Fit one region into a timeline that is now `totalMs` long.
 *
 * Trimming shortens the effective timeline, and every track has to follow:
 * a region that used to end at 30 s cannot still end there once the recording
 * collapses to 20 s. A region that no longer has room for `minDurationMs`
 * inside the new length is dropped rather than squashed to a sliver nobody
 * asked for; anything else is clamped into range.
 *
 * `totalMs <= 0` means the duration is not known yet, so nothing is touched:
 * the length arrives asynchronously and clamping against zero would delete the
 * whole project.
 */
export function normaliseSpanToDuration(
  span: TimeSpan,
  totalMs: number,
  minDurationMs: number,
): SpanNormalisation {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return { action: 'keep' }
  const minMs = Number.isFinite(minDurationMs) && minDurationMs > 0 ? minDurationMs : 1
  if (minMs > totalMs) return { action: 'keep' }

  // Empty or inverted, or starting so late that a minimum-length region no
  // longer fits before the end: there is nothing left to keep.
  if (!(span.end > span.start) || span.start >= totalMs) return { action: 'drop' }

  const start = Math.max(0, Math.min(span.start, totalMs - minMs))
  const end = Math.max(start + minMs, Math.min(span.end, totalMs))

  if (start === span.start && end === span.end) return { action: 'keep' }
  return { action: 'clamp', start, end }
}

/**
 * Apply `normaliseSpanToDuration` to a whole track and report the work: which
 * regions move and which go. Callers push both through their own handlers, so
 * the reducer stays free of the source/effective time mapping.
 */
export function normaliseSpansToDuration(
  regions: ReadonlyArray<IdentifiedSpan>,
  totalMs: number,
  minDurationMs: number,
): { clamped: IdentifiedSpan[]; dropped: string[] } {
  const clamped: IdentifiedSpan[] = []
  const dropped: string[] = []

  for (const region of regions) {
    const result = normaliseSpanToDuration(region, totalMs, minDurationMs)
    if (result.action === 'drop') dropped.push(region.id)
    else if (result.action === 'clamp')
      clamped.push({ id: region.id, start: result.start, end: result.end })
  }

  return { clamped, dropped }
}

/** Format a millisecond value for the drag/resize tooltip and item labels. */
export function formatTooltipMs(ms: number): string {
  const s = ms / 1000
  const min = Math.floor(s / 60)
  const sec = s % 60
  return min > 0 ? `${min}:${sec.toFixed(1).padStart(4, '0')}` : `${sec.toFixed(1)}s`
}
