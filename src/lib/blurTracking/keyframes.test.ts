import { describe, expect, it } from 'vitest'
import type { BlurTrack, BlurTrackKeyframe } from '@/components/video-editor/types'
import {
  BLUR_TRACK_FADE_OUT_MS,
  findKeyframeIndex,
  mergeUserPin,
  normalizeBlurTrack,
  resolveTrackedBlurRect,
  simplifyKeyframes,
  unionRect,
} from './keyframes'

const SOURCE = { width: 1920, height: 1080 }

function track(keyframes: BlurTrackKeyframe[], overrides: Partial<BlurTrack> = {}): BlurTrack {
  return {
    version: 1,
    space: 'source',
    keyframes,
    sourceSize: SOURCE,
    sampleIntervalMs: 100,
    anchorMs: keyframes[0]?.timeMs ?? 0,
    ...overrides,
  }
}

/** A keyframe whose top-left is `yPx` source pixels down, 200x40 source px. */
function at(
  timeMs: number,
  yPx: number,
  extra: Partial<BlurTrackKeyframe> = {},
): BlurTrackKeyframe {
  return {
    timeMs,
    x: 100 / SOURCE.width,
    y: yPx / SOURCE.height,
    w: 200 / SOURCE.width,
    h: 40 / SOURCE.height,
    ...extra,
  }
}

describe('findKeyframeIndex', () => {
  const keyframes = [at(0, 0), at(100, 10), at(200, 20), at(300, 30)]

  it('returns -1 before the first keyframe and the last index after the last', () => {
    expect(findKeyframeIndex(keyframes, -1)).toBe(-1)
    expect(findKeyframeIndex(keyframes, 0)).toBe(0)
    expect(findKeyframeIndex(keyframes, 9999)).toBe(3)
  })

  it('agrees with a linear scan for every probe, with and without a stale hint', () => {
    for (let t = -50; t <= 400; t += 7) {
      let expected = -1
      for (let i = 0; i < keyframes.length; i++) if (keyframes[i].timeMs <= t) expected = i
      expect(findKeyframeIndex(keyframes, t)).toBe(expected)
      expect(findKeyframeIndex(keyframes, t, 3)).toBe(expected)
      expect(findKeyframeIndex(keyframes, t, 0)).toBe(expected)
    }
  })
})

describe('resolveTrackedBlurRect', () => {
  it('lerps between two nearby keyframes', () => {
    const resolved = resolveTrackedBlurRect(track([at(0, 100), at(100, 104)]), 50)
    expect(resolved).not.toBeNull()
    expect(resolved!.opacity).toBe(1)
    expect(resolved!.rect.y * SOURCE.height).toBeCloseTo(102, 6)
  })

  it('holds the last rect when the next keyframe is lost', () => {
    const resolved = resolveTrackedBlurRect(track([at(0, 100), at(100, 900, { lost: true })]), 60)
    expect(resolved!.rect.y * SOURCE.height).toBeCloseTo(100, 6)
    expect(resolved!.opacity).toBe(1)
  })

  it('fades out linearly over the fade window after a lost keyframe, then draws nothing', () => {
    const lost = track([at(0, 100), at(100, 100, { lost: true })])
    expect(resolveTrackedBlurRect(lost, 100)!.opacity).toBe(1)
    expect(resolveTrackedBlurRect(lost, 100 + BLUR_TRACK_FADE_OUT_MS / 2)!.opacity).toBeCloseTo(
      0.5,
      6,
    )
    expect(resolveTrackedBlurRect(lost, 100 + BLUR_TRACK_FADE_OUT_MS)).toBeNull()
    expect(resolveTrackedBlurRect(lost, 5000)).toBeNull()
  })

  it('unions the two rects when the gap is long and the displacement large', () => {
    // 200 source px in 100 ms: the lerp would leave the content uncovered for
    // whole frames, so the rendered rect must cover both ends.
    const jump = track([at(0, 100), at(100, 300)])
    const mid = resolveTrackedBlurRect(jump, 50)!
    expect(mid.rect.y * SOURCE.height).toBeCloseTo(100, 6)
    expect(mid.rect.h * SOURCE.height).toBeCloseTo(240, 6)
    // Ground truth at any instant inside the interval is inside the union.
    for (let t = 0; t <= 100; t += 10) {
      const truthY = 100 + 2 * t
      const rect = resolveTrackedBlurRect(jump, t)!.rect
      expect(rect.y * SOURCE.height).toBeLessThanOrEqual(truthY + 1e-6)
      expect((rect.y + rect.h) * SOURCE.height).toBeGreaterThanOrEqual(truthY + 40 - 1e-6)
    }
  })

  it('lerps instead of unioning when the gap is short or the displacement small', () => {
    // Same 200 px, but 40 ms apart: densified frames, so the lerp is accurate.
    const dense = track([at(0, 100), at(40, 300)])
    expect(resolveTrackedBlurRect(dense, 20)!.rect.y * SOURCE.height).toBeCloseTo(200, 6)
    // Long gap, 5 px displacement: under the union threshold.
    const slow = track([at(0, 100), at(100, 105)])
    expect(resolveTrackedBlurRect(slow, 50)!.rect.y * SOURCE.height).toBeCloseTo(102.5, 6)
  })

  it('clamps to the first and last keyframe outside the track', () => {
    const t = track([at(100, 10), at(200, 20)])
    expect(resolveTrackedBlurRect(t, 0)!.rect.y * SOURCE.height).toBeCloseTo(10, 6)
    expect(resolveTrackedBlurRect(t, 10_000)!.rect.y * SOURCE.height).toBeCloseTo(20, 6)
  })

  it('draws nothing before a track that starts lost', () => {
    expect(resolveTrackedBlurRect(track([at(100, 10, { lost: true })]), 0)).toBeNull()
  })
})

describe('unionRect', () => {
  it('covers both inputs', () => {
    const u = unionRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.2, y: 0.05, w: 0.2, h: 0.1 })
    expect(u).toEqual({ x: 0.1, y: 0.05, w: expect.closeTo(0.3, 10), h: expect.closeTo(0.25, 10) })
  })
})

describe('simplifyKeyframes', () => {
  it('drops keyframes a lerp already predicts and keeps the endpoints', () => {
    const linear = [at(0, 0), at(100, 10), at(200, 20), at(300, 30), at(400, 40)]
    const simplified = simplifyKeyframes(linear, SOURCE)
    expect(simplified).toHaveLength(2)
    expect(simplified[0].timeMs).toBe(0)
    expect(simplified[1].timeMs).toBe(400)
  })

  it('stays within the tolerance at every dropped keyframe', () => {
    const wobbly = [at(0, 0), at(100, 12), at(200, 20), at(300, 33), at(400, 40)]
    const simplified = simplifyKeyframes(wobbly, SOURCE, 0.5)
    const rebuilt = track(simplified)
    for (const original of wobbly) {
      const resolved = resolveTrackedBlurRect(rebuilt, original.timeMs)!
      expect(Math.abs(resolved.rect.y - original.y) * SOURCE.height).toBeLessThanOrEqual(0.5 + 1e-9)
    }
  })

  it('never drops a lost transition or a user pin', () => {
    const withStates = [
      at(0, 0),
      at(100, 10),
      at(200, 20, { lost: true }),
      at(300, 20, { lost: true }),
      at(400, 40),
      at(500, 50, { origin: 'user' }),
      at(600, 60),
    ]
    const simplified = simplifyKeyframes(withStates, SOURCE)
    expect(simplified.some((k) => k.lost && k.timeMs === 200)).toBe(true)
    expect(simplified.some((k) => k.origin === 'user' && k.timeMs === 500)).toBe(true)
    expect(simplified.some((k) => k.timeMs === 400)).toBe(true)
  })

  it('returns short lists untouched', () => {
    expect(simplifyKeyframes([at(0, 0)], SOURCE)).toHaveLength(1)
    expect(simplifyKeyframes([at(0, 0), at(100, 5)], SOURCE)).toHaveLength(2)
  })
})

describe('normalizeBlurTrack', () => {
  const valid = track([at(0, 0), at(100, 10)])

  it('accepts a well-formed track and round-trips it through JSON', () => {
    const parsed = JSON.parse(JSON.stringify(valid))
    expect(normalizeBlurTrack(parsed)).toEqual(valid)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 7],
    ['an array', [at(0, 0)]],
    ['the wrong space', { ...valid, space: 'stage' }],
    ['no keyframes', { ...valid, keyframes: [] }],
    ['non-array keyframes', { ...valid, keyframes: { 0: at(0, 0) } }],
    ['a missing sourceSize', { ...valid, sourceSize: undefined }],
    ['a zero sourceSize', { ...valid, sourceSize: { width: 0, height: 1080 } }],
    ['a non-finite sourceSize', { ...valid, sourceSize: { width: Number.NaN, height: 1080 } }],
    ['only unusable keyframes', { ...valid, keyframes: [{ timeMs: 0, x: 0, y: 0, w: 0, h: 0 }] }],
    [
      'non-finite coordinates',
      { ...valid, keyframes: [{ ...at(0, 0), y: Number.POSITIVE_INFINITY }] },
    ],
  ])('drops a track with %s so the region degrades to static', (_label, value) => {
    expect(normalizeBlurTrack(value)).toBeUndefined()
  })

  it('keeps the good keyframes and discards the corrupt ones', () => {
    const normalized = normalizeBlurTrack({
      ...valid,
      keyframes: [at(0, 0), { timeMs: 50, x: 0, y: 0, w: -1, h: 1 }, at(100, 10), 'junk'],
    })
    expect(normalized!.keyframes.map((k) => k.timeMs)).toEqual([0, 100])
  })

  it('sorts by time and collapses duplicates keeping the last', () => {
    const normalized = normalizeBlurTrack({
      ...valid,
      keyframes: [at(200, 20), at(100, 10), at(100, 99, { origin: 'user' }), at(0, 0)],
    })
    expect(normalized!.keyframes.map((k) => k.timeMs)).toEqual([0, 100, 200])
    expect(normalized!.keyframes[1].origin).toBe('user')
    expect(normalized!.keyframes[1].y * SOURCE.height).toBeCloseTo(99, 6)
  })

  it('fills a missing sample interval and anchor rather than failing', () => {
    const normalized = normalizeBlurTrack({
      space: 'source',
      keyframes: [at(250, 10)],
      sourceSize: SOURCE,
    })
    expect(normalized!.sampleIntervalMs).toBe(100)
    expect(normalized!.anchorMs).toBe(250)
    expect(normalized!.version).toBe(1)
  })

  it('keeps a complete quality block and drops a partial one', () => {
    const good = normalizeBlurTrack({
      ...valid,
      quality: { meanScore: 0.9, lostMs: 0, trackedMs: 1 },
    })
    expect(good!.quality).toEqual({ meanScore: 0.9, lostMs: 0, trackedMs: 1 })
    expect(normalizeBlurTrack({ ...valid, quality: { meanScore: 0.9 } })!.quality).toBeUndefined()
  })

  it('ignores unknown fields instead of failing on them', () => {
    const normalized = normalizeBlurTrack({ ...valid, futureField: { nested: true } })
    expect(normalized).toBeDefined()
    expect(normalized).not.toHaveProperty('futureField')
  })
})

describe('mergeUserPin', () => {
  it('replaces tracked keyframes within one sample interval and marks the pin', () => {
    const base = track([at(0, 0), at(100, 10), at(200, 20), at(300, 30), at(400, 40)])
    const merged = mergeUserPin(base, at(200, 77))
    expect(merged.keyframes.map((k) => k.timeMs)).toEqual([0, 200, 400])
    const pin = merged.keyframes.find((k) => k.timeMs === 200)!
    expect(pin.origin).toBe('user')
    expect(pin.y * SOURCE.height).toBeCloseTo(77, 6)
  })

  it('never removes another user pin and clears the lost flag on the pinned frame', () => {
    const base = track([at(0, 0, { origin: 'user' }), at(50, 5), at(100, 10, { lost: true })])
    const merged = mergeUserPin(base, at(100, 11, { lost: true }))
    expect(merged.keyframes.map((k) => k.timeMs)).toEqual([0, 100])
    expect(merged.keyframes[0].origin).toBe('user')
    expect(merged.keyframes[1].lost).toBeUndefined()
  })

  it('keeps the result sorted so it resolves without re-normalising', () => {
    const base = track([at(0, 0), at(400, 40)])
    const merged = mergeUserPin(base, at(200, 20))
    expect(merged.keyframes.map((k) => k.timeMs)).toEqual([0, 200, 400])
  })
})
