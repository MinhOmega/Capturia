import { describe, expect, it } from 'vitest'
import { BlurTrackSession, MAX_DENSIFY_RING } from './blurTrackSession'
import { resolveTrackedBlurRect } from './keyframes'
import { createSyntheticScreen, createTrackerFrame } from './syntheticScreen'
import {
  buildBlurTrack,
  buildSampleGrid,
  DENSIFY_THRESHOLD_PX,
  normRectToSourcePx,
  planBackwardChunks,
  shouldDensify,
} from './trackPlan'
import type { GrayImage, TrackerSample } from './trackerCore'

const SOURCE = { width: 1280, height: 720 }

function sample(overrides: Partial<TrackerSample> & { timeMs: number }): TrackerSample {
  return {
    x: 100,
    y: 200,
    w: 220,
    h: 20,
    state: 'found',
    score: 0.95,
    maxQuadrantScore: 0.95,
    reacquired: false,
    ...overrides,
  }
}

describe('buildSampleGrid', () => {
  it('walks outwards from the anchor and stops at the span', () => {
    const grid = buildSampleGrid(1000, 700, 1350, 100)
    expect(grid.forward).toEqual([1100, 1200, 1300])
    expect(grid.backward).toEqual([900, 800, 700])
  })

  it('is empty on both sides when the span is one interval wide', () => {
    expect(buildSampleGrid(1000, 1000, 1000, 100)).toEqual({ forward: [], backward: [] })
  })

  it('refuses a non-positive interval rather than looping forever', () => {
    expect(buildSampleGrid(1000, 0, 5000, 0)).toEqual({ forward: [], backward: [] })
  })

  it('lands on the same instants regardless of where the span starts', () => {
    // Determinism: the grid is anchored to t0, not to the span.
    const a = buildSampleGrid(1000, 0, 2000, 100)
    const b = buildSampleGrid(1000, 500, 1500, 100)
    expect(b.forward.every((time) => a.forward.includes(time))).toBe(true)
    expect(b.backward.every((time) => a.backward.includes(time))).toBe(true)
  })
})

describe('shouldDensify', () => {
  it('fires on a displacement over the threshold', () => {
    const previous = sample({ timeMs: 0 })
    expect(
      shouldDensify(previous, sample({ timeMs: 100, y: 200 + DENSIFY_THRESHOLD_PX + 1 })),
    ).toBe(true)
    expect(
      shouldDensify(previous, sample({ timeMs: 100, y: 200 + DENSIFY_THRESHOLD_PX - 1 })),
    ).toBe(false)
  })

  it('fires on any state change, however small the move', () => {
    expect(shouldDensify(sample({ timeMs: 0 }), sample({ timeMs: 100, state: 'lost' }))).toBe(true)
    expect(shouldDensify(sample({ timeMs: 0, state: 'lost' }), sample({ timeMs: 100 }))).toBe(true)
  })

  it('measures the displacement diagonally, not per axis', () => {
    const previous = sample({ timeMs: 0, x: 0, y: 0 })
    expect(shouldDensify(previous, sample({ timeMs: 100, x: 5, y: 5 }))).toBe(true)
  })
})

describe('planBackwardChunks', () => {
  it('splits into chunks of the requested size, last one short', () => {
    expect(planBackwardChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns one chunk when the size is not usable', () => {
    expect(planBackwardChunks([1, 2, 3], 0)).toEqual([[1, 2, 3]])
    expect(planBackwardChunks([], 0)).toEqual([])
  })
})

describe('buildBlurTrack', () => {
  it('normalises source pixels against the frame', () => {
    const track = buildBlurTrack([sample({ timeMs: 0 })], { sourceSize: SOURCE, anchorMs: 0 })
    expect(track.keyframes[0].x).toBeCloseTo(100 / 1280, 9)
    expect(track.keyframes[0].y).toBeCloseTo(200 / 720, 9)
    expect(track.keyframes[0].w).toBeCloseTo(220 / 1280, 9)
    expect(track.sourceSize).toEqual(SOURCE)
  })

  it('emits nothing for a tentative sample so the rect is held where it was', () => {
    const track = buildBlurTrack(
      [
        sample({ timeMs: 0, y: 200 }),
        sample({ timeMs: 100, state: 'tentative', y: 200 }),
        sample({ timeMs: 200, y: 260 }),
      ],
      { sourceSize: SOURCE, anchorMs: 0 },
    )
    expect(track.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([0, 200])
  })

  it('collapses a run of lost samples into the keyframe that starts it', () => {
    const track = buildBlurTrack(
      [
        sample({ timeMs: 0 }),
        sample({ timeMs: 100, state: 'lost' }),
        sample({ timeMs: 200, state: 'lost' }),
        sample({ timeMs: 300, state: 'lost' }),
      ],
      { sourceSize: SOURCE, anchorMs: 0 },
    )
    const lost = track.keyframes.filter((keyframe) => keyframe.lost)
    expect(lost).toHaveLength(1)
    expect(lost[0].timeMs).toBe(100)
  })

  it('pre-rolls a re-acquisition by one grid interval, because early is free and late is a leak', () => {
    const track = buildBlurTrack(
      [
        sample({ timeMs: 0 }),
        sample({ timeMs: 100, state: 'lost' }),
        sample({ timeMs: 200, state: 'lost' }),
        sample({ timeMs: 300, reacquired: true, y: 400 }),
      ],
      { sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
    )
    const found = track.keyframes.filter((keyframe) => !keyframe.lost)
    expect(found.map((keyframe) => keyframe.timeMs)).toEqual([0, 200])
  })

  it('never lets the pre-roll reorder the list', () => {
    // The lost keyframe and the re-acquisition are one interval apart, so the
    // pre-roll would land exactly on it.
    const track = buildBlurTrack(
      [
        sample({ timeMs: 0 }),
        sample({ timeMs: 100, state: 'lost' }),
        sample({ timeMs: 200, reacquired: true, y: 400 }),
      ],
      { sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
    )
    const times = track.keyframes.map((keyframe) => keyframe.timeMs)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(new Set(times).size).toBe(times.length)
  })

  it('reports how much of the span was tracked and how much was hidden', () => {
    const track = buildBlurTrack(
      [
        sample({ timeMs: 0, score: 1 }),
        sample({ timeMs: 100, score: 0.8 }),
        sample({ timeMs: 200, state: 'lost' }),
      ],
      { sourceSize: SOURCE, anchorMs: 0, sampleIntervalMs: 100 },
    )
    expect(track.quality).toEqual({ meanScore: 0.9, lostMs: 100, trackedMs: 200 })
  })

  it('sorts samples that arrived out of order, as the backward pass produces them', () => {
    const track = buildBlurTrack(
      [sample({ timeMs: 300 }), sample({ timeMs: 100 }), sample({ timeMs: 200, y: 260 })],
      { sourceSize: SOURCE, anchorMs: 300 },
    )
    expect(track.keyframes.map((keyframe) => keyframe.timeMs)).toEqual([100, 200, 300])
  })

  it('keeps user pins and lets them replace the tracked keyframe at the same instant', () => {
    const pin = { timeMs: 100, x: 0.5, y: 0.5, w: 0.1, h: 0.05, origin: 'user' as const }
    const track = buildBlurTrack([sample({ timeMs: 0 }), sample({ timeMs: 100 })], {
      sourceSize: SOURCE,
      anchorMs: 0,
      pins: [pin],
    })
    const merged = track.keyframes.find((keyframe) => keyframe.timeMs === 100)
    expect(merged).toMatchObject({ origin: 'user', x: 0.5 })
  })

  it('produces a track the renderer can resolve at every analysed instant', () => {
    const samples = [0, 100, 200, 300].map((timeMs) => sample({ timeMs, y: 200 + timeMs / 100 }))
    const track = buildBlurTrack(samples, { sourceSize: SOURCE, anchorMs: 0 })
    for (const analysed of samples) {
      const resolved = resolveTrackedBlurRect(track, analysed.timeMs)
      expect(resolved).not.toBeNull()
      expect(resolved!.rect.y * SOURCE.height).toBeCloseTo(analysed.y, 6)
    }
  })
})

describe('normRectToSourcePx', () => {
  it('is the inverse of the normalisation buildBlurTrack applies', () => {
    const rect = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 }
    const px = normRectToSourcePx(rect, SOURCE)
    expect(px).toEqual({ x: 128, y: 144, w: 384, h: 36 })
  })
})

// ---------------------------------------------------------------------------
// The session, driven over synthetic frames without a browser
// ---------------------------------------------------------------------------

/** Half-size so a test can render dozens of frames without the suite crawling. */
// `cellRow` has to sit inside the shorter pane; the default row 12 would be
// below the bottom of a 360 px frame.
const SESSION_SCREEN = { width: 640, height: 360, rowCount: 20, cellRow: 5 } as const

function sessionOver(gridTimes: number[]): {
  session: BlurTrackSession<GrayImage>
  released: GrayImage[]
  screen: ReturnType<typeof createSyntheticScreen>
} {
  const screen = createSyntheticScreen(SESSION_SCREEN)
  const released: GrayImage[] = []
  const created = BlurTrackSession.create(screen.render({ scrollY: 0 }), screen.cellRect, 0, {
    toFrame: (image) => createTrackerFrame(image),
    release: (image) => released.push(image),
    gridTimes,
  })
  if (!created.ok) throw new Error(`refused: ${created.reason}`)
  return { session: created.session, released, screen }
}

describe('BlurTrackSession', () => {
  it('analyses only the grid instants and releases every frame it was given', () => {
    const gridTimes = [100, 200, 300]
    const { session, released, screen } = sessionOver(gridTimes)
    const pushed: GrayImage[] = []
    // 30 fps for 350 ms, a slow scroll that never triggers densification.
    for (let timeMs = 33; timeMs <= 350; timeMs += 33) {
      const image = screen.render({ scrollY: Math.round(timeMs / 100) })
      pushed.push(image)
      session.push(image, timeMs)
    }
    session.dispose()
    expect(session.isComplete()).toBe(true)
    expect(new Set(released).size).toBe(released.length)
    for (const image of pushed) expect(released).toContain(image)
  })

  it('analyses the frames in between when the content moved far', () => {
    const gridTimes = [100, 200]
    const { session, screen } = sessionOver(gridTimes)
    const samples = []
    // 4 source px per frame at 60 fps: 25 px between grid instants, well over
    // the densification threshold.
    for (let timeMs = 20; timeMs <= 220; timeMs += 20) {
      const scrollY = Math.round(timeMs * 0.25)
      samples.push(...session.push(screen.render({ scrollY }), timeMs))
    }
    session.dispose()
    // More samples than grid instants means the interval was filled in.
    expect(samples.length).toBeGreaterThan(gridTimes.length)
    const between = samples.filter((s) => s.timeMs > 100 && s.timeMs < 200)
    expect(between.length).toBeGreaterThan(0)
    for (const s of samples) {
      const truth = screen.cellRectAt(Math.round(s.timeMs * 0.25))
      expect(Math.abs(s.y - truth.y), `at ${s.timeMs} ms`).toBeLessThanOrEqual(1)
    }
  })

  it('picks the frame nearest the grid instant, not the first one past it', () => {
    const { session, screen } = sessionOver([100])
    // Frames at 90 and 140: 90 is nearer to 100, so it is the one analysed.
    const samples = [
      ...session.push(screen.render({ scrollY: 9 }), 90),
      ...session.push(screen.render({ scrollY: 14 }), 140),
    ]
    session.dispose()
    expect(samples).toHaveLength(1)
    expect(samples[0].timeMs).toBe(90)
  })

  it('releases frames pushed after the last grid instant instead of holding them', () => {
    const { session, released, screen } = sessionOver([100])
    session.push(screen.render({ scrollY: 1 }), 100)
    const late = screen.render({ scrollY: 2 })
    session.push(late, 200)
    expect(released).toContain(late)
  })

  it('bounds the frames it holds between two grid instants', () => {
    const { session, released, screen } = sessionOver([10_000])
    for (let i = 0; i < MAX_DENSIFY_RING * 3; i++)
      session.push(screen.render({ scrollY: i }), i * 16)
    // Everything past the bound has been let go while the grid instant is still far off.
    expect(released.length).toBeGreaterThanOrEqual(MAX_DENSIFY_RING)
    session.dispose()
  })

  it('gives the same samples however the frames were split into chunks', () => {
    // The backward pass decodes in chunks; the state machine must not be able
    // to tell where a chunk boundary fell.
    const gridTimes = [100, 200, 300]
    const screen = createSyntheticScreen(SESSION_SCREEN)
    const frames = []
    for (let timeMs = 40; timeMs <= 320; timeMs += 40) {
      frames.push({ image: screen.render({ scrollY: Math.round(timeMs / 10) }), timeMs })
    }

    const run = (chunkSize: number) => {
      const created = BlurTrackSession.create(screen.render({ scrollY: 0 }), screen.cellRect, 0, {
        toFrame: (image: GrayImage) => createTrackerFrame(image),
        release: () => undefined,
        gridTimes,
      })
      if (!created.ok) throw new Error('refused')
      const samples = []
      for (let i = 0; i < frames.length; i += chunkSize) {
        for (const held of frames.slice(i, i + chunkSize)) {
          samples.push(...created.session.push(held.image, held.timeMs))
        }
      }
      return samples
    }

    expect(run(4)).toEqual(run(8))
    expect(run(1)).toEqual(run(8))
  })
})
