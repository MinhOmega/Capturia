/**
 * Peak bucketing shared by the audio-peaks Web Worker and its tests.
 *
 * Output: Float32Array of length 2*N, [min0, max0, min1, max1, ...], where each
 * block covers `totalSamples / N` samples of the channel-averaged signal.
 * N = min(MAX_PEAK_BLOCKS, ceil(duration * PEAK_BLOCKS_PER_SECOND)).
 */

export const PEAK_BLOCKS_PER_SECOND = 200;
export const MAX_PEAK_BLOCKS = 24000;

export function peakBlockCount(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.min(MAX_PEAK_BLOCKS, Math.ceil(durationSeconds * PEAK_BLOCKS_PER_SECOND));
}

export function computePeaks(channels: Float32Array[], durationSeconds: number): Float32Array {
  const nCh = channels.length;
  if (nCh === 0) return new Float32Array(0);

  const totalSamples = channels[0].length;
  const N = peakBlockCount(durationSeconds);
  if (N === 0 || totalSamples === 0) return new Float32Array(0);

  const blockSize = totalSamples / N;
  const peaks = new Float32Array(N * 2);

  for (let i = 0; i < N; i++) {
    const start = Math.floor(i * blockSize);
    const end = Math.min(totalSamples, Math.floor((i + 1) * blockSize));
    let minVal = 0;
    let maxVal = 0;
    for (let j = start; j < end; j++) {
      let sample = 0;
      for (let c = 0; c < nCh; c++) sample += channels[c][j];
      sample /= nCh;
      if (sample < minVal) minVal = sample;
      if (sample > maxVal) maxVal = sample;
    }
    peaks[i * 2] = minVal;
    peaks[i * 2 + 1] = maxVal;
  }

  return peaks;
}
