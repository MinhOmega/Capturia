import { describe, expect, it } from 'vitest';
import { computePeaks, MAX_PEAK_BLOCKS, PEAK_BLOCKS_PER_SECOND, peakBlockCount } from './audioPeaks';

describe('peakBlockCount', () => {
  it('uses 200 blocks per second', () => {
    expect(peakBlockCount(2)).toBe(2 * PEAK_BLOCKS_PER_SECOND);
    expect(peakBlockCount(0.0049)).toBe(1);
  });

  it('caps very long recordings', () => {
    expect(peakBlockCount(60 * 60)).toBe(MAX_PEAK_BLOCKS);
  });

  it('returns 0 for empty or invalid durations', () => {
    expect(peakBlockCount(0)).toBe(0);
    expect(peakBlockCount(Number.NaN)).toBe(0);
  });
});

describe('computePeaks', () => {
  it('returns an empty array with no channels or no samples', () => {
    expect(computePeaks([], 1)).toHaveLength(0);
    expect(computePeaks([new Float32Array(0)], 1)).toHaveLength(0);
  });

  it('emits [min, max] pairs per block', () => {
    // 0.01 s -> 2 blocks; 4 samples -> 2 samples per block
    const mono = new Float32Array([0.5, -0.25, -1, 0.75]);
    const peaks = computePeaks([mono], 0.01);
    expect(Array.from(peaks)).toEqual([-0.25, 0.5, -1, 0.75]);
  });

  it('averages channels before bucketing', () => {
    const left = new Float32Array([1, 1]);
    const right = new Float32Array([0, -1]);
    const peaks = computePeaks([left, right], 0.005); // 1 block
    expect(Array.from(peaks)).toEqual([0, 0.5]);
  });

  it('never reports a positive min or a negative max for silence', () => {
    const silence = new Float32Array(100);
    const peaks = computePeaks([silence], 0.05); // 10 blocks
    expect(peaks).toHaveLength(20);
    expect(Array.from(peaks).every((v) => v === 0)).toBe(true);
  });

  it('keeps every sample inside exactly one block', () => {
    const samples = new Float32Array(1000).map((_, i) => (i === 999 ? 1 : 0));
    const peaks = computePeaks([samples], 0.015); // 3 blocks of 333.3 samples
    expect(peaks).toHaveLength(6);
    expect(peaks[5]).toBe(1);
  });
});
