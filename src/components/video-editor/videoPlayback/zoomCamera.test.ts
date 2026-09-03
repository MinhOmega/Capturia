import { beforeEach, describe, expect, it } from 'vitest'
import type { CursorTrack } from '@/lib/cursor/types'
import type { ZoomRegion } from '../types'
import { DEFAULT_ROTATION_3D, ROTATION_3D_PRESETS, ZOOM_DEPTH_SCALES } from '../types'
import { ZOOM_IN_OVERLAP_MS, ZOOM_SPRING_MAX_STEP_MS } from './constants'
import { buildCursorTelemetry, type CursorTelemetryPoint } from './cursorFollowUtils'
import {
  advanceZoomCamera,
  createZoomCameraState,
  measureZoomMotionIntensity,
  resolveZoomCameraTarget,
  stepZoomCamera,
  type ZoomCameraGeometry,
} from './zoomCamera'
import { resetDominantRegionCache } from './zoomRegionUtils'
import { computeZoomTransform, type ZoomTransform } from './zoomTransform'

const geometry: ZoomCameraGeometry = {
  stageSize: { width: 1280, height: 720 },
  baseMask: { x: 64, y: 36, width: 1152, height: 648 },
}

// Two connected regions (gap 1200 ms) followed by a lone one.
const regions: ZoomRegion[] = [
  { id: 'a', startMs: 1500, endMs: 4000, depth: 2, focus: { cx: 0.3, cy: 0.4 } },
  { id: 'b', startMs: 5200, endMs: 8000, depth: 4, focus: { cx: 0.7, cy: 0.6 }, customScale: 2.35 },
  { id: 'c', startMs: 11_000, endMs: 13_000, depth: 3, focus: { cx: 0.5, cy: 0.5 } },
]

function timeSeries(stepMs: number, endMs: number) {
  const times: number[] = []
  for (let t = 0; t <= endMs; t += stepMs) times.push(t)
  return times
}

/** The preview ticker: snaps unless actively playing. */
function runPreviewLoop(times: number[], isPlaying: (t: number) => boolean) {
  const state = createZoomCameraState()
  return times.map((t) => {
    const target = resolveZoomCameraTarget(regions, t, geometry)
    return advanceZoomCamera(state, target.transform, t, isPlaying(t))
  })
}

/** frameRenderer.updateAnimationState: always animating, stepped by content dt. */
function runExportLoop(times: number[]) {
  const state = createZoomCameraState()
  return times.map((t) => {
    const target = resolveZoomCameraTarget(regions, t, geometry)
    return advanceZoomCamera(state, target.transform, t, true)
  })
}

beforeEach(() => {
  resetDominantRegionCache()
})

describe('resolveZoomCameraTarget', () => {
  it('is unzoomed outside every region and when forced', () => {
    const idle = resolveZoomCameraTarget(regions, 0, geometry)
    expect(idle.progress).toBe(0)
    expect(idle.scale).toBe(1)
    expect(idle.transform).toEqual({ scale: 1, x: 0, y: 0 })
    const forced = resolveZoomCameraTarget(regions, 2500, geometry, { forceUnzoomed: true })
    expect(forced.transform).toEqual({ scale: 1, x: 0, y: 0 })
  })

  it('uses the customScale-aware scale and the clamped focus at full zoom', () => {
    const target = resolveZoomCameraTarget(regions, 7000, geometry)
    expect(target.scale).toBe(2.35)
    expect(target.progress).toBe(1)
    const expected = computeZoomTransform({
      ...geometry,
      zoomScale: 2.35,
      focusX: target.focus.cx,
      focusY: target.focus.cy,
    })
    expect(target.transform).toEqual(expected)
  })

  it('pans in transform space during a connected transition', () => {
    const start = resolveZoomCameraTarget(regions, 4000, geometry).transform
    const mid = resolveZoomCameraTarget(regions, 4500, geometry).transform
    const end = resolveZoomCameraTarget(regions, 5000, geometry).transform
    expect(start.scale).toBeCloseTo(ZOOM_DEPTH_SCALES[2], 6)
    expect(end.scale).toBeCloseTo(2.35, 6)
    // Mid-pan lies on the straight segment between the two transforms.
    const u = (mid.scale - start.scale) / (end.scale - start.scale)
    expect(u).toBeGreaterThan(0)
    expect(u).toBeLessThan(1)
    expect(mid.x).toBeCloseTo(start.x + (end.x - start.x) * u, 6)
    expect(mid.y).toBeCloseTo(start.y + (end.y - start.y) * u, 6)
  })
})

describe('advanceZoomCamera', () => {
  it('snaps on the first frame, when not animating, on backwards time and on big jumps', () => {
    const state = createZoomCameraState()
    const t1: ZoomTransform = { scale: 2, x: -300, y: -200 }
    expect(advanceZoomCamera(state, t1, 1000, true)).toEqual(t1) // first frame
    const t2: ZoomTransform = { scale: 1.5, x: -100, y: -50 }
    expect(advanceZoomCamera(state, t2, 1016, false)).toEqual(t2) // paused / seeking
    const t3: ZoomTransform = { scale: 1.2, x: -40, y: -20 }
    expect(advanceZoomCamera(state, t3, 900, true)).toEqual(t3) // backwards
    const t4: ZoomTransform = { scale: 3, x: -800, y: -400 }
    expect(advanceZoomCamera(state, t4, 900 + ZOOM_SPRING_MAX_STEP_MS + 1, true)).toEqual(t4) // jump
    // A normal step glides instead.
    const sprung = advanceZoomCamera(
      state,
      { scale: 1, x: 0, y: 0 },
      900 + ZOOM_SPRING_MAX_STEP_MS + 1 + 16,
      true,
    )
    expect(sprung.scale).toBeGreaterThan(1)
    expect(sprung.scale).toBeLessThan(3)
    expect(state.applied).toEqual(sprung)
  })
})

describe('preview / export parity', () => {
  it('produces identical transforms for the same content-time series while playing', () => {
    const times = timeSeries(1000 / 60, 14_000)
    const preview = runPreviewLoop(times, () => true)
    const exported = runExportLoop(times)
    expect(preview).toEqual(exported)
  })

  it('holds at the exact target once a region has settled, at 30 and 60 fps alike', () => {
    for (const fps of [30, 60]) {
      const times = timeSeries(1000 / fps, 8000)
      const exported = runExportLoop(times)
      const settleIndex = times.findIndex(
        (t) => t >= regions[0].startMs + ZOOM_IN_OVERLAP_MS + 1500,
      )
      const target = resolveZoomCameraTarget(regions, times[settleIndex], geometry).transform
      expect(exported[settleIndex].scale).toBeCloseTo(target.scale, 3)
      expect(exported[settleIndex].x).toBeCloseTo(target.x, 1)
      expect(exported[settleIndex].y).toBeCloseTo(target.y, 1)
    }
  })

  it('never jerks: the sprung scale changes less per frame than the raw ease at the zoom-in launch', () => {
    const times = timeSeries(1000 / 60, 3000)
    const exported = runExportLoop(times)
    const targets = times.map((t) => resolveZoomCameraTarget(regions, t, geometry).transform)
    const launch = times.findIndex((t) => targets[times.indexOf(t)].scale > 1)
    const rawStep = targets[launch + 1].scale - targets[launch].scale
    const sprungStep = exported[launch + 1].scale - exported[launch].scale
    expect(rawStep).toBeGreaterThan(0)
    expect(sprungStep).toBeGreaterThan(0)
    expect(sprungStep).toBeLessThan(rawStep)
  })

  it('a paused preview shows the eased target, export the sprung value, and they agree once settled', () => {
    const times = timeSeries(1000 / 60, 3400)
    const pausedAt = 3400
    const preview = runPreviewLoop(times, (t) => t < pausedAt)
    const exported = runExportLoop(times)
    const last = times.length - 1
    expect(preview[last]).toEqual(resolveZoomCameraTarget(regions, times[last], geometry).transform)
    expect(exported[last].scale).toBeCloseTo(preview[last].scale, 2)
  })
})

describe('auto-follow focus (focusMode "auto") preview / export parity', () => {
  // Synthetic cursor: parks left, then sweeps right across the auto region,
  // with a hidden span in the middle of the sweep.
  const track: CursorTrack = {
    samples: [
      { timeMs: 0, x: 0.3, y: 0.45 },
      { timeMs: 2500, x: 0.3, y: 0.45 },
      { timeMs: 3000, x: 0.35, y: 0.5, visible: false },
      { timeMs: 3500, x: 0.7, y: 0.6 },
      { timeMs: 6000, x: 0.7, y: 0.6 },
    ],
  }
  const telemetry = buildCursorTelemetry(track)
  const autoRegions: ZoomRegion[] = [
    {
      id: 'auto',
      startMs: 1500,
      endMs: 5000,
      depth: 3,
      focus: { cx: 0.5, cy: 0.5 },
      focusMode: 'auto',
    },
    { id: 'manual', startMs: 8000, endMs: 9000, depth: 3, focus: { cx: 0.6, cy: 0.4 } },
  ]

  function runLoop(
    times: number[],
    isPlaying: (t: number) => boolean,
    cursorTelemetry?: CursorTelemetryPoint[],
  ) {
    const state = createZoomCameraState()
    return times.map((t) =>
      stepZoomCamera(state, autoRegions, t, geometry, { animating: isPlaying(t), cursorTelemetry }),
    )
  }

  it('produces identical transforms and focus in the preview and export loops while playing', () => {
    const times = timeSeries(1000 / 60, 10_000)
    const preview = runLoop(times, () => true, telemetry)
    const exported = runLoop(times, () => true, telemetry)
    expect(preview.map((s) => s.applied)).toEqual(exported.map((s) => s.applied))
    expect(preview.map((s) => s.target.focus)).toEqual(exported.map((s) => s.target.focus))
  })

  it('follows the cursor at full zoom: lags behind the raw cursor during the sweep, settles on it after', () => {
    const times = timeSeries(1000 / 60, 6000)
    const steps = runLoop(times, () => true, telemetry)
    const at = (ms: number) => steps[times.findIndex((t) => t >= ms)]
    const rawAt = (ms: number) =>
      resolveZoomCameraTarget(autoRegions, ms, geometry, { cursorTelemetry: telemetry }).focus
    // Mid-sweep the smoothed focus trails the raw cursor.
    const mid = at(3300)
    expect(mid.target.focusMode).toBe('auto')
    expect(mid.target.focus.cx).toBeGreaterThan(rawAt(2500).cx)
    expect(mid.target.focus.cx).toBeLessThan(rawAt(3300).cx)
    // Well after the sweep it has converged on the parked cursor.
    const settled = at(4800)
    expect(settled.target.focus.cx).toBeCloseTo(rawAt(4800).cx, 3)
    expect(settled.target.focus.cy).toBeCloseTo(rawAt(4800).cy, 3)
  })

  it('converges at the same content time at 30 and 60 fps (frame-rate independent)', () => {
    const at30 = runLoop(timeSeries(1000 / 30, 4000), () => true, telemetry)
    const at60 = runLoop(timeSeries(1000 / 60, 4000), () => true, telemetry)
    // 4000 ms is a sample of both series (index 120 and 240).
    const f30 = at30[at30.length - 1].target.focus
    const f60 = at60[at60.length - 1].target.focus
    expect(Math.hypot(f30.cx - f60.cx, f30.cy - f60.cy)).toBeLessThan(0.005)
  })

  it('snaps to the raw cursor focus when the preview is not playing, and export never snaps', () => {
    const times = timeSeries(1000 / 60, 3400)
    const paused = runLoop(times, (t) => t < 3300, telemetry)
    const last = times.length - 1
    const raw = resolveZoomCameraTarget(autoRegions, times[last], geometry, {
      cursorTelemetry: telemetry,
    })
    expect(paused[last].target.focus).toEqual(raw.focus)
    expect(paused[last].applied).toEqual(raw.transform)
    const exported = runLoop(times, () => true, telemetry)
    expect(exported[last].target.focus.cx).toBeLessThan(raw.focus.cx)
  })

  it('behaves as a manual region without telemetry, and resets the smoothed focus on a manual region', () => {
    const times = timeSeries(1000 / 60, 9000)
    const state = createZoomCameraState()
    for (const t of times) {
      const step = stepZoomCamera(state, autoRegions, t, geometry, { animating: true })
      if (t > 2500 && t < 5000) {
        expect(step.target.focus).toEqual(resolveZoomCameraTarget(autoRegions, t, geometry).focus)
      }
    }
    expect(state.smoothedAutoFocus).toBeNull()
  })
})

describe('measureZoomMotionIntensity', () => {
  it('normalises translation by the stage size and takes the largest axis', () => {
    expect(
      measureZoomMotionIntensity(
        { scale: 1, x: 0, y: 0 },
        { scale: 1.02, x: 64, y: 0 },
        geometry.stageSize,
      ),
    ).toBeCloseTo(0.05, 6)
    expect(
      measureZoomMotionIntensity(
        { scale: 1, x: 0, y: 0 },
        { scale: 1, x: 0, y: 72 },
        geometry.stageSize,
      ),
    ).toBeCloseTo(0.1, 6)
  })
})

describe('resolveZoomCameraTarget - 3D tilt ramps with the eased zoom progress (B1-e)', () => {
  const tilted: ZoomRegion[] = [
    {
      id: 'iso',
      startMs: 1500,
      endMs: 4000,
      depth: 2,
      focus: { cx: 0.3, cy: 0.4 },
      rotationPreset: 'iso',
    },
    {
      id: 'left',
      startMs: 5200,
      endMs: 8000,
      depth: 4,
      focus: { cx: 0.7, cy: 0.6 },
      rotationPreset: 'left',
    },
  ]

  it('is identity when unzoomed, when forced unzoomed and for regions without a preset', () => {
    expect(resolveZoomCameraTarget(tilted, 0, geometry).rotation3D).toEqual(DEFAULT_ROTATION_3D)
    expect(
      resolveZoomCameraTarget(tilted, 2500, geometry, { forceUnzoomed: true }).rotation3D,
    ).toEqual(DEFAULT_ROTATION_3D)
    expect(resolveZoomCameraTarget(regions, 2500, geometry).rotation3D).toEqual(DEFAULT_ROTATION_3D)
  })

  it('holds the full preset on the plateau and scales it by progress on the ramp', () => {
    const plateau = resolveZoomCameraTarget(tilted, 2500, geometry)
    expect(plateau.progress).toBe(1)
    expect(plateau.rotation3D).toEqual(ROTATION_3D_PRESETS.iso)

    const ramp = resolveZoomCameraTarget(tilted, 1500 - 400, geometry)
    expect(ramp.progress).toBeGreaterThan(0)
    expect(ramp.progress).toBeLessThan(1)
    expect(ramp.rotation3D.rotationX).toBeCloseTo(
      ROTATION_3D_PRESETS.iso.rotationX * ramp.progress,
      9,
    )
    expect(ramp.rotation3D.rotationY).toBeCloseTo(
      ROTATION_3D_PRESETS.iso.rotationY * ramp.progress,
      9,
    )

    const rampOut = resolveZoomCameraTarget([tilted[0]], 4000 + 500, geometry)
    expect(rampOut.progress).toBeGreaterThan(0)
    expect(rampOut.progress).toBeLessThan(1)
    expect(rampOut.rotation3D.rotationY).toBeCloseTo(
      ROTATION_3D_PRESETS.iso.rotationY * rampOut.progress,
      9,
    )
  })

  it('pans the tilt between two presets during a connected transition', () => {
    const mid = resolveZoomCameraTarget(tilted, 4500, geometry)
    expect(mid.transition).toBe(true)
    expect(mid.progress).toBe(1)
    expect(mid.rotation3D.rotationX).toBeGreaterThan(-10)
    expect(mid.rotation3D.rotationX).toBeLessThan(0)
    expect(mid.rotation3D.rotationY).toBeGreaterThan(-22)
    expect(mid.rotation3D.rotationY).toBeLessThan(-16)
  })

  it('survives the full step (auto-follow focus rewrite keeps the rotation)', () => {
    const state = createZoomCameraState()
    const { target } = stepZoomCamera(state, tilted, 2500, geometry, { animating: true })
    expect(target.rotation3D).toEqual(ROTATION_3D_PRESETS.iso)
  })
})
