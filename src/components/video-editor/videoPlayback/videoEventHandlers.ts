import type React from 'react';
import type { TrimRegion, VideoSegment } from '../types';
import { createRafCoalescer } from './rafCoalescer';

// Keep "scrub mode" on for a brief tail after `seeked`: rapid drag-scrubbing fires
// `seeking`/`seeked` dozens of times a second and toggling effects each time would flicker.
const SCRUB_END_DEBOUNCE_MS = 150;

interface VideoEventHandlersParams {
  video: HTMLVideoElement;
  isSeekingRef: React.MutableRefObject<boolean>;
  isPlayingRef: React.MutableRefObject<boolean>;
  allowPlaybackRef: React.MutableRefObject<boolean>;
  currentTimeRef: React.MutableRefObject<number>;
  timeUpdateAnimationRef: React.MutableRefObject<number | null>;
  onPlayStateChange: (playing: boolean) => void;
  onTimeUpdate: (time: number) => void;
  trimRegionsRef: React.MutableRefObject<TrimRegion[]>;
  segmentsRef: React.MutableRefObject<VideoSegment[]>;
  previewPlaybackRateRef: React.MutableRefObject<number>;
  /** Scrub state: true from the first `seeking` until SCRUB_END_DEBOUNCE_MS after the last `seeked`. */
  isScrubbingRef?: React.MutableRefObject<boolean>;
  scrubEndTimerRef?: React.MutableRefObject<number | null>;
  onScrubChange?: (scrubbing: boolean) => void;
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
  } = params;

  const MAX_SPURIOUS_PAUSE_RETRIES = 3;
  let spuriousPauseRetries = 0;

  const clearScrubEndTimer = () => {
    if (scrubEndTimerRef && scrubEndTimerRef.current !== null) {
      window.clearTimeout(scrubEndTimerRef.current);
      scrubEndTimerRef.current = null;
    }
  };

  // currentTimeRef is updated synchronously on every call (cheap; the Pixi ticker
  // and other imperative consumers read it directly). The React state commit
  // (`onTimeUpdate`) is coalesced to at most once per animation frame so a burst
  // of `seeking` events (fast timeline drag) or the per-frame rAF playback loop
  // can't force more than one parent re-render per frame.
  const timeUpdateCoalescer = createRafCoalescer<number>(onTimeUpdate);

  const emitTime = (timeValue: number) => {
    currentTimeRef.current = timeValue * 1000;
    timeUpdateCoalescer.schedule(timeValue);
  };

  // Find the segment containing the given source time (ms)
  const findSegmentAtTime = (timeMs: number): VideoSegment | null => {
    const segs = segmentsRef.current;
    if (segs.length === 0) return null;
    return segs.find((s) => timeMs >= s.startMs && timeMs < s.endMs) ?? null;
  };

  // Fallback: check trim regions (backward compat when segments not available)
  const findActiveTrimRegion = (currentTimeMs: number): TrimRegion | null => {
    const trimRegions = trimRegionsRef.current;
    return trimRegions.find(
      (region) => currentTimeMs >= region.startMs && currentTimeMs < region.endMs
    ) || null;
  };

  // Find the next non-deleted segment boundary after a given source time
  const findNextKeptSegmentStart = (afterMs: number): number | null => {
    const segs = segmentsRef.current;
    for (const seg of segs) {
      if (seg.startMs >= afterMs && !seg.deleted) {
        return seg.startMs;
      }
    }
    return null;
  };

  function updateTime() {
    if (!video) return;

    const currentTimeMs = video.currentTime * 1000;
    const segs = segmentsRef.current;

    if (segs.length > 0) {
      // Segment-aware playback
      const seg = findSegmentAtTime(currentTimeMs);

      if (seg && seg.deleted && !video.paused && !video.ended) {
        // Inside a deleted segment — skip to next kept segment
        const nextStart = findNextKeptSegmentStart(seg.endMs);
        if (nextStart !== null) {
          video.currentTime = nextStart / 1000;
          emitTime(nextStart / 1000);
        } else {
          video.pause();
        }
      } else if (seg && !seg.deleted) {
        // Apply per-segment speed × preview playback rate (clamped to browser limits)
        const previewRate = previewPlaybackRateRef.current;
        const targetRate = Math.max(0.0625, Math.min(16, seg.speed * previewRate));
        if (Math.abs(video.playbackRate - targetRate) > 0.001) {
          video.playbackRate = targetRate;
        }
        emitTime(video.currentTime);
      } else {
        emitTime(video.currentTime);
      }
    } else {
      // Legacy trim-region path
      const activeTrimRegion = findActiveTrimRegion(currentTimeMs);
      if (activeTrimRegion && !video.paused && !video.ended) {
        const skipToTime = activeTrimRegion.endMs / 1000;
        if (skipToTime >= video.duration) {
          video.pause();
        } else {
          video.currentTime = skipToTime;
          emitTime(skipToTime);
        }
      } else {
        emitTime(video.currentTime);
      }
    }

    if (!video.paused && !video.ended) {
      timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
    }
  }

  const handlePlay = () => {
    if (isSeekingRef.current) {
      console.warn('[videoEvents] handlePlay: pausing because isSeeking=true');
      video.pause();
      return;
    }

    if (!allowPlaybackRef.current) {
      console.warn('[videoEvents] handlePlay: pausing because allowPlayback=false');
      video.pause();
      return;
    }

    console.log('[videoEvents] handlePlay: allowing playback, isPlaying=true');
    spuriousPauseRetries = 0;
    isPlayingRef.current = true;
    onPlayStateChange(true);
    if (timeUpdateAnimationRef.current) {
      cancelAnimationFrame(timeUpdateAnimationRef.current);
    }
    timeUpdateAnimationRef.current = requestAnimationFrame(updateTime);
  };

  const handlePause = () => {
    // On some platforms (notably Chromium on Linux/Wayland) the browser may
    // emit a native pause event right after play() succeeds — e.g. because
    // of a WebGL video texture interaction.  When allowPlayback is still
    // true we treat this as a spurious pause and retry playback once.
    if (allowPlaybackRef.current && !isSeekingRef.current && !video.ended && spuriousPauseRetries < MAX_SPURIOUS_PAUSE_RETRIES) {
      spuriousPauseRetries += 1;
      console.log('[videoEvents] handlePause: spurious native pause detected, retry', spuriousPauseRetries);
      video.play().catch(() => {
        // Retry failed — accept the pause
        isPlayingRef.current = false;
        onPlayStateChange(false);
        if (timeUpdateAnimationRef.current) {
          cancelAnimationFrame(timeUpdateAnimationRef.current);
          timeUpdateAnimationRef.current = null;
        }
        emitTime(video.currentTime);
      });
      return;
    }

    isPlayingRef.current = false;
    onPlayStateChange(false);
    if (timeUpdateAnimationRef.current) {
      cancelAnimationFrame(timeUpdateAnimationRef.current);
      timeUpdateAnimationRef.current = null;
    }
    emitTime(video.currentTime);
  };

  const handleSeeked = () => {
    isSeekingRef.current = false;

    if (isScrubbingRef && scrubEndTimerRef) {
      clearScrubEndTimer();
      scrubEndTimerRef.current = window.setTimeout(() => {
        isScrubbingRef.current = false;
        scrubEndTimerRef.current = null;
        onScrubChange?.(false);
      }, SCRUB_END_DEBOUNCE_MS);
    }

    const currentTimeMs = video.currentTime * 1000;
    const segs = segmentsRef.current;

    if (segs.length > 0) {
      const seg = findSegmentAtTime(currentTimeMs);
      if (seg && seg.deleted && isPlayingRef.current && !video.paused) {
        const nextStart = findNextKeptSegmentStart(seg.endMs);
        if (nextStart !== null) {
          video.currentTime = nextStart / 1000;
          emitTime(nextStart / 1000);
        } else {
          video.pause();
        }
      } else {
        if (!isPlayingRef.current && !video.paused) {
          video.pause();
        }
        emitTime(video.currentTime);
      }
    } else {
      // Legacy trim path
      const activeTrimRegion = findActiveTrimRegion(currentTimeMs);
      if (activeTrimRegion && isPlayingRef.current && !video.paused) {
        const skipToTime = activeTrimRegion.endMs / 1000;
        if (skipToTime >= video.duration) {
          video.pause();
        } else {
          video.currentTime = skipToTime;
          emitTime(skipToTime);
        }
      } else {
        if (!isPlayingRef.current && !video.paused) {
          video.pause();
        }
        emitTime(video.currentTime);
      }
    }
  };

  const handleSeeking = () => {
    isSeekingRef.current = true;

    if (isScrubbingRef) {
      clearScrubEndTimer();
      if (!isScrubbingRef.current) {
        isScrubbingRef.current = true;
        onScrubChange?.(true);
      }
    }

    if (!isPlayingRef.current && !video.paused) {
      video.pause();
    }
    emitTime(video.currentTime);
  };

  return {
    handlePlay,
    handlePause,
    handleSeeked,
    handleSeeking,
    /** Drop any pending coalesced time commit and the scrub tail timer (call on unmount / rewire). */
    dispose: () => {
      timeUpdateCoalescer.cancel();
      clearScrubEndTimer();
    },
  };
}
