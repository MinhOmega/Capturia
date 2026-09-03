import { describe, expect, it, vi } from 'vitest'
import { MAX_IN_MEMORY_SOURCE_BYTES } from '@/lib/exporter/sourceFileLimits'
import { peakBlockCount } from './audioPeaks'
import {
  addSamplesToPeakColumns,
  createPeakColumns,
  type DecodedAudioChunk,
  reduceAudioChunksToPeaks,
  shouldStreamAudioPeaks,
} from './streamingAudioPeaks'

function chunk(startSec: number, samples: number[], sampleRate = 4): DecodedAudioChunk {
  return { startSec, samples: Float32Array.from(samples), sampleRate }
}

async function* asChunks(list: DecodedAudioChunk[]): AsyncGenerator<DecodedAudioChunk> {
  for (const item of list) yield item
}

describe('shouldStreamAudioPeaks', () => {
  it('streams only above the exporter threshold', () => {
    expect(shouldStreamAudioPeaks(MAX_IN_MEMORY_SOURCE_BYTES)).toBe(false)
    expect(shouldStreamAudioPeaks(MAX_IN_MEMORY_SOURCE_BYTES + 1)).toBe(true)
    expect(shouldStreamAudioPeaks(0)).toBe(false)
  })

  it('never streams on a missing or nonsense size', () => {
    expect(shouldStreamAudioPeaks(null)).toBe(false)
    expect(shouldStreamAudioPeaks(undefined)).toBe(false)
    expect(shouldStreamAudioPeaks(Number.NaN)).toBe(false)
    expect(shouldStreamAudioPeaks(Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('honours an explicit threshold', () => {
    expect(shouldStreamAudioPeaks(100, 99)).toBe(true)
    expect(shouldStreamAudioPeaks(100, 100)).toBe(false)
  })
})

describe('createPeakColumns', () => {
  it('defaults to the same column count as the in-memory path', () => {
    const state = createPeakColumns(30)
    expect(state.columnCount).toBe(peakBlockCount(30))
    expect(state.peaks).toHaveLength(state.columnCount * 2)
  })

  it('collapses to zero columns for a nonsense duration', () => {
    expect(createPeakColumns(0).columnCount).toBe(0)
    expect(createPeakColumns(Number.NaN).columnCount).toBe(0)
    expect(createPeakColumns(-5).columnCount).toBe(0)
  })
})

describe('addSamplesToPeakColumns', () => {
  it('reduces one chunk to per-column min and max', () => {
    // 2 s at 4 Hz over 4 columns: 2 samples per column.
    const state = createPeakColumns(2, 4)
    addSamplesToPeakColumns(state, chunk(0, [0.5, 0.25, -0.75, 0.1, -0.2, -0.4, 0.9, 0.3]))
    expect(Array.from(state.peaks)).toEqual([
      0, 0.5, -0.75, 0.10000000149011612, -0.4000000059604645, 0, 0, 0.8999999761581421,
    ])
    expect(state.filledColumns).toBe(4)
  })

  it('seeds min and max at zero so a silent column reads flat', () => {
    const state = createPeakColumns(1, 2)
    addSamplesToPeakColumns(state, chunk(0, [0.5, 0.5, 0, 0], 4))
    expect(Array.from(state.peaks)).toEqual([0, 0.5, 0, 0])
  })

  it('places a chunk by its own start time, not by arrival order', () => {
    const state = createPeakColumns(2, 4)
    addSamplesToPeakColumns(state, chunk(1.5, [0.8, -0.8]))
    expect(state.peaks[6]).toBeCloseTo(-0.8)
    expect(state.peaks[7]).toBeCloseTo(0.8)
    // Earlier columns untouched.
    expect(Array.from(state.peaks.subarray(0, 6))).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('spans several columns from a single chunk', () => {
    const state = createPeakColumns(4, 4)
    addSamplesToPeakColumns(state, chunk(0, [1, 1, 1, 1, -1, -1, -1, -1, 0.5, 0.5], 4))
    expect(state.peaks[1]).toBeCloseTo(1)
    expect(state.peaks[2]).toBeCloseTo(-1)
    expect(state.peaks[5]).toBeCloseTo(0.5)
    expect(state.filledColumns).toBe(3)
  })

  it('drops samples that run past the reported duration instead of piling them into the last column', () => {
    const state = createPeakColumns(1, 2)
    addSamplesToPeakColumns(state, chunk(0.9, [0.1, 0.2, 0.9, 0.9, 0.9], 4))
    // Only the sample at 0.9 s lands; 1.15 s onward is beyond the duration.
    expect(state.peaks[3]).toBeCloseTo(0.1)
    expect(state.peaks[1]).toBe(0)
  })

  it('ignores empty chunks and unusable states', () => {
    const empty = createPeakColumns(0)
    addSamplesToPeakColumns(empty, chunk(0, [1]))
    expect(empty.peaks).toHaveLength(0)

    const state = createPeakColumns(2, 4)
    addSamplesToPeakColumns(state, chunk(0, []))
    addSamplesToPeakColumns(state, { startSec: 0, samples: Float32Array.of(1), sampleRate: 0 })
    expect(Array.from(state.peaks)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('reduceAudioChunksToPeaks', () => {
  it('reduces a whole stream and reports the source duration', async () => {
    const result = await reduceAudioChunksToPeaks(
      asChunks([chunk(0, [0.5, -0.5, 0.25, 0.75]), chunk(1, [1, -1, 0.1, 0.1])]),
      { durationSec: 2, columnCount: 2 },
    )
    expect(result.durationMs).toBe(2000)
    expect(Array.from(result.peaks)).toEqual([-0.5, 0.75, -1, 1])
  })

  it('emits throttled partial peaks so the timeline fills in progressively', async () => {
    let clock = 0
    const updates: Array<{ progress: number; peaks: number[] }> = []
    await reduceAudioChunksToPeaks(
      asChunks([
        chunk(0, [0.5, 0.5, 0.5, 0.5]),
        chunk(1, [1, 1, 1, 1]),
        chunk(2, [0.2, 0.2, 0.2, 0.2]),
        chunk(3, [0.3, 0.3, 0.3, 0.3]),
      ]),
      {
        durationSec: 4,
        columnCount: 4,
        progressIntervalMs: 100,
        // 60 ms per chunk: the 1st and 3rd land inside the interval, the 2nd
        // and 4th cross it.
        now: () => (clock += 60),
        onProgress: (update) =>
          updates.push({ progress: update.progress, peaks: Array.from(update.peaks) }),
      },
    )
    expect(updates.map((update) => update.progress)).toEqual([0.5, 1])
    // The first emission carries the columns decoded so far and nothing beyond.
    expect(updates[0].peaks.slice(4)).toEqual([0, 0, 0, 0])
    expect(updates[0].peaks[1]).toBeCloseTo(0.5)
  })

  it('hands each progress update its own copy of the columns', async () => {
    const seen: Float32Array[] = []
    await reduceAudioChunksToPeaks(asChunks([chunk(0, [0.5, 0.5]), chunk(1, [1, 1])]), {
      durationSec: 2,
      columnCount: 2,
      progressIntervalMs: 0,
      onProgress: (update) => seen.push(update.peaks),
    })
    expect(seen).toHaveLength(2)
    // The second update must not have mutated the first one's snapshot.
    expect(seen[0][3]).toBe(0)
    expect(seen[1][3]).toBeCloseTo(1)
  })

  it('rejects before reading anything when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = vi.fn(async function* () {
      yield chunk(0, [1])
    })
    await expect(
      reduceAudioChunksToPeaks(source(), {
        durationSec: 1,
        columnCount: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops at the next chunk boundary when aborted mid-stream', async () => {
    const controller = new AbortController()
    let produced = 0
    async function* source(): AsyncGenerator<DecodedAudioChunk> {
      for (let i = 0; i < 8; i++) {
        produced++
        if (i === 1) controller.abort()
        yield chunk(i, [1, 1, 1, 1])
      }
    }
    await expect(
      reduceAudioChunksToPeaks(source(), {
        durationSec: 8,
        columnCount: 8,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    // Two chunks pulled, then the abort was seen: the remaining six were never decoded.
    expect(produced).toBe(2)
  })

  it('returns empty peaks rather than throwing for a zero-length source', async () => {
    await expect(reduceAudioChunksToPeaks(asChunks([]), { durationSec: 0 })).resolves.toEqual({
      peaks: new Float32Array(0),
      durationMs: 0,
    })
  })
})
