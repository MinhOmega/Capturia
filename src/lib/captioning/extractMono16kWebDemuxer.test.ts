import { describe, expect, it, vi } from 'vitest'
import {
  audioDataToMono,
  type CaptionAudioDecoder,
  type CaptionDemuxer,
  type CaptionDemuxerStream,
  extractMonoPcmViaWebDemuxer,
  type MonoMixableAudioData,
  type WebDemuxerAudioDeps,
} from './extractMono16kWebDemuxer'

type DecoderInit = Parameters<NonNullable<WebDemuxerAudioDeps['createDecoder']>>[0]

/** Fake `AudioData` holding planar float channels. */
function fakeAudioData(
  channels: Float32Array[],
  sampleRate: number,
  timestampUs: number,
  options: { format?: AudioSampleFormat | null; convert?: boolean } = {},
): MonoMixableAudioData & { closed: boolean } {
  const frames = channels[0]?.length ?? 0
  const convert = options.convert ?? true
  return {
    format: options.format === undefined ? 'f32-planar' : options.format,
    numberOfChannels: channels.length,
    numberOfFrames: frames,
    sampleRate,
    timestamp: timestampUs,
    closed: false,
    copyTo(destination, { planeIndex, format }) {
      if (format && format !== 'f32-planar') throw new Error('unsupported conversion')
      if (format === 'f32-planar' && !convert && this.format !== 'f32-planar') {
        throw new Error('conversion not implemented')
      }
      ;(destination as Float32Array).set(channels[planeIndex ?? 0]!)
    },
    close() {
      this.closed = true
    },
  }
}

function encodedChunk(timestampUs: number): EncodedAudioChunk {
  return {
    timestamp: timestampUs,
    type: 'key',
    byteLength: 4,
    duration: 20_000,
  } as unknown as EncodedAudioChunk
}

function chunkStream(chunks: EncodedAudioChunk[]): ReadableStream<EncodedAudioChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

interface FakeDemuxerOptions {
  streams?: CaptionDemuxerStream[]
  duration?: number
  chunks?: EncodedAudioChunk[]
}

function fakeDemuxer(options: FakeDemuxerOptions = {}) {
  const calls = { load: 0, destroy: 0, readRange: null as [number, number] | null }
  const demuxer: CaptionDemuxer = {
    async load() {
      calls.load += 1
    },
    async getMediaInfo() {
      return {
        duration: options.duration ?? 1,
        streams: options.streams ?? [
          { codec_type_string: 'video', codec_string: 'vp09' },
          { codec_type_string: 'audio', codec_string: 'opus', sample_rate: 48_000, channels: 2 },
        ],
      }
    },
    async getDecoderConfig() {
      return { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }
    },
    read(_type, start = 0, end = 0) {
      calls.readRange = [start, end]
      return chunkStream(options.chunks ?? [encodedChunk(0), encodedChunk(20_000)])
    },
    destroy() {
      calls.destroy += 1
    },
  }
  return { demuxer, calls }
}

/**
 * Fake decoder: every encoded chunk yields 960 frames (20 ms at 48 kHz) of a
 * stereo signal with left = 1, right = 0 so the mono mix is 0.5.
 */
function fakeDecoder(opts: { failOn?: number; emit?: boolean } = {}) {
  const state = { configured: null as AudioDecoderConfig | null, closed: false, decoded: 0 }
  const outputs: Array<ReturnType<typeof fakeAudioData>> = []
  const createDecoder = (init: DecoderInit): CaptionAudioDecoder => ({
    decodeQueueSize: 0,
    get state(): CodecState {
      return state.closed ? 'closed' : state.configured ? 'configured' : 'unconfigured'
    },
    configure(config) {
      state.configured = config
    },
    decode(chunk) {
      state.decoded += 1
      if (opts.failOn === state.decoded) {
        init.error(new DOMException('bad packet', 'EncodingError'))
        return
      }
      if (opts.emit === false) return
      const left = new Float32Array(960).fill(1)
      const right = new Float32Array(960).fill(0)
      const data = fakeAudioData([left, right], 48_000, chunk.timestamp)
      outputs.push(data)
      init.output(data)
    },
    async flush() {
      // Nothing queued in the fake.
    },
    close() {
      state.closed = true
    },
  })
  return { createDecoder, state, outputs }
}

describe('extractMonoPcmViaWebDemuxer', () => {
  it('decodes the audio stream to a linear mono buffer and releases resources', async () => {
    const { demuxer, calls } = fakeDemuxer({ duration: 0.04 })
    const decoder = fakeDecoder()
    const file = new File([new Uint8Array(8)], 'clip.webm')

    const result = await extractMonoPcmViaWebDemuxer(file, undefined, undefined, {
      createDemuxer: () => demuxer,
      createDecoder: decoder.createDecoder,
      isConfigSupported: async () => true,
    })

    expect(result.sampleRate).toBe(48_000)
    expect(result.capped).toBe(false)
    expect(result.durationSec).toBeCloseTo(0.04, 6)
    expect(result.mono.length).toBe(1920)
    expect(result.mono[0]).toBeCloseTo(0.5, 6)
    expect(result.mono[1919]).toBeCloseTo(0.5, 6)
    expect(decoder.state.configured?.codec).toBe('opus')
    expect(decoder.state.closed).toBe(true)
    expect(decoder.outputs.every((data) => data.closed)).toBe(true)
    expect(calls.load).toBe(1)
    expect(calls.destroy).toBe(1)
    expect(calls.readRange).toEqual([0, 4 * 60 * 60])
  })

  it('caps the read range and reports when the track was cut short', async () => {
    const { demuxer, calls } = fakeDemuxer({ duration: 120 })
    const decoder = fakeDecoder()

    const result = await extractMonoPcmViaWebDemuxer(new File([], 'long.mp4'), undefined, 10, {
      createDemuxer: () => demuxer,
      createDecoder: decoder.createDecoder,
      isConfigSupported: async () => true,
    })

    expect(calls.readRange).toEqual([0, 10])
    expect(result.capped).toBe(true)
  })

  it('rejects sources without an audio stream', async () => {
    const { demuxer, calls } = fakeDemuxer({
      streams: [{ codec_type_string: 'video', codec_string: 'avc1' }],
    })
    await expect(
      extractMonoPcmViaWebDemuxer(new File([], 'mute.mp4'), undefined, undefined, {
        createDemuxer: () => demuxer,
        createDecoder: fakeDecoder().createDecoder,
        isConfigSupported: async () => true,
      }),
    ).rejects.toThrow(/No audio track/)
    expect(calls.destroy).toBe(1)
  })

  it('rejects codecs the runtime cannot decode', async () => {
    const { demuxer } = fakeDemuxer()
    await expect(
      extractMonoPcmViaWebDemuxer(new File([], 'clip.mkv'), undefined, undefined, {
        createDemuxer: () => demuxer,
        createDecoder: fakeDecoder().createDecoder,
        isConfigSupported: async () => false,
      }),
    ).rejects.toThrow(/not supported for captions: opus/)
  })

  it('surfaces decoder errors and closes the decoder', async () => {
    const { demuxer } = fakeDemuxer()
    const decoder = fakeDecoder({ failOn: 2 })
    await expect(
      extractMonoPcmViaWebDemuxer(new File([], 'clip.webm'), undefined, undefined, {
        createDemuxer: () => demuxer,
        createDecoder: decoder.createDecoder,
        isConfigSupported: async () => true,
      }),
    ).rejects.toThrow(/Audio decoder error: bad packet/)
    expect(decoder.state.closed).toBe(true)
  })

  it('treats a decoder that emits nothing as a failure so the next fallback can run', async () => {
    const { demuxer } = fakeDemuxer()
    await expect(
      extractMonoPcmViaWebDemuxer(new File([], 'clip.webm'), undefined, undefined, {
        createDemuxer: () => demuxer,
        createDecoder: fakeDecoder({ emit: false }).createDecoder,
        isConfigSupported: async () => true,
      }),
    ).rejects.toThrow(/zero audio frames/)
  })

  it('honours an abort signal', async () => {
    const { demuxer, calls } = fakeDemuxer()
    const controller = new AbortController()
    controller.abort()
    const createDecoder = vi.fn(fakeDecoder().createDecoder)
    await expect(
      extractMonoPcmViaWebDemuxer(new File([], 'clip.webm'), controller.signal, undefined, {
        createDemuxer: () => demuxer,
        createDecoder,
        isConfigSupported: async () => true,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(createDecoder).not.toHaveBeenCalled()
    expect(calls.load).toBe(0)
  })
})

describe('audioDataToMono', () => {
  it('averages planar float channels', () => {
    const data = fakeAudioData(
      [new Float32Array([1, 0.5]), new Float32Array([0, 0.5]), new Float32Array([-1, 0.5])],
      48_000,
      0,
    )
    expect(Array.from(audioDataToMono(data))).toEqual([0, 0.5])
  })

  it('falls back to the native sample format when the runtime does not convert', () => {
    const interleaved = new Int16Array([32767, -32768, 0, 16384])
    const data: MonoMixableAudioData = {
      format: 's16',
      numberOfChannels: 2,
      numberOfFrames: 2,
      sampleRate: 16_000,
      timestamp: 0,
      copyTo(destination, { format }) {
        if (format) throw new Error('conversion not implemented')
        ;(destination as Int16Array).set(interleaved)
      },
      close() {
        // Nothing to release in the fake.
      },
    }
    const mono = audioDataToMono(data)
    expect(mono[0]).toBeCloseTo((32767 / 32768 - 1) / 2, 6)
    expect(mono[1]).toBeCloseTo((0 + 0.5) / 2, 6)
  })

  it('handles unsigned 8-bit interleaved samples', () => {
    const data: MonoMixableAudioData = {
      format: 'u8',
      numberOfChannels: 1,
      numberOfFrames: 3,
      sampleRate: 8_000,
      timestamp: 0,
      copyTo(destination, { format }) {
        if (format) throw new Error('conversion not implemented')
        ;(destination as Uint8Array).set([0, 128, 255])
      },
      close() {
        // Nothing to release in the fake.
      },
    }
    const mono = audioDataToMono(data)
    expect(mono[0]).toBeCloseTo(-1, 6)
    expect(mono[1]).toBeCloseTo(0, 6)
    expect(mono[2]).toBeCloseTo(127 / 128, 6)
  })

  it('returns silence for empty buffers', () => {
    expect(audioDataToMono(fakeAudioData([], 48_000, 0)).length).toBe(0)
  })
})
