import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrimRegion, VideoSegment } from '@/components/video-editor/types'
import type { OnFrameCallback } from './streamingDecoder'
import type { SpeedRegion } from './timelineSegments'

/**
 * GIF export on both decode paths with fake decoders: frame-count parity,
 * the WebCodecs -> seek fallback rule and the decode-path selection.
 */

type StreamingFailure =
  | 'metadata'
  | 'before-first'
  | 'mid'
  | 'empty'
  | 'ended-early'
  /** decodeAll swallows the frame callback's rejection and returns with no frames. */
  | 'swallow-callback'

const state = vi.hoisted(() => ({
  durationSec: 2,
  streamingFailure: null as StreamingFailure | null,
  streamingConstructed: 0,
  seekConstructed: 0,
  decodeAllArgs: null as null | {
    trims: TrimRegion[] | undefined
    speeds: SpeedRegion[] | undefined
  },
  rendered: [] as number[],
  renderFailAt: -1,
  gifFrames: [] as number[],
  lastStreaming: null as null | {
    cancel: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  },
  closedFrames: 0,
}))

vi.mock('gif.js', () => {
  class FakeGif {
    frames = 0
    private listeners: Record<string, Array<(value: unknown) => void>> = {}
    addFrame(): void {
      this.frames += 1
    }
    on(event: string, callback: (value: unknown) => void): void {
      const list = this.listeners[event] ?? []
      list.push(callback)
      this.listeners[event] = list
    }
    render(): void {
      state.gifFrames.push(this.frames)
      for (const callback of this.listeners.finished ?? []) callback(new Blob(['gif']))
    }
    abort(): void {
      // Nothing to stop in the fake.
    }
  }
  return { default: FakeGif }
})

vi.mock('./frameRenderer', () => ({
  FrameRenderer: class {
    async initialize(): Promise<void> {
      // No Pixi in the fake.
    }
    async renderFrame(_source: unknown, sourceTimestampUs: number): Promise<void> {
      if (state.rendered.length === state.renderFailAt) throw new Error('renderer exploded')
      state.rendered.push(sourceTimestampUs / 1000)
    }
    getCanvas(): unknown {
      return {}
    }
    destroy(): void {
      // Nothing to release in the fake.
    }
  },
}))

vi.mock('@/utils/platformUtils', () => ({ getPlatform: async () => 'linux' }))

vi.mock('./videoDecoder', () => ({
  VideoFileDecoder: class {
    constructor() {
      state.seekConstructed += 1
    }
    async loadVideo() {
      return { width: 640, height: 360, duration: state.durationSec }
    }
    getVideoElement() {
      const listeners: Array<() => void> = []
      const element = {
        currentTimeValue: 0,
        get currentTime() {
          return this.currentTimeValue
        },
        set currentTime(value: number) {
          this.currentTimeValue = value
          const pending = listeners.splice(0)
          setTimeout(() => {
            for (const listener of pending) listener()
          }, 0)
        },
        addEventListener(_event: string, listener: () => void) {
          listeners.push(listener)
        },
        requestVideoFrameCallback(callback: () => void) {
          setTimeout(callback, 0)
        },
      }
      return element
    }
    destroy(): void {
      // Nothing to release in the fake.
    }
  },
}))

vi.mock('./streamingDecoder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streamingDecoder')>()
  class FakeStreamingVideoDecoder {
    cancel = vi.fn()
    destroy = vi.fn()
    constructor() {
      state.streamingConstructed += 1
      state.lastStreaming = this
    }
    async loadMetadata() {
      if (state.streamingFailure === 'metadata') throw new Error('web-demuxer failed to load')
      return { width: 640, height: 360, duration: state.durationSec }
    }
    getExportMetrics(fps: number, trims?: TrimRegion[], speeds?: SpeedRegion[]) {
      return actual.computeExportMetrics(state.durationSec, fps, trims, speeds)
    }
    async decodeAll(
      fps: number,
      trims: TrimRegion[] | undefined,
      speeds: SpeedRegion[] | undefined,
      onFrame: OnFrameCallback,
      onWarning?: (message: string) => void,
    ) {
      state.decodeAllArgs = { trims, speeds }
      if (state.streamingFailure === 'before-first') throw new Error('Unsupported codec: av01')
      if (state.streamingFailure === 'empty') return
      const { totalFrames } = actual.computeExportMetrics(state.durationSec, fps, trims, speeds)
      for (let i = 0; i < totalFrames; i += 1) {
        const frame = {
          close() {
            state.closedFrames += 1
          },
        } as unknown as VideoFrame
        if (state.streamingFailure === 'swallow-callback') {
          try {
            await onFrame(frame, (i * 1_000_000) / fps, (i * 1000) / fps)
          } catch {
            return
          }
          continue
        }
        await onFrame(frame, (i * 1_000_000) / fps, (i * 1000) / fps)
        if (state.streamingFailure === 'mid' && i === 0) throw new Error('VideoDecoder error')
        if (state.streamingFailure === 'ended-early' && i === 1) {
          onWarning?.('Decode ended early')
          return
        }
      }
    }
  }
  return { ...actual, StreamingVideoDecoder: FakeStreamingVideoDecoder }
})

import { GifExporter } from './gifExporter'
import { buildGifFramePlan } from './gifExportPlan'

const globalScope = globalThis as Record<string, unknown>

class FakeVideoFrame {
  close(): void {
    state.closedFrames += 1
  }
}

function baseConfig(overrides: Partial<ConstructorParameters<typeof GifExporter>[0]> = {}) {
  return {
    videoUrl: 'file:///tmp/clip.webm',
    width: 320,
    height: 180,
    frameRate: 20 as const,
    loop: true,
    sizePreset: 'original' as const,
    wallpaper: '#000',
    zoomRegions: [],
    showShadow: false,
    shadowIntensity: 0,
    showBlur: false,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    sourceDurationMs: state.durationSec * 1000,
    ...overrides,
  }
}

const TRIMS: TrimRegion[] = [{ id: 't', startMs: 500, endMs: 1000 }]
const SEGMENTS: VideoSegment[] = [
  { id: 'a', startMs: 0, endMs: 1000, deleted: false, speed: 2 },
  { id: 'b', startMs: 1000, endMs: 1500, deleted: true, speed: 1 },
  { id: 'c', startMs: 1500, endMs: 2000, deleted: false, speed: 1 },
]

beforeEach(() => {
  state.durationSec = 2
  state.streamingFailure = null
  state.streamingConstructed = 0
  state.seekConstructed = 0
  state.decodeAllArgs = null
  state.rendered = []
  state.renderFailAt = -1
  state.gifFrames = []
  state.lastStreaming = null
  state.closedFrames = 0
  globalScope.VideoFrame = FakeVideoFrame
  globalScope.VideoDecoder = class {}
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  delete globalScope.VideoFrame
  delete globalScope.VideoDecoder
  delete globalScope.localStorage
  vi.restoreAllMocks()
})

describe('GifExporter decode paths', () => {
  it('produces the same frame count on both paths for a trimmed source', async () => {
    const seek = await new GifExporter(
      baseConfig({ trimRegions: TRIMS, decodePath: 'seek' }),
    ).export()
    const seekFrames = state.gifFrames[0]
    state.rendered = []
    const webcodecs = await new GifExporter(
      baseConfig({ trimRegions: TRIMS, decodePath: 'webcodecs' }),
    ).export()

    expect(seek.success).toBe(true)
    expect(webcodecs.success).toBe(true)
    expect(seekFrames).toBe(30)
    expect(state.gifFrames[1]).toBe(30)
    expect(webcodecs.warnings).toBeUndefined()
    expect(state.streamingConstructed).toBe(1)
    expect(state.seekConstructed).toBe(1)
    // The streaming decoder received the trim mapped through segmentAdapter.
    expect(state.decodeAllArgs?.trims).toEqual([
      expect.objectContaining({ startMs: 500, endMs: 1000 }),
    ])
  })

  it('produces the same frame count on both paths for per-segment speed edits', async () => {
    const plans = (['seek', 'webcodecs'] as const).map((decodePath) =>
      buildGifFramePlan({
        decodePath,
        frameRate: 20,
        sourceDurationMs: 2000,
        decoderDurationSec: 2,
        segments: SEGMENTS,
      }),
    )
    expect(plans.map((plan) => plan.totalFrames)).toEqual([20, 20])

    await new GifExporter(baseConfig({ segments: SEGMENTS, decodePath: 'seek' })).export()
    await new GifExporter(baseConfig({ segments: SEGMENTS, decodePath: 'webcodecs' })).export()

    expect(state.gifFrames).toEqual([20, 20])
    expect(state.decodeAllArgs?.speeds).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 1000, speed: 2 }),
    ])
    expect(state.decodeAllArgs?.trims).toEqual([
      expect.objectContaining({ startMs: 1000, endMs: 1500 }),
    ])
    // Every VideoFrame handed over by the decoder was closed.
    expect(state.closedFrames).toBeGreaterThanOrEqual(20)
  })

  it('falls back to the seek path when the decoder fails before the first frame', async () => {
    state.streamingFailure = 'before-first'
    const result = await new GifExporter(
      baseConfig({ trimRegions: TRIMS, decodePath: 'webcodecs' }),
    ).export()

    expect(result.success).toBe(true)
    expect(result.warnings).toEqual(['editor.exportWarningDecoderFallback'])
    expect(state.gifFrames).toEqual([30])
    expect(state.streamingConstructed).toBe(1)
    expect(state.seekConstructed).toBe(1)
    expect(state.lastStreaming?.destroy).toHaveBeenCalled()
  })

  it('falls back when the streaming decoder cannot open the source', async () => {
    state.streamingFailure = 'metadata'
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(true)
    expect(result.warnings).toEqual(['editor.exportWarningDecoderFallback'])
    expect(state.seekConstructed).toBe(1)
  })

  it('falls back when the decoder delivers no frames at all', async () => {
    state.streamingFailure = 'empty'
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(true)
    expect(result.warnings).toEqual(['editor.exportWarningDecoderFallback'])
  })

  it('does not fall back once frames were delivered', async () => {
    state.streamingFailure = 'mid'
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(false)
    expect(result.error).toContain('VideoDecoder error')
    expect(state.seekConstructed).toBe(0)
  })

  it('reports a short decode as a soft warning and keeps the frames', async () => {
    state.streamingFailure = 'ended-early'
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(true)
    expect(result.warnings).toEqual(['editor.exportWarningDecodeEndedEarly'])
    expect(state.gifFrames).toEqual([2])
  })

  it('never falls back on a render failure and cancels the decoder', async () => {
    state.renderFailAt = 0
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(false)
    expect(result.error).toBe('renderer exploded')
    expect(state.lastStreaming?.cancel).toHaveBeenCalled()
    expect(state.seekConstructed).toBe(0)
  })

  it('never falls back when the decoder hides the render failure behind zero frames', async () => {
    state.renderFailAt = 0
    state.streamingFailure = 'swallow-callback'
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(false)
    expect(result.error).toBe('renderer exploded')
    expect(state.seekConstructed).toBe(0)
  })

  it('defaults to the seek path', async () => {
    const result = await new GifExporter(baseConfig()).export()

    expect(result.success).toBe(true)
    expect(state.streamingConstructed).toBe(0)
    expect(state.seekConstructed).toBe(1)
    expect(state.gifFrames).toEqual([40])
  })

  it('honours the localStorage override when no decodePath is configured', async () => {
    globalScope.localStorage = { getItem: () => 'webcodecs' }
    const result = await new GifExporter(baseConfig()).export()

    expect(result.success).toBe(true)
    expect(state.streamingConstructed).toBe(1)
    expect(state.seekConstructed).toBe(0)
    expect(state.gifFrames).toEqual([40])
  })

  it('uses the seek path when VideoDecoder is unavailable', async () => {
    delete globalScope.VideoDecoder
    const result = await new GifExporter(baseConfig({ decodePath: 'webcodecs' })).export()

    expect(result.success).toBe(true)
    expect(result.warnings).toBeUndefined()
    expect(state.streamingConstructed).toBe(0)
    expect(state.seekConstructed).toBe(1)
  })
})

describe('buildGifFramePlan', () => {
  it('maps output frames back to source time on both paths', () => {
    const seek = buildGifFramePlan({
      decodePath: 'seek',
      frameRate: 20,
      sourceDurationMs: 2000,
      trimRegions: TRIMS,
    })
    const webcodecs = buildGifFramePlan({
      decodePath: 'webcodecs',
      frameRate: 20,
      sourceDurationMs: 2000,
      decoderDurationSec: 2,
      trimRegions: TRIMS,
    })
    for (const plan of [seek, webcodecs]) {
      expect(plan.frameDelayMs).toBe(50)
      expect(plan.totalFrames).toBe(30)
      expect(plan.sourceTimeMsForFrame(0)).toBe(0)
      expect(plan.sourceTimeMsForFrame(4)).toBe(200)
      // Frame 10 (output 0.5 s) lands right after the trimmed span.
      expect(plan.sourceTimeMsForFrame(10)).toBeCloseTo(1000, 6)
      expect(plan.sourceTimeMsForFrame(29)).toBeCloseTo(1950, 6)
    }
    expect(seek.decodePlan).toBeNull()
    expect(webcodecs.decodePlan?.segments).toEqual([
      { startSec: 0, endSec: 0.5, speed: 1 },
      { startSec: 1, endSec: 2, speed: 1 },
    ])
  })

  it('applies the global playback speed on the seek path like the legacy loop', () => {
    const plan = buildGifFramePlan({
      decodePath: 'seek',
      frameRate: 20,
      sourceDurationMs: 2000,
      playbackSpeed: 2,
    })
    expect(plan.totalFrames).toBe(20)
    expect(plan.sourceTimeMsForFrame(3)).toBe(300)
  })
})
