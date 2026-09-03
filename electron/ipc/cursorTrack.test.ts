import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compactCursorTrackPauseRanges,
  normalizeCursorTrackPauseRanges,
  readCursorTrackSidecar,
  resolveCursorSidecarPath,
  sanitizeCursorTrack,
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
