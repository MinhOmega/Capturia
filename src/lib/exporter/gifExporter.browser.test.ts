import { describe, expect, it } from 'vitest'
import sampleVideoUrl from '@/__fixtures__/sample.webm?url'
import { GifExporter } from './gifExporter'
import type { ExportProgress } from './types'

/**
 * GIF export frame count in a real browser: `ceil(effectiveDuration * fps)`
 * frames go into gif.js and a valid GIF89a comes out. Two sources:
 * - the bundled 2 s fixture, and
 * - a synthetic WebM recorded in-test from a `<canvas>` via `MediaRecorder`
 *   (no container duration, so the exporter is told `sourceDurationMs`).
 */

const GIF_FPS = 15
/** The bundled fixture is a 2 s clip (its container rounds up to 2.008 s). */
const FIXTURE_DURATION_MS = 2000

function gifHeader(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.slice(0, 6))
}

function renderingEvents(events: ExportProgress[]): ExportProgress[] {
  return events.filter((p) => p.phase !== 'finalizing')
}

/**
 * Record `durationMs` of a moving square from a canvas into a WebM blob URL.
 * Returns `null` when the browser cannot record VP8/VP9 from a canvas.
 */
async function recordSyntheticCanvasWebm(durationMs: number): Promise<string | null> {
  if (typeof MediaRecorder === 'undefined') return null
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) =>
    MediaRecorder.isTypeSupported(type),
  )
  if (!mimeType) return null

  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 120
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const stream = canvas.captureStream(30)
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })

  let frame = 0
  let timer = 0
  const draw = () => {
    ctx.fillStyle = '#102030'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#ffcc00'
    ctx.fillRect((frame * 4) % canvas.width, 40, 32, 32)
    frame += 1
    timer = window.setTimeout(draw, 1000 / 30)
  }
  draw()
  recorder.start(100)
  await new Promise((resolve) => setTimeout(resolve, durationMs))
  recorder.stop()
  await stopped
  window.clearTimeout(timer)
  for (const track of stream.getTracks()) track.stop()

  if (chunks.length === 0) return null
  return URL.createObjectURL(new Blob(chunks, { type: mimeType }))
}

function baseConfig(videoUrl: string, onProgress: (p: ExportProgress) => void) {
  return {
    videoUrl,
    width: 160,
    height: 120,
    frameRate: GIF_FPS as 15,
    loop: true,
    sizePreset: 'medium' as const,
    wallpaper: '#1a1a2e',
    zoomRegions: [],
    showShadow: false,
    shadowIntensity: 0,
    showBlur: false,
    cropRegion: { x: 0, y: 0, width: 1, height: 1 },
    onProgress,
  }
}

describe('GifExporter (real browser)', () => {
  it('encodes ceil(duration * fps) frames from the fixture into a GIF89a', async () => {
    const events: ExportProgress[] = []
    // The fixture's container says 2.008 s; the editor probes the real end and
    // hands it over as `sourceDurationMs`, which is what makes the frame count
    // deterministic instead of `ceil(2.008 * 15) = 31`.
    const exporter = new GifExporter({
      ...baseConfig(sampleVideoUrl, (p) => events.push(p)),
      sourceDurationMs: FIXTURE_DURATION_MS,
    })
    const result = await exporter.export()

    expect(result.success, result.error).toBe(true)
    const bytes = new Uint8Array(await result.blob!.arrayBuffer())
    expect(gifHeader(bytes)).toMatch(/^GIF8[79]a/)
    expect(bytes.length).toBeGreaterThan(512)

    const expectedFrames = Math.ceil((FIXTURE_DURATION_MS / 1000) * GIF_FPS)
    const rendering = renderingEvents(events)
    expect(rendering.at(-1)!.totalFrames).toBe(expectedFrames)
    expect(rendering.at(-1)!.currentFrame).toBe(expectedFrames)
    expect(events.filter((p) => p.phase === 'finalizing').at(-1)!.percentage).toBe(100)
  })

  it('encodes the right frame count from a canvas-recorded WebM with a probed duration', async () => {
    const durationMs = 1000
    const videoUrl = await recordSyntheticCanvasWebm(durationMs)
    if (!videoUrl) {
      console.warn('[browser-test] MediaRecorder cannot record a canvas here; skipping')
      return
    }
    try {
      const events: ExportProgress[] = []
      const exporter = new GifExporter({
        ...baseConfig(videoUrl, (p) => events.push(p)),
        // MediaRecorder writes no duration into the container; the editor
        // probes it and hands it over the same way.
        sourceDurationMs: durationMs,
      })
      const result = await exporter.export()

      expect(result.success, result.error).toBe(true)
      const bytes = new Uint8Array(await result.blob!.arrayBuffer())
      expect(gifHeader(bytes)).toMatch(/^GIF8[79]a/)

      const expectedFrames = Math.ceil((durationMs / 1000) * GIF_FPS)
      const rendering = renderingEvents(events)
      expect(rendering.at(-1)!.totalFrames).toBe(expectedFrames)
      expect(rendering.at(-1)!.currentFrame).toBe(expectedFrames)
    } finally {
      URL.revokeObjectURL(videoUrl)
    }
  })
})
