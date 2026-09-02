/**
 * Interim duration override (D17): browser-recorded WebM files can carry an
 * inflated container duration. `VideoPlayback` probes the real end in the
 * background and the editor forwards it as `sourceDurationMs`; the exporters
 * prefer it over `video.duration` so trailing frozen frames are not exported.
 * Superseded by packet-scan validation once the streaming decoder lands.
 */

/**
 * Picks the source duration (ms) the exporter should trust.
 *
 * @param decodedSeconds  `video.duration` reported by the media element.
 * @param overrideMs      Probed duration from the editor, if any.
 * @returns the override when it is a finite positive number, else the decoded
 *   value clamped at 0. An override longer than the decoded duration is
 *   ignored: a probe can only tighten the end, never extend it.
 */
export function resolveSourceDurationMs(
  decodedSeconds: number,
  overrideMs?: number | null,
): number {
  const decodedMs = Number.isFinite(decodedSeconds) ? Math.max(0, decodedSeconds * 1000) : 0
  if (typeof overrideMs !== 'number' || !Number.isFinite(overrideMs) || overrideMs <= 0) {
    return decodedMs
  }
  if (decodedMs > 0 && overrideMs > decodedMs) {
    return decodedMs
  }
  return overrideMs
}
