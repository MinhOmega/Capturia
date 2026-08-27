import { describe, expect, it } from 'vitest';
import {
  createTextAnnotationRegion,
  getZoomScale,
  MAX_ZOOM_SCALE,
  MIN_ZOOM_SCALE,
  resolveTextAnnotationContent,
  ZOOM_DEPTH_SCALES,
  type ZoomDepth,
  type ZoomRegion,
} from './types';

function zoomRegion(overrides: Partial<ZoomRegion> = {}): ZoomRegion {
  return {
    id: 'zoom-1',
    startMs: 0,
    endMs: 1000,
    depth: 3,
    focus: { cx: 0.5, cy: 0.5 },
    ...overrides,
  };
}

describe('getZoomScale', () => {
  it('falls back to the depth preset when customScale is unset', () => {
    for (const depth of [1, 2, 3, 4, 5, 6] as ZoomDepth[]) {
      expect(getZoomScale(zoomRegion({ depth }))).toBe(ZOOM_DEPTH_SCALES[depth]);
    }
    expect(getZoomScale(zoomRegion({ depth: 2, customScale: undefined }))).toBe(ZOOM_DEPTH_SCALES[2]);
  });

  it('prefers a finite customScale over the preset', () => {
    expect(getZoomScale(zoomRegion({ depth: 3, customScale: 2.35 }))).toBe(2.35);
  });

  it('clamps customScale into the supported range', () => {
    expect(getZoomScale(zoomRegion({ customScale: 0.2 }))).toBe(MIN_ZOOM_SCALE);
    expect(getZoomScale(zoomRegion({ customScale: 12 }))).toBe(MAX_ZOOM_SCALE);
    expect(getZoomScale(zoomRegion({ customScale: Number.POSITIVE_INFINITY }))).toBe(MAX_ZOOM_SCALE);
    expect(getZoomScale(zoomRegion({ customScale: Number.NEGATIVE_INFINITY }))).toBe(MIN_ZOOM_SCALE);
  });

  it('ignores NaN customScale and uses the preset', () => {
    expect(getZoomScale(zoomRegion({ depth: 4, customScale: Number.NaN }))).toBe(ZOOM_DEPTH_SCALES[4]);
  });

  it('keeps the preset table inside the custom range', () => {
    for (const scale of Object.values(ZOOM_DEPTH_SCALES)) {
      expect(scale).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE);
      expect(scale).toBeLessThanOrEqual(MAX_ZOOM_SCALE);
    }
  });
});

// Regression coverage for upstream #127: a freshly created text annotation must
// start with truly empty content so the properties panel's placeholder shows
// and typing replaces rather than appends to baked-in text.
describe('createTextAnnotationRegion', () => {
  it('starts with empty content, not a baked-in placeholder string', () => {
    const region = createTextAnnotationRegion({
      id: 'annotation-1',
      startMs: 1000,
      endMs: 2000,
      zIndex: 1,
    });

    expect(region.content).toBe('');
    expect(region.type).toBe('text');
    expect(region.id).toBe('annotation-1');
    expect(region.zIndex).toBe(1);
  });

  it('gives every region its own position/size/style objects', () => {
    const a = createTextAnnotationRegion({ id: 'a', startMs: 0, endMs: 1, zIndex: 0 });
    const b = createTextAnnotationRegion({ id: 'b', startMs: 0, endMs: 1, zIndex: 0 });
    expect(a.style).not.toBe(b.style);
    expect(a.position).not.toBe(b.position);
    expect(a.size).not.toBe(b.size);
  });
});

describe('resolveTextAnnotationContent', () => {
  it('falls back to empty content when no prior text was stored', () => {
    expect(resolveTextAnnotationContent(undefined)).toBe('');
  });

  it('preserves existing text content when converting an existing region to text', () => {
    expect(resolveTextAnnotationContent('hello world')).toBe('hello world');
  });
});
