import type { VideoSegment } from '@/components/video-editor/types'
import { effectiveToSourceMsWithSegments } from '@/lib/trim/timeMapping'

/**
 * Perceptual curve on normalized amplitude; exponent < 1 lifts quiet passages so
 * one loud spike doesn't flatten the rest.
 */
export const WAVEFORM_GAMMA = 0.6

/** 1 / loudest |peak|, so quiet recordings still fill the row. 0 when silent/empty. */
export function computeNormalizationFactor(peaks: Float32Array | null): number {
  if (!peaks || peaks.length === 0) return 0
  let globalMax = 0
  for (let i = 0; i < peaks.length; i++) {
    const a = Math.abs(peaks[i])
    if (a > globalMax) globalMax = a
  }
  return globalMax > 0 ? 1 / globalMax : 0
}

export interface WaveformColumnsInput {
  /** [min, max] pairs indexed over the SOURCE duration. */
  peaks: Float32Array
  /** Duration of the decoded audio (source time). */
  sourceDurationMs: number
  /** Visible window in the timeline's own (EFFECTIVE) time. */
  rangeStartMs: number
  rangeEndMs: number
  /** Number of columns (canvas CSS pixels). */
  width: number
  /**
   * Capturia segments (deleted / per-speed). When empty the timeline is in
   * source time and the mapping is the identity.
   */
  segments?: VideoSegment[]
  normFactor?: number
}

/**
 * Rectified display amplitude (0..1, gamma-curved) per column. Each column covers
 * an effective-time slice which is mapped back to source time through the
 * segments, so the waveform lines up with split / sped-up segments on screen.
 */
export function computeWaveformColumns(input: WaveformColumnsInput): Float32Array {
  const { peaks, sourceDurationMs, rangeStartMs, rangeEndMs, width } = input
  const segments = input.segments ?? []
  const W = Math.max(0, Math.floor(width))
  const out = new Float32Array(W)
  const rangeMs = rangeEndMs - rangeStartMs
  const N = peaks.length / 2
  const normFactor = input.normFactor ?? computeNormalizationFactor(peaks)
  if (W === 0 || rangeMs <= 0 || sourceDurationMs <= 0 || N === 0 || normFactor === 0) {
    return out
  }

  const toSource = (effectiveMs: number) =>
    segments.length > 0 ? effectiveToSourceMsWithSegments(effectiveMs, segments) : effectiveMs

  for (let x = 0; x < W; x++) {
    const effStart = rangeStartMs + (x / W) * rangeMs
    const effEnd = rangeStartMs + ((x + 1) / W) * rangeMs
    let srcStart = toSource(effStart)
    let srcEnd = toSource(effEnd)
    if (srcEnd < srcStart) [srcStart, srcEnd] = [srcEnd, srcStart]

    const lo = Math.max(0, Math.floor((srcStart / sourceDurationMs) * N))
    const hi = Math.min(N - 1, Math.ceil((srcEnd / sourceDurationMs) * N))

    let absMax = 0
    for (let i = lo; i <= hi; i++) {
      const a = Math.abs(peaks[i * 2])
      const b = Math.abs(peaks[i * 2 + 1])
      if (a > absMax) absMax = a
      if (b > absMax) absMax = b
    }
    const normalized = Math.min(1, absMax * normFactor)
    out[x] = normalized > 0 ? normalized ** WAVEFORM_GAMMA : 0
  }

  return out
}
