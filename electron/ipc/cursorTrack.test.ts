import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CURSOR_TRACK_COMPACTION,
  compactCursorTrackPauseRanges,
  compactCursorTrackSamples,
  normalizeCursorTrackPauseRanges,
  readCursorTrackSidecar,
  resolveCursorSidecarPath,
  sanitizeCursorTrack,
  MAX_CURSOR_TRACK_MARKERS,
  sanitizeVideoMetadata,
  writeCursorTrackSidecar,
} from './cursorTrack'

const sampleAt = (timeMs: number) => ({ timeMs, x: 0.5, y: 0.5 })
const clickAt = (timeMs: number) => ({
  type: 'click' as const,
  startMs: timeMs,
  endMs: timeMs,
  point: { x: 0.5, y: 0.5 },
})

describe('compactCursorTrackPauseRanges', () => {
  it('returns the input untouched when there are no usable ranges', () => {
    const track = { samples: [sampleAt(0), sampleAt(100)], events: [clickAt(50)] }
    expect(compactCursorTrackPauseRanges(track, [])).toBe(track)
    expect(compactCursorTrackPauseRanges(track, [{ startMs: 10, endMs: 10 }])).toBe(track)
    expect(compactCursorTrackPauseRanges(track, [{ startMs: Number.NaN, endMs: 20 }])).toBe(track)
  })

  it('drops samples inside a pause and shifts later samples back by the pause length', () => {
    const track = {
      samples: [
        sampleAt(0),
        sampleAt(100),
        sampleAt(200),
        sampleAt(300),
        sampleAt(500),
        sampleAt(700),
      ],
      events: [],
    }
    const compacted = compactCursorTrackPauseRanges(track, [{ startMs: 150, endMs: 350 }])
    // 200 and 300 are inside the pause; 500 -> 300, 700 -> 500.
    expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([0, 100, 300, 500])
    // Input is not mutated.
    expect(track.samples.map((sample) => sample.timeMs)).toEqual([0, 100, 200, 300, 500, 700])
  })

  it('accumulates several pauses and merges overlapping / unordered ranges', () => {
    const track = {
      samples: [sampleAt(0), sampleAt(1000), sampleAt(2000), sampleAt(3000), sampleAt(4000)],
      events: [],
    }
    const compacted = compactCursorTrackPauseRanges(track, [
      { startMs: 2500, endMs: 2600 },
      { startMs: 900, endMs: 1100 },
      { startMs: 2550, endMs: 2700 },
      { endMs: 1500, startMs: 1050 }, // reversed + overlapping -> merged into 900..1500
    ])
    expect(
      normalizeCursorTrackPauseRanges([
        { startMs: 2500, endMs: 2600 },
        { startMs: 900, endMs: 1100 },
        { startMs: 2550, endMs: 2700 },
        { endMs: 1500, startMs: 1050 },
      ]),
    ).toEqual([
      { startMs: 900, endMs: 1500 },
      { startMs: 2500, endMs: 2700 },
    ])
    // 1000 inside first pause -> dropped; 2000 -> 1400; 3000 -> 3000-600-200 = 2200; 4000 -> 3200.
    expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([0, 1400, 2200, 3200])
  })

  it('drops events inside a pause, shifts later ones and clamps a selection that spans the pause', () => {
    const track = {
      samples: [sampleAt(0)],
      events: [
        clickAt(50),
        clickAt(250), // inside
        { type: 'selection' as const, startMs: 180, endMs: 450, point: { x: 0.5, y: 0.5 } }, // spans the pause
        clickAt(600),
      ],
    }
    const compacted = compactCursorTrackPauseRanges(track, [{ startMs: 200, endMs: 400 }])
    expect(compacted.events).toEqual([
      clickAt(50),
      { type: 'selection', startMs: 180, endMs: 250, point: { x: 0.5, y: 0.5 } },
      clickAt(400),
    ])
  })

  it('a pause that runs until the stop instant drops the trailing samples', () => {
    const track = {
      samples: [sampleAt(0), sampleAt(100), sampleAt(900), sampleAt(1000)],
      events: [],
    }
    const compacted = compactCursorTrackPauseRanges(track, [{ startMs: 500, endMs: 1000 }])
    expect(compacted.samples.map((sample) => sample.timeMs)).toEqual([0, 100])
  })
})

describe('cursorTrack (pure)', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-cursor-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('is importable without electron', async () => {
    const mod = await import('./cursorTrack')
    expect(typeof mod.sanitizeCursorTrack).toBe('function')
  })

  it('sanitizeCursorTrack clamps, sorts and drops invalid samples/events', () => {
    const track = sanitizeCursorTrack({
      samples: [
        { timeMs: 50, x: 1.5, y: -0.2, click: true },
        { timeMs: 10, x: 0.25, y: 0.5, cursorKind: 'ibeam' },
        { timeMs: Number.NaN, x: 0, y: 0 },
      ],
      events: [
        { type: 'click', startMs: 20, endMs: 10, point: { x: 2, y: 0.5 } },
        { type: 'bogus' as 'click', startMs: 0, endMs: 0, point: { x: 0, y: 0 } },
      ],
      space: {
        mode: 'source-display',
        displayId: ' 7 ',
        bounds: { x: 0, y: 0, width: 100, height: 50 },
      },
      stats: { sampleCount: -1, clickCount: 3.9 },
      capture: { sourceId: 'screen:1:0', width: 1920.9, height: 1 },
    })
    expect(track).toBeDefined()
    expect(track?.source).toBe('recorded')
    // Legacy `ibeam` sidecars map onto the widened kind set.
    expect(track?.samples).toEqual([
      { timeMs: 10, x: 0.25, y: 0.5, click: false, visible: true, cursorKind: 'text' },
      { timeMs: 50, x: 1, y: 0, click: true, visible: true, cursorKind: 'arrow' },
    ])
    expect(track?.events).toEqual([
      { type: 'click', startMs: 20, endMs: 20, point: { x: 1, y: 0.5 } },
    ])
    expect(track?.space).toEqual({
      mode: 'source-display',
      displayId: '7',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
    })
    expect(track?.stats).toEqual({ sampleCount: 2, clickCount: 3 })
    expect(track?.capture).toEqual({ sourceId: 'screen:1:0', width: 1920, height: undefined })
  })

  it('sanitizeCursorTrack keeps the widened cursor kinds and maps unknown ones to arrow', () => {
    const track = sanitizeCursorTrack({
      samples: [
        { timeMs: 0, x: 0, y: 0, cursorKind: 'pointer' },
        { timeMs: 1, x: 0, y: 0, cursorKind: 'resize-nwse' },
        { timeMs: 2, x: 0, y: 0, cursorKind: 'ibeam' },
        { timeMs: 3, x: 0, y: 0, cursorKind: 'something-new' },
        { timeMs: 4, x: 0, y: 0 },
      ],
    })
    expect(track?.samples.map((sample) => sample.cursorKind)).toEqual([
      'pointer',
      'resize-nwse',
      'text',
      'arrow',
      'arrow',
    ])
  })

  it('sanitizeCursorTrack returns undefined for empty input', () => {
    expect(sanitizeCursorTrack(undefined)).toBeUndefined()
    expect(sanitizeCursorTrack({ samples: [] })).toBeUndefined()
    expect(
      sanitizeCursorTrack({ samples: [{ timeMs: 'x' as unknown as number, x: 0, y: 0 }] }),
    ).toBeUndefined()
  })

  it('sanitizeVideoMetadata keeps only well-formed fields', () => {
    expect(sanitizeVideoMetadata(null)).toBeNull()
    expect(sanitizeVideoMetadata({ frameRate: 0, width: 1 })).toBeNull()
    expect(
      sanitizeVideoMetadata({
        frameRate: 59.94,
        width: 1920.4,
        height: 1080,
        mimeType: ' video/webm ',
        capturedAt: 1234.5,
        systemCursorMode: 'never',
        hasMicrophoneAudio: true,
        durationMs: 999,
        cursorTrack: { samples: [{ timeMs: 0, x: 0.5, y: 0.5 }] },
      }),
    ).toEqual({
      frameRate: 60,
      width: 1920,
      height: 1080,
      mimeType: 'video/webm',
      capturedAt: 1234,
      systemCursorMode: 'never',
      hasMicrophoneAudio: true,
      cursorTrack: {
        source: 'recorded',
        samples: [{ timeMs: 0, x: 0.5, y: 0.5, click: false, visible: true, cursorKind: 'arrow' }],
      },
    })
  })

  it('writes and reads the sidecar next to the video', async () => {
    const videoPath = path.join(dir, 'recording-1.webm')
    expect(resolveCursorSidecarPath(videoPath)).toBe(path.join(dir, 'recording-1.cursor.json'))

    await writeCursorTrackSidecar(videoPath, { samples: [{ timeMs: 5, x: 0.1, y: 0.2 }] })
    const raw = JSON.parse(await readFile(resolveCursorSidecarPath(videoPath), 'utf-8'))
    expect(raw.version).toBe(1)

    const track = await readCursorTrackSidecar(videoPath)
    expect(track?.samples).toEqual([
      { timeMs: 5, x: 0.1, y: 0.2, click: false, visible: true, cursorKind: 'arrow' },
    ])
    expect(await readCursorTrackSidecar(path.join(dir, 'missing.webm'))).toBeUndefined()
  })

  it('skips writing a sidecar for an empty track', async () => {
    const videoPath = path.join(dir, 'recording-2.webm')
    await writeCursorTrackSidecar(videoPath, { samples: [] })
    await expect(readFile(resolveCursorSidecarPath(videoPath))).rejects.toThrow()
  })
})

/**
 * A capture at the tracker's live rate (~60 Hz), long enough that the pre-1.9
 * head slice would have thrown away everything past the first ~100 seconds.
 */
function syntheticTrack(options: {
  durationMs: number
  intervalMs?: number
  clickTimesMs?: number[]
}): {
  samples: Array<{ timeMs: number; x: number; y: number; click?: boolean }>
  events: Array<{ type: 'click'; startMs: number; endMs: number; point: { x: number; y: number } }>
} {
  const intervalMs = options.intervalMs ?? 16
  // Clicks have to land on the sampling grid, else no sample carries `click`.
  const clickTimes = new Set(
    (options.clickTimesMs ?? []).map((timeMs) => Math.round(timeMs / intervalMs) * intervalMs),
  )
  const samples: Array<{ timeMs: number; x: number; y: number; click?: boolean }> = []
  for (let timeMs = 0; timeMs <= options.durationMs; timeMs += intervalMs) {
    samples.push({
      timeMs,
      x: (timeMs % 1_000) / 1_000,
      y: (timeMs % 700) / 700,
      click: clickTimes.has(timeMs),
    })
  }
  const events = [...clickTimes].map((timeMs) => ({
    type: 'click' as const,
    startMs: timeMs,
    endMs: timeMs,
    point: { x: 0.5, y: 0.5 },
  }))
  return { samples, events }
}

describe('cursor-track size policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves a track at the old head-slice cap untouched', () => {
    const { samples } = syntheticTrack({ durationMs: 16 * 5_999 })
    expect(samples).toHaveLength(6_000)
    const track = sanitizeCursorTrack({ samples })
    expect(track?.samples).toHaveLength(6_000)
    expect(track?.samples.map((sample) => sample.timeMs)).toEqual(
      samples.map((sample) => sample.timeMs),
    )
  })

  it('keeps a 20-minute track alive to its last second instead of cutting it short', () => {
    const durationMs = 20 * 60 * 1_000
    const { samples, events } = syntheticTrack({ durationMs, clickTimesMs: [600_000] })
    const track = sanitizeCursorTrack({ samples, events })
    const times = track?.samples.map((sample) => sample.timeMs) ?? []

    expect(times.length).toBeGreaterThan(6_000)
    expect(times[times.length - 1]).toBe(durationMs)
    // The whole last second survives, at roughly the 30 Hz target.
    const lastSecond = times.filter((timeMs) => timeMs > durationMs - 1_000)
    expect(lastSecond.length).toBeGreaterThanOrEqual(25)
    expect(lastSecond.length).toBeLessThanOrEqual(40)
    // ... and so does a second sampled halfway through.
    expect(times.filter((timeMs) => timeMs >= 500_000 && timeMs < 501_000).length).toBeGreaterThan(
      20,
    )
  })

  it('never drops a click, and keeps the samples within 250 ms of one', () => {
    const clickTimesMs = [1_008, 300_000, 900_000, 1_198_992]
    const { samples, events } = syntheticTrack({ durationMs: 20 * 60 * 1_000, clickTimesMs })
    const track = sanitizeCursorTrack({ samples, events })
    const kept = track?.samples ?? []

    expect(kept.filter((sample) => sample.click).map((sample) => sample.timeMs)).toEqual(
      clickTimesMs,
    )
    for (const clickMs of clickTimesMs) {
      const around = samples.filter((sample) => Math.abs(sample.timeMs - clickMs) <= 250)
      const keptAround = kept.filter((sample) => Math.abs(sample.timeMs - clickMs) <= 250)
      expect(keptAround).toHaveLength(around.length)
    }
  })

  it('keeps a two-hour track under the serialized payload guard', () => {
    const { samples, events } = syntheticTrack({
      durationMs: 2 * 60 * 60 * 1_000,
      intervalMs: 16,
      clickTimesMs: [60_000, 3_600_000],
    })
    const track = sanitizeCursorTrack({ samples, events })
    expect(track?.samples.length).toBeLessThanOrEqual(DEFAULT_CURSOR_TRACK_COMPACTION.maxSamples)
    expect(JSON.stringify(track?.samples).length).toBeLessThan(
      DEFAULT_CURSOR_TRACK_COMPACTION.maxSampleBytes,
    )
    // Still covers the last second of the recording.
    const times = track?.samples.map((sample) => sample.timeMs) ?? []
    expect(times[times.length - 1]).toBe(2 * 60 * 60 * 1_000)
  })

  it('drops uniformly across time and logs once when the byte guard trips', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { samples } = syntheticTrack({ durationMs: 600_000 })
    const compacted = compactCursorTrackSamples(samples, [], {
      compactAboveSamples: 0,
      maxSampleBytes: 20_000,
    })

    expect(compacted.length).toBeLessThan(samples.length)
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(24_000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('payload ceiling reached')

    // Uniform, not a tail cut: both halves of the recording keep samples.
    const times = compacted.map((sample) => sample.timeMs)
    expect(times.filter((timeMs) => timeMs < 300_000).length).toBeGreaterThan(10)
    expect(times.filter((timeMs) => timeMs >= 300_000).length).toBeGreaterThan(10)
    expect(times[times.length - 1]).toBe(600_000)
  })

  it('thins uniformly to the count ceiling while keeping every click', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const clickTimesMs = [0, 160_000, 320_000, 480_000]
    const { samples, events } = syntheticTrack({ durationMs: 600_000, clickTimesMs })
    const compacted = compactCursorTrackSamples(samples, events, {
      compactAboveSamples: 0,
      maxSamples: 500,
    })

    expect(compacted.length).toBeLessThanOrEqual(520)
    expect(compacted.filter((sample) => sample.click).map((sample) => sample.timeMs)).toEqual(
      clickTimesMs,
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('sample ceiling reached')
  })
})

describe('cursor-track sidecar compatibility', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-cursor-sidecar-'))
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('loads a legacy sidecar: bare track, no version wrapper, legacy cursor kind', async () => {
    const videoPath = path.join(dir, 'legacy-recording.webm')
    await writeFile(
      resolveCursorSidecarPath(videoPath),
      JSON.stringify({
        source: 'recorded',
        samples: [
          { timeMs: 0, x: 0.25, y: 0.75, cursorKind: 'ibeam' },
          { timeMs: 20, x: 0.3, y: 0.7, click: true },
        ],
        events: [{ type: 'click', startMs: 20, endMs: 20, point: { x: 0.3, y: 0.7 } }],
        stats: { sampleCount: 2, clickCount: 1 },
      }),
      'utf-8',
    )

    const track = await readCursorTrackSidecar(videoPath)
    expect(track?.samples).toEqual([
      { timeMs: 0, x: 0.25, y: 0.75, click: false, visible: true, cursorKind: 'text' },
      { timeMs: 20, x: 0.3, y: 0.7, click: true, visible: true, cursorKind: 'arrow' },
    ])
    expect(track?.events).toHaveLength(1)
  })

  it('writes a long track as compact JSON that still round-trips', async () => {
    const videoPath = path.join(dir, 'long-recording.webm')
    const { samples, events } = syntheticTrack({ durationMs: 600_000, clickTimesMs: [1_000] })
    await writeCursorTrackSidecar(videoPath, { samples, events })

    const raw = await readFile(resolveCursorSidecarPath(videoPath), 'utf-8')
    expect(raw).not.toContain('\n')
    expect(JSON.parse(raw).version).toBe(1)

    const track = await readCursorTrackSidecar(videoPath)
    expect(track?.samples.length).toBeGreaterThan(6_000)
    expect(track?.samples[track.samples.length - 1].timeMs).toBe(600_000)
  })
})

describe('recording markers (D2)', () => {
  const markerAt = (timeMs: number) => ({ type: 'marker' as const, timeMs })
  const trackWith = (events: unknown[]) => ({
    samples: [sampleAt(0), sampleAt(1_000)],
    events: events as never,
  })

  it('keeps markers through sanitize, rounded and sorted after the pointer events', () => {
    const track = sanitizeCursorTrack(
      trackWith([markerAt(900.4), clickAt(100), markerAt(400.6), markerAt(-5)]),
    )
    expect(track?.events).toEqual([
      clickAt(100),
      { type: 'marker', timeMs: 0 },
      { type: 'marker', timeMs: 401 },
      { type: 'marker', timeMs: 900 },
    ])
  })

  it('drops a marker with an unusable time and leaves a track without markers alone', () => {
    expect(
      sanitizeCursorTrack(trackWith([markerAt(Number.NaN), { type: 'marker' }]))?.events,
    ).toBeUndefined()
    expect(sanitizeCursorTrack(trackWith([clickAt(50)]))?.events).toEqual([clickAt(50)])
  })

  it('does not count a marker as a click', () => {
    const track = sanitizeCursorTrack({
      samples: [sampleAt(0), sampleAt(10)],
      events: [markerAt(5), clickAt(6)] as never,
      stats: { sampleCount: 2, clickCount: Number.NaN },
    })
    expect(track?.stats?.clickCount).toBe(1)
  })

  it('caps markers separately from the pointer events', () => {
    const markers = Array.from({ length: MAX_CURSOR_TRACK_MARKERS + 25 }, (_, index) =>
      markerAt(index),
    )
    const track = sanitizeCursorTrack(trackWith([...markers, clickAt(1)]))
    const kept = (track?.events ?? []).filter((event) => event.type === 'marker')
    expect(kept).toHaveLength(MAX_CURSOR_TRACK_MARKERS)
    // The earliest survive: the cap keeps the recording's own order.
    expect(kept[0]).toEqual({ type: 'marker', timeMs: 0 })
  })

  it('collapses paused time out of markers and drops the ones inside a pause', () => {
    const compacted = compactCursorTrackPauseRanges(
      {
        samples: [sampleAt(0), sampleAt(3_000)],
        events: [markerAt(500), markerAt(1_500), markerAt(2_500), clickAt(2_600)] as never,
      },
      [{ startMs: 1_000, endMs: 2_000 }],
    )
    expect(compacted.events).toEqual([
      { type: 'click', startMs: 1_600, endMs: 1_600, point: { x: 0.5, y: 0.5 } },
      { type: 'marker', timeMs: 500 },
      { type: 'marker', timeMs: 1_500 },
    ])
  })

  it('round-trips markers through the sidecar file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-markers-'))
    try {
      const videoPath = path.join(dir, 'take.mp4')
      await writeCursorTrackSidecar(videoPath, trackWith([clickAt(10), markerAt(2_500)]))
      const reloaded = await readCursorTrackSidecar(videoPath)
      expect(reloaded?.events).toEqual([clickAt(10), { type: 'marker', timeMs: 2_500 }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads a sidecar written before markers existed unchanged', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'capturia-markers-'))
    try {
      const videoPath = path.join(dir, 'take.mp4')
      const legacy = {
        version: 1,
        cursorTrack: {
          source: 'recorded',
          samples: [
            { timeMs: 0, x: 0.5, y: 0.5, click: false, visible: true, cursorKind: 'arrow' },
          ],
          events: [clickAt(20)],
        },
      }
      await writeFile(resolveCursorSidecarPath(videoPath), JSON.stringify(legacy, null, 2), 'utf-8')
      const reloaded = await readCursorTrackSidecar(videoPath)
      expect(reloaded?.events).toEqual([clickAt(20)])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
