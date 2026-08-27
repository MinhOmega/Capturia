import { describe, expect, it } from 'vitest';
import { computeExportMetrics, shouldFailDecodeEndedEarly, validateDuration } from './streamingDecoder';

describe('validateDuration', () => {
  it('returns scanned duration when container reports Infinity', () => {
    expect(validateDuration(Infinity, 15.3)).toBe(15.3);
  });

  it('returns scanned duration when container reports 0', () => {
    expect(validateDuration(0, 15.3)).toBe(15.3);
  });

  it('returns scanned duration when container reports NaN', () => {
    expect(validateDuration(NaN, 15.3)).toBe(15.3);
  });

  it('returns scanned duration when container is inflated beyond threshold', () => {
    expect(validateDuration(42, 15.3)).toBe(15.3);
  });

  it('returns container duration when values are close', () => {
    expect(validateDuration(15.5, 15.3)).toBe(15.5);
  });

  it('returns container duration when scanned is slightly higher', () => {
    // container < scanned (scanned overshoot from last frame duration)
    expect(validateDuration(15.0, 15.3)).toBe(15.0);
  });

  it('returns scanned duration when container under-reports beyond threshold', () => {
    expect(validateDuration(10, 15.3)).toBe(15.3);
  });

  it('returns container duration when scanned is zero (corrupted/empty file)', () => {
    expect(validateDuration(10, 0)).toBe(10);
  });

  it('returns 0 when both container is NaN and scanned is zero', () => {
    expect(validateDuration(NaN, 0)).toBe(0);
  });
});

describe('shouldFailDecodeEndedEarly', () => {
  it('does not fail once every segment has been satisfied', () => {
    expect(
      shouldFailDecodeEndedEarly({
        cancelled: false,
        lastDecodedFrameSec: 5.33,
        requiredEndSec: 6.498,
        streamDurationSec: 5.33,
      }),
    ).toBe(false);
  });

  it('fails when decode stops far before the required end', () => {
    expect(
      shouldFailDecodeEndedEarly({
        cancelled: false,
        lastDecodedFrameSec: 5.33,
        requiredEndSec: 10,
        streamDurationSec: 5.33,
      }),
    ).toBe(true);
  });

  it('fails when no frame could be decoded for a non-empty timeline', () => {
    expect(
      shouldFailDecodeEndedEarly({
        cancelled: false,
        lastDecodedFrameSec: null,
        requiredEndSec: 1,
      }),
    ).toBe(true);
  });

  it('fails when the decoder has not reached the reported stream end', () => {
    expect(
      shouldFailDecodeEndedEarly({
        cancelled: false,
        lastDecodedFrameSec: 4.9,
        requiredEndSec: 6.498,
        streamDurationSec: 5.33,
      }),
    ).toBe(true);
  });
});

describe('computeExportMetrics', () => {
  it('counts ceil((duration - 1ms) * fps) frames for an untrimmed source', () => {
    // 10 s at 30 fps: (10 - 0.001) * 30 = 299.97 -> 300 frames.
    expect(computeExportMetrics(10, 30)).toEqual({ effectiveDuration: 10, totalFrames: 300 });
  });

  it('sums per-segment frame counts after trims and speed changes', () => {
    const metrics = computeExportMetrics(
      10,
      30,
      [{ id: 't', startMs: 2000, endMs: 4000 }],
      [{ id: 's', startMs: 6000, endMs: 10000, speed: 2 }],
    );
    // [0,2] @1x -> 2 s (60 frames); [4,6] @1x -> 2 s (60); [6,10] @2x -> 2 s (60).
    expect(metrics.effectiveDuration).toBeCloseTo(6, 9);
    expect(metrics.totalFrames).toBe(180);
  });

  it('never returns a negative frame count for a sliver segment', () => {
    // A 0.5 ms keep segment is shorter than the 1 ms epsilon.
    const metrics = computeExportMetrics(1, 60, [{ id: 't', startMs: 0, endMs: 999.5 }]);
    expect(metrics.totalFrames).toBe(0);
  });
});
