import { describe, expect, it } from 'vitest';
import { DEFAULT_CURSOR_STYLE, type CursorTrack } from './types';
import {
  CURSOR_REFERENCE_WIDTH,
  createCursorMotionBlurState,
  drawCompositedCursor,
  getCursorMotionBlurPx,
  normalizePointerSample,
  projectCursorToViewport,
  resetCursorMotionBlurState,
  resolveCursorClipRect,
  resolveCursorContentScale,
  resolveCursorSizeNorm,
  resolveCursorState,
} from './cursorComposer';

interface RecordedContext {
  ctx: CanvasRenderingContext2D;
  scaleCalls: Array<{ x: number; y: number }>;
  arcCalls: Array<{ x: number; y: number; radius: number }>;
  translateCalls: Array<{ x: number; y: number }>;
  gradientRadii: number[];
}

function createRecordingContext(): RecordedContext {
  const scaleCalls: Array<{ x: number; y: number }> = [];
  const arcCalls: Array<{ x: number; y: number; radius: number }> = [];
  const translateCalls: Array<{ x: number; y: number }> = [];
  const gradientRadii: number[] = [];
  const noop = () => undefined;
  // Style properties are plain writable fields; only the calls we assert on are recorded.
  const ctx = {
    save: noop,
    restore: noop,
    translate: (x: number, y: number) => {
      translateCalls.push({ x, y });
    },
    scale: (x: number, y: number) => {
      scaleCalls.push({ x, y });
    },
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    arc: (x: number, y: number, radius: number) => {
      arcCalls.push({ x, y, radius });
    },
    createRadialGradient: (_x0: number, _y0: number, _r0: number, _x1: number, _y1: number, r1: number) => {
      gradientRadii.push(r1);
      return { addColorStop: noop };
    },
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    filter: 'none',
  } as unknown as CanvasRenderingContext2D;

  return { ctx, scaleCalls, arcCalls, translateCalls, gradientRadii };
}

describe('cursor size normalisation', () => {
  it('normalises the cursor by the displayed full-video width', () => {
    expect(resolveCursorSizeNorm({ maskRect: { width: CURSOR_REFERENCE_WIDTH } })).toBeCloseTo(1, 6);
    expect(resolveCursorSizeNorm({ maskRect: { width: 3840 } })).toBeCloseTo(2, 6);
    expect(resolveCursorSizeNorm({ maskRect: { width: 960 } })).toBeCloseTo(0.5, 6);
  });

  it('is crop invariant: cropping enlarges the cursor together with the content', () => {
    const full = resolveCursorSizeNorm({ maskRect: { width: 1920 }, cropRegion: { width: 1 } });
    const halfCrop = resolveCursorSizeNorm({ maskRect: { width: 960 }, cropRegion: { width: 0.5 } });
    expect(halfCrop).toBeCloseTo(full, 6);
  });

  it('multiplies camera zoom into the content scale', () => {
    const scale = resolveCursorContentScale({
      cameraScale: { x: 2, y: 2 },
      maskRect: { width: 3840 },
      cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    });
    expect(scale).toBeCloseTo(4, 6);
  });

  it('draws glyph, highlight and ripple proportionally to the canvas width', () => {
    const state = {
      visible: true,
      x: 0.5,
      y: 0.5,
      scale: 2.2,
      highlightAlpha: 0.5,
      rippleScale: 1.6,
      rippleAlpha: 0.4,
      cursorKind: 'arrow' as const,
    };
    const style = { ...DEFAULT_CURSOR_STYLE, shadow: 0 };
    const cameraScale = { x: 1.3, y: 1.3 };
    const cropRegion = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

    const render = (canvasWidth: number) => {
      const recorded = createRecordingContext();
      drawCompositedCursor(
        recorded.ctx,
        { x: canvasWidth / 2, y: canvasWidth / 4 },
        state,
        style,
        resolveCursorContentScale({ cameraScale, maskRect: { width: canvasWidth * 0.8 }, cropRegion }),
      );
      return recorded;
    };

    const hd = render(1920);
    const uhd = render(3840);

    // Glyph scale (the ctx.scale call that precedes drawing the glyph).
    expect(uhd.scaleCalls[0].x / hd.scaleCalls[0].x).toBeCloseTo(2, 6);
    expect(uhd.scaleCalls[0].y / hd.scaleCalls[0].y).toBeCloseTo(2, 6);
    // Ripple radius, then highlight radius (both drawn with ctx.arc).
    expect(hd.arcCalls).toHaveLength(2);
    expect(uhd.arcCalls).toHaveLength(2);
    expect(uhd.arcCalls[0].radius / hd.arcCalls[0].radius).toBeCloseTo(2, 6);
    expect(uhd.arcCalls[1].radius / hd.arcCalls[1].radius).toBeCloseTo(2, 6);
    expect(uhd.gradientRadii[0] / hd.gradientRadii[0]).toBeCloseTo(2, 6);
    // At the reference width the glyph is `28 * size * camera` px.
    expect(hd.scaleCalls[0].x).toBeCloseTo(2.2 * 1.3, 6);
  });
});

describe('cursor clip to bounds', () => {
  const VISIBLE_STATE = {
    visible: true,
    x: 0.5,
    y: 0.5,
    scale: 1,
    highlightAlpha: 0,
    rippleScale: 1,
    rippleAlpha: 0,
    cursorKind: 'arrow' as const,
  };

  it('returns null when clipping is disabled (default) or the mask is empty', () => {
    const base = {
      maskRect: { x: 100, y: 50, width: 800, height: 400 },
      maskBorderRadius: 24,
      cameraScale: { x: 1, y: 1 },
      cameraPosition: { x: 0, y: 0 },
    };
    expect(resolveCursorClipRect({ ...base, style: DEFAULT_CURSOR_STYLE })).toBeNull();
    expect(resolveCursorClipRect({ ...base, style: { clipToBounds: false } })).toBeNull();
    expect(
      resolveCursorClipRect({
        ...base,
        style: { clipToBounds: true },
        maskRect: { x: 0, y: 0, width: 0, height: 0 },
      }),
    ).toBeNull();
  });

  it('applies the camera transform to the mask rect and scales the radius', () => {
    const rect = resolveCursorClipRect({
      style: { clipToBounds: true },
      maskRect: { x: 100, y: 50, width: 800, height: 400 },
      maskBorderRadius: 24,
      cameraScale: { x: 1.5, y: 1.5 },
      cameraPosition: { x: -200, y: -100 },
    });

    expect(rect).toEqual({
      x: -200 + 1.5 * 100,
      y: -100 + 1.5 * 50,
      width: 1200,
      height: 600,
      radius: 36,
    });
  });

  it('is a pure function of the mask so preview and export produce the same clip rect', () => {
    const args = {
      style: { clipToBounds: true },
      maskRect: { x: 120, y: 60, width: 1680, height: 960 },
      maskBorderRadius: 16,
      cameraScale: { x: 2, y: 2 },
      cameraPosition: { x: -900, y: -500 },
    };
    expect(resolveCursorClipRect(args)).toEqual(resolveCursorClipRect({ ...args }));
  });

  it('clips the drawing context only when a clip rect is provided', () => {
    const clipCalls: number[] = [];
    const arcToCalls: number[] = [];
    const recorded = createRecordingContext();
    const ctx = recorded.ctx as unknown as { clip: () => void; arcTo: () => void };
    ctx.clip = () => {
      clipCalls.push(1);
    };
    ctx.arcTo = () => {
      arcToCalls.push(1);
    };

    drawCompositedCursor(recorded.ctx, { x: 10, y: 10 }, VISIBLE_STATE, { ...DEFAULT_CURSOR_STYLE, shadow: 0 }, 1);
    expect(clipCalls).toHaveLength(0);

    drawCompositedCursor(recorded.ctx, { x: 10, y: 10 }, VISIBLE_STATE, { ...DEFAULT_CURSOR_STYLE, shadow: 0 }, 1, {
      clipRect: { x: 0, y: 0, width: 200, height: 100, radius: 12 },
    });
    expect(clipCalls).toHaveLength(1);
    expect(arcToCalls).toHaveLength(4);
  });
});

describe('cursor motion blur', () => {
  it('snaps (no blur) on the first sample, when blur is off, and when time does not advance', () => {
    const state = createCursorMotionBlurState();
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state, timeMs: 0 })).toBe(0);
    // Same time again (paused re-render) snaps.
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 500, y: 0 }, state, timeMs: 0 })).toBe(0);
    // Backwards time (scrub/seek) snaps.
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 900, y: 0 }, state, timeMs: -16 })).toBe(0);
    // Blur disabled never blurs, even on fast moves.
    const off = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 0, point: { x: 0, y: 0 }, state: off, timeMs: 0 });
    expect(getCursorMotionBlurPx({ motionBlur: 0, point: { x: 900, y: 0 }, state: off, timeMs: 16 })).toBe(0);
  });

  it('scales with speed, is frame-rate independent and clamps at 6 px', () => {
    // 100 px in 16 ms = 6250 px/s -> 6250 * 0.5 * 0.004 = 12.5 -> clamped to 6.
    const fast = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 0.5, point: { x: 0, y: 0 }, state: fast, timeMs: 0 });
    expect(getCursorMotionBlurPx({ motionBlur: 0.5, point: { x: 100, y: 0 }, state: fast, timeMs: 16 })).toBe(6);

    // 8 px in 16 ms = 500 px/s -> 500 * 1 * 0.004 = 2 px.
    const slow60 = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state: slow60, timeMs: 0 });
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 8, y: 0 }, state: slow60, timeMs: 16 })).toBeCloseTo(2, 6);

    // Same speed sampled at 30 fps (16 px in 32 ms) gives the same blur.
    const slow30 = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state: slow30, timeMs: 0 });
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 16, y: 0 }, state: slow30, timeMs: 32 })).toBeCloseTo(2, 6);

    // Static cursor: no blur.
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 16, y: 0 }, state: slow30, timeMs: 48 })).toBe(0);
  });

  it('produces the same blur relative to the frame for preview and export sizes', () => {
    // The same content-space move rendered on a 960 px preview (sizeNorm 0.5)
    // and a 3840 px export (sizeNorm 2): blur px scales with the canvas.
    const preview = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state: preview, timeMs: 0, sizeNorm: 0.5 });
    const previewPx = getCursorMotionBlurPx({ motionBlur: 1, point: { x: 4, y: 0 }, state: preview, timeMs: 16, sizeNorm: 0.5 });

    const exportState = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state: exportState, timeMs: 0, sizeNorm: 2 });
    const exportPx = getCursorMotionBlurPx({ motionBlur: 1, point: { x: 16, y: 0 }, state: exportState, timeMs: 16, sizeNorm: 2 });

    expect(previewPx).toBeGreaterThan(0);
    expect(exportPx / previewPx).toBeCloseTo(4, 6);
    expect(previewPx / 0.5).toBeCloseTo(exportPx / 2, 6);
  });

  it('resets to an uninitialised state', () => {
    const state = createCursorMotionBlurState();
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 0, y: 0 }, state, timeMs: 0 });
    getCursorMotionBlurPx({ motionBlur: 1, point: { x: 8, y: 0 }, state, timeMs: 16 });
    resetCursorMotionBlurState(state);
    expect(state).toEqual({ x: 0, y: 0, lastTimeMs: null, initialized: false });
    expect(getCursorMotionBlurPx({ motionBlur: 1, point: { x: 100, y: 0 }, state, timeMs: 32 })).toBe(0);
  });

  it('applies ctx.filter only when a blur radius is requested', () => {
    const filters: string[] = [];
    const recorded = createRecordingContext();
    Object.defineProperty(recorded.ctx, 'filter', {
      set(value: string) {
        filters.push(value);
      },
      configurable: true,
    });
    const state = {
      visible: true,
      x: 0.5,
      y: 0.5,
      scale: 1,
      highlightAlpha: 0,
      rippleScale: 1,
      rippleAlpha: 0,
      cursorKind: 'arrow' as const,
    };

    drawCompositedCursor(recorded.ctx, { x: 10, y: 10 }, state, { ...DEFAULT_CURSOR_STYLE, shadow: 0 }, 1, { motionBlurPx: 0 });
    expect(filters).toHaveLength(0);

    drawCompositedCursor(recorded.ctx, { x: 10, y: 10 }, state, { ...DEFAULT_CURSOR_STYLE, shadow: 0 }, 1, { motionBlurPx: 3.5 });
    expect(filters).toEqual(['blur(3.50px)']);
  });

  it('normalises motionBlur into the resolved style range', () => {
    expect(resolveCursorState({ timeMs: 0, style: { ...DEFAULT_CURSOR_STYLE, enabled: false, motionBlur: 4 } }).visible).toBe(false);
    expect(DEFAULT_CURSOR_STYLE.motionBlur).toBe(0);
    expect(DEFAULT_CURSOR_STYLE.clipToBounds).toBe(false);
  });
});

// Ported from upstream cursorRenderer.test.ts (mapCursorToCroppedViewport) against
// projectCursorToViewport with an identity camera: viewport = baseOffset + maskRect.
describe('projectCursorToViewport crop handling', () => {
  const FULL_CROP = { x: 0, y: 0, width: 1, height: 1 };
  const VIEWPORT = { x: 100, y: 50, width: 800, height: 400 };

  const project = (normX: number, normY: number, cropRegion = FULL_CROP) =>
    projectCursorToViewport({
      normalizedX: normX,
      normalizedY: normY,
      cropRegion,
      baseOffset: { x: VIEWPORT.x, y: VIEWPORT.y },
      maskRect: { width: VIEWPORT.width, height: VIEWPORT.height },
      cameraScale: { x: 1, y: 1 },
      cameraPosition: { x: 0, y: 0 },
      stageSize: { width: 1000, height: 500 },
    });

  it('maps positions directly onto the viewport when there is no crop', () => {
    expect(project(0.5, 0.5)).toMatchObject({ x: 500, y: 250, inViewport: true, inCrop: true });
    expect(project(0, 0)).toMatchObject({ x: 100, y: 50, inViewport: true });
    expect(project(1, 1)).toMatchObject({ x: 900, y: 450, inViewport: true });
  });

  it('re-normalizes a full-frame position into the cropped viewport', () => {
    // Crop the right-bottom half of the frame. A point at the frame centre
    // (0.5, 0.5) sits at the top-left corner of this crop.
    const crop = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    expect(project(0.5, 0.5, crop)).toMatchObject({ x: 100, y: 50, inViewport: true });
    // The centre of the crop (0.75, 0.75) maps to the viewport centre.
    expect(project(0.75, 0.75, crop)).toMatchObject({ x: 500, y: 250, inViewport: true });
  });

  it('does not drift: a point on the visible cropped content keeps its relative offset', () => {
    const crop = { x: 0.2, y: 0.1, width: 0.6, height: 0.6 };
    const normX = 0.6;
    const normY = 0.4;
    const mapped = project(normX, normY, crop);

    const expectedPx = VIEWPORT.x + ((normX - crop.x) / crop.width) * VIEWPORT.width;
    const expectedPy = VIEWPORT.y + ((normY - crop.y) / crop.height) * VIEWPORT.height;
    expect(mapped.x).toBeCloseTo(expectedPx, 6);
    expect(mapped.y).toBeCloseTo(expectedPy, 6);
    expect(mapped.inViewport).toBe(true);

    // The naive projection (full-frame coordinate straight onto the crop
    // viewport) would land somewhere else.
    const buggyPx = VIEWPORT.x + normX * VIEWPORT.width;
    expect(Math.abs(mapped.x - buggyPx)).toBeGreaterThan(1);
  });

  it('hides the cursor when the position falls outside the visible crop', () => {
    const crop = { x: 0.5, y: 0.5, width: 0.5, height: 0.5 };
    // (0.1, 0.1) is in the top-left of the frame, outside the bottom-right
    // crop, even though it projects to a point that is still on the stage.
    const outside = project(0.1, 0.1, crop);
    expect(outside.inCrop).toBe(false);
    expect(outside.inViewport).toBe(false);
    // Just past the crop edge is hidden too.
    expect(project(1.0001, 0.75, crop).inViewport).toBe(false);
    expect(project(0.75, 0.4999, crop).inViewport).toBe(false);
  });

  it('hides the cursor for a degenerate crop', () => {
    const projected = project(0.5, 0.5, { x: 0, y: 0, width: 0, height: 0 });
    expect(projected.inCrop).toBe(false);
    expect(projected.inViewport).toBe(false);
  });

  it('still hides the cursor when the camera pushes it far off the stage', () => {
    const projected = projectCursorToViewport({
      normalizedX: 1,
      normalizedY: 1,
      cropRegion: FULL_CROP,
      baseOffset: { x: VIEWPORT.x, y: VIEWPORT.y },
      maskRect: { width: VIEWPORT.width, height: VIEWPORT.height },
      cameraScale: { x: 3, y: 3 },
      cameraPosition: { x: 0, y: 0 },
      stageSize: { width: 1000, height: 500 },
    });
    expect(projected.inCrop).toBe(true);
    expect(projected.inViewport).toBe(false);
  });
});

describe('cursorComposer', () => {
  it('interpolates and smooths recorded cursor track', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.1, y: 0.1, visible: true },
        { timeMs: 100, x: 0.2, y: 0.2, visible: true },
        { timeMs: 200, x: 0.4, y: 0.4, visible: true },
      ],
    };

    const state = resolveCursorState({
      timeMs: 100,
      track,
      style: { ...DEFAULT_CURSOR_STYLE, smoothingMs: 0 },
    });

    expect(state.visible).toBe(true);
    expect(state.x).toBeCloseTo(0.2, 2);
    expect(state.y).toBeCloseTo(0.2, 2);
    expect(state.cursorKind).toBe('arrow');
  });

  it('resolves ibeam cursor kind from recorded samples', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.2, y: 0.2, visible: true, cursorKind: 'arrow' },
        { timeMs: 120, x: 0.3, y: 0.3, visible: true, cursorKind: 'ibeam' },
      ],
    };

    const state = resolveCursorState({
      timeMs: 100,
      track,
      style: { ...DEFAULT_CURSOR_STYLE, smoothingMs: 0 },
    });

    expect(state.cursorKind).toBe('ibeam');
  });

  it('returns default position when cursor track has no samples', () => {
    const state = resolveCursorState({
      timeMs: 100,
      track: { samples: [] },
      zoomRegions: [],
      fallbackFocus: { cx: 0.62, cy: 0.34 },
    });

    // Empty samples → getPreparedCursorTrack returns null → default (0.5, 0.5)
    expect(state.x).toBeCloseTo(0.5, 3);
    expect(state.y).toBeCloseTo(0.5, 3);
    expect(state.visible).toBe(false);
  });

  it('projects normalized point through crop and camera transform', () => {
    const projected = projectCursorToViewport({
      normalizedX: 0.5,
      normalizedY: 0.5,
      cropRegion: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
      baseOffset: { x: 100, y: 50 },
      maskRect: { width: 800, height: 400 },
      cameraScale: { x: 1.2, y: 1.2 },
      cameraPosition: { x: -40, y: 20 },
      stageSize: { width: 1280, height: 720 },
    });

    expect(projected.x).toBeCloseTo(560, 2);
    expect(projected.y).toBeCloseTo(320, 2);
    expect(projected.inViewport).toBe(true);
  });

  it('normalizes pointer samples to 0..1', () => {
    const sample = normalizePointerSample(16, 960, 540, 1920, 1080, true);
    expect(sample.x).toBe(0.5);
    expect(sample.y).toBe(0.5);
    expect(sample.click).toBe(true);
  });

  it('supports time offset alignment for cursor track', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.1, y: 0.1, visible: true },
        { timeMs: 100, x: 0.5, y: 0.5, visible: true },
      ],
    };

    const withoutOffset = resolveCursorState({
      timeMs: 0,
      track,
      style: { ...DEFAULT_CURSOR_STYLE, smoothingMs: 0, timeOffsetMs: 0 },
    });
    const withOffset = resolveCursorState({
      timeMs: 0,
      track,
      style: { ...DEFAULT_CURSOR_STYLE, smoothingMs: 0, timeOffsetMs: 100 },
    });

    expect(withoutOffset.x).toBeCloseTo(0.1, 3);
    expect(withOffset.x).toBeCloseTo(0.5, 3);
  });

  it('auto-hides static cursor after inactivity window', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.42, y: 0.42, visible: true },
        { timeMs: 120, x: 0.42, y: 0.42, visible: true },
      ],
    };

    const hiddenState = resolveCursorState({
      timeMs: 280,
      track,
      style: {
        ...DEFAULT_CURSOR_STYLE,
        smoothingMs: 0,
        autoHideStatic: true,
        staticHideDelayMs: 100,
        staticHideFadeMs: 120,
      },
    });

    expect(hiddenState.visible).toBe(false);
    expect(hiddenState.highlightAlpha).toBeCloseTo(0, 3);
  });

  it('keeps cursor visible when track remains active', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.1, y: 0.1, visible: true },
        { timeMs: 120, x: 0.25, y: 0.2, visible: true },
        { timeMs: 260, x: 0.4, y: 0.35, visible: true },
      ],
    };

    const state = resolveCursorState({
      timeMs: 280,
      track,
      style: {
        ...DEFAULT_CURSOR_STYLE,
        smoothingMs: 0,
        autoHideStatic: true,
        staticHideDelayMs: 180,
        staticHideFadeMs: 120,
      },
    });

    expect(state.visible).toBe(true);
    expect(state.highlightAlpha).toBeGreaterThan(0.05);
  });

  it('loops cursor back toward start near the end of the track', () => {
    const track: CursorTrack = {
      source: 'recorded',
      samples: [
        { timeMs: 0, x: 0.12, y: 0.2, visible: true, cursorKind: 'arrow' },
        { timeMs: 1000, x: 0.9, y: 0.8, visible: true, cursorKind: 'ibeam' },
      ],
    };

    const state = resolveCursorState({
      timeMs: 1000,
      track,
      style: {
        ...DEFAULT_CURSOR_STYLE,
        smoothingMs: 0,
        loopCursorPosition: true,
        loopBlendMs: 400,
      },
    });

    expect(state.x).toBeCloseTo(0.12, 3);
    expect(state.y).toBeCloseTo(0.2, 3);
    expect(state.cursorKind).toBe('arrow');
  });

  it('applies cursor offset before drawing glyph', () => {
    const translateCalls: Array<{ x: number; y: number }> = [];
    const context = {
      save: () => {},
      restore: () => {},
      translate: (x: number, y: number) => {
        translateCalls.push({ x, y });
      },
      scale: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      arc: () => {},
      set globalAlpha(_: number) {},
      set fillStyle(_: string | CanvasGradient | CanvasPattern) {},
      set strokeStyle(_: string | CanvasGradient | CanvasPattern) {},
      set lineWidth(_: number) {},
      set shadowColor(_: string) {},
      set shadowBlur(_: number) {},
      set shadowOffsetX(_: number) {},
      set shadowOffsetY(_: number) {},
    } as unknown as CanvasRenderingContext2D;

    drawCompositedCursor(
      context,
      { x: 100, y: 60 },
      {
        visible: true,
        x: 0.5,
        y: 0.5,
        scale: 1,
        highlightAlpha: 0,
        rippleScale: 1,
        rippleAlpha: 0,
        cursorKind: 'arrow',
      },
      { ...DEFAULT_CURSOR_STYLE, offsetX: 12, offsetY: -6, shadow: 0 },
    );

    expect(translateCalls[0]).toEqual({ x: 112, y: 54 });
  });

  it('scales cursor glyph with zoom content scale', () => {
    const scaleCalls: Array<{ x: number; y: number }> = [];
    const context = {
      save: () => {},
      restore: () => {},
      translate: () => {},
      scale: (x: number, y: number) => {
        scaleCalls.push({ x, y });
      },
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      arc: () => {},
      set globalAlpha(_: number) {},
      set fillStyle(_: string | CanvasGradient | CanvasPattern) {},
      set strokeStyle(_: string | CanvasGradient | CanvasPattern) {},
      set lineWidth(_: number) {},
      set shadowColor(_: string) {},
      set shadowBlur(_: number) {},
      set shadowOffsetX(_: number) {},
      set shadowOffsetY(_: number) {},
    } as unknown as CanvasRenderingContext2D;

    drawCompositedCursor(
      context,
      { x: 100, y: 60 },
      {
        visible: true,
        x: 0.5,
        y: 0.5,
        scale: 1,
        highlightAlpha: 0,
        rippleScale: 1,
        rippleAlpha: 0,
        cursorKind: 'arrow',
      },
      { ...DEFAULT_CURSOR_STYLE, shadow: 0 },
      2,
    );

    expect(scaleCalls[0]).toEqual({ x: 2, y: 2 });
  });

  it('draws ibeam glyph with center hotspot alignment', () => {
    const translateCalls: Array<{ x: number; y: number }> = [];
    const moveCalls: Array<{ x: number; y: number }> = [];
    const context = {
      save: () => {},
      restore: () => {},
      translate: (x: number, y: number) => {
        translateCalls.push({ x, y });
      },
      scale: () => {},
      beginPath: () => {},
      moveTo: (x: number, y: number) => {
        moveCalls.push({ x, y });
      },
      lineTo: () => {},
      closePath: () => {},
      fill: () => {},
      stroke: () => {},
      arc: () => {},
      set globalAlpha(_: number) {},
      set fillStyle(_: string | CanvasGradient | CanvasPattern) {},
      set strokeStyle(_: string | CanvasGradient | CanvasPattern) {},
      set lineWidth(_: number) {},
      set lineCap(_: CanvasLineCap) {},
      set lineJoin(_: CanvasLineJoin) {},
      set shadowColor(_: string) {},
      set shadowBlur(_: number) {},
      set shadowOffsetX(_: number) {},
      set shadowOffsetY(_: number) {},
    } as unknown as CanvasRenderingContext2D;

    drawCompositedCursor(
      context,
      { x: 100, y: 60 },
      {
        visible: true,
        x: 0.5,
        y: 0.5,
        scale: 1,
        highlightAlpha: 0,
        rippleScale: 1,
        rippleAlpha: 0,
        cursorKind: 'ibeam',
      },
      { ...DEFAULT_CURSOR_STYLE, shadow: 0 },
    );

    expect(translateCalls[0]).toEqual({ x: 100, y: 60 });
    expect(translateCalls[1].x).toBeCloseTo(0, 6);
    expect(translateCalls[1].y).toBeCloseTo(0, 6);
    expect(moveCalls[0]).toEqual({ x: 0, y: -10 });
  });

});
