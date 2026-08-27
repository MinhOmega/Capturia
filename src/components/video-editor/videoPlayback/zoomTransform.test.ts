import { describe, expect, it } from 'vitest';
import type { Container } from 'pixi.js';
import {
  applyZoomTransform,
  computeFocusFromTransform,
  computeZoomTransform,
  createMotionBlurState,
  getMotionBlurAmountResponse,
  type MotionBlurFilterLike,
  resetMotionBlurState,
  stepMotionBlur,
} from './zoomTransform';

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

describe('getMotionBlurAmountResponse', () => {
  it('is 0 at the bottom of the slider and boosted (2.2x) at the top', () => {
    expect(getMotionBlurAmountResponse(0)).toBe(0);
    expect(getMotionBlurAmountResponse(1)).toBeCloseTo(2.2, 9);
  });

  it('is monotonic and clamps out-of-range / non-finite input', () => {
    let previous = -1;
    for (let amount = 0; amount <= 1.0001; amount += 0.05) {
      const response = getMotionBlurAmountResponse(amount);
      expect(response).toBeGreaterThanOrEqual(previous);
      previous = response;
    }
    expect(getMotionBlurAmountResponse(-3)).toBe(0);
    expect(getMotionBlurAmountResponse(7)).toBeCloseTo(2.2, 9);
    expect(getMotionBlurAmountResponse(Number.NaN)).toBe(0);
  });
});

describe('stepMotionBlur', () => {
  const still = { scale: 1, x: 0, y: 0 };

  it('primes the state on the first frame without blurring', () => {
    const state = createMotionBlurState();
    const sample = stepMotionBlur(state, { scale: 1.5, x: -40, y: -20 }, stageSize, 1, 1000);
    expect(sample.blurPx).toBe(0);
    expect(sample.velocity).toEqual({ x: 0, y: 0 });
    expect(state.initialized).toBe(true);
    expect(state.prevCamX).toBe(-40);
    expect(state.lastFrameTimeMs).toBe(1000);
  });

  it('blurs along the direction of camera travel and stays idle below the speed threshold', () => {
    const state = createMotionBlurState();
    stepMotionBlur(state, still, stageSize, 1, 0);
    // 20 stage px in 16 ms -> 1250 px/s (stage is 900 px tall, ~1500 ref px/s).
    const moving = stepMotionBlur(state, { scale: 1, x: 20, y: 0 }, stageSize, 1, 16);
    expect(moving.blurPx).toBeGreaterThan(0);
    expect(moving.velocity.x).toBeGreaterThan(0);
    expect(moving.velocity.y).toBe(0);
    expect(moving.kernelSize).toBeGreaterThanOrEqual(7);
    expect(moving.kernelSize % 2).toBe(1);

    // 0.05 px in 16 ms is ~3 px/s, below VELOCITY_THRESHOLD_PPS.
    const crawling = stepMotionBlur(state, { scale: 1, x: 20.05, y: 0 }, stageSize, 1, 32);
    expect(crawling.blurPx).toBe(0);
    expect(crawling.velocity).toEqual({ x: 0, y: 0 });
    expect(crawling.kernelSize).toBe(5);
  });

  it('scales with the slider amount and is off at 0', () => {
    const run = (amount: number) => {
      const state = createMotionBlurState();
      stepMotionBlur(state, still, stageSize, amount, 0);
      return stepMotionBlur(state, { scale: 1, x: 12, y: 9 }, stageSize, amount, 16).blurPx;
    };
    expect(run(0)).toBe(0);
    expect(run(0.35)).toBeGreaterThan(0);
    expect(run(1)).toBeGreaterThan(run(0.35));
  });

  it('blurs the same fraction of the frame in preview and export for one camera path', () => {
    // The same normalised pan (2 % of the stage width per 16 ms) on a small
    // preview canvas and a full-resolution export stage.
    const preview = { width: 960, height: 540 };
    const exportStage = { width: 3840, height: 2160 };
    const pan = (stage: { width: number; height: number }) => {
      const state = createMotionBlurState();
      stepMotionBlur(state, still, stage, 0.5, 0);
      const sample = stepMotionBlur(state, { scale: 1, x: stage.width * 0.02, y: 0 }, stage, 0.5, 16);
      return sample.blurPx / stage.height;
    };
    expect(pan(preview)).toBeGreaterThan(0);
    expect(pan(exportStage)).toBeCloseTo(pan(preview), 9);
  });

  it('clamps the frame delta so a stalled clock does not produce a huge velocity', () => {
    const state = createMotionBlurState();
    stepMotionBlur(state, still, stageSize, 1, 0);
    const longGap = stepMotionBlur(state, { scale: 1, x: 200, y: 0 }, stageSize, 1, 5000);
    const state2 = createMotionBlurState();
    stepMotionBlur(state2, still, stageSize, 1, 0);
    const shortGap = stepMotionBlur(state2, { scale: 1, x: 200, y: 0 }, stageSize, 1, 80);
    // dt is clamped to 80 ms, so the two produce the same blur.
    expect(longGap.blurPx).toBeCloseTo(shortGap.blurPx, 9);
  });

  it('resets so the next frame primes again instead of measuring across a seek', () => {
    const state = createMotionBlurState();
    stepMotionBlur(state, still, stageSize, 1, 0);
    resetMotionBlurState(state);
    expect(state.initialized).toBe(false);
    const sample = stepMotionBlur(state, { scale: 1, x: 500, y: 500 }, stageSize, 1, 16);
    expect(sample.blurPx).toBe(0);
  });
});

describe('applyZoomTransform motion blur', () => {
  function makeContainer() {
    const state = { scale: 1, x: 0, y: 0 };
    return {
      state,
      container: {
        scale: { set: (value: number) => { state.scale = value; } },
        position: { set: (x: number, y: number) => { state.x = x; state.y = y; } },
      } as unknown as Container,
    };
  }
  function makeFilter(): MotionBlurFilterLike {
    return { velocity: { x: 0, y: 0 }, kernelSize: 5, offset: 0 };
  }
  const base = { stageSize, baseMask, zoomScale: 1, focusX: 0.5, focusY: 0.5 };

  it('drives the filter from consecutive frames while playing', () => {
    const { container } = makeContainer();
    const filter = makeFilter();
    const motionBlurState = createMotionBlurState();
    const common = { ...base, cameraContainer: container, motionBlurFilter: filter, motionBlurState, isPlaying: true, motionBlurAmount: 1 };
    applyZoomTransform({ ...common, transformOverride: { scale: 1, x: 0, y: 0 }, frameTimeMs: 0 });
    applyZoomTransform({ ...common, transformOverride: { scale: 1, x: 0, y: 30 }, frameTimeMs: 16 });
    expect(filter.velocity.y).toBeGreaterThan(0);
    expect(filter.velocity.x).toBe(0);
    expect(filter.kernelSize).toBeGreaterThanOrEqual(7);
  });

  it('zeroes the filter and resets the state when not playing or at amount 0', () => {
    const { container, state } = makeContainer();
    const filter = makeFilter();
    const motionBlurState = createMotionBlurState();
    const common = { ...base, cameraContainer: container, motionBlurFilter: filter, motionBlurState };
    applyZoomTransform({ ...common, isPlaying: true, motionBlurAmount: 1, transformOverride: { scale: 1, x: 0, y: 0 }, frameTimeMs: 0 });
    applyZoomTransform({ ...common, isPlaying: true, motionBlurAmount: 1, transformOverride: { scale: 1, x: 40, y: 0 }, frameTimeMs: 16 });
    expect(filter.velocity.x).toBeGreaterThan(0);

    applyZoomTransform({ ...common, isPlaying: false, motionBlurAmount: 1, transformOverride: { scale: 1, x: 80, y: 0 }, frameTimeMs: 32 });
    expect(filter.velocity).toEqual({ x: 0, y: 0 });
    expect(filter.kernelSize).toBe(5);
    expect(motionBlurState.initialized).toBe(false);
    // The camera transform is still applied.
    expect(state.x).toBe(80);

    applyZoomTransform({ ...common, isPlaying: true, motionBlurAmount: 0, transformOverride: { scale: 1, x: 120, y: 0 }, frameTimeMs: 48 });
    applyZoomTransform({ ...common, isPlaying: true, motionBlurAmount: 0, transformOverride: { scale: 1, x: 160, y: 0 }, frameTimeMs: 64 });
    expect(filter.velocity).toEqual({ x: 0, y: 0 });
  });
});
