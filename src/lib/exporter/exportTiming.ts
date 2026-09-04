/**
 * How long an export took, and how much video came out of it.
 *
 * The success toast says "12s of video exported in 3s" because the two numbers
 * together are the only ones that mean anything: "3s" alone says nothing about
 * a 5-second clip versus a 20-minute recording, and it is the ratio that tells
 * someone whether the hardware encoder was in play.
 *
 * Formatting stays here, and unit-free of any language: the caller interpolates
 * the two strings into a translated sentence.
 */

/**
 * Compact clock for a duration in seconds: `9s`, `59s`, `1m 05s`, `1h 02m`.
 * Rounds to the nearest second and never returns a negative or `NaN` value.
 */
export function formatExportClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
  if (safe < 60) return `${safe}s`
  const minutes = Math.floor(safe / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(safe % 60).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export interface ExportTimingSummary {
  /** Playing time of the exported video, e.g. `12s`. */
  video: string
  /** Wall time the export took, e.g. `3s`. */
  elapsed: string
}

/**
 * The two strings the success toast interpolates.
 * `videoDurationMs` is the timeline duration that was exported (after trims and
 * speed changes), `elapsedMs` the wall time from the click to the saved file.
 */
export function buildExportTimingSummary(
  videoDurationMs: number,
  elapsedMs: number,
): ExportTimingSummary {
  return {
    video: formatExportClock(videoDurationMs / 1000),
    elapsed: formatExportClock(elapsedMs / 1000),
  }
}
