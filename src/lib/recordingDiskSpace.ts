/**
 * How much free space a recording needs before it is allowed to start.
 *
 * A capture writes continuously and has no way to shrink once the volume fills:
 * the file is truncated wherever the writer happened to be, which on the native
 * path means an MP4 with no `moov` box and nothing to open. Checking once at
 * the start costs a `statfs` and turns a lost recording into a sentence.
 *
 * Pure: main answers the byte count (`get-recordings-disk-space`), this decides
 * what to do about it, so both thresholds are testable without a filesystem.
 */

const BYTES_PER_MIB = 1024 * 1024
const BYTES_PER_GIB = 1024 * BYTES_PER_MIB

/** Below this, recording still starts but the user is told space is short. */
export const RECORDING_DISK_SPACE_WARN_BYTES = 2 * BYTES_PER_GIB
/** Below this, recording does not start: there is no useful capture to be had. */
export const RECORDING_DISK_SPACE_BLOCK_BYTES = 200 * BYTES_PER_MIB

export type RecordingDiskSpaceSnapshot = {
  success: boolean
  /** Bytes an unprivileged process may still write to the recordings volume. */
  availableBytes?: number
  totalBytes?: number
  message?: string
}

export type RecordingDiskSpaceVerdict =
  | { level: 'ok' }
  | { level: 'warn'; availableBytes: number }
  | { level: 'blocked'; availableBytes: number }

/**
 * A check that could not run answers `ok`. An old preload without the bridge
 * method, or a volume `statfs` cannot describe, must not stop a recording that
 * would have been fine.
 */
export function assessRecordingDiskSpace(
  snapshot?: RecordingDiskSpaceSnapshot | null,
): RecordingDiskSpaceVerdict {
  if (!snapshot?.success) return { level: 'ok' }
  const availableBytes = Number(snapshot.availableBytes)
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return { level: 'ok' }
  if (availableBytes < RECORDING_DISK_SPACE_BLOCK_BYTES) return { level: 'blocked', availableBytes }
  if (availableBytes < RECORDING_DISK_SPACE_WARN_BYTES) return { level: 'warn', availableBytes }
  return { level: 'ok' }
}

/** Short, unit-suffixed size for a toast: `840 MB`, `1.7 GB`. */
export function formatAvailableSpace(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (safeBytes >= BYTES_PER_GIB) return `${(safeBytes / BYTES_PER_GIB).toFixed(1)} GB`
  return `${Math.round(safeBytes / BYTES_PER_MIB)} MB`
}
