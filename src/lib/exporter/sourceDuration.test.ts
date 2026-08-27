import { describe, expect, it } from 'vitest';
import { resolveSourceDurationMs } from './sourceDuration';

describe('resolveSourceDurationMs', () => {
  it('uses the decoded duration when no override is given', () => {
    expect(resolveSourceDurationMs(12.5)).toBe(12_500);
    expect(resolveSourceDurationMs(12.5, undefined)).toBe(12_500);
    expect(resolveSourceDurationMs(12.5, null)).toBe(12_500);
  });

  it('prefers a shorter probed duration over an inflated container duration', () => {
    // Inflated WebM: container says 20 min, probe found the real end at 6.2 s.
    expect(resolveSourceDurationMs(1200, 6_200)).toBe(6_200);
  });

  it('ignores an override longer than the decoded duration', () => {
    expect(resolveSourceDurationMs(10, 15_000)).toBe(10_000);
  });

  it('ignores non-finite or non-positive overrides', () => {
    expect(resolveSourceDurationMs(10, 0)).toBe(10_000);
    expect(resolveSourceDurationMs(10, -5)).toBe(10_000);
    expect(resolveSourceDurationMs(10, Number.NaN)).toBe(10_000);
    expect(resolveSourceDurationMs(10, Number.POSITIVE_INFINITY)).toBe(10_000);
  });

  it('falls back to the override when the decoded duration is unusable', () => {
    expect(resolveSourceDurationMs(Number.NaN, 4_000)).toBe(4_000);
    expect(resolveSourceDurationMs(Number.POSITIVE_INFINITY, 4_000)).toBe(4_000);
    expect(resolveSourceDurationMs(0, 4_000)).toBe(4_000);
  });

  it('never returns a negative duration', () => {
    expect(resolveSourceDurationMs(-3)).toBe(0);
    expect(resolveSourceDurationMs(Number.NaN)).toBe(0);
  });
});
