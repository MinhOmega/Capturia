import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { mixAudioBufferToMono } from '@/lib/captioning/extractMono16kMediabunny'
import { MAX_IN_MEMORY_SOURCE_BYTES } from '@/lib/exporter/sourceFileLimits'
import { peakBlockCount } from './audioPeaks'

/**
 * Waveform peaks for recordings too large to read into memory.
 *
 * The in-memory path in `useAudioPeaks.ts` reads the whole file through
 * `readBinaryFile` and hands it to `decodeAudioData`, which needs the entire
 * recording plus its decoded PCM resident at once: about 12 MB per minute of
 * 48 kHz mono float on top of the file itself. Past a few hundred megabytes
 * that is a renderer crash rather than a slow waveform.
 *
 * This path never holds more than one decoded chunk. Audio packets are demuxed
 * and decoded a chunk at a time (mediabunny's `AudioBufferSink`, which drives
 * WebCodecs `AudioDecoder` under the hood - the same stack the captioning and
 * export paths use), each chunk is folded into a fixed number of min/max
 * columns, and the chunk is dropped. Memory is flat in the recording's length;
 * only the column array survives, and its size depends on duration alone.
 *
 * The column count is `peakBlockCount(duration)`, exactly what the in-memory
 * path produces, so `BackgroundWaveform` cannot tell the two apart.
 */

/** One decoded, channel-averaged chunk of audio on the source timeline. */
export interface DecodedAudioChunk {
  /** Chunk start on the source timeline, in seconds. */
  startSec: number
  /** Channel-averaged samples. */
  samples: Float32Array
  sampleRate: number
}

/**
 * Min/max per column, in the layout `BackgroundWaveform` expects:
 * `[min0, max0, min1, max1, ...]`, length `2 * columnCount`.
 */
export interface PeakColumns {
  columnCount: number
  durationSec: number
  peaks: Float32Array
  /** Highest column reached so far; audio arrives in order, so this is progress. */
  filledColumns: number
}

export interface StreamingPeaksProgress {
  /** A copy of the columns filled so far, safe to hand to React. */
  peaks: Float32Array
  durationMs: number
  /** 0..1. */
  progress: number
}

export interface ReduceAudioChunksOptions {
  durationSec: number
  /** Defaults to `peakBlockCount(durationSec)`. */
  columnCount?: number
  signal?: AbortSignal
  onProgress?: (update: StreamingPeaksProgress) => void
  /** Minimum gap between progress callbacks. Defaults to 250 ms. */
  progressIntervalMs?: number
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number
}

export interface StreamAudioPeaksResult {
  peaks: Float32Array
  durationMs: number
}

const DEFAULT_PROGRESS_INTERVAL_MS = 250

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

/**
 * Whether a source of `sizeBytes` must take the streaming path. The threshold
 * is the exporter's, so "too large for the waveform" and "too large to export
 * in memory" stay the same number.
 */
export function shouldStreamAudioPeaks(
  sizeBytes: number | null | undefined,
  thresholdBytes: number = MAX_IN_MEMORY_SOURCE_BYTES,
): boolean {
  if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes)) return false
  return sizeBytes > thresholdBytes
}

export function createPeakColumns(durationSec: number, columnCount?: number): PeakColumns {
  const columns = columnCount ?? peakBlockCount(durationSec)
  const safeColumns = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 0
  return {
    columnCount: safeColumns,
    durationSec: durationSec > 0 ? durationSec : 0,
    peaks: new Float32Array(safeColumns * 2),
    filledColumns: 0,
  }
}

/**
 * Folds one decoded chunk into the columns it overlaps. Columns keep the
 * running min/max seeded at 0, which is what the in-memory `computePeaks` does,
 * so a half-wave column of a silent passage is 0 either way.
 *
 * Samples outside `[0, durationSec)` are dropped rather than clamped into the
 * first or last column: a container whose timestamps run past its own reported
 * duration would otherwise pile a whole tail into one column and spike it.
 */
export function addSamplesToPeakColumns(state: PeakColumns, chunk: DecodedAudioChunk): void {
  const { columnCount, durationSec, peaks } = state
  const { samples, sampleRate } = chunk
  if (columnCount <= 0 || durationSec <= 0 || sampleRate <= 0 || samples.length === 0) return

  const totalSamples = durationSec * sampleRate
  const samplesPerColumn = totalSamples / columnCount
  if (!Number.isFinite(samplesPerColumn) || samplesPerColumn <= 0) return

  const startSample = chunk.startSec * sampleRate
  let index = 0
  while (index < samples.length) {
    const absolute = startSample + index
    if (absolute < 0) {
      index++
      continue
    }
    const column = Math.floor(absolute / samplesPerColumn)
    if (column >= columnCount) break

    // Last sample of this column, so the inner loop runs without a division.
    const columnEnd = Math.min(
      samples.length,
      Math.ceil((column + 1) * samplesPerColumn - startSample),
    )
    if (columnEnd <= index) {
      index++
      continue
    }

    let min = peaks[column * 2]
    let max = peaks[column * 2 + 1]
    for (; index < columnEnd; index++) {
      const sample = samples[index]
      if (sample < min) min = sample
      if (sample > max) max = sample
    }
    peaks[column * 2] = min
    peaks[column * 2 + 1] = max
    if (column + 1 > state.filledColumns) state.filledColumns = column + 1
  }
}

/**
 * Reduces a stream of decoded chunks to peak columns. Split out from
 * {@link streamAudioPeaks} so the reduction, the progress throttle and
 * cancellation are testable without a demuxer.
 *
 * Cancellation is checked once per chunk and before the first one, so an abort
 * stops the work at the next chunk boundary instead of after the whole track.
 */
export async function reduceAudioChunksToPeaks(
  chunks: AsyncIterable<DecodedAudioChunk>,
  options: ReduceAudioChunksOptions,
): Promise<StreamAudioPeaksResult> {
  const { durationSec, signal, onProgress } = options
  const now = options.now ?? Date.now
  const intervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS
  const state = createPeakColumns(durationSec, options.columnCount)
  const durationMs = state.durationSec * 1000

  if (signal?.aborted) throw abortError()
  if (state.columnCount === 0) return { peaks: new Float32Array(0), durationMs }

  let lastProgressAt = now()
  for await (const chunk of chunks) {
    if (signal?.aborted) throw abortError()
    addSamplesToPeakColumns(state, chunk)
    if (!onProgress) continue
    const timestamp = now()
    if (timestamp - lastProgressAt < intervalMs) continue
    lastProgressAt = timestamp
    onProgress({
      peaks: state.peaks.slice(),
      durationMs,
      progress: Math.min(1, state.filledColumns / state.columnCount),
    })
  }
  if (signal?.aborted) throw abortError()

  return { peaks: state.peaks, durationMs }
}

/**
 * Demuxes and decodes the audio track of `file` chunk by chunk and reduces it
 * to peak columns. Throws when the file has no decodable audio track or no
 * usable duration; the caller then shows no waveform.
 */
export async function streamAudioPeaks(
  file: File,
  options: {
    signal?: AbortSignal
    onProgress?: (update: StreamingPeaksProgress) => void
    progressIntervalMs?: number
  } = {},
): Promise<StreamAudioPeaksResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('No audio track in this recording')
    if (options.signal?.aborted) throw abortError()
    if (!(await track.canDecode())) {
      throw new Error(`Audio codec not supported for the waveform: ${track.codec ?? 'unknown'}`)
    }

    const durationSec = await track.computeDuration()
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error('This recording reports no usable audio duration')
    }

    const sampleRate = track.sampleRate || 48_000
    const sink = new AudioBufferSink(track)
    async function* decodedChunks(): AsyncGenerator<DecodedAudioChunk> {
      for await (const wrapped of sink.buffers()) {
        yield {
          startSec: wrapped.timestamp,
          samples: mixAudioBufferToMono(wrapped.buffer),
          sampleRate: wrapped.buffer.sampleRate || sampleRate,
        }
      }
    }

    return await reduceAudioChunksToPeaks(decodedChunks(), {
      durationSec,
      signal: options.signal,
      onProgress: options.onProgress,
      progressIntervalMs: options.progressIntervalMs,
    })
  } finally {
    try {
      input.dispose()
    } catch {
      // Already disposed.
    }
  }
}
