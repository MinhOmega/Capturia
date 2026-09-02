import { beforeEach, describe, expect, it } from 'vitest'
import type { CursorTrack } from '@/lib/cursor/types'
import type { ZoomRegion } from '../types'
import { DEFAULT_ROTATION_3D, ROTATION_3D_PRESETS, ZOOM_DEPTH_SCALES } from '../types'
import { buildCursorTelemetry } from './cursorFollowUtils'
import {
  CONNECTED_ZOOM_PAN_DURATION_MS,
  TRANSITION_WINDOW_MS,
  ZOOM_IN_OVERLAP_MS,
  ZOOM_IN_TRANSITION_WINDOW_MS,
} from './constants'
import { getFocusBoundsForScale } from './focusUtils'
import {
  computeRegionStrength,
  findDominantRegion,
  getConnectedRegionPairs,
  resetDominantRegionCache,
} from './zoomRegionUtils'

function region(
  overrides: Partial<ZoomRegion> & { id: string; startMs: number; endMs: number },
): ZoomRegion {
  return { depth: 3, focus: { cx: 0.5, cy: 0.5 }, ...overrides }
}

beforeEach(() => {
  resetDominantRegionCache()
})

describe('computeRegionStrength (Screen Studio curve)', () => {
  const r = region({ id: 'a', startMs: 5000, endMs: 8000 })
  const leadInStart = r.startMs + ZOOM_IN_OVERLAP_MS - ZOOM_IN_TRANSITION_WINDOW_MS

  it('starts easing in ~1022 ms before startMs and is fully zoomed 500 ms inside the region', () => {
    expect(leadInStart).toBeCloseTo(5000 - 1022.575, 3)
    expect(computeRegionStrength(r, leadInStart - 1)).toBe(0)
    expect(computeRegionStrength(r, leadInStart + 1)).toBeGreaterThan(0)
    expect(computeRegionStrength(r, r.startMs)).toBeGreaterThan(0.9)
    expect(computeRegionStrength(r, r.startMs)).toBeLessThan(1)
    expect(computeRegionStrength(r, r.startMs + ZOOM_IN_OVERLAP_MS)).toBe(1)
  })

  it('holds at 1 until endMs, then eases out over TRANSITION_WINDOW_MS', () => {
    expect(computeRegionStrength(r, 6500)).toBe(1)
    expect(computeRegionStrength(r, r.endMs)).toBe(1)
    const mid = computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS / 2)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    expect(computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS)).toBeCloseTo(0, 6)
    expect(computeRegionStrength(r, r.endMs + TRANSITION_WINDOW_MS + 1)).toBe(0)
  })

  it('is monotonic on both ramps', () => {
    let prev = 0
    for (let t = leadInStart; t <= r.startMs + ZOOM_IN_OVERLAP_MS; t += 10) {
      const s = computeRegionStrength(r, t)
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = s
    }
    prev = 1
    for (let t = r.endMs; t <= r.endMs + TRANSITION_WINDOW_MS; t += 10) {
      const s = computeRegionStrength(r, t)
      expect(s).toBeLessThanOrEqual(prev + 1e-9)
      prev = s
    }
  })
})

describe('findDominantRegion', () => {
  it('returns the { region, strength } shape with an empty result when unzoomed', () => {
    const result = findDominantRegion([region({ id: 'a', startMs: 10_000, endMs: 12_000 })], 0)
    expect(result.region).toBeNull()
    expect(result.strength).toBe(0)
    expect(result.blendedScale).toBeNull()
    expect(result.transition).toBeNull()
  })

  it('clamps the returned focus to the bounds of the effective (custom) scale', () => {
    const r = region({
      id: 'a',
      startMs: 0,
      endMs: 5000,
      focus: { cx: 0.02, cy: 0.98 },
      customScale: 2,
    })
    const { region: active } = findDominantRegion([r], 2500)
    const bounds = getFocusBoundsForScale(2)
    expect(active?.focus).toEqual({ cx: bounds.minX, cy: bounds.maxY })
  })

  it('prefers the stronger region, and the later one on ties', () => {
    const a = region({ id: 'a', startMs: 0, endMs: 3000 })
    const b = region({ id: 'b', startMs: 2000, endMs: 6000 })
    // Both fully zoomed at 2600 (b reached 1 at 2500) -> the later one wins.
    expect(findDominantRegion([a, b], 2600).region?.id).toBe('b')
    // Well after a's lead-out only b is active.
    expect(findDominantRegion([a, b], 5000).region?.id).toBe('b')
  })

  it('memoises the last result for identical inputs (single-slot cache)', () => {
    const regions = [region({ id: 'a', startMs: 0, endMs: 5000 })]
    const first = findDominantRegion(regions, 1000.2)
    const second = findDominantRegion(regions, 1000.4) // rounds to the same ms
    expect(second).toBe(first)
    expect(findDominantRegion([...regions], 1000)).not.toBe(first) // new array ref
    expect(findDominantRegion(regions, 1000, { connectZooms: true })).not.toBe(first)
  })
})

describe('connected zoom transitions', () => {
  // a -> b gap is 1200 ms: 1000 ms pan, then a 200 ms "connected hold" on b.
  const a = region({ id: 'a', startMs: 1000, endMs: 4000, focus: { cx: 0.3, cy: 0.5 }, depth: 2 })
  const b = region({ id: 'b', startMs: 5200, endMs: 9000, focus: { cx: 0.7, cy: 0.5 }, depth: 4 })
  const far = region({ id: 'c', startMs: 12_000, endMs: 14_000 })

  it('pairs regions whose gap is at most 1500 ms', () => {
    const pairs = getConnectedRegionPairs([far, b, a])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].currentRegion.id).toBe('a')
    expect(pairs[0].nextRegion.id).toBe('b')
    expect(pairs[0].transitionStart).toBe(a.endMs)
    expect(pairs[0].transitionEnd).toBe(a.endMs + CONNECTED_ZOOM_PAN_DURATION_MS)
    expect(
      getConnectedRegionPairs([a, region({ id: 'd', startMs: 5501, endMs: 6000 })]),
    ).toHaveLength(0)
  })

  it('pans between the two regions in the gap instead of zooming out (connectZooms)', () => {
    const regions = [a, b, far]
    const mid = findDominantRegion(regions, a.endMs + 500, { connectZooms: true })
    expect(mid.strength).toBe(1)
    expect(mid.transition).not.toBeNull()
    expect(mid.transition?.startScale).toBe(ZOOM_DEPTH_SCALES[2])
    expect(mid.transition?.endScale).toBe(ZOOM_DEPTH_SCALES[4])
    expect(mid.blendedScale).toBeGreaterThan(ZOOM_DEPTH_SCALES[2])
    expect(mid.blendedScale).toBeLessThan(ZOOM_DEPTH_SCALES[4])
    expect(mid.region?.id).toBe('b')
    expect(mid.region?.focus.cx).toBeGreaterThan(0.3)
    expect(mid.region?.focus.cx).toBeLessThan(0.7)

    // Without connectZooms the same instant is a plain cross-fade (a easing
    // out while b eases in): partial strength, no pan.
    const legacy = findDominantRegion(regions, a.endMs + 500)
    expect(legacy.strength).toBeLessThan(1)
    expect(legacy.strength).toBeGreaterThan(0)
    expect(legacy.transition).toBeNull()
    expect(legacy.blendedScale).toBeNull()
  })

  it('holds the next region at full strength between the pan end and its startMs', () => {
    const hold = findDominantRegion([a, b], a.endMs + CONNECTED_ZOOM_PAN_DURATION_MS + 1, {
      connectZooms: true,
    })
    expect(hold.region?.id).toBe('b')
    expect(hold.strength).toBe(1)
    expect(hold.transition).toBeNull()
    expect(hold.blendedScale).toBeNull()
    const bounds = getFocusBoundsForScale(ZOOM_DEPTH_SCALES[4])
    expect(hold.region?.focus.cx).toBeCloseTo(Math.min(0.7, bounds.maxX), 9)
  })

  it('never dips below full strength across the whole a -> b seam', () => {
    for (let t = a.endMs - 100; t <= b.startMs + ZOOM_IN_OVERLAP_MS; t += 25) {
      expect(findDominantRegion([a, b], t, { connectZooms: true }).strength).toBe(1)
    }
  })

  it('still eases the unconnected region out normally', () => {
    const out = findDominantRegion([a, b, far], far.endMs + TRANSITION_WINDOW_MS / 2, {
      connectZooms: true,
    })
    expect(out.region?.id).toBe('c')
    expect(out.strength).toBeGreaterThan(0)
    expect(out.strength).toBeLessThan(1)
  })
})

/**
 * Ported from upstream (issue #72): an auto-focus zoom region must pan to
 * follow the cursor for its whole span, not freeze at the focus captured when
 * the region was created / suggested. Telemetry comes from Capturia's
 * CursorTrack through buildCursorTelemetry.
 */
describe('findDominantRegion - auto-follow (focusMode "auto")', () => {
  const baseRegion: ZoomRegion = {
    id: 'zoom-1',
    startMs: 0,
    endMs: 4000,
    depth: 3,
    customScale: ZOOM_DEPTH_SCALES[3],
    // Static focus captured at suggestion time (e.g. the dwell centroid); ignored
    // in favour of the live cursor once focusMode is 'auto'. Kept within the
    // depth-3 focus bounds so clamping does not distort the assertions.
    focus: { cx: 0.35, cy: 0.5 },
    focusMode: 'auto',
    source: 'auto',
  }

  // Cursor sweeps steadily from the left edge to the right edge across the region.
  const movingTrack: CursorTrack = {
    samples: [
      { timeMs: 0, x: 0.1, y: 0.5 },
      { timeMs: 1000, x: 0.3, y: 0.5, visible: false },
      { timeMs: 2000, x: 0.5, y: 0.5 },
      { timeMs: 4000, x: 0.9, y: 0.5 },
    ],
  }
  const movingTelemetry = buildCursorTelemetry(movingTrack)

  it('tracks the cursor across the region instead of freezing at the initial focus', () => {
    const early = findDominantRegion([baseRegion], 200, { cursorTelemetry: movingTelemetry })
    const mid = findDominantRegion([baseRegion], 2000, { cursorTelemetry: movingTelemetry })
    const late = findDominantRegion([baseRegion], 3800, { cursorTelemetry: movingTelemetry })

    expect(early.region).not.toBeNull()
    expect(mid.region).not.toBeNull()
    expect(late.region).not.toBeNull()

    // The focus must move meaningfully between samples (cursor-following), not stay pinned.
    expect(mid.region?.focus.cx).toBeGreaterThan(early.region?.focus.cx ?? 0)
    expect(late.region?.focus.cx).toBeGreaterThan(mid.region?.focus.cx ?? 0)

    // And it must not equal the static creation-time focus baked into the region.
    expect(mid.region?.focus.cx).not.toBeCloseTo(baseRegion.focus.cx, 2)
    expect(mid.region?.focus.cx).toBeCloseTo(0.5, 6)
  })

  it('clamps the cursor focus to the bounds of the effective scale', () => {
    const bounds = getFocusBoundsForScale(ZOOM_DEPTH_SCALES[3])
    const late = findDominantRegion([baseRegion], 4000, { cursorTelemetry: movingTelemetry })
    expect(late.region?.focus.cx).toBeCloseTo(bounds.maxX, 6)
  })

  it('stays frozen at the static focus when focusMode is not auto (manual regions unaffected)', () => {
    const manualRegion: ZoomRegion = { ...baseRegion, focusMode: 'manual', source: 'manual' }

    const early = findDominantRegion([manualRegion], 200, { cursorTelemetry: movingTelemetry })
    const late = findDominantRegion([manualRegion], 3800, { cursorTelemetry: movingTelemetry })

    expect(early.region?.focus.cx).toBeCloseTo(manualRegion.focus.cx, 5)
    expect(late.region?.focus.cx).toBeCloseTo(manualRegion.focus.cx, 5)
  })

  it('falls back to the static focus without telemetry (old projects, no cursor track)', () => {
    const noTelemetry = findDominantRegion([baseRegion], 2000)
    expect(noTelemetry.region?.focus.cx).toBeCloseTo(baseRegion.focus.cx, 5)
    const emptyTelemetry = findDominantRegion([baseRegion], 2000, { cursorTelemetry: [] })
    expect(emptyTelemetry.region?.focus.cx).toBeCloseTo(baseRegion.focus.cx, 5)
  })

  it('keys the memoised result on the telemetry identity', () => {
    const withTelemetry = findDominantRegion([baseRegion], 2000, {
      cursorTelemetry: movingTelemetry,
    })
    const without = findDominantRegion([baseRegion], 2000)
    expect(withTelemetry.region?.focus.cx).not.toBeCloseTo(without.region?.focus.cx ?? 0, 2)
  })

  it('pans between an auto region and a manual region using the shared cursor focus', () => {
    const autoRegion: ZoomRegion = { ...baseRegion, endMs: 2000 }
    const manualNext: ZoomRegion = {
      id: 'zoom-2',
      startMs: 3200,
      endMs: 6000,
      depth: 3,
      focus: { cx: 0.6, cy: 0.5 },
    }
    const midPan = findDominantRegion([autoRegion, manualNext], 2500, {
      connectZooms: true,
      cursorTelemetry: movingTelemetry,
    })
    expect(midPan.transition).not.toBeNull()
    // The outgoing auto region's end focus is the cursor at 2500 ms, not its static focus.
    expect(midPan.transition?.startFocus.cx).toBeCloseTo(0.6, 6)
    expect(midPan.transition?.endFocus.cx).toBeCloseTo(0.6, 6)
  })
})

describe('findDominantRegion - 3D rotation presets (B1-e)', () => {
  const iso = region({ id: 'iso', startMs: 1000, endMs: 4000, depth: 2, rotationPreset: 'iso' })
  const right = region({
    id: 'right',
    startMs: 5200,
    endMs: 9000,
    depth: 4,
    rotationPreset: 'right',
  })
  const flat = region({ id: 'flat', startMs: 12_000, endMs: 14_000 })

  it('is identity outside every region and for a region without a preset', () => {
    // 10 s is past iso's ease-out and before flat's lead-in (~1022 ms before 12 s).
    const idle = findDominantRegion([iso, flat], 10_000)
    expect(idle.region).toBeNull()
    expect(idle.rotation3D).toEqual(DEFAULT_ROTATION_3D)
    expect(findDominantRegion([iso, flat], 13_000).rotation3D).toEqual(DEFAULT_ROTATION_3D)
  })

  it("reports the full preset while the region is active (ramp is the caller's job via strength)", () => {
    const plateau = findDominantRegion([iso], 2500)
    expect(plateau.strength).toBe(1)
    expect(plateau.rotation3D).toEqual(ROTATION_3D_PRESETS.iso)
    const rampingIn = findDominantRegion([iso], iso.startMs - 500)
    expect(rampingIn.strength).toBeGreaterThan(0)
    expect(rampingIn.strength).toBeLessThan(1)
    expect(rampingIn.rotation3D).toEqual(ROTATION_3D_PRESETS.iso)
  })

  it('lerps the tilt between two presets with the connected-pan progress, then holds the next preset', () => {
    const regions = [iso, right, flat]
    const start = findDominantRegion(regions, iso.endMs, { connectZooms: true })
    expect(start.rotation3D.rotationY).toBeCloseTo(ROTATION_3D_PRESETS.iso.rotationY, 6)
    expect(start.rotation3D.rotationX).toBeCloseTo(ROTATION_3D_PRESETS.iso.rotationX, 6)

    const mid = findDominantRegion(regions, iso.endMs + 500, { connectZooms: true })
    expect(mid.transition).not.toBeNull()
    const p = mid.transition?.progress ?? 0
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
    expect(mid.rotation3D.rotationX).toBeCloseTo(-10 + (0 - -10) * p, 6)
    expect(mid.rotation3D.rotationY).toBeCloseTo(-16 + (22 - -16) * p, 6)
    expect(mid.rotation3D.rotationZ).toBe(0)

    const end = findDominantRegion(regions, iso.endMs + CONNECTED_ZOOM_PAN_DURATION_MS, {
      connectZooms: true,
    })
    expect(end.rotation3D.rotationY).toBeCloseTo(22, 6)
    expect(end.rotation3D.rotationX).toBeCloseTo(0, 6)

    const hold = findDominantRegion(regions, iso.endMs + CONNECTED_ZOOM_PAN_DURATION_MS + 1, {
      connectZooms: true,
    })
    expect(hold.transition).toBeNull()
    expect(hold.rotation3D).toEqual(ROTATION_3D_PRESETS.right)
  })

  it('a flat region next to a tilted one pans the tilt back to identity', () => {
    const flatNext = region({ id: 'flat-next', startMs: 5200, endMs: 9000, depth: 4 })
    const mid = findDominantRegion([iso, flatNext], iso.endMs + 500, { connectZooms: true })
    const p = mid.transition?.progress ?? 0
    expect(mid.rotation3D.rotationY).toBeCloseTo(-16 * (1 - p), 6)
    const hold = findDominantRegion(
      [iso, flatNext],
      iso.endMs + CONNECTED_ZOOM_PAN_DURATION_MS + 1,
      { connectZooms: true },
    )
    expect(hold.rotation3D).toEqual(DEFAULT_ROTATION_3D)
  })
})
