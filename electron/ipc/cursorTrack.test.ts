import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  readCursorTrackSidecar,
  resolveCursorSidecarPath,
  sanitizeCursorTrack,
  sanitizeVideoMetadata,
  writeCursorTrackSidecar,
} from './cursorTrack'

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
      space: { mode: 'source-display', displayId: ' 7 ', bounds: { x: 0, y: 0, width: 100, height: 50 } },
      stats: { sampleCount: -1, clickCount: 3.9 },
      capture: { sourceId: 'screen:1:0', width: 1920.9, height: 1 },
    })
    expect(track).toBeDefined()
    expect(track?.source).toBe('recorded')
    expect(track?.samples).toEqual([
      { timeMs: 10, x: 0.25, y: 0.5, click: false, visible: true, cursorKind: 'ibeam' },
      { timeMs: 50, x: 1, y: 0, click: true, visible: true, cursorKind: 'arrow' },
    ])
    expect(track?.events).toEqual([{ type: 'click', startMs: 20, endMs: 20, point: { x: 1, y: 0.5 } }])
    expect(track?.space).toEqual({ mode: 'source-display', displayId: '7', bounds: { x: 0, y: 0, width: 100, height: 50 } })
    expect(track?.stats).toEqual({ sampleCount: 2, clickCount: 3 })
    expect(track?.capture).toEqual({ sourceId: 'screen:1:0', width: 1920, height: undefined })
  })

  it('sanitizeCursorTrack returns undefined for empty input', () => {
    expect(sanitizeCursorTrack(undefined)).toBeUndefined()
    expect(sanitizeCursorTrack({ samples: [] })).toBeUndefined()
    expect(sanitizeCursorTrack({ samples: [{ timeMs: 'x' as unknown as number, x: 0, y: 0 }] })).toBeUndefined()
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
    expect(track?.samples).toEqual([{ timeMs: 5, x: 0.1, y: 0.2, click: false, visible: true, cursorKind: 'arrow' }])
    expect(await readCursorTrackSidecar(path.join(dir, 'missing.webm'))).toBeUndefined()
  })

  it('skips writing a sidecar for an empty track', async () => {
    const videoPath = path.join(dir, 'recording-2.webm')
    await writeCursorTrackSidecar(videoPath, { samples: [] })
    await expect(readFile(resolveCursorSidecarPath(videoPath))).rejects.toThrow()
  })
})
