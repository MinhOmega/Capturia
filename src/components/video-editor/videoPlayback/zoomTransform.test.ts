import { describe, expect, it } from 'vitest';
import { computeFocusFromTransform, computeZoomTransform } from './zoomTransform';

const stageSize = { width: 1600, height: 900 };
const baseMask = { x: 100, y: 50, width: 1400, height: 800 };

describe('computeZoomTransform', () => {
  it('is the identity at progress 0 and at scale 1 on the centre', () => {
    for (const t of [
      computeZoomTransform({ stageSize, baseMask, zoomScale: 2, zoomProgress: 0, focusX: 0.2, focusY: 0.8 }),
      computeZoomTransform({ stageSize, baseMask, zoomScale: 1, focusX: 0.5, focusY: 0.5 }),
    ]) {
      expect(t.scale).toBe(1);
      expect(Math.abs(t.x)).toBe(0);
      expect(Math.abs(t.y)).toBe(0);
    }
  });

  it('keeps the focus point on the stage centre at full progress', () => {
    const focus = { cx: 0.3, cy: 0.7 };
    const t = computeZoomTransform({ stageSize, baseMask, zoomScale: 2.2, focusX: focus.cx, focusY: focus.cy });
    // camera maps stage px p to p*scale + translation
    expect(focus.cx * stageSize.width * t.scale + t.x).toBeCloseTo(stageSize.width / 2, 6);
    expect(focus.cy * stageSize.height * t.scale + t.y).toBeCloseTo(stageSize.height / 2, 6);
  });

  it('is linear in progress for both scale and translation', () => {
    const full = computeZoomTransform({ stageSize, baseMask, zoomScale: 3, focusX: 0.25, focusY: 0.25 });
    const half = computeZoomTransform({ stageSize, baseMask, zoomScale: 3, zoomProgress: 0.5, focusX: 0.25, focusY: 0.25 });
    expect(half.scale).toBeCloseTo(1 + (full.scale - 1) / 2, 9);
    expect(half.x).toBeCloseTo(full.x / 2, 9);
    expect(half.y).toBeCloseTo(full.y / 2, 9);
  });

  it('returns the identity for a degenerate stage or mask', () => {
    expect(computeZoomTransform({ stageSize: { width: 0, height: 0 }, baseMask, zoomScale: 2, focusX: 0.5, focusY: 0.5 }))
      .toEqual({ scale: 1, x: 0, y: 0 });
    expect(computeZoomTransform({ stageSize, baseMask: { ...baseMask, width: 0 }, zoomScale: 2, focusX: 0.5, focusY: 0.5 }))
      .toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe('computeFocusFromTransform', () => {
  it('inverts computeZoomTransform at full progress', () => {
    for (const focus of [{ cx: 0.3, cy: 0.7 }, { cx: 0.5, cy: 0.5 }, { cx: 0.8, cy: 0.2 }]) {
      const t = computeZoomTransform({ stageSize, baseMask, zoomScale: 1.8, focusX: focus.cx, focusY: focus.cy });
      const back = computeFocusFromTransform({ stageSize, baseMask, zoomScale: t.scale, x: t.x, y: t.y });
      expect(back.cx).toBeCloseTo(focus.cx, 9);
      expect(back.cy).toBeCloseTo(focus.cy, 9);
    }
  });

  it('falls back to the centre for an invalid scale', () => {
    expect(computeFocusFromTransform({ stageSize, baseMask, zoomScale: 0, x: 10, y: 10 })).toEqual({ cx: 0.5, cy: 0.5 });
  });
});
