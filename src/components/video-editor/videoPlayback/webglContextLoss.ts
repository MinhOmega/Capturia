/**
 * Recovery policy for a lost WebGL context on the preview canvas.
 *
 * On Linux/Wayland (Mesa/EGL) the preview's Pixi context can be lost while the
 * exporter hammers the GPU. The wallpaper is a plain DOM layer and survives;
 * the video sprite lives inside the lost context and never comes back on its
 * own, which shows up as "only the background remains". The recovery is to
 * tear the Pixi application down and rebuild it from scratch: the host bumps
 * a generation counter, its setup effect re-runs, and the texture / filter /
 * ticker effects re-attach because the ready flag toggles.
 *
 * This module is DOM-free so the policy can be unit tested: which event leads
 * to which action, that a second `webglcontextlost` during a pending rebuild
 * is ignored, and when the host should stop retrying and tell the user.
 */

export interface ContextLossRecoveryOptions {
  /** Bump the generation so the host rebuilds its rendering stage. */
  regenerate: () => void
  /** Called once when recovery is abandoned (the host shows a toast). */
  onGiveUp: (reason: ContextLossGiveUpReason) => void
  /**
   * Consecutive failed rebuilds (or losses that follow a rebuild too quickly)
   * tolerated before giving up. Default 2: one retry, then the toast.
   */
  maxFailures?: number
  /** Delay before retrying after a rebuild that threw. Default 1000 ms. */
  retryDelayMs?: number
  /**
   * A context lost again within this window after a successful rebuild counts
   * as a failed rebuild (the GPU is flapping). Default 3000 ms.
   */
  minStableMs?: number
  /** Injectable clock / timer for tests. */
  now?: () => number
  schedule?: (fn: () => void, delayMs: number) => unknown
  cancel?: (handle: unknown) => void
  log?: Pick<Console, 'warn' | 'error' | 'info'>
}

export type ContextLossGiveUpReason = 'rebuild-failed' | 'context-flapping'

export type ContextLostAction = 'rebuild' | 'ignored' | 'gave-up'
export type RebuildFailedAction = 'retry' | 'gave-up'

export interface ContextLossRecovery {
  /**
   * `webglcontextlost` listener. Always calls `preventDefault()` (the browser
   * only attempts restoration when the page opts in), then either schedules a
   * rebuild or, if one is already pending / recovery was abandoned, ignores
   * the event.
   */
  handleContextLost: (event: { preventDefault(): void }) => ContextLostAction
  /** `webglcontextrestored` listener: diagnostics only (the stage is rebuilt anyway). */
  handleContextRestored: () => void
  /** The host finished a rebuild and the new stage is up. */
  rebuildSucceeded: () => void
  /** The host's rebuild threw (e.g. Pixi could not create a context). */
  rebuildFailed: (error: unknown) => RebuildFailedAction
  /** Cancel a pending retry timer (host unmount). */
  dispose: () => void
  /** Read-only view for tests / diagnostics. */
  readonly state: {
    readonly generation: number
    readonly pendingRebuild: boolean
    readonly failures: number
    readonly gaveUp: boolean
  }
}

const DEFAULT_MAX_FAILURES = 2
const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_MIN_STABLE_MS = 3000

export function createContextLossRecovery(
  options: ContextLossRecoveryOptions,
): ContextLossRecovery {
  const {
    regenerate,
    onGiveUp,
    maxFailures = DEFAULT_MAX_FAILURES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    minStableMs = DEFAULT_MIN_STABLE_MS,
    now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    schedule = (fn, delayMs) => setTimeout(fn, delayMs),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    log = console,
  } = options

  let generation = 0
  let pendingRebuild = false
  let failures = 0
  let gaveUp = false
  let lastRebuildOkAt: number | null = null
  let retryHandle: unknown = null

  const giveUp = (reason: ContextLossGiveUpReason) => {
    if (gaveUp) return
    gaveUp = true
    pendingRebuild = false
    log.error('[VideoPlayback] WebGL context recovery abandoned', { reason, failures })
    onGiveUp(reason)
  }

  const requestRebuild = () => {
    pendingRebuild = true
    generation += 1
    regenerate()
  }

  const clearRetry = () => {
    if (retryHandle !== null) {
      cancel(retryHandle)
      retryHandle = null
    }
  }

  return {
    handleContextLost(event) {
      // Opt in to the browser's restoration attempt; without this the canvas is
      // permanently dead even if the driver recovers.
      event.preventDefault()
      if (gaveUp) return 'gave-up'
      if (pendingRebuild) {
        // A rebuild is already on its way; the second event is the same loss
        // reported again (or the dying canvas firing during teardown).
        return 'ignored'
      }
      const t = now()
      if (lastRebuildOkAt !== null && t - lastRebuildOkAt < minStableMs) {
        // Lost again right after a rebuild came up: the context is flapping and
        // each cycle counts as a failed rebuild.
        failures += 1
        if (failures >= maxFailures) {
          giveUp('context-flapping')
          return 'gave-up'
        }
      } else {
        // The previous stage stayed up long enough: this is a fresh incident.
        failures = 0
      }
      log.warn('[VideoPlayback] WebGL context lost, rebuilding the preview stage', {
        generation: generation + 1,
        failures,
      })
      requestRebuild()
      return 'rebuild'
    },

    handleContextRestored() {
      log.info('[VideoPlayback] WebGL context restored', { generation })
    },

    rebuildSucceeded() {
      pendingRebuild = false
      lastRebuildOkAt = now()
      clearRetry()
      // The failure streak is deliberately kept: whether the stage really
      // settled is decided by the next loss (inside or outside minStableMs).
    },

    rebuildFailed(error) {
      pendingRebuild = false
      failures += 1
      log.error('[VideoPlayback] preview stage rebuild failed', { generation, failures, error })
      if (gaveUp) return 'gave-up'
      if (failures >= maxFailures) {
        giveUp('rebuild-failed')
        return 'gave-up'
      }
      clearRetry()
      retryHandle = schedule(() => {
        retryHandle = null
        if (gaveUp) return
        log.warn('[VideoPlayback] retrying the preview stage rebuild', {
          generation: generation + 1,
        })
        requestRebuild()
      }, retryDelayMs)
      return 'retry'
    },

    dispose() {
      clearRetry()
    },

    get state() {
      return { generation, pendingRebuild, failures, gaveUp }
    },
  }
}
