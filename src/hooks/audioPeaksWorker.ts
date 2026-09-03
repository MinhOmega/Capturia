/**
 * Web Worker: computes min/max peak pairs from raw audio channel data.
 * In: { channels: Float32Array[]; duration: number }.
 * Out: Float32Array of length 2*N, [min0, max0, min1, max1, ...].
 * Channel buffers and the peaks buffer are transferred (zero-copy).
 */
import { computePeaks } from './audioPeaks'

self.onmessage = (event: MessageEvent<{ channels: Float32Array[]; duration: number }>) => {
  const { channels, duration } = event.data
  const peaks = computePeaks(channels, duration)
  ;(self as unknown as Worker).postMessage(peaks, [peaks.buffer])
}
