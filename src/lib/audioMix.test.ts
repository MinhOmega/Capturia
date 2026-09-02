import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_MIX_FADE_IN_SECONDS,
  AUDIO_MIX_LIMITER,
  type AudioMixContext,
  buildAudioMixGraph,
  mixAudioTracks,
  needsAudioMixGraph,
  normalizeMicrophoneGain,
} from './audioMix'

class FakeAudioParam {
  value = 1
  setValueAtTime = vi.fn((next: number) => {
    this.value = next
  })
  linearRampToValueAtTime = vi.fn((next: number) => {
    this.value = next
  })
}

class FakeGainNode {
  gain = new FakeAudioParam()
  connect = vi.fn(<T>(destination: T) => destination)
}

class FakeCompressorNode {
  threshold = new FakeAudioParam()
  knee = new FakeAudioParam()
  ratio = new FakeAudioParam()
  attack = new FakeAudioParam()
  release = new FakeAudioParam()
  connect = vi.fn(<T>(destination: T) => destination)
}

class FakeSourceNode {
  constructor(readonly stream: FakeMediaStream) {}
  connect = vi.fn(<T>(destination: T) => destination)
}

class FakeDestinationNode {
  stream = { getAudioTracks: () => [{ kind: 'audio', id: 'dest-track' }] }
  connect = vi.fn(<T>(destination: T) => destination)
}

class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[]) {}
  getAudioTracks() {
    return this.tracks
  }
}

class FakeAudioContext {
  currentTime = 0.5
  createGain = vi.fn(() => new FakeGainNode())
  createDynamicsCompressor = vi.fn(() => new FakeCompressorNode())
  createMediaStreamSource = vi.fn((stream: FakeMediaStream) => new FakeSourceNode(stream))
  createMediaStreamDestination = vi.fn(() => new FakeDestinationNode())
  resume = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
}

const track = (id: string) => ({ kind: 'audio', id }) as unknown as MediaStreamTrack
const asContext = (fake: FakeAudioContext) => fake as unknown as AudioMixContext

describe('normalizeMicrophoneGain', () => {
  it('clamps to the HUD range and defaults to unity', () => {
    expect(normalizeMicrophoneGain(undefined)).toBe(1)
    expect(normalizeMicrophoneGain(Number.NaN)).toBe(1)
    expect(normalizeMicrophoneGain(0.1)).toBe(0.5)
    expect(normalizeMicrophoneGain(5)).toBe(2)
    expect(normalizeMicrophoneGain(1.3)).toBe(1.3)
  })
})

describe('buildAudioMixGraph', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('needs no graph without a microphone', () => {
    expect(needsAudioMixGraph({ systemAudioTrack: track('sys') })).toBe(false)
    expect(needsAudioMixGraph({})).toBe(false)
    expect(needsAudioMixGraph({ micAudioTrack: track('mic') })).toBe(true)
    expect(buildAudioMixGraph(asContext(new FakeAudioContext()), {})).toBeNull()
  })

  it('routes mic -> gain -> limiter -> destination with a ramp to the user gain', () => {
    const ctx = new FakeAudioContext()
    const graph = buildAudioMixGraph(asContext(ctx), {
      micAudioTrack: track('mic'),
      microphoneGain: 1.5,
    })
    expect(graph).not.toBeNull()
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(1)
    expect(ctx.createGain).toHaveBeenCalledTimes(1)
    expect(graph?.systemGain).toBeNull()

    const micGain = graph?.micGain as unknown as FakeGainNode
    expect(micGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0.5)
    expect(micGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1.5,
      0.5 + AUDIO_MIX_FADE_IN_SECONDS,
    )

    const [micSource] = ctx.createMediaStreamSource.mock.results.map((r) => r.value)
    expect((micSource.stream as FakeMediaStream).tracks).toEqual([track('mic')])
    expect(micSource.connect).toHaveBeenCalledWith(micGain)
    const limiter = graph?.limiter as unknown as FakeCompressorNode
    expect(micGain.connect).toHaveBeenCalledWith(limiter)
    const [destination] = ctx.createMediaStreamDestination.mock.results.map((r) => r.value)
    expect(limiter.connect).toHaveBeenCalledWith(destination)
    expect(graph?.track).toEqual({ kind: 'audio', id: 'dest-track' })
  })

  it('adds the system branch at unity through the same limiter when both inputs are present', () => {
    const ctx = new FakeAudioContext()
    ctx.currentTime = 2
    const graph = buildAudioMixGraph(asContext(ctx), {
      micAudioTrack: track('mic'),
      systemAudioTrack: track('sys'),
      microphoneGain: 0.8,
    })
    expect(ctx.createMediaStreamSource).toHaveBeenCalledTimes(2)
    expect(ctx.createGain).toHaveBeenCalledTimes(2)

    const systemGain = graph?.systemGain as unknown as FakeGainNode
    expect(systemGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 2)
    expect(systemGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      1,
      2 + AUDIO_MIX_FADE_IN_SECONDS,
    )
    const micGain = graph?.micGain as unknown as FakeGainNode
    expect(micGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(
      0.8,
      2 + AUDIO_MIX_FADE_IN_SECONDS,
    )

    const [, systemSource] = ctx.createMediaStreamSource.mock.results.map((r) => r.value)
    expect((systemSource.stream as FakeMediaStream).tracks).toEqual([track('sys')])
    expect(systemSource.connect).toHaveBeenCalledWith(systemGain)
    const limiter = graph?.limiter as unknown as FakeCompressorNode
    expect(systemGain.connect).toHaveBeenCalledWith(limiter)
    expect(micGain.connect).toHaveBeenCalledWith(limiter)
    // One limiter feeds the destination exactly once.
    expect(limiter.connect).toHaveBeenCalledTimes(1)
  })

  it('configures the soft limiter', () => {
    const ctx = new FakeAudioContext()
    const graph = buildAudioMixGraph(asContext(ctx), { micAudioTrack: track('mic') })
    const limiter = graph?.limiter as unknown as FakeCompressorNode
    expect(limiter.threshold.value).toBe(AUDIO_MIX_LIMITER.thresholdDb)
    expect(limiter.knee.value).toBe(AUDIO_MIX_LIMITER.kneeDb)
    expect(limiter.ratio.value).toBe(AUDIO_MIX_LIMITER.ratio)
    expect(limiter.attack.value).toBe(AUDIO_MIX_LIMITER.attackSeconds)
    expect(limiter.release.value).toBe(AUDIO_MIX_LIMITER.releaseSeconds)
  })

  it('honours a custom fade-in and a context at time zero', () => {
    const ctx = new FakeAudioContext()
    ctx.currentTime = 0
    const graph = buildAudioMixGraph(asContext(ctx), {
      micAudioTrack: track('mic'),
      fadeInSeconds: 0.1,
    })
    const micGain = graph?.micGain as unknown as FakeGainNode
    expect(micGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0)
    expect(micGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 0.1)
  })
})

describe('mixAudioTracks', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaStream', FakeMediaStream)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns nothing when there is no audio input', () => {
    const createContext = vi.fn()
    expect(mixAudioTracks({}, createContext)).toEqual({ context: null, track: null, stream: null })
    expect(createContext).not.toHaveBeenCalled()
  })

  it('passes a lone system track through verbatim without creating a context', () => {
    const createContext = vi.fn()
    const sys = track('sys')
    const result = mixAudioTracks({ systemAudioTrack: sys }, createContext)
    expect(result.context).toBeNull()
    expect(result.track).toBe(sys)
    expect((result.stream as unknown as FakeMediaStream).tracks).toEqual([sys])
    expect(createContext).not.toHaveBeenCalled()
  })

  it('creates and resumes a context when the mic is present and hands back the destination stream', () => {
    const ctx = new FakeAudioContext()
    const result = mixAudioTracks(
      { micAudioTrack: track('mic'), systemAudioTrack: track('sys') },
      () => ctx as unknown as AudioContext,
    )
    expect(result.context).toBe(ctx)
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect(result.track).toEqual({ kind: 'audio', id: 'dest-track' })
    const [destination] = ctx.createMediaStreamDestination.mock.results.map((r) => r.value)
    expect(result.stream).toBe(destination.stream)
  })

  it('records the raw tracks when no AudioContext is available', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const mic = track('mic')
    const sys = track('sys')
    const result = mixAudioTracks({ micAudioTrack: mic, systemAudioTrack: sys }, () => undefined)
    expect(result.context).toBeNull()
    expect(result.track).toBe(mic)
    expect((result.stream as unknown as FakeMediaStream).tracks).toEqual([mic, sys])
    warn.mockRestore()
  })
})
