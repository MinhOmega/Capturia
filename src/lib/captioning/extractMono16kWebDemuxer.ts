import { WebDemuxer } from 'web-demuxer'
import { MAX_CAPTION_AUDIO_SEC } from './captionConstants'
import { mergeChunksToMonoLinear } from './extractMono16kMediabunny'

/**
 * Demux + WebCodecs audio decode through `web-demuxer` (the same wasm demuxer
 * the export streaming decoder uses). This is the first fallback when
 * `decodeAudioData` cannot handle the container (WebM/Matroska with video,
 * fragmented MP4); the mediabunny variant (`extractMono16kMediabunny.ts`) is
 * kept as the second fallback for containers this demuxer rejects.
 *
 * The output shape is shared by both demux paths so `extractMono16k.ts` can
 * chain them.
 */
export interface DecodedMonoPcm {
  mono: Float32Array
  sampleRate: number
  durationSec: number
  /** True when `maxReadSec` cut the track short of its reported duration. */
  capped: boolean
}

/** Subset of `web-demuxer`'s stream info this module reads. */
export interface CaptionDemuxerStream {
  codec_type_string: string
  codec_string?: string
  sample_rate?: number
  channels?: number
  duration?: number
}

/** Subset of `WebDemuxer` used here; the tests provide a fake. */
export interface CaptionDemuxer {
  load(source: File): Promise<void>
  getMediaInfo(): Promise<{ duration: number; streams: CaptionDemuxerStream[] }>
  getDecoderConfig(type: 'audio'): Promise<AudioDecoderConfig>
  read(type: 'audio', start?: number, end?: number): ReadableStream<EncodedAudioChunk>
  destroy(): void
}

/** Subset of `AudioDecoder` used here; the tests provide a fake. */
export interface CaptionAudioDecoder {
  readonly decodeQueueSize: number
  readonly state: CodecState
  configure(config: AudioDecoderConfig): void
  decode(chunk: EncodedAudioChunk): void
  flush(): Promise<void>
  close(): void
}

/** Slice of `AudioData` needed to mix a decoded buffer down to mono. */
export interface MonoMixableAudioData {
  readonly format: AudioSampleFormat | null
  readonly numberOfChannels: number
  readonly numberOfFrames: number
  readonly sampleRate: number
  /** Microseconds, like `AudioData.timestamp`. */
  readonly timestamp: number
  copyTo(destination: AllowSharedBufferSource, options: AudioDataCopyToOptions): void
  close(): void
}

export interface WebDemuxerAudioDeps {
  createDemuxer?: () => CaptionDemuxer
  createDecoder?: (init: {
    output: (data: MonoMixableAudioData) => void
    error: (error: DOMException) => void
  }) => CaptionAudioDecoder
  isConfigSupported?: (config: AudioDecoderConfig) => Promise<boolean>
}

/** Encoded chunks queued in the decoder before the reader pauses. */
const MAX_DECODE_QUEUE = 16

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function defaultCreateDemuxer(): CaptionDemuxer {
  // Relative URL so it resolves in both dev (http) and packaged (file://) builds.
  const wasmFilePath = new URL('./wasm/web-demuxer.wasm', globalThis.location.href).href
  return new WebDemuxer({ wasmFilePath })
}

function defaultCreateDecoder(init: {
  output: (data: MonoMixableAudioData) => void
  error: (error: DOMException) => void
}): CaptionAudioDecoder {
  return new AudioDecoder(init)
}

async function defaultIsConfigSupported(config: AudioDecoderConfig): Promise<boolean> {
  if (typeof AudioDecoder === 'undefined') return false
  try {
    const result = await AudioDecoder.isConfigSupported(config)
    return result.supported === true
  } catch {
    return false
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1))
}

/* ----------------------------------------------------------------------------
 * AudioData -> mono float
 * -------------------------------------------------------------------------- */

function planeToFloat(
  data: MonoMixableAudioData,
  planeIndex: number,
  format: AudioSampleFormat,
  frames: number,
  channels: number,
): Float32Array {
  const planar = format.endsWith('-planar')
  const count = planar ? frames : frames * channels
  const base = format.replace('-planar', '')
  let raw: Float32Array | Int16Array | Int32Array | Uint8Array
  let scale = 1
  let offset = 0
  switch (base) {
    case 'f32':
      raw = new Float32Array(count)
      break
    case 's16':
      raw = new Int16Array(count)
      scale = 1 / 32768
      break
    case 's32':
      raw = new Int32Array(count)
      scale = 1 / 2147483648
      break
    case 'u8':
      raw = new Uint8Array(count)
      scale = 1 / 128
      offset = -128
      break
    default:
      throw new Error(`Unsupported audio sample format: ${format}`)
  }
  data.copyTo(raw, { planeIndex })
  const out = new Float32Array(frames)
  if (planar) {
    for (let i = 0; i < frames; i++) out[i] = (raw[i]! + offset) * scale
  } else {
    for (let i = 0; i < frames; i++) out[i] = (raw[i * channels + planeIndex]! + offset) * scale
  }
  return out
}

/**
 * Averages every channel of a decoded `AudioData` into one Float32Array.
 * Prefers the decoder's own conversion to `f32-planar`; falls back to reading
 * the native sample format when the runtime does not convert.
 */
export function audioDataToMono(data: MonoMixableAudioData): Float32Array {
  const frames = data.numberOfFrames
  const channels = data.numberOfChannels
  const out = new Float32Array(frames)
  if (frames === 0 || channels === 0) return out

  const accumulate = (plane: Float32Array) => {
    for (let i = 0; i < frames; i++) out[i] += plane[i]!
  }

  const format = data.format
  let converted = false
  if (format !== 'f32-planar') {
    try {
      const plane = new Float32Array(frames)
      for (let c = 0; c < channels; c++) {
        data.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        accumulate(plane)
      }
      converted = true
    } catch {
      out.fill(0)
    }
  }
  if (!converted) {
    if (!format) throw new Error('Decoded audio has no sample format.')
    for (let c = 0; c < channels; c++) {
      if (format === 'f32-planar') {
        const plane = new Float32Array(frames)
        data.copyTo(plane, { planeIndex: c })
        accumulate(plane)
      } else {
        accumulate(planeToFloat(data, c, format, frames, channels))
      }
    }
  }

  if (channels > 1) {
    for (let i = 0; i < frames; i++) out[i] /= channels
  }
  return out
}

/* ----------------------------------------------------------------------------
 * Demux + decode
 * -------------------------------------------------------------------------- */

/**
 * Decodes the first audio stream to mono PCM at the decoder's native sample
 * rate, placed on a linear timeline (`mergeChunksToMonoLinear`).
 *
 * @param maxReadSec Optional cap on how much audio to decode (decoded PCM is
 *   held in memory). `capped` reports whether the cap cut the track short.
 */
export async function extractMonoPcmViaWebDemuxer(
  file: File,
  signal?: AbortSignal,
  maxReadSec?: number,
  deps: WebDemuxerAudioDeps = {},
): Promise<DecodedMonoPcm> {
  const createDemuxer = deps.createDemuxer ?? defaultCreateDemuxer
  const createDecoder = deps.createDecoder ?? defaultCreateDecoder
  const isConfigSupported = deps.isConfigSupported ?? defaultIsConfigSupported

  if (signal?.aborted) throw abortError()
  const demuxer = createDemuxer()
  let decoder: CaptionAudioDecoder | null = null
  const chunks: Array<{ startSample: number; data: Float32Array }> = []
  let sampleRate = 0
  let maxEndSec = 0
  let decodeError: Error | null = null

  try {
    await demuxer.load(file)
    if (signal?.aborted) throw abortError()

    const mediaInfo = await demuxer.getMediaInfo()
    const audioStream = mediaInfo.streams.find((s) => s.codec_type_string === 'audio')
    if (!audioStream) {
      throw new Error('No audio track found in this video.')
    }

    const config = await demuxer.getDecoderConfig('audio')
    if (!(await isConfigSupported(config))) {
      throw new Error(
        `Audio codec not supported for captions: ${config.codec || audioStream.codec_string || 'unknown'}`,
      )
    }

    const containerDurationSec = Number.isFinite(mediaInfo.duration) ? mediaInfo.duration : 0
    const streamDurationSec =
      typeof audioStream.duration === 'number' && Number.isFinite(audioStream.duration)
        ? audioStream.duration
        : 0
    const reportedDurationSec = Math.max(containerDurationSec, streamDurationSec, 0)
    const readCapSec = Math.min(maxReadSec ?? MAX_CAPTION_AUDIO_SEC, MAX_CAPTION_AUDIO_SEC)

    decoder = createDecoder({
      output: (data) => {
        try {
          if (sampleRate === 0) sampleRate = data.sampleRate
          const startSec = data.timestamp / 1_000_000
          chunks.push({
            startSample: Math.round(startSec * sampleRate),
            data: audioDataToMono(data),
          })
          maxEndSec = Math.max(maxEndSec, startSec + data.numberOfFrames / data.sampleRate)
        } catch (error) {
          decodeError = decodeError ?? (error instanceof Error ? error : new Error(String(error)))
        } finally {
          data.close()
        }
      },
      error: (error) => {
        decodeError = decodeError ?? new Error(`Audio decoder error: ${error.message}`)
      },
    })
    decoder.configure(config)

    const reader = demuxer.read('audio', 0, readCapSec).getReader()
    try {
      while (true) {
        if (signal?.aborted) throw abortError()
        if (decodeError) throw decodeError
        const { done, value } = await reader.read()
        if (done || !value) break
        while (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
          if (signal?.aborted) throw abortError()
          if (decodeError) throw decodeError
          await nextTick()
        }
        decoder.decode(value)
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // Already closed.
      }
    }

    try {
      await decoder.flush()
    } catch (error) {
      if (decodeError) throw decodeError
      throw error
    }
    if (decodeError) throw decodeError
    if (signal?.aborted) throw abortError()

    if (chunks.length === 0 || sampleRate <= 0) {
      throw new Error('Decoded zero audio frames from this video.')
    }

    // Prefer the extent implied by decoded frames (fixes bad container durations).
    const durationSec = maxEndSec > 0.02 ? maxEndSec : reportedDurationSec
    const capped = reportedDurationSec > readCapSec + 0.5
    const mono = mergeChunksToMonoLinear(chunks, sampleRate, durationSec)
    return { mono, sampleRate, durationSec, capped }
  } finally {
    if (decoder && decoder.state !== 'closed') {
      try {
        decoder.close()
      } catch {
        // Already closed.
      }
    }
    try {
      demuxer.destroy()
    } catch {
      // Already destroyed.
    }
  }
}
