import type React from 'react'
import { FRAME_DURATION_SEC } from '@/lib/frameStep'
import type { TrimRegion, VideoSegment } from '../types'
import {
  clampNativePlaybackRate,
  MAX_NATIVE_PLAYBACK_RATE,
  planFrameStep,
  resolvePreviewSpeedMode,
} from './frameStepPreview'
import { createRafCoalescer } from './rafCoalescer'

// Keep "scrub mode" on for a brief tail after `seeked`: rapid drag-scrubbing fires
// `seeking`/`seeked` dozens of times a second and toggling effects each time would flicker.
const SCRUB_END_DEBOUNCE_MS = 150
// A frame-stepping seek that never reports `seeked` (some sources stall past their
// buffered end) releases the one-seek-in-flight throttle after this long.
const STEP_SEEK_TIMEOUT_MS = 500
// Two positions closer than this are the same frame as far as seeking goes.
const SEEK_EPSILON_SEC = 0.001

interface VideoEventHandlersParams {
  video: HTMLVideoElement
  isSeekingRef: React.MutableRefObject<boolean>
  isPlayingRef: React.MutableRefObject<boolean>
  allowPlaybackRef: React.MutableRefObject<boolean>
  currentTimeRef: React.MutableRefObject<number>
  timeUpdateAnimationRef: React.MutableRefObject<number | null>
  onPlayStateChange: (playing: boolean) => void
  onTimeUpdate: (time: number) => void
  trimRegionsRef: React.MutableRefObject<TrimRegion[]>
  segmentsRef: React.MutableRefObject<VideoSegment[]>
  previewPlaybackRateRef: React.MutableRefObject<number>
  /** Scrub state: true from the first `seeking` until SCRUB_END_DEBOUNCE_MS after the last `seeked`. */
  isScrubbingRef?: React.MutableRefObject<boolean>
  scrubEndTimerRef?: React.MutableRefObject<number | null>
  onScrubChange?: (scrubbing: boolean) => void
  /**
   * Highest `playbackRate` the element accepts (see `probeNativePlaybackRateCap`).
   * Speeds above it preview frame-stepped and muted. Default: Chromium's 16.
   */
  nativePlaybackRateCap?: number
  /** Mirrors the frame-stepping state for imperative readers (the playback ref). */
  frameSteppingRef?: React.MutableRefObject<boolean>
  onFrameSteppingChange?: (active: boolean) => void
  /** Source frame length; a stepping seek is only issued once the clock moved at least this far. */
  frameDurationSec?: number
  /** Wall clock (ms), injectable for tests; must match the animation-frame timestamps. */
  now?: () => number
}

export function createVideoEventHandlers(params: VideoEventHandlersParams) {
  const {
    video,
    isSeekingRef,
    isPlayingRef,
    allowPlaybackRef,
    currentTimeRef,
    timeUpdateAnimationRef,
    onPlayStateChange,
    onTimeUpdate,
    trimRegionsRef,
    segmentsRef,
    previewPlaybackRateRef,
    isScrubbingRef,
    scrubEndTimerRef,
    onScrubChange,
    nativePlaybackRateCap = MAX_NATIVE_PLAYBACK_RATE,
    frameSteppingRef,
    onFrameSteppingChange,
    frameDurationSec = FRAME_DURATION_SEC,
    now = () => performance.now(),
  } = params

  const MAX_SPURIOUS_PAUSE_RETRIES = 3
  let spuriousPauseRetries = 0

  // Frame-stepped preview (segment speed x preview rate above the element's cap):
  // a virtual clock owns the playhead and the muted element is seeked toward it
  // every animation frame. See frameStepPreview.ts for the planner.
  let stepping = false
  let virtualSec = 0
  let lastTickMs = 0
  let mutedBeforeStepping = false
  let seekInFlight = false
  let seekIssuedAtMs = 0
  // Position of the last seek this module issued (stepping or hand-back), so its
  // own `seeking` event is told apart from a user scrub.
  let ownSeekTargetSec: number | null = null
  // The pause that ends a frame-stepped run at the end of the media is ours, not a
  // spurious native pause to retry.
  let expectEndPause = false

  const clearScrubEndTimer = () => {
    if (scrubEndTimerRef && scrubEndTimerRef.current !== null) {
      window.clearTimeout(scrubEndTimerRef.current)
      scrubEndTimerRef.current = null
    }
  }

  // currentTimeRef is updated synchronously on every call (cheap; the Pixi ticker
  // and other imperative consumers read it directly). The React state commit
  // (`onTimeUpdate`) is coalesced to at most once per animation frame so a burst
  // of `seeking` events (fast timeline drag) or the per-frame rAF playback loop
  // can't force more than one parent re-render per frame.
  const timeUpdateCoalescer = createRafCoalescer<number>(onTimeUpdate)

  const emitTime = (timeValue: number) => {
    currentTimeRef.current = timeValue * 1000
    timeUpdateCoalescer.schedule(timeValue)
  }

  // Find the segment containing the given source time (ms)
  const findSegmentAtTime = (timeMs: number): VideoSegment | null => {
    const segs = segmentsRef.current
    if (segs.length === 0) return null
    return segs.find((s) => timeMs >= s.startMs && timeMs < s.endMs) ?? null
  }

  // Fallback: check trim regions (backward compat when segments not available)
  const findActiveTrimRegion = (currentTimeMs: number): TrimRegion | null => {
    const trimRegions = trimRegionsRef.current
    return (
      trimRegions.find(
        (region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs,
      ) || null
    )
  }

  // Find the next non-deleted segment boundary after a given source time
  const findNextKeptSegmentStart = (afterMs: number): number | null => {
    const segs = segmentsRef.current
    for (const seg of segs) {
      if (seg.startMs >= afterMs && !seg.deleted) {
        return seg.startMs
      }
    }
    return null
  }

  const setStepping = (active: boolean) => {
    if (stepping === active) return
    stepping = active
    if (frameSteppingRef) frameSteppingRef.current = active
    onFrameSteppingChange?.(active)
  }

  const issueOwnSeek = (toSec: number) => {
    ownSeekTargetSec = toSec
    video.currentTime = toSec
  }

  const isOwnSeek = () =>
    ownSeekTargetSec !== null && Math.abs(video.currentTime - ownSeekTargetSec) < SEEK_EPSILON_SEC

  const beginFrameStepping = (fromSec: number, nowMs: number) => {
    virtualSec = fromSec
    lastTickMs = nowMs
    seekInFlight = false
    ownSeekTargetSec = null
    mutedBeforeStepping = video.muted
    video.muted = true
    // The element stays in the playing state so play / pause remains observable
    // through `video.paused`; at 1x it barely moves between two stepping seeks,
    // and every frame it shows is one the virtual clock asked for.
    try {
      video.playbackRate = 1
    } catch {
      // Some elements refuse rate changes mid-seek; the seeks still drive time.
    }
    setStepping(true)
  }

  const endFrameStepping = () => {
    if (!stepping) return
    setStepping(false)
    seekInFlight = false
    video.muted = mutedBeforeStepping
  }

  const applyNativeRate = (speed: number) => {
    const targetRate = clampNativePlaybackRate(speed, nativePlaybackRateCap)
    if (Math.abs(video.playbackRate - targetRate) > 0.001) {
      video.playbackRate = targetRate
    }
  }

  const tickFrameStepping = (nowMs: number) => {
    const dtSec = (nowMs - lastTickMs) / 1000
    lastTickMs = nowMs
    const plan = planFrameStep({
      fromSec: virtualSec,
      dtSec,
      segments: segmentsRef.current,
      previewRate: previewPlaybackRateRef.current,
      durationSec: video.duration,
      nativeCap: nativePlaybackRateCap,
      frameDurationSec,
    })

    if (plan.kind === 'end') {
      virtualSec = plan.toSec
      endFrameStepping()
      issueOwnSeek(plan.toSec)
      emitTime(plan.toSec)
      expectEndPause = true
      video.pause()
      return
    }

    if (plan.kind === 'hand-back') {
      // Back below the cap: land the element on the virtual playhead once (no
      // scrub mode for that seek) and let it play natively from there.
      virtualSec = plan.toSec
      endFrameStepping()
      if (Math.abs(video.currentTime - plan.toSec) > SEEK_EPSILON_SEC) {
        issueOwnSeek(plan.toSec)
      }
      applyNativeRate(plan.speed)
      emitTime(plan.toSec)
      return
    }

    virtualSec = plan.toSec
    // The playhead advances every frame; the element is seeked toward it only
    // once the previous seek has landed, so a slow decoder still presents
    // frames instead of sitting perpetually mid-seek. No seek for less than a
    // frame of movement: a no-op seek would never report `seeked`.
    if (seekInFlight && nowMs - seekIssuedAtMs > STEP_SEEK_TIMEOUT_MS) {
      seekInFlight = false
    }
    if (!seekInFlight && Math.abs(plan.toSec - video.currentTime) >= frameDurationSec) {
      seekInFlight = true
      seekIssuedAtMs = nowMs
      issueOwnSeek(plan.toSec)
    }
    emitTime(plan.toSec)
  }

  function updateTime(frameTimeMs?: number) {
    if (!video) return
    const nowMs = typeof frameTimeMs === 'number' ? frameTimeMs : now()

    if (stepping) {
      if (video.paused || video.ended) {
        endFrameStepping()
      } else {
        tickFrameStepping(nowMs)
        if (!video.paused && !video.ended) {
          timeUpdateAnimationRef.current = requestAnimationFrame(updateTime)
        }
        return
      }
    }

    const currentTimeMs = video.currentTime * 1000
    const segs = segmentsRef.current

    if (segs.length > 0) {
      // Segment-aware playback
      const seg = findSegmentAtTime(currentTimeMs)

      if (seg && seg.deleted && !video.paused && !video.ended) {
        // Inside a deleted segment — skip to next kept segment
        const nextStart = findNextKeptSegmentStart(seg.endMs)
        if (nextStart !== null) {
          video.currentTime = nextStart / 1000
          emitTime(nextStart / 1000)
        } else {
          video.pause()
        }
      } else if (seg && !seg.deleted) {
        // Per-segment speed x preview playback rate. Up to the element's cap the
        // element plays natively; above it the preview frame-steps (muted).
        const speed = seg.speed * previewPlaybackRateRef.current
        if (
          resolvePreviewSpeedMode(speed, nativePlaybackRateCap) === 'frame-step' &&
          !video.paused &&
          !video.ended
        ) {
          beginFrameStepping(video.currentTime, nowMs)
          tickFrameStepping(nowMs)
        } else {
          applyNativeRate(speed)
          emitTime(video.currentTime)
        }
      } else {
        emitTime(video.currentTime)
      }
    } else {
      // Legacy trim-region path
      const activeTrimRegion = findActiveTrimRegion(currentTimeMs)
      if (activeTrimRegion && !video.paused && !video.ended) {
        const skipToTime = activeTrimRegion.endMs / 1000
        if (skipToTime >= video.duration) {
          video.pause()
        } else {
          video.currentTime = skipToTime
          emitTime(skipToTime)
        }
      } else {
        emitTime(video.currentTime)
      }
    }

    if (!video.paused && !video.ended) {
      timeUpdateAnimationRef.current = requestAnimationFrame(updateTime)
    }
  }

  const handlePlay = () => {
    if (isSeekingRef.current) {
      console.warn('[videoEvents] handlePlay: pausing because isSeeking=true')
      video.pause()
      return
    }

    if (!allowPlaybackRef.current) {
      console.warn('[videoEvents] handlePlay: pausing because allowPlayback=false')
      video.pause()
      return
    }

    console.log('[videoEvents] handlePlay: allowing playback, isPlaying=true')
    spuriousPauseRetries = 0
    isPlayingRef.current = true
    onPlayStateChange(true)
    if (timeUpdateAnimationRef.current) {
      cancelAnimationFrame(timeUpdateAnimationRef.current)
    }
    timeUpdateAnimationRef.current = requestAnimationFrame(updateTime)
  }

  const handlePause = () => {
    const endedByStepping = expectEndPause
    expectEndPause = false
    endFrameStepping()

    // On some platforms (notably Chromium on Linux/Wayland) the browser may
    // emit a native pause event right after play() succeeds — e.g. because
    // of a WebGL video texture interaction.  When allowPlayback is still
    // true we treat this as a spurious pause and retry playback once.
    if (
      allowPlaybackRef.current &&
      !isSeekingRef.current &&
      !video.ended &&
      !endedByStepping &&
      spuriousPauseRetries < MAX_SPURIOUS_PAUSE_RETRIES
    ) {
      spuriousPauseRetries += 1
      console.log(
        '[videoEvents] handlePause: spurious native pause detected, retry',
        spuriousPauseRetries,
      )
      video.play().catch(() => {
        // Retry failed — accept the pause
        isPlayingRef.current = false
        onPlayStateChange(false)
        if (timeUpdateAnimationRef.current) {
          cancelAnimationFrame(timeUpdateAnimationRef.current)
          timeUpdateAnimationRef.current = null
        }
        emitTime(video.currentTime)
      })
      return
    }

    isPlayingRef.current = false
    onPlayStateChange(false)
    if (timeUpdateAnimationRef.current) {
      cancelAnimationFrame(timeUpdateAnimationRef.current)
      timeUpdateAnimationRef.current = null
    }
    emitTime(video.currentTime)
  }

  const handleSeeked = () => {
    if (stepping) {
      seekInFlight = false
      // Our own stepping seek landed: the next one may go out. The animation
      // loop stays the only time authority, so nothing else to do.
      if (!isSeekingRef.current) return
      // A user seek landed while stepping: the virtual clock adopts it.
      virtualSec = video.currentTime
    }
    ownSeekTargetSec = null
    isSeekingRef.current = false

    if (isScrubbingRef && scrubEndTimerRef) {
      clearScrubEndTimer()
      scrubEndTimerRef.current = window.setTimeout(() => {
        isScrubbingRef.current = false
        scrubEndTimerRef.current = null
        onScrubChange?.(false)
      }, SCRUB_END_DEBOUNCE_MS)
    }

    const currentTimeMs = video.currentTime * 1000
    const segs = segmentsRef.current

    if (segs.length > 0) {
      const seg = findSegmentAtTime(currentTimeMs)
      if (seg && seg.deleted && isPlayingRef.current && !video.paused) {
        const nextStart = findNextKeptSegmentStart(seg.endMs)
        if (nextStart !== null) {
          video.currentTime = nextStart / 1000
          emitTime(nextStart / 1000)
        } else {
          video.pause()
        }
      } else {
        if (!isPlayingRef.current && !video.paused) {
          video.pause()
        }
        emitTime(video.currentTime)
      }
    } else {
      // Legacy trim path
      const activeTrimRegion = findActiveTrimRegion(currentTimeMs)
      if (activeTrimRegion && isPlayingRef.current && !video.paused) {
        const skipToTime = activeTrimRegion.endMs / 1000
        if (skipToTime >= video.duration) {
          video.pause()
        } else {
          video.currentTime = skipToTime
          emitTime(skipToTime)
        }
      } else {
        if (!isPlayingRef.current && !video.paused) {
          video.pause()
        }
        emitTime(video.currentTime)
      }
    }
  }

  const handleSeeking = () => {
    // Seeks this module issued (per-frame stepping, the hand-back landing) must
    // not flip the preview into scrub mode: that would soften the canvas and
    // snap the zoom every frame while stepping.
    if (isOwnSeek()) {
      if (!stepping) ownSeekTargetSec = null
      return
    }
    if (stepping) {
      // A user scrub while stepping: the virtual clock follows the new position
      // and the next tick continues from there (or hands back if that stretch
      // is below the cap).
      virtualSec = video.currentTime
      seekInFlight = false
      ownSeekTargetSec = null
    }
    isSeekingRef.current = true

    if (isScrubbingRef) {
      clearScrubEndTimer()
      if (!isScrubbingRef.current) {
        isScrubbingRef.current = true
        onScrubChange?.(true)
      }
    }

    if (!isPlayingRef.current && !video.paused) {
      video.pause()
    }
    emitTime(video.currentTime)
  }

  return {
    handlePlay,
    handlePause,
    handleSeeked,
    handleSeeking,
    /** Drop any pending coalesced time commit and the scrub tail timer (call on unmount / rewire). */
    dispose: () => {
      endFrameStepping()
      timeUpdateCoalescer.cancel()
      clearScrubEndTimer()
    },
  }
}
