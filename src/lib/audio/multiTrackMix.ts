/**
 * Sums several decoded audio tracks into one planar stream for export.
 *
 * Recordings that keep the microphone and system audio as separate tracks
 * (OBS, screen recorders that write one track per input) used to be exported
 * with only the first track; if that one was silent the mic vanished from the
 * export. The exporter now opens one decoder sink per track and feeds their
 * buffers through `MultiTrackMixer`, which places every chunk on a shared
 * sample grid anchored at source time zero, sums the channels (per-track gain,
 * mono upmixed / surround folded to the mix layout) and releases output only
 * up to the point every live track has delivered, so tracks that start late,
 * end early or arrive in different chunk sizes stay sample-aligned.
 *
 * The sum is soft-limited so two loud sources cannot wrap or overflow the
 * encoder; the export's own gain / loudness / hard-limiter chain runs
 * afterwards, unchanged.
 */

import { conformPlanarChannels } from './downmix'

/** Output channel count the mixer works in: mono or stereo, like the encoders. */
export type MixChannelCount = 1 | 2

/** One decoded chunk of a track: absolute source time plus planar samples. */
export interface PlanarAudioChunk {
  /** Source time of the first sample, in seconds (may be negative for codec preroll). */
  timestampSec: number
  sampleRate: number
  /** `planes[channel][frame]`; all planes have the same length. */
  planes: Float32Array[]
}

export interface MultiTrackMixerOptions {
  trackCount: number
  sampleRate: number
  channels: MixChannelCount
  /** Linear gain per track; missing entries default to 1. */
  trackGains?: number[]
  /**
   * Soft-limiter knee in linear scale (0 < knee < 1). Samples above it are
   * squashed towards 1 with a `tanh` curve; `false` disables the limiter.
   * Defaults to `DEFAULT_SOFT_LIMIT_KNEE`.
   */
  softLimitKnee?: number | false
}

export const DEFAULT_SOFT_LIMIT_KNEE = 0.9

/** Mono stays mono; anything with a stereo or wider track mixes in stereo. */
export function resolveMixChannelCount(trackChannelCounts: number[]): MixChannelCount {
  return trackChannelCounts.some((count) => count >= 2) ? 2 : 1
}

/**
 * Soft-knee limiter, in place. Below `knee` the signal is untouched; above it
 * the excess is compressed with `tanh` so the output approaches but never
 * exceeds 1. Continuous with slope 1 at the knee, so no click is introduced.
 */
export function softLimitInPlace(plane: Float32Array, knee = DEFAULT_SOFT_LIMIT_KNEE): void {
  if (!(knee > 0 && knee < 1)) return
  const headroom = 1 - knee
  for (let i = 0; i < plane.length; i += 1) {
    const sample = plane[i]
    const magnitude = Math.abs(sample)
    if (magnitude <= knee) continue
    const limited = knee + headroom * Math.tanh((magnitude - knee) / headroom)
    plane[i] = sample < 0 ? -limited : limited
  }
}

interface TrackState {
  /** Absolute frame index up to which this track has delivered samples. */
  frontier: number
  ended: boolean
  gain: number
}

/**
 * Sample-accurate accumulator for N tracks. Push chunks in any interleaving;
 * `drain()` returns the mixed frames every live track has already covered.
 */
export class MultiTrackMixer {
  readonly sampleRate: number
  readonly channels: MixChannelCount
  private readonly tracks: TrackState[]
  private readonly knee: number | false
  private acc: Float32Array[]
  /** Absolute frame index of `acc[*][0]`. */
  private accStart = 0
  /** Absolute frame index one past the last accumulated sample. */
  private accEnd = 0

  constructor(options: MultiTrackMixerOptions) {
    if (!(options.trackCount >= 1)) throw new Error('MultiTrackMixer needs at least one track')
    if (!(options.sampleRate > 0)) throw new Error('MultiTrackMixer needs a positive sample rate')
    this.sampleRate = options.sampleRate
    this.channels = options.channels
    this.knee = options.softLimitKnee ?? DEFAULT_SOFT_LIMIT_KNEE
    this.tracks = Array.from({ length: options.trackCount }, (_, index) => {
      const gain = options.trackGains?.[index]
      return {
        frontier: Number.NEGATIVE_INFINITY,
        ended: false,
        gain: Number.isFinite(gain) ? Math.max(0, gain as number) : 1,
      }
    })
    this.acc = Array.from({ length: options.channels }, () => new Float32Array(0))
  }

  /** Frames accumulated but not yet released. */
  get pendingFrames(): number {
    return this.accEnd - this.accStart
  }

  push(trackIndex: number, chunk: PlanarAudioChunk): void {
    const track = this.tracks[trackIndex]
    if (!track) throw new Error(`Unknown mixer track ${trackIndex}`)
    if (track.ended) throw new Error(`Mixer track ${trackIndex} already ended`)
    if (chunk.sampleRate !== this.sampleRate) {
      throw new Error(
        `Mixer track ${trackIndex} sample rate ${chunk.sampleRate} differs from ${this.sampleRate}`,
      )
    }

    const frameCount = chunk.planes[0]?.length ?? 0
    const start = Math.round(chunk.timestampSec * this.sampleRate)
    const end = start + frameCount
    // Samples that sit before the release point (codec preroll, or a chunk that
    // straddles the last drain) are dropped rather than re-emitted.
    const writeStart = Math.max(start, this.accStart)
    if (frameCount > 0 && end > writeStart) {
      const planes = conformPlanarChannels(chunk.planes, this.channels)
      this.ensureCapacity(end)
      const skip = writeStart - start
      const base = writeStart - this.accStart
      const gain = track.gain
      for (let channel = 0; channel < this.channels; channel += 1) {
        const target = this.acc[channel]
        const source = planes[channel]
        for (let frame = skip; frame < frameCount; frame += 1) {
          target[base + frame - skip] += source[frame] * gain
        }
      }
      if (end > this.accEnd) this.accEnd = end
    }
    if (end > track.frontier) track.frontier = end
  }

  end(trackIndex: number): void {
    const track = this.tracks[trackIndex]
    if (!track) throw new Error(`Unknown mixer track ${trackIndex}`)
    track.ended = true
  }

  /** Releases every frame all live tracks have covered (nothing until each has pushed once). */
  drain(): PlanarAudioChunk | null {
    let ready = Number.POSITIVE_INFINITY
    let live = 0
    for (const track of this.tracks) {
      if (track.ended) continue
      live += 1
      if (track.frontier < ready) ready = track.frontier
    }
    if (live === 0) ready = this.accEnd
    return this.release(Math.min(ready, this.accEnd))
  }

  /** Releases everything that is left; call after `end()` on every track. */
  flush(): PlanarAudioChunk | null {
    return this.release(this.accEnd)
  }

  private release(untilFrame: number): PlanarAudioChunk | null {
    const count = untilFrame - this.accStart
    if (!(count > 0)) return null
    const held = this.accEnd - this.accStart
    const planes = this.acc.map((plane) => {
      const out = plane.slice(0, count)
      if (this.knee !== false) softLimitInPlace(out, this.knee)
      plane.copyWithin(0, count, held)
      plane.fill(0, Math.max(0, held - count), held)
      return out
    })
    const timestampSec = this.accStart / this.sampleRate
    this.accStart = untilFrame
    if (this.accEnd < this.accStart) this.accEnd = this.accStart
    return { timestampSec, sampleRate: this.sampleRate, planes }
  }

  private ensureCapacity(absoluteEnd: number): void {
    const needed = absoluteEnd - this.accStart
    if (needed <= this.acc[0].length) return
    const capacity = Math.max(needed, this.acc[0].length * 2, this.sampleRate)
    const held = this.accEnd - this.accStart
    this.acc = this.acc.map((plane) => {
      const grown = new Float32Array(capacity)
      grown.set(plane.subarray(0, held))
      return grown
    })
  }
}

export interface MixTrackStreamsOptions extends Omit<MultiTrackMixerOptions, 'trackCount'> {
  /** Polled between chunks; the generator returns early once it reports true. */
  isCancelled?: () => boolean
}

/**
 * Pulls chunks from one async source per track (in source order, as decoder
 * sinks deliver them), always advancing the track that lags furthest behind,
 * and yields mixed chunks as soon as every live track has covered them. Memory
 * stays bounded by the skew between tracks plus one chunk.
 */
export async function* mixTrackStreams(
  sources: AsyncIterable<PlanarAudioChunk>[],
  options: MixTrackStreamsOptions,
): AsyncGenerator<PlanarAudioChunk, void, undefined> {
  if (sources.length === 0) return
  const mixer = new MultiTrackMixer({ ...options, trackCount: sources.length })
  const iterators = sources.map((source) => source[Symbol.asyncIterator]())
  const frontiers = sources.map(() => Number.NEGATIVE_INFINITY)
  const ended = sources.map(() => false)

  try {
    for (;;) {
      if (options.isCancelled?.()) return
      let next = -1
      for (let index = 0; index < iterators.length; index += 1) {
        if (ended[index]) continue
        if (next === -1 || frontiers[index] < frontiers[next]) next = index
      }
      if (next === -1) break

      const result = await iterators[next].next()
      if (result.done) {
        ended[next] = true
        mixer.end(next)
      } else {
        const chunk = result.value
        mixer.push(next, chunk)
        const chunkEnd =
          Math.round(chunk.timestampSec * chunk.sampleRate) + (chunk.planes[0]?.length ?? 0)
        if (chunkEnd > frontiers[next]) frontiers[next] = chunkEnd
      }
      const mixed = mixer.drain()
      if (mixed) yield mixed
    }
    const rest = mixer.flush()
    if (rest) yield rest
  } finally {
    for (let index = 0; index < iterators.length; index += 1) {
      if (ended[index]) continue
      try {
        await iterators[index].return?.()
      } catch {
        /* source already closed */
      }
    }
  }
}
