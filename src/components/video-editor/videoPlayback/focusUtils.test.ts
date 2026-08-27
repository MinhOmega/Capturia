import { describe, expect, it } from 'vitest';
import { clampFocusToScale, getFocusBoundsForScale } from './focusUtils';

describe('getFocusBoundsForScale', () => {
  it('keeps half a zoom window away from every edge', () => {
    expect(getFocusBoundsForScale(2)).toEqual({ minX: 0.25, maxX: 0.75, minY: 0.25, maxY: 0.75 });
  });

  it('collapses to the centre at scale 1 and below', () => {
    expect(getFocusBoundsForScale(1)).toEqual({ minX: 0.5, maxX: 0.5, minY: 0.5, maxY: 0.5 });
    expect(getFocusBoundsForScale(0.5)).toEqual({ minX: 0.5, maxX: 0.5, minY: 0.5, maxY: 0.5 });
  });

  it('falls back to scale 1 for a non-finite scale', () => {
    expect(getFocusBoundsForScale(Number.NaN)).toEqual(getFocusBoundsForScale(1));
  });
});

describe('clampFocusToScale', () => {
  it('clamps a corner focus into the bounds for the scale', () => {
    expect(clampFocusToScale({ cx: 0, cy: 1 }, 2)).toEqual({ cx: 0.25, cy: 0.75 });
  });

  it('is independent of the stage size argument', () => {
    const focus = { cx: 0.9, cy: 0.1 };
    expect(clampFocusToScale(focus, 1.8, { width: 1920, height: 1080 })).toEqual(
      clampFocusToScale(focus, 1.8, { width: 0, height: 0 }),
    );
  });

  it('leaves an in-bounds focus untouched and maps NaN to the centre', () => {
    expect(clampFocusToScale({ cx: 0.5, cy: 0.6 }, 3)).toEqual({ cx: 0.5, cy: 0.6 });
    expect(clampFocusToScale({ cx: Number.NaN, cy: 0.5 }, 3)).toEqual({ cx: 0.5, cy: 0.5 });
  });
});
