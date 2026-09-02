/**
 * Pure timing and settings logic for the Notes window's teleprompter mode.
 *
 * The React component owns the DOM; everything here is side-effect free so the
 * frame math, the manual-scroll hold and the settings normalisation can be
 * tested without a browser. Scroll speed is in CSS pixels per second, font
 * size in CSS pixels.
 */

export const MIN_TELEPROMPTER_SPEED = 10
export const MAX_TELEPROMPTER_SPEED = 150
export const TELEPROMPTER_SPEED_STEP = 5

export const MIN_NOTES_FONT_SIZE = 14
export const MAX_NOTES_FONT_SIZE = 48
export const NOTES_FONT_SIZE_STEP = 2

/**
 * Longest interval a single animation frame may account for. A tab that was
 * throttled in the background must not jump the whole way it "missed".
 */
export const MAX_TELEPROMPTER_FRAME_MS = 100

/**
 * How far the DOM scroll position may drift from the tracked one before the
 * drift counts as a manual scroll. Also the slack used to decide the
 * teleprompter has reached the bottom.
 */
export const TELEPROMPTER_SCROLL_TOLERANCE_PX = 1

/** How long auto-scroll waits after the reader scrolls by hand before it resumes. */
export const TELEPROMPTER_MANUAL_SCROLL_HOLD_MS = 2_000

export type NotesTeleprompterSettings = {
  /** Auto-scroll speed in CSS pixels per second. */
  speed: number
  /** Note body font size in CSS pixels while teleprompter mode is on. */
  fontSize: number
}

export const DEFAULT_NOTES_TELEPROMPTER_SETTINGS: NotesTeleprompterSettings = {
  speed: 40,
  fontSize: 16,
}

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, value))
}

export function clampTeleprompterSpeed(value: number): number {
  return clampNumber(
    value,
    DEFAULT_NOTES_TELEPROMPTER_SETTINGS.speed,
    MIN_TELEPROMPTER_SPEED,
    MAX_TELEPROMPTER_SPEED,
  )
}

export function clampNotesFontSize(value: number): number {
  return clampNumber(
    value,
    DEFAULT_NOTES_TELEPROMPTER_SETTINGS.fontSize,
    MIN_NOTES_FONT_SIZE,
    MAX_NOTES_FONT_SIZE,
  )
}

/**
 * Coerces whatever was persisted into valid settings. Unknown fields are
 * dropped, out-of-range numbers are clamped and anything else falls back to
 * the default, so a hand-edited or stale preferences file cannot break the
 * window.
 */
export function normalizeNotesTeleprompterSettings(value: unknown): NotesTeleprompterSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_NOTES_TELEPROMPTER_SETTINGS }
  }

  const candidate = value as Partial<NotesTeleprompterSettings>
  return {
    speed: clampTeleprompterSpeed(candidate.speed ?? Number.NaN),
    fontSize: clampNotesFontSize(candidate.fontSize ?? Number.NaN),
  }
}

export type TeleprompterFrame = {
  elapsedMs: number
  nextTimestamp: number | null
}

/**
 * Elapsed time between two animation-frame timestamps, capped so a stalled
 * frame cannot jump the text. The first frame (or any unusable timestamp)
 * only primes the clock and advances nothing.
 */
export function getTeleprompterFrame(
  previousTimestamp: number | null,
  currentTimestamp: number,
): TeleprompterFrame {
  if (!Number.isFinite(currentTimestamp)) {
    return { elapsedMs: 0, nextTimestamp: null }
  }

  if (
    previousTimestamp === null ||
    !Number.isFinite(previousTimestamp) ||
    currentTimestamp <= previousTimestamp
  ) {
    return { elapsedMs: 0, nextTimestamp: currentTimestamp }
  }

  return {
    elapsedMs: Math.min(currentTimestamp - previousTimestamp, MAX_TELEPROMPTER_FRAME_MS),
    nextTimestamp: currentTimestamp,
  }
}

/** Next scroll offset after `elapsedMs` at `speed` px/s, never past the bottom. */
export function getNextTeleprompterScrollTop(
  currentScrollTop: number,
  speed: number,
  elapsedMs: number,
  maxScrollTop: number,
): number {
  const safeCurrent = Number.isFinite(currentScrollTop) ? Math.max(0, currentScrollTop) : 0
  const safeMaximum = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  const distance = (clampTeleprompterSpeed(speed) * safeElapsed) / 1_000

  return Math.min(safeMaximum, safeCurrent + distance)
}

/**
 * True when the DOM moved by more than rounding could explain, i.e. the reader
 * scrolled by hand (wheel, scrollbar, keyboard) or the layout changed under us.
 */
export function hasManualScrollDrift(trackedPosition: number, actualScrollTop: number): boolean {
  if (!Number.isFinite(trackedPosition) || !Number.isFinite(actualScrollTop)) {
    return false
  }

  return Math.abs(actualScrollTop - trackedPosition) > TELEPROMPTER_SCROLL_TOLERANCE_PX
}

/**
 * Playback tracks its own fractional position instead of reading `scrollTop`
 * back every frame: at the slowest speed a frame advances well under a pixel,
 * and an engine that snaps scroll offsets to whole pixels would round that
 * away and stall the teleprompter. The DOM still wins once it drifts beyond
 * the tolerance, so a manual scroll moves the teleprompter rather than
 * fighting it.
 */
export function resolveTeleprompterPosition(
  trackedPosition: number,
  actualScrollTop: number,
): number {
  if (!Number.isFinite(actualScrollTop)) {
    return Number.isFinite(trackedPosition) ? Math.max(0, trackedPosition) : 0
  }

  if (!Number.isFinite(trackedPosition)) {
    return Math.max(0, actualScrollTop)
  }

  return Math.max(
    0,
    hasManualScrollDrift(trackedPosition, actualScrollTop) ? actualScrollTop : trackedPosition,
  )
}

/**
 * Content that fits the window is never "at the end" — it has nowhere to
 * scroll, so playback stays armed and starts moving as soon as the note grows
 * past the viewport.
 */
export function isAtTeleprompterEnd(scrollTop: number, maxScrollTop: number): boolean {
  if (!Number.isFinite(maxScrollTop) || maxScrollTop <= 0) {
    return false
  }

  const safeScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0
  return safeScrollTop >= maxScrollTop - TELEPROMPTER_SCROLL_TOLERANCE_PX
}

export function getMaxScrollTop(
  element: Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>,
): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}

/**
 * Scroll offset that keeps the same relative reading position after the
 * scrollable height changed (font size change, teleprompter toggle). A note
 * that no longer scrolls lands at the top.
 */
export function scaleScrollTop(scrollTop: number, previousMax: number, nextMax: number): number {
  if (!Number.isFinite(nextMax) || nextMax <= 0) {
    return 0
  }

  if (!Number.isFinite(previousMax) || previousMax <= 0 || !Number.isFinite(scrollTop)) {
    return 0
  }

  const fraction = Math.min(1, Math.max(0, scrollTop / previousMax))
  return fraction * nextMax
}

/** Mutable per-playback state; one instance lives for the duration of a play. */
export type TeleprompterRunState = {
  /** Fractional scroll position the teleprompter believes it is at. */
  position: number
  /** Timestamp of the previous frame, or null when the clock needs priming. */
  previousTimestamp: number | null
  /** While set, auto-scroll waits until this timestamp before moving again. */
  holdUntil: number | null
}

export function createTeleprompterRunState(scrollTop: number): TeleprompterRunState {
  return {
    position: Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
    previousTimestamp: null,
    holdUntil: null,
  }
}

export type TeleprompterStepInput = {
  timestamp: number
  actualScrollTop: number
  maxScrollTop: number
  speed: number
  holdMs?: number
}

export type TeleprompterStepResult = {
  state: TeleprompterRunState
  /** Offset to write to the DOM this frame, or null to leave it alone. */
  scrollTop: number | null
  /** True once the bottom is reached; the caller stops playback. */
  atEnd: boolean
  /** True while a manual scroll keeps auto-scroll waiting. */
  holding: boolean
}

/**
 * Records a manual scroll: the tracked position adopts the DOM offset and
 * auto-scroll waits `holdMs` from `timestamp` before resuming. Calling it again
 * while already holding extends the wait, so a reader who keeps scrolling is
 * never fought.
 */
export function holdTeleprompter(
  state: TeleprompterRunState,
  timestamp: number,
  actualScrollTop: number,
  holdMs: number = TELEPROMPTER_MANUAL_SCROLL_HOLD_MS,
): TeleprompterRunState {
  const safeTimestamp = Number.isFinite(timestamp) ? timestamp : 0
  const safeHold = Number.isFinite(holdMs) ? Math.max(0, holdMs) : 0
  return {
    position: Number.isFinite(actualScrollTop) ? Math.max(0, actualScrollTop) : state.position,
    previousTimestamp: null,
    holdUntil: safeTimestamp + safeHold,
  }
}

/**
 * One animation frame of playback. Detects manual drift and starts a hold,
 * waits out an active hold, otherwise advances by elapsed time and reports
 * when the bottom is reached.
 */
export function stepTeleprompter(
  state: TeleprompterRunState,
  input: TeleprompterStepInput,
): TeleprompterStepResult {
  const { timestamp, actualScrollTop, maxScrollTop, speed } = input
  const holdMs = input.holdMs ?? TELEPROMPTER_MANUAL_SCROLL_HOLD_MS

  if (hasManualScrollDrift(state.position, actualScrollTop)) {
    return {
      state: holdTeleprompter(state, timestamp, actualScrollTop, holdMs),
      scrollTop: null,
      atEnd: false,
      holding: holdMs > 0,
    }
  }

  if (state.holdUntil !== null) {
    if (!Number.isFinite(timestamp) || timestamp < state.holdUntil) {
      return { state, scrollTop: null, atEnd: false, holding: true }
    }

    // The hold just expired: re-prime the clock so the first moving frame
    // measures from now, not from before the reader took over.
    state = {
      position: resolveTeleprompterPosition(state.position, actualScrollTop),
      previousTimestamp: null,
      holdUntil: null,
    }
  }

  const frame = getTeleprompterFrame(state.previousTimestamp, timestamp)
  const nextState: TeleprompterRunState = {
    ...state,
    previousTimestamp: frame.nextTimestamp,
  }

  if (frame.elapsedMs <= 0) {
    return { state: nextState, scrollTop: null, atEnd: false, holding: false }
  }

  const position = getNextTeleprompterScrollTop(
    resolveTeleprompterPosition(state.position, actualScrollTop),
    speed,
    frame.elapsedMs,
    maxScrollTop,
  )
  nextState.position = position

  if (isAtTeleprompterEnd(position, maxScrollTop)) {
    nextState.position = Math.max(0, maxScrollTop)
    return { state: nextState, scrollTop: nextState.position, atEnd: true, holding: false }
  }

  return { state: nextState, scrollTop: position, atEnd: false, holding: false }
}

export type SpaceShortcutTarget = {
  tagName?: string
  isContentEditable?: boolean
}

/**
 * Whether a Space key press should toggle playback. Space already activates a
 * focused button and types into inputs or the editor, so those targets keep
 * their native behaviour.
 */
export function shouldSpaceTogglePlayback(
  event: { code?: string; key?: string; repeat?: boolean },
  target: SpaceShortcutTarget | null,
  editorContainsTarget: boolean,
): boolean {
  const isSpace = event.code === 'Space' || event.key === ' '
  if (!isSpace || event.repeat) {
    return false
  }

  if (editorContainsTarget || target?.isContentEditable) {
    return false
  }

  const tag = (target?.tagName ?? '').toUpperCase()
  return !['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(tag)
}
