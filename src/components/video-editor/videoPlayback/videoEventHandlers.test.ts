import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoSegment } from '../types'
import { createVideoEventHandlers } from './videoEventHandlers'

function seg(id: string, startMs: number, endMs: number, speed = 1, deleted = false): VideoSegment {
  return { id, startMs, endMs, speed, deleted }
}

interface FakeVideo {
  currentTime: number
  duration: number
  paused: boolean
  ended: boolean
  muted: boolean
  playbackRate: number
  play: () => Promise<void>
  pause: () => void
  seeks: number[]
}

function fakeVideo(overrides: Partial<FakeVideo> = {}): FakeVideo {
  const video: FakeVideo = {
    currentTime: 0,
    duration: 100,
    paused: false,
    ended: false,
    muted: false,
    playbackRate: 1,
    seeks: [],
    play: vi.fn(async () => {
      video.paused = false
    }),
    pause: vi.fn(() => {
      video.paused = true
    }),
    ...overrides,
  }
  // Record every seek so the tests can see what the element was asked to show.
  let time = video.currentTime
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (value: number) => {
      time = value
      video.seeks.push(value)
    },
  })
  return video
}

function harness(segments: VideoSegment[], options: { previewRate?: number; cap?: number } = {}) {
  let clock = 0
  const rafQueue: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('window', { setTimeout, clearTimeout })

  const video = fakeVideo()
  const refs = {
    isSeekingRef: { current: false },
    isPlayingRef: { current: false },
    allowPlaybackRef: { current: true },
    currentTimeRef: { current: 0 },
    timeUpdateAnimationRef: { current: null as number | null },
    trimRegionsRef: { current: [] },
    segmentsRef: { current: segments },
    previewPlaybackRateRef: { current: options.previewRate ?? 1 },
    isScrubbingRef: { current: false },
    scrubEndTimerRef: { current: null as number | null },
    frameSteppingRef: { current: false },
  }
  const onPlayStateChange = vi.fn()
  const onTimeUpdate = vi.fn()
  const onFrameSteppingChange = vi.fn()
  const handlers = createVideoEventHandlers({
    video: video as unknown as HTMLVideoElement,
    ...refs,
    onPlayStateChange,
    onTimeUpdate,
    onFrameSteppingChange,
    nativePlaybackRateCap: options.cap,
    now: () => clock,
  })

  /**
   * Advance the clock by `ms` and run every callback queued for the next
   * animation frame (the playback loop and the coalesced time commit).
   */
  const frame = (ms: number) => {
    clock += ms
    const callbacks = rafQueue.splice(0)
    if (callbacks.length === 0) throw new Error('no animation frame queued')
    for (const cb of callbacks) cb(clock)
  }

  return { video, refs, handlers, frame, onPlayStateChange, onFrameSteppingChange, rafQueue }
}

const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

beforeEach(() => {
  consoleLog.mockClear()
  consoleWarn.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createVideoEventHandlers - native path (at or below the playbackRate cap)', () => {
  it('sets the element rate to segment speed x preview rate and never frame-steps', () => {
    const h = harness([seg('a', 0, 10_000, 2)], { previewRate: 4 })
    h.handlers.handlePlay()
    h.frame(16)

    expect(h.video.playbackRate).toBe(8)
    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.video.muted).toBe(false)
    expect(h.video.seeks).toEqual([])
    expect(h.onFrameSteppingChange).not.toHaveBeenCalled()
  })

  it('clamps to the probed cap when the element accepts less than 16x', () => {
    const h = harness([seg('a', 0, 10_000, 8)], { cap: 8 })
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.video.playbackRate).toBe(8)
    expect(h.refs.frameSteppingRef.current).toBe(false)
  })
})

describe('createVideoEventHandlers - frame-stepped preview above the cap', () => {
  it('mutes, keeps the element at 1x and drives currentTime from the virtual clock', () => {
    const h = harness([seg('a', 0, 10_000, 40)])
    h.video.currentTime = 1
    h.video.seeks.length = 0
    h.handlers.handlePlay()

    h.frame(16) // enters stepping; dt = 0 on the first tick
    expect(h.refs.frameSteppingRef.current).toBe(true)
    expect(h.onFrameSteppingChange).toHaveBeenCalledWith(true)
    expect(h.video.muted).toBe(true)
    expect(h.video.playbackRate).toBe(1)
    expect(h.video.seeks).toEqual([])

    h.frame(16) // 16 ms at 40x = 0.64 s of source
    expect(h.video.seeks).toHaveLength(1)
    expect(h.video.seeks[0]).toBeCloseTo(1.64, 9)
    expect(h.refs.currentTimeRef.current).toBeCloseTo(1640, 6)
  })

  it('throttles to one seek in flight and releases it on seeked (or after the timeout)', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.handlers.handlePlay()
    h.frame(16)
    h.frame(16)
    expect(h.video.seeks).toHaveLength(1)

    h.frame(16) // previous seek has not landed: playhead advances, no new seek
    expect(h.video.seeks).toHaveLength(1)
    expect(h.refs.currentTimeRef.current).toBeCloseTo(1280, 6)

    h.handlers.handleSeeked() // our own seek landed
    expect(h.refs.isSeekingRef.current).toBe(false)
    h.frame(16)
    expect(h.video.seeks).toHaveLength(2)
    expect(h.video.seeks[1]).toBeCloseTo(1.92, 9)

    h.frame(600) // never landed: the throttle times out and a seek goes out again
    expect(h.video.seeks).toHaveLength(3)
  })

  it('applies the preview rate on top of the segment speed (1x segment at 32x preview)', () => {
    const h = harness([seg('a', 0, 100_000, 1)], { previewRate: 32 })
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(true)
    h.frame(100)
    expect(h.video.seeks[0]).toBeCloseTo(3.2, 9)
  })

  it('hands back to native playback when the clock enters a slower segment, unmuted, no scrub', () => {
    const h = harness([seg('fast', 0, 10_000, 40), seg('slow', 10_000, 20_000, 2)])
    h.video.currentTime = 9.99
    h.video.seeks.length = 0
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(true)

    h.frame(16) // 249.75 ms effective + 16 ms crosses the 250 ms boundary
    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.onFrameSteppingChange).toHaveBeenLastCalledWith(false)
    expect(h.video.muted).toBe(false)
    expect(h.video.playbackRate).toBe(2)
    expect(h.video.seeks).toHaveLength(1)
    expect(h.video.seeks[0]).toBeCloseTo(10.0315, 9)

    // The landing seek is ours: it must not switch on scrub mode.
    h.handlers.handleSeeking()
    expect(h.refs.isScrubbingRef.current).toBe(false)
    expect(h.refs.isSeekingRef.current).toBe(false)
  })

  it('steps over a deleted stretch through the effective-time mapping', () => {
    const h = harness([
      seg('fast', 0, 10_000, 40),
      seg('gap', 10_000, 20_000, 1, true),
      seg('tail', 20_000, 30_000, 40),
    ])
    h.video.currentTime = 9.99
    h.video.seeks.length = 0
    h.handlers.handlePlay()
    h.frame(16)
    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(true)
    // 0.25 ms left in `fast`, 15.75 ms in `tail` at 40x = 630 ms past 20 s.
    expect(h.video.seeks[0]).toBeCloseTo(20.63, 9)
  })

  it('stops at the end of the media without a spurious-pause retry', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.video.currentTime = 99.9
    h.video.seeks.length = 0
    h.handlers.handlePlay()
    h.frame(16)
    h.frame(16)

    expect(h.video.seeks).toEqual([100])
    expect(h.video.pause).toHaveBeenCalledOnce()
    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.video.muted).toBe(false)

    h.handlers.handlePause()
    expect(h.video.play).not.toHaveBeenCalled()
    expect(h.onPlayStateChange).toHaveBeenLastCalledWith(false)
  })

  it('ends stepping and restores the mute state when the user pauses', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.video.muted = false
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.video.muted).toBe(true)

    h.refs.allowPlaybackRef.current = false
    h.video.pause()
    h.handlers.handlePause()

    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.video.muted).toBe(false)
    expect(h.onPlayStateChange).toHaveBeenLastCalledWith(false)
  })

  it('adopts a user seek made while stepping and continues from there', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.handlers.handlePlay()
    h.frame(16)
    h.frame(16)
    expect(h.refs.currentTimeRef.current).toBeCloseTo(640, 6)

    // A timeline scrub lands the element somewhere else.
    h.video.currentTime = 50
    h.handlers.handleSeeking()
    expect(h.refs.isSeekingRef.current).toBe(true)
    expect(h.refs.isScrubbingRef.current).toBe(true)
    h.handlers.handleSeeked()
    expect(h.refs.isSeekingRef.current).toBe(false)

    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(true)
    expect(h.refs.currentTimeRef.current).toBeCloseTo(50_640, 6)
  })

  it('does not enter stepping while the element is paused', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.video.paused = true
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.video.muted).toBe(false)
  })

  it('dispose ends stepping so a rewired handler set starts clean', () => {
    const h = harness([seg('a', 0, 100_000, 40)])
    h.handlers.handlePlay()
    h.frame(16)
    expect(h.refs.frameSteppingRef.current).toBe(true)
    h.handlers.dispose()
    expect(h.refs.frameSteppingRef.current).toBe(false)
    expect(h.video.muted).toBe(false)
  })
})
