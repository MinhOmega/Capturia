import { beforeEach, describe, expect, it } from 'vitest';
import type { ZoomRegion } from '../types';
import { ZOOM_DEPTH_SCALES } from '../types';
import { ZOOM_IN_OVERLAP_MS, ZOOM_SPRING_MAX_STEP_MS } from './constants';
import {
  advanceZoomCamera,
  createZoomCameraState,
  measureZoomMotionIntensity,
  resolveZoomCameraTarget,
  type ZoomCameraGeometry,
} from './zoomCamera';
import { resetDominantRegionCache } from './zoomRegionUtils';
import { computeZoomTransform, type ZoomTransform } from './zoomTransform';

const geometry: ZoomCameraGeometry = {
  stageSize: { width: 1280, height: 720 },
  baseMask: { x: 64, y: 36, width: 1152, height: 648 },
};

// Two connected regions (gap 1200 ms) followed by a lone one.
const regions: ZoomRegion[] = [
  { id: 'a', startMs: 1500, endMs: 4000, depth: 2, focus: { cx: 0.3, cy: 0.4 } },
  { id: 'b', startMs: 5200, endMs: 8000, depth: 4, focus: { cx: 0.7, cy: 0.6 }, customScale: 2.35 },
  { id: 'c', startMs: 11_000, endMs: 13_000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
];

function timeSeries(stepMs: number, endMs: number) {
  const times: number[] = [];
  for (let t = 0; t <= endMs; t += stepMs) times.push(t);
  return times;
}

/** The preview ticker: snaps unless actively playing. */
function runPreviewLoop(times: number[], isPlaying: (t: number) => boolean) {
  const state = createZoomCameraState();
  return times.map((t) => {
    const target = resolveZoomCameraTarget(regions, t, geometry);
    return advanceZoomCamera(state, target.transform, t, isPlaying(t));
  });
}

/** frameRenderer.updateAnimationState: always animating, stepped by content dt. */
function runExportLoop(times: number[]) {
  const state = createZoomCameraState();
  return times.map((t) => {
    const target = resolveZoomCameraTarget(regions, t, geometry);
    return advanceZoomCamera(state, target.transform, t, true);
  });
}

beforeEach(() => {
  resetDominantRegionCache();
});

describe('resolveZoomCameraTarget', () => {
  it('is unzoomed outside every region and when forced', () => {
    const idle = resolveZoomCameraTarget(regions, 0, geometry);
    expect(idle.progress).toBe(0);
    expect(idle.scale).toBe(1);
    expect(idle.transform).toEqual({ scale: 1, x: 0, y: 0 });
    const forced = resolveZoomCameraTarget(regions, 2500, geometry, { forceUnzoomed: true });
    expect(forced.transform).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it('uses the customScale-aware scale and the clamped focus at full zoom', () => {
    const target = resolveZoomCameraTarget(regions, 7000, geometry);
    expect(target.scale).toBe(2.35);
    expect(target.progress).toBe(1);
    const expected = computeZoomTransform({ ...geometry, zoomScale: 2.35, focusX: target.focus.cx, focusY: target.focus.cy });
    expect(target.transform).toEqual(expected);
  });

  it('pans in transform space during a connected transition', () => {
    const start = resolveZoomCameraTarget(regions, 4000, geometry).transform;
    const mid = resolveZoomCameraTarget(regions, 4500, geometry).transform;
    const end = resolveZoomCameraTarget(regions, 5000, geometry).transform;
    expect(start.scale).toBeCloseTo(ZOOM_DEPTH_SCALES[2], 6);
    expect(end.scale).toBeCloseTo(2.35, 6);
    // Mid-pan lies on the straight segment between the two transforms.
    const u = (mid.scale - start.scale) / (end.scale - start.scale);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(1);
    expect(mid.x).toBeCloseTo(start.x + (end.x - start.x) * u, 6);
    expect(mid.y).toBeCloseTo(start.y + (end.y - start.y) * u, 6);
  });
});

describe('advanceZoomCamera', () => {
  it('snaps on the first frame, when not animating, on backwards time and on big jumps', () => {
    const state = createZoomCameraState();
    const t1: ZoomTransform = { scale: 2, x: -300, y: -200 };
    expect(advanceZoomCamera(state, t1, 1000, true)).toEqual(t1); // first frame
    const t2: ZoomTransform = { scale: 1.5, x: -100, y: -50 };
    expect(advanceZoomCamera(state, t2, 1016, false)).toEqual(t2); // paused / seeking
    const t3: ZoomTransform = { scale: 1.2, x: -40, y: -20 };
    expect(advanceZoomCamera(state, t3, 900, true)).toEqual(t3); // backwards
    const t4: ZoomTransform = { scale: 3, x: -800, y: -400 };
    expect(advanceZoomCamera(state, t4, 900 + ZOOM_SPRING_MAX_STEP_MS + 1, true)).toEqual(t4); // jump
    // A normal step glides instead.
    const sprung = advanceZoomCamera(state, { scale: 1, x: 0, y: 0 }, 900 + ZOOM_SPRING_MAX_STEP_MS + 1 + 16, true);
    expect(sprung.scale).toBeGreaterThan(1);
    expect(sprung.scale).toBeLessThan(3);
    expect(state.applied).toEqual(sprung);
  });
});

describe('preview / export parity', () => {
  it('produces identical transforms for the same content-time series while playing', () => {
    const times = timeSeries(1000 / 60, 14_000);
    const preview = runPreviewLoop(times, () => true);
    const exported = runExportLoop(times);
    expect(preview).toEqual(exported);
  });

  it('holds at the exact target once a region has settled, at 30 and 60 fps alike', () => {
    for (const fps of [30, 60]) {
      const times = timeSeries(1000 / fps, 8000);
      const exported = runExportLoop(times);
      const settleIndex = times.findIndex((t) => t >= regions[0].startMs + ZOOM_IN_OVERLAP_MS + 1500);
      const target = resolveZoomCameraTarget(regions, times[settleIndex], geometry).transform;
      expect(exported[settleIndex].scale).toBeCloseTo(target.scale, 3);
      expect(exported[settleIndex].x).toBeCloseTo(target.x, 1);
      expect(exported[settleIndex].y).toBeCloseTo(target.y, 1);
    }
  });

  it('never jerks: the sprung scale changes less per frame than the raw ease at the zoom-in launch', () => {
    const times = timeSeries(1000 / 60, 3000);
    const exported = runExportLoop(times);
    const targets = times.map((t) => resolveZoomCameraTarget(regions, t, geometry).transform);
    const launch = times.findIndex((t) => targets[times.indexOf(t)].scale > 1);
    const rawStep = targets[launch + 1].scale - targets[launch].scale;
    const sprungStep = exported[launch + 1].scale - exported[launch].scale;
    expect(rawStep).toBeGreaterThan(0);
    expect(sprungStep).toBeGreaterThan(0);
    expect(sprungStep).toBeLessThan(rawStep);
  });

  it('a paused preview shows the eased target, export the sprung value, and they agree once settled', () => {
    const times = timeSeries(1000 / 60, 3400);
    const pausedAt = 3400;
    const preview = runPreviewLoop(times, (t) => t < pausedAt);
    const exported = runExportLoop(times);
    const last = times.length - 1;
    expect(preview[last]).toEqual(resolveZoomCameraTarget(regions, times[last], geometry).transform);
    expect(exported[last].scale).toBeCloseTo(preview[last].scale, 2);
  });
});

describe('measureZoomMotionIntensity', () => {
  it('normalises translation by the stage size and takes the largest axis', () => {
    expect(measureZoomMotionIntensity({ scale: 1, x: 0, y: 0 }, { scale: 1.02, x: 64, y: 0 }, geometry.stageSize))
      .toBeCloseTo(0.05, 6);
    expect(measureZoomMotionIntensity({ scale: 1, x: 0, y: 0 }, { scale: 1, x: 0, y: 72 }, geometry.stageSize))
      .toBeCloseTo(0.1, 6);
  });
});
