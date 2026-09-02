import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOFT_LIMIT_KNEE,
  MultiTrackMixer,
  type PlanarAudioChunk,
  mixTrackStreams,
  resolveMixChannelCount,
  softLimitInPlace,
} from './multiTrackMix'

const SR = 1000

function chunk(
  timestampSec: number,
  frames: number,
  fill: number | ((frame: number, channel: number) => number),
  channels = 1,
  sampleRate = SR,
): PlanarAudioChunk {
  const planes = Array.from({ length: channels }, (_, channel) => {
    const plane = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) {
      plane[i] = typeof fill === 'number' ? fill : fill(i, channel)
    }
    return plane
  })
  return { timestampSec, sampleRate, planes }
}

async function* fromChunks(chunks: PlanarAudioChunk[]): AsyncGenerator<PlanarAudioChunk> {
  for (const c of chunks) yield c
}

async function collect(
  gen: AsyncIterable<PlanarAudioChunk>,
): Promise<{ chunks: PlanarAudioChunk[]; joined: Float32Array[] }> {
  const chunks: PlanarAudioChunk[] = []
  for await (const c of gen) chunks.push(c)
  const channels = chunks[0]?.planes.length ?? 0
  const total = chunks.reduce((sum, c) => sum + (c.planes[0]?.length ?? 0), 0)
  const joined = Array.from({ length: channels }, () => new Float32Array(total))
  let offset = 0
  for (const c of chunks) {
    for (let ch = 0; ch < channels; ch += 1) joined[ch].set(c.planes[ch], offset)
    offset += c.planes[0].length
  }
  return { chunks, joined }
}

describe('resolveMixChannelCount', () => {
  it('stays mono only when every track is mono', () => {
    expect(resolveMixChannelCount([1, 1])).toBe(1)
    expect(resolveMixChannelCount([1, 2])).toBe(2)
    expect(resolveMixChannelCount([6, 1])).toBe(2)
  })
})

describe('softLimitInPlace', () => {
  it('leaves samples below the knee untouched and caps the rest below 1', () => {
    const plane = new Float32Array([0.5, -0.5, 0.9, 1.0, 1.8, -2.5, 10])
    softLimitInPlace(plane, DEFAULT_SOFT_LIMIT_KNEE)
    expect(plane[0]).toBe(0.5)
    expect(plane[1]).toBe(-0.5)
    expect(plane[2]).toBeCloseTo(0.9, 6)
    for (let i = 3; i < plane.length; i += 1) {
      expect(Math.abs(plane[i])).toBeLessThanOrEqual(1)
      expect(Math.abs(plane[i])).toBeGreaterThan(0.9)
    }
    expect(plane[5]).toBeLessThan(0)
    // Monotonic: louder input stays louder output.
    expect(plane[4]).toBeGreaterThan(plane[3])
  })

  it('is a no-op for an invalid knee', () => {
    const plane = new Float32Array([1.5])
    softLimitInPlace(plane, 1)
    expect(plane[0]).toBe(1.5)
  })
})

describe('MultiTrackMixer', () => {
  it('sums two aligned mono tracks sample by sample', () => {
    const mixer = new MultiTrackMixer({ trackCount: 2, sampleRate: SR, channels: 1 })
    mixer.push(0, chunk(0, 4, 0.25))
    mixer.push(1, chunk(0, 4, 0.5))
    const out = mixer.drain()
    expect(out?.timestampSec).toBe(0)
    expect(Array.from(out!.planes[0])).toEqual([0.75, 0.75, 0.75, 0.75])
    expect(mixer.pendingFrames).toBe(0)
  })

  it('releases nothing until every live track has delivered', () => {
    const mixer = new MultiTrackMixer({ trackCount: 2, sampleRate: SR, channels: 1 })
    mixer.push(0, chunk(0, 10, 1))
    expect(mixer.drain()).toBeNull()
    mixer.push(1, chunk(0, 4, 1))
    expect(mixer.drain()?.planes[0].length).toBe(4)
    expect(mixer.pendingFrames).toBe(6)
  })

  it('aligns a track that starts late on the sample grid', () => {
    const mixer = new MultiTrackMixer({
      trackCount: 2,
      sampleRate: SR,
      channels: 1,
      softLimitKnee: false,
    })
    mixer.push(0, chunk(0, 10, 0.1))
    // 3 ms late = 3 frames at 1 kHz.
    mixer.push(1, chunk(0.003, 4, 0.2))
    const out = mixer.drain()!
    expect(out.planes[0].length).toBe(7)
    expect(Array.from(out.planes[0]).map((v) => Number(v.toFixed(4)))).toEqual([
      0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3,
    ])
  })

  it('keeps releasing when a track ends early', () => {
    const mixer = new MultiTrackMixer({
      trackCount: 2,
      sampleRate: SR,
      channels: 1,
      softLimitKnee: false,
    })
    mixer.push(0, chunk(0, 6, 0.1))
    mixer.push(1, chunk(0, 2, 0.2))
    expect(mixer.drain()?.planes[0].length).toBe(2)
    mixer.end(1)
    const rest = mixer.drain()!
    expect(rest.timestampSec).toBeCloseTo(2 / SR, 9)
    expect(Array.from(rest.planes[0]).map((v) => Number(v.toFixed(4)))).toEqual([
      0.1, 0.1, 0.1, 0.1,
    ])
    expect(mixer.flush()).toBeNull()
  })

  it('upmixes mono to stereo and folds surround before summing', () => {
    const mixer = new MultiTrackMixer({
      trackCount: 2,
      sampleRate: SR,
      channels: 2,
      softLimitKnee: false,
    })
    mixer.push(0, chunk(0, 2, 0.2, 1))
    // 5.1: FL=0.4 only.
    mixer.push(
      1,
      chunk(0, 2, (_, channel) => (channel === 0 ? 0.4 : 0), 6),
    )
    const out = mixer.drain()!
    expect(out.planes.length).toBe(2)
    expect(out.planes[0][0]).toBeGreaterThan(0.2)
    expect(out.planes[1][0]).toBeCloseTo(0.2, 6)
  })

  it('applies per-track gain and drops preroll before time zero', () => {
    const mixer = new MultiTrackMixer({
      trackCount: 2,
      sampleRate: SR,
      channels: 1,
      trackGains: [0.5, 2],
      softLimitKnee: false,
    })
    mixer.push(0, chunk(-0.002, 5, 1))
    mixer.push(1, chunk(0, 3, 0.1))
    const out = mixer.drain()!
    expect(out.timestampSec).toBe(0)
    expect(Array.from(out.planes[0]).map((v) => Number(v.toFixed(4)))).toEqual([0.7, 0.7, 0.7])
  })

  it('soft-limits the sum so it never exceeds full scale', () => {
    const mixer = new MultiTrackMixer({ trackCount: 2, sampleRate: SR, channels: 1 })
    mixer.push(0, chunk(0, 3, 0.9))
    mixer.push(1, chunk(0, 3, 0.9))
    const out = mixer.drain()!
    for (const sample of out.planes[0]) {
      expect(sample).toBeLessThanOrEqual(1)
      expect(sample).toBeGreaterThan(0.9)
    }
  })

  it('rejects a chunk with a different sample rate', () => {
    const mixer = new MultiTrackMixer({ trackCount: 1, sampleRate: SR, channels: 1 })
    expect(() => mixer.push(0, chunk(0, 2, 0, 1, 2 * SR))).toThrow(/sample rate/)
  })

  it('survives buffer growth across many releases without losing samples', () => {
    const mixer = new MultiTrackMixer({
      trackCount: 2,
      sampleRate: SR,
      channels: 1,
      softLimitKnee: false,
    })
    const out: number[] = []
    let t = 0
    for (let i = 0; i < 50; i += 1) {
      mixer.push(
        0,
        chunk(t / SR, 37, (f) => (t + f) / 10_000),
      )
      mixer.push(1, chunk(t / SR, 37, 0))
      t += 37
      const released = mixer.drain()
      if (released) out.push(...released.planes[0])
    }
    mixer.end(0)
    mixer.end(1)
    const rest = mixer.flush()
    if (rest) out.push(...rest.planes[0])
    expect(out.length).toBe(50 * 37)
    for (let i = 0; i < out.length; i += 1) expect(out[i]).toBeCloseTo(i / 10_000, 6)
  })
})

describe('mixTrackStreams', () => {
  it('merges tracks with different chunk sizes and offsets into one continuous stream', async () => {
    const a = [chunk(0, 5, 0.1), chunk(0.005, 5, 0.1), chunk(0.01, 5, 0.1)]
    // Starts 2 frames late, bigger chunks, ends before a.
    const b = [chunk(0.002, 8, 0.2)]
    const { chunks, joined } = await collect(
      mixTrackStreams([fromChunks(a), fromChunks(b)], {
        sampleRate: SR,
        channels: 1,
        softLimitKnee: false,
      }),
    )
    expect(chunks[0].timestampSec).toBe(0)
    // Contiguous timestamps.
    let expectedNext = 0
    for (const c of chunks) {
      expect(c.timestampSec).toBeCloseTo(expectedNext / SR, 9)
      expectedNext += c.planes[0].length
    }
    expect(joined[0].length).toBe(15)
    const rounded = Array.from(joined[0]).map((v) => Number(v.toFixed(4)))
    expect(rounded).toEqual([
      0.1, 0.1, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1,
    ])
  })

  it('handles a single source and an empty source list', async () => {
    const solo = await collect(
      mixTrackStreams([fromChunks([chunk(0, 3, 0.4)])], { sampleRate: SR, channels: 1 }),
    )
    expect(Array.from(solo.joined[0]).map((v) => Number(v.toFixed(4)))).toEqual([0.4, 0.4, 0.4])
    const none = await collect(mixTrackStreams([], { sampleRate: SR, channels: 1 }))
    expect(none.chunks).toEqual([])
  })

  it('stops pulling and closes the sources when cancelled', async () => {
    let pulled = 0
    let returned = 0
    const endless: AsyncIterable<PlanarAudioChunk> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            pulled += 1
            return { done: false, value: chunk((pulled - 1) / SR, 1, 0.1) }
          },
          async return() {
            returned += 1
            return { done: true, value: undefined }
          },
        }
      },
    }
    let cancelled = false
    const gen = mixTrackStreams([endless, endless], {
      sampleRate: SR,
      channels: 1,
      isCancelled: () => cancelled,
    })
    await gen.next()
    cancelled = true
    const last = await gen.next()
    expect(last.done).toBe(true)
    expect(pulled).toBeGreaterThan(0)
    expect(returned).toBe(2)
  })
})
