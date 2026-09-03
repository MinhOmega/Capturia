/** One frame in seconds at 60 FPS (~16.67ms). */
export const FRAME_DURATION_SEC = 1 / 60

/**
 * New playhead time after stepping one frame, clamped to [0, duration].
 * `frameDurationSec` lets callers step by the source's real frame length
 * (e.g. 1 / resolvePreviewFrameRate(sourceFrameRate)); it defaults to 60 FPS.
 */
export function computeFrameStepTime(
  currentTime: number,
  duration: number,
  direction: 'forward' | 'backward',
  frameDurationSec: number = FRAME_DURATION_SEC,
): number {
  const frame =
    Number.isFinite(frameDurationSec) && frameDurationSec > 0
      ? frameDurationSec
      : FRAME_DURATION_SEC
  const delta = direction === 'forward' ? frame : -frame
  return Math.min(duration, Math.max(0, currentTime + delta))
}
