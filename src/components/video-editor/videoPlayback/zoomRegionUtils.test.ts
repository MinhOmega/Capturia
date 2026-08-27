import { beforeEach, describe, expect, it } from 'vitest';
import type { ZoomRegion } from '../types';
import { ZOOM_DEPTH_SCALES } from '../types';
import {
  CONNECTED_ZOOM_PAN_DURATION_MS,
  TRANSITION_WINDOW_MS,
  ZOOM_IN_OVERLAP_MS,
  ZOOM_IN_TRANSITION_WINDOW_MS,
} from './constants';
import { getFocusBoundsForScale } from './focusUtils';
import {
  computeRegionStrength,
  findDominantRegion,
  getConnectedRegionPairs,
  resetDominantRegionCache,
} from './zoomRegionUtils';

function region(overrides: Partial<ZoomRegion> & { id: string; startMs: number; endMs: number }): ZoomRegion {
  return { depth: 3, focus: { cx: 0.5, cy: 0.5 }, ...overrides };
}

beforeEach(() => {
  resetDominantRegionCache();
});

describe('computeRegionStrength (Screen Studio curve)', () => {
  const r = region({ id: 'a', startMs: 5000, endMs: 8000 });
  const leadInStart = r.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS;

  it('starts easing in ~1022 ms before startMs and is fully zoomed 500 ms inside the region', () => {
    expect(leadInStart).toBeCloseTo(5000 - 1022.575, 3);
    expect(computeRegionStrength(r, leadInStart - 1)).toBe(0);
    expect(computeRegionStrength(r, leadInStart + 1)).toBeGreaterThan(0);
    expect(computeRegionStrength(r, r.startMs)).toBeGreaterThan(0.9);
    expect(computeRegionStrength(r, r.startMs)).toBeLessThan(1);
    expect(computeRegionStrength(r, r.startMs + ZOOM_IN_OVERLAP_MS)).toBe(1);
  });

  it('holds at 1 until endMs, then eases out over TRANSITION_WINDOW_MS', () => {
    expect(computeRegionStrength(r, 6500)).toBe(1);
    expect(computeRegionStrength(r, r.endMs)).toBe(1);
    const mid = computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS)).toBeCloseTo(0, 6);
    expect(computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS + 1)).toBe(0);
  });

  it('is monotonic on both ramps', () => {
    let prev = 0;
    for (let t = leadInStart; t <= r.startMs + ZOOM_IN_OVERLAP_MS; t += 10) {
      const s = computeRegionStrength(r, t);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = s;
    }
    prev = 1;
    for (let t = r.endMs; t <= r.endMs + TRANSITION_WINDOW_MS; t += 10) {
      const s = computeRegionStrength(r, t);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });
});

describe('findDominantRegion', () => {
  it('returns the { region, strength } shape with an empty result when unzoomed', () => {
    const result = findDominantRegion([region({ id: 'a', startMs: 10_000, endMs: 12_000 })], 0);
    expect(result.region).toBeNull();
    expect(result.strength).toBe(0);
    expect(result.blendedScale).toBeNull();
    expect(result.transition).toBeNull();
  });

  it('clamps the returned focus to the bounds of the effective (custom) scale', () => {
    const r = region({ id: 'a', startMs: 0, endMs: 5000, focus: { cx: 0.02, cy: 0.98 }, customScale: 2 });
    const { region: active } = findDominantRegion([r], 2500);
    const bounds = getFocusBoundsForScale(2);
    expect(active?.focus).toEqual({ cx: bounds.minX, cy: bounds.maxY });
  });

  it('prefers the stronger region, and the later one on ties', () => {
    const a = region({ id: 'a', startMs: 0, endMs: 3000 });
    const b = region({ id: 'b', startMs: 2000, endMs: 6000 });
    // Both fully zoomed at 2600 (b reached 1 at 2500) -> the later one wins.
    expect(findDominantRegion([a, b], 2600).region?.id).toBe('b');
    // Well after a's lead-out only b is active.
    expect(findDominantRegion([a, b], 5000).region?.id).toBe('b');
  });

  it('memoises the last result for identical inputs (single-slot cache)', () => {
    const regions = [region({ id: 'a', startMs: 0, endMs: 5000 })];
    const first = findDominantRegion(regions, 1000.2);
    const second = findDominantRegion(regions, 1000.4); // rounds to the same ms
    expect(second).toBe(first);
    expect(findDominantRegion([...regions], 1000)).not.toBe(first); // new array ref
    expect(findDominantRegion(regions, 1000, { connectZooms: true })).not.toBe(first);
  });
});

describe('connected zoom transitions', () => {
  // a -> b gap is 1200 ms: 1000 ms pan, then a 200 ms "connected hold" on b.
  const a = region({ id: 'a', startMs: 1000, endMs: 4000, focus: { cx: 0.3, cy: 0.5 }, depth: 2 });
  const b = region({ id: 'b', startMs: 5200, endMs: 9000, focus: { cx: 0.7, cy: 0.5 }, depth: 4 });
  const far = region({ id: 'c', startMs: 12_000, endMs: 14_000 });

  it('pairs regions whose gap is at most 1500 ms', () => {
    const pairs = getConnectedRegionPairs([far, b, a]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].currentRegion.id).toBe('a');
    expect(pairs[0].nextRegion.id).toBe('b');
    expect(pairs[0].transitionStart).toBe(a.endMs);
    expect(pairs[0].transitionEnd).toBe(a.endMs + CONNECTED_ZOOM_PAN_DURATION_MS);
    expect(getConnectedRegionPairs([a, region({ id: 'd', startMs: 5501, endMs: 6000 })])).toHaveLength(0);
  });

  it('pans between the two regions in the gap instead of zooming out (connectZooms)', () => {
    const regions = [a, b, far];
    const mid = findDominantRegion(regions, a.endMs + 500, { connectZooms: true });
    expect(mid.strength).toBe(1);
    expect(mid.transition).not.toBeNull();
    expect(mid.transition?.startScale).toBe(ZOOM_DEPTH_SCALES[2]);
    expect(mid.transition?.endScale).toBe(ZOOM_DEPTH_SCALES[4]);
    expect(mid.blendedScale).toBeGreaterThan(ZOOM_DEPTH_SCALES[2]);
    expect(mid.blendedScale).toBeLessThan(ZOOM_DEPTH_SCALES[4]);
    expect(mid.region?.id).toBe('b');
    expect(mid.region?.focus.cx).toBeGreaterThan(0.3);
    expect(mid.region?.focus.cx).toBeLessThan(0.7);

    // Without connectZooms the same instant is a plain cross-fade (a easing
    // out while b eases in): partial strength, no pan.
    const legacy = findDominantRegion(regions, a.endMs + 500);
    expect(legacy.strength).toBeLessThan(1);
    expect(legacy.strength).toBeGreaterThan(0);
    expect(legacy.transition).toBeNull();
    expect(legacy.blendedScale).toBeNull();
  });

  it('holds the next region at full strength between the pan end and its startMs', () => {
    const hold = findDominantRegion([a, b], a.endMs + CONNECTED_ZOOM_PAN_DURATION_MS + 1, { connectZooms: true });
    expect(hold.region?.id).toBe('b');
    expect(hold.strength).toBe(1);
    expect(hold.transition).toBeNull();
    expect(hold.blendedScale).toBeNull();
    const bounds = getFocusBoundsForScale(ZOOM_DEPTH_SCALES[4]);
    expect(hold.region?.focus.cx).toBeCloseTo(Math.min(0.7, bounds.maxX), 9);
  });

  it('never dips below full strength across the whole a -> b seam', () => {
    for (let t = a.endMs - 100; t <= b.startMs + ZOOM_IN_OVERLAP_MS; t += 25) {
      expect(findDominantRegion([a, b], t, { connectZooms: true }).strength).toBe(1);
    }
  });

  it('still eases the unconnected region out normally', () => {
    const out = findDominantRegion([a, b, far], far.endMs + TRANSITION_WINDOW_MS / 2, { connectZooms: true });
    expect(out.region?.id).toBe('c');
    expect(out.strength).toBeGreaterThan(0);
    expect(out.strength).toBeLessThan(1);
  });
});
