import { describe, expect, it } from 'vitest';

import { computeFrameStepTime, FRAME_DURATION_SEC } from '@/lib/frameStep';

describe('computeFrameStepTime', () => {
  const duration = 10;

  it('moves forward by one frame from the middle', () => {
    const result = computeFrameStepTime(5, duration, 'forward');
    expect(result).toBeCloseTo(5 + FRAME_DURATION_SEC, 10);
  });

  it('moves backward by one frame from the middle', () => {
    const result = computeFrameStepTime(5, duration, 'backward');
    expect(result).toBeCloseTo(5 - FRAME_DURATION_SEC, 10);
  });

  it('clamps to 0 when stepping backward at the beginning', () => {
    const result = computeFrameStepTime(0, duration, 'backward');
    expect(result).toBe(0);
  });

  it('clamps to 0 when stepping backward near the beginning', () => {
    const result = computeFrameStepTime(FRAME_DURATION_SEC / 2, duration, 'backward');
    expect(result).toBe(0);
  });

  it('clamps to duration when stepping forward at the end', () => {
    const result = computeFrameStepTime(duration, duration, 'forward');
    expect(result).toBe(duration);
  });

  it('clamps to duration when stepping forward near the end', () => {
    const result = computeFrameStepTime(duration - FRAME_DURATION_SEC / 2, duration, 'forward');
    expect(result).toBe(duration);
  });

  it('handles duration of 0 gracefully', () => {
    expect(computeFrameStepTime(0, 0, 'forward')).toBe(0);
    expect(computeFrameStepTime(0, 0, 'backward')).toBe(0);
  });

  it('steps by the caller-supplied frame duration for non-60fps sources', () => {
    const frame30 = 1 / 30;
    expect(computeFrameStepTime(5, duration, 'forward', frame30)).toBeCloseTo(5 + frame30, 10);
    expect(computeFrameStepTime(5, duration, 'backward', frame30)).toBeCloseTo(5 - frame30, 10);
  });

  it('falls back to the 60fps frame when the supplied duration is not positive', () => {
    expect(computeFrameStepTime(5, duration, 'forward', 0)).toBeCloseTo(5 + FRAME_DURATION_SEC, 10);
    expect(computeFrameStepTime(5, duration, 'forward', Number.NaN)).toBeCloseTo(5 + FRAME_DURATION_SEC, 10);
  });
});
