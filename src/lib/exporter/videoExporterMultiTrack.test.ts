import { describe, expect, it, vi } from 'vitest'
import type { SpeedTimelineSegment } from './timelineSegments'

// Lightweight AudioBuffer polyfill for Node (no Web Audio API available).
class FakeAudioBuffer {
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
  private readonly channels: Float32Array[]

  constructor(opts: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = opts.length
    this.numberOfChannels = opts.numberOfChannels
    this.sampleRate = opts.sampleRate
    this.channels = Array.from(
      { length: opts.numberOfChannels },
      () => new Float32Array(opts.length),
    )
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel]
  }
}
Object.assign(globalThis, { AudioBuffer: FakeAudioBuffer })

type WrappedBuffer = { buffer: FakeAudioBuffer; timestamp: number; duration: number }

/** Stand-in for mediabunny's `InputAudioTrack`: only what the exporter reads. */
interface FakeTrack {
  id: number
  sampleRate: number
  numberOfChannels: number
  codec: string | null
  canDecode(): Promise<boolean>
}

/** Private exporter state `runExportAttempt` fills in before `exportAudioTrack()`. */
type ExporterInternals = {
  sourceAudioTrack: unknown
  sourceAudioTracks: unknown[]
  sourceAudioStreamCount: number | null
  sourceDurationMs: number
  samplingMode: 'seek-only' | 'webcodecs'
  audioTimeline: SpeedTimelineSegment[]
  audioTotalFrames: number
  muxer: { addAudioBuffer(buffer: FakeAudioBuffer): Promise<void> } | null
  warnings: Set<string>
  exportAudioTrack(): Promise<void>
  collectMixableAudioTracks(input: unknown, primary: unknown): Promise<unknown[]>
}

// Track-aware fake sink: each track has its own decoded buffers, yielded in
// source order when they overlap [start, end), like mediabunny does.
const sinkState = { byTrack: new Map<unknown, WrappedBuffer[]>(), constructed: [] as unknown[] }

vi.mock('mediabunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mediabunny')>()
  return {
    ...actual,
    AudioBufferSink: class FakeAudioBufferSink {
      constructor(private readonly track: unknown) {
        sinkState.constructed.push(track)
      }
      async *buffers(start: number, end: number): AsyncGenerator<WrappedBuffer> {
        for (const wrapped of sinkState.byTrack.get(this.track) ?? []) {
          const bufferStart = wrapped.timestamp
          const bufferEnd = wrapped.timestamp + wrapped.duration
          if (bufferEnd <= start || bufferStart >= end) continue
          yield wrapped
        }
      }
    },
  }
})

const { VideoExporter } = await import('./videoExporter')

const SR = 48000

function track(id: number, numberOfChannels = 1, sampleRate = SR, decodable = true): FakeTrack {
  return {
    id,
    sampleRate,
    numberOfChannels,
    codec: 'aac',
    canDecode: async () => decodable,
  }
}

/** Synthetic decoded track: `chunkSec` buffers from `startSec`, sample = `fill(absoluteIndex, channel)`. */
function makeBuffers(opts: {
  durationSec: number
  channels?: number
  chunkSec?: number
  startSec?: number
  fill: (absoluteIndex: number, channel: number) => number
}): WrappedBuffer[] {
  const channels = opts.channels ?? 1
  const chunkSec = opts.chunkSec ?? 0.1
  const startSec = opts.startSec ?? 0
  const buffers: WrappedBuffer[] = []
  for (let t = startSec; t < opts.durationSec - 1e-9; t += chunkSec) {
    const duration = Math.min(chunkSec, opts.durationSec - t)
    const length = Math.round(duration * SR)
    const buffer = new FakeAudioBuffer({ length, numberOfChannels: channels, sampleRate: SR })
    const base = Math.round(t * SR)
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c)
      for (let i = 0; i < length; i++) data[i] = opts.fill(base + i, c)
    }
    buffers.push({ buffer, timestamp: t, duration })
  }
  return buffers
}

function makeExporter(durationMs: number) {
  const exporter = new VideoExporter({
    videoUrl: 'file:///tmp/mock.webm',
    width: 1920,
    height: 1080,
    frameRate: 60,
    bitrate: 20_000_000,
    wallpaper: '#000',
    zoomRegions: [],
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    showShadow: false,
    shadowIntensity: 0,
    showBlur: false,
    audioProcessing: { normalizeLoudness: false },
  }) as unknown as ExporterInternals
  exporter.sourceDurationMs = durationMs
  exporter.samplingMode = 'seek-only'
  exporter.audioTimeline = [{ startSec: 0, endSec: durationMs / 1000, speed: 1 }]
  exporter.audioTotalFrames = Math.ceil((durationMs / 1000) * 60)
  const added: FakeAudioBuffer[] = []
  exporter.muxer = {
    addAudioBuffer: async (buffer: FakeAudioBuffer) => {
      added.push(buffer)
    },
  }
  return { exporter, added }
}

function concatChannel(buffers: FakeAudioBuffer[], channel = 0): Float32Array {
  const total = buffers.reduce((sum, b) => sum + b.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const buffer of buffers) {
    out.set(buffer.getChannelData(channel), offset)
    offset += buffer.length
  }
  return out
}

function reset() {
  sinkState.byTrack.clear()
  sinkState.constructed.length = 0
}

describe('VideoExporter multi-track audio', () => {
  it('sums every source audio track sample-accurately before the gain chain', async () => {
    reset()
    const system = track(1)
    const mic = track(2)
    sinkState.byTrack.set(system, makeBuffers({ durationSec: 0.5, fill: () => 0.1 }))
    // Mic starts 20 ms late (typical for a second capture input) with smaller chunks.
    sinkState.byTrack.set(
      mic,
      makeBuffers({ durationSec: 0.5, startSec: 0.02, chunkSec: 0.03, fill: () => 0.2 }),
    )

    const { exporter, added } = makeExporter(500)
    exporter.sourceAudioTrack = system
    exporter.sourceAudioTracks = [system, mic]
    await exporter.exportAudioTrack()

    expect(sinkState.constructed).toEqual([system, mic])
    const mixed = concatChannel(added)
    expect(mixed.length).toBe(Math.round(0.5 * SR))
    const lateStart = Math.round(0.02 * SR)
    expect(mixed[0]).toBeCloseTo(0.1, 5)
    expect(mixed[lateStart - 1]).toBeCloseTo(0.1, 5)
    expect(mixed[lateStart]).toBeCloseTo(0.3, 5)
    expect(mixed[mixed.length - 1]).toBeCloseTo(0.3, 5)
    for (const buffer of added) expect(buffer.numberOfChannels).toBe(1)
  })

  it('mixes in stereo when any track is stereo, upmixing the mono one', async () => {
    reset()
    const stereo = track(1, 2)
    const mono = track(2, 1)
    sinkState.byTrack.set(
      stereo,
      makeBuffers({ durationSec: 0.2, channels: 2, fill: (_, c) => (c === 0 ? 0.4 : 0) }),
    )
    sinkState.byTrack.set(mono, makeBuffers({ durationSec: 0.2, fill: () => 0.1 }))

    const { exporter, added } = makeExporter(200)
    exporter.sourceAudioTrack = stereo
    exporter.sourceAudioTracks = [stereo, mono]
    await exporter.exportAudioTrack()

    expect(added.length).toBeGreaterThan(0)
    for (const buffer of added) expect(buffer.numberOfChannels).toBe(2)
    expect(concatChannel(added, 0)[0]).toBeCloseTo(0.5, 5)
    expect(concatChannel(added, 1)[0]).toBeCloseTo(0.1, 5)
  })

  it('keeps the single-track path unchanged (one sink, buffers passed through)', async () => {
    reset()
    const only = track(1)
    const source = makeBuffers({ durationSec: 0.3, fill: (i) => Math.sin(i / 50) * 0.5 })
    sinkState.byTrack.set(only, source)

    const { exporter, added } = makeExporter(300)
    exporter.sourceAudioTrack = only
    exporter.sourceAudioTracks = [only]
    await exporter.exportAudioTrack()

    expect(sinkState.constructed).toEqual([only])
    const expected = concatChannel(source.map((w) => w.buffer))
    const actual = concatChannel(added)
    expect(actual.length).toBe(expected.length)
    for (let i = 0; i < actual.length; i += 1) expect(actual[i]).toBe(expected[i])
  })

  it('reads mixed audio per kept range so trims apply to every track', async () => {
    reset()
    const a = track(1)
    const b = track(2)
    sinkState.byTrack.set(a, makeBuffers({ durationSec: 1, fill: () => 0.1 }))
    sinkState.byTrack.set(b, makeBuffers({ durationSec: 1, fill: () => 0.1 }))

    const exporter = new VideoExporter({
      videoUrl: 'file:///tmp/mock.webm',
      width: 1920,
      height: 1080,
      frameRate: 60,
      bitrate: 20_000_000,
      wallpaper: '#000',
      zoomRegions: [],
      cropRegion: { x: 0, y: 0, width: 1, height: 1 },
      showShadow: false,
      shadowIntensity: 0,
      showBlur: false,
      trimRegions: [{ id: 't', startMs: 200, endMs: 800 }],
      audioProcessing: { normalizeLoudness: false },
    }) as unknown as ExporterInternals
    exporter.sourceDurationMs = 1000
    exporter.samplingMode = 'seek-only'
    exporter.audioTimeline = [
      { startSec: 0, endSec: 0.2, speed: 1 },
      { startSec: 0.8, endSec: 1, speed: 1 },
    ]
    exporter.audioTotalFrames = 24
    const added: FakeAudioBuffer[] = []
    exporter.muxer = { addAudioBuffer: async (buffer) => void added.push(buffer) }
    exporter.sourceAudioTrack = a
    exporter.sourceAudioTracks = [a, b]
    await exporter.exportAudioTrack()

    const mixed = concatChannel(added)
    expect(mixed.length).toBe(Math.round(0.4 * SR))
    expect(mixed[0]).toBeCloseTo(0.2, 5)
    expect(mixed[mixed.length - 1]).toBeCloseTo(0.2, 5)
  })
})

describe('VideoExporter collectMixableAudioTracks', () => {
  function input(tracks: FakeTrack[]) {
    return { getAudioTracks: async () => tracks }
  }

  it('keeps every decodable track at the primary sample rate, primary first', async () => {
    const { exporter } = makeExporter(1000)
    const primary = track(1)
    const mic = track(2, 2)
    const result = await exporter.collectMixableAudioTracks(input([mic, primary]), primary)
    expect(result).toEqual([primary, mic])
    expect(exporter.warnings.size).toBe(0)
  })

  it('skips undecodable or differently sampled tracks and records one warning', async () => {
    const { exporter } = makeExporter(1000)
    const primary = track(1)
    const broken = track(2, 1, SR, false)
    const other = track(3, 1, 44100)
    const result = await exporter.collectMixableAudioTracks(
      input([primary, broken, other]),
      primary,
    )
    expect(result).toEqual([primary])
    expect([...exporter.warnings]).toEqual(['editor.exportWarningAudioTracksSkipped'])
  })

  it('falls back to the primary when the track list cannot be read', async () => {
    const { exporter } = makeExporter(1000)
    const primary = track(1)
    const result = await exporter.collectMixableAudioTracks(
      {
        getAudioTracks: async () => {
          throw new Error('disposed')
        },
      },
      primary,
    )
    expect(result).toEqual([primary])
    expect(exporter.warnings.size).toBe(0)
  })
})
